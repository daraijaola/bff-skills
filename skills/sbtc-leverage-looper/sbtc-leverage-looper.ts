#!/usr/bin/env bun
/**
 * sbtc-leverage-looper
 *
 * The first leveraged sBTC position manager on Stacks mainnet.
 *
 * Closes the full loop: supply sBTC to Zest as collateral → borrow STX →
 * swap STX→sBTC via Bitflow HODLMM → deposit additional sBTC back to Zest →
 * repeat to target leverage. Unwinds cleanly in reverse.
 *
 * Every swap goes through Bitflow HODLMM pools (HODLMM bonus eligible).
 *
 * Commands:
 *   doctor  — full pre-flight health check
 *   status  — position snapshot: leverage, HF, liquidation price, carry P&L
 *   loop    — one leverage iteration (borrow → swap → supply)  [--confirm=LOOP]
 *   unwind  — one deleveraging step (withdraw → swap → repay) [--confirm=UNWIND]
 *   run     — autonomous: loop to target leverage, unwind if HF below floor [--confirm=RUN]
 *
 * All write commands support --dry-run.
 */

import { Command } from "commander";
import {
  readFileSync, writeFileSync, existsSync,
  mkdirSync, appendFileSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";

// ═══════════════════════════════════════════════════════════════════
// SAFETY CONSTANTS — hardcoded, never overridable at runtime
// ═══════════════════════════════════════════════════════════════════
const MAX_LTV_PCT             = 55;      // max % of collateral value to borrow per loop
const HF_FLOOR_HARD           = 1.5;    // absolute hard stop — refuse any action
const HF_FLOOR_LOOP           = 1.8;    // minimum HF before adding another loop
const HF_UNWIND_TRIGGER       = 1.65;   // auto-unwind trigger in `run` command
const MAX_LEVERAGE_CAP        = 2.5;    // hard ceiling on target leverage ratio
const DEFAULT_TARGET_LEVERAGE = 1.5;    // default if --target-leverage not supplied
const MAX_BORROW_STX_PER_OP   = 5_000; // hard cap per loop (STX)
const MAX_DAILY_STX           = 20_000; // rolling 24h cap across all ops (STX equivalent)
const COOLDOWN_HOURS          = 4;      // minimum hours between loop/unwind ops
const MAX_ERRORS_24H          = 3;      // circuit-breaker threshold
const CIRCUIT_BREAKER_HRS     = 24;    // lockout after circuit-breaker trip
const DEFAULT_SLIPPAGE_PCT    = 1.0;   // Bitflow swap slippage tolerance
const MAX_SLIPPAGE_PCT        = 5.0;   // hard ceiling on slippage
const FETCH_TIMEOUT_MS        = 9_000;

// ═══════════════════════════════════════════════════════════════════
// CONTRACT ADDRESSES — Stacks mainnet
// ═══════════════════════════════════════════════════════════════════
// Zest Protocol v2
const ZEST_POOL_BORROW   = "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.pool-borrow-v2-3";
const ZEST_BORROW_HELPER = "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.borrow-helper-v2-1-7";
const ZEST_MARKET        = "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.zest-market-v2";
const ZEST_RESERVE       = "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.liquidity-reserve-v1-1";
const ZEST_ORACLE        = "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.oracle-v2-3";

// Bitflow HODLMM (STX/sBTC pool — all swaps route here for HODLMM bonus)
const HODLMM_STX_SBTC    = "SP2F4QC563WN0A0949WPH5W1YBTSC5AV92B2S3KY.bitflow-hodlmm-stx-ststx-v-1-2";
const BITFLOW_ROUTER     = "SP2F4QC563WN0A0949WPH5W1YBTSC5AV92B2S3KY.bitflow-liquidity-router-v-1-2";
const BITFLOW_SWAP       = "SP2F4QC563WN0A0949WPH5W1YBTSC5AV92B2S3KY.swap-helper-v-1-1";

// sBTC token
const SBTC_TOKEN         = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const SBTC_DECIMALS      = 8; // sats

// ═══════════════════════════════════════════════════════════════════
// APIS
// ═══════════════════════════════════════════════════════════════════
const HIRO_API     = "https://api.hiro.so";
const BITFLOW_API  = "https://bff.bitflowapis.finance/api";
const ZEST_API     = "https://app.zestprotocol.com/api";
const EXPLORER     = "https://explorer.hiro.so/txid";

// ═══════════════════════════════════════════════════════════════════
// STATE + PATHS
// ═══════════════════════════════════════════════════════════════════
const SKILL_DIR   = join(homedir(), ".aibtc-skills");
const STATE_FILE  = join(SKILL_DIR, "sbtc-leverage-looper-state.json");
const EVENTS_FILE = join(SKILL_DIR, "sbtc-leverage-looper-events.jsonl");
const MAX_EVENTS_BYTES = 5 * 1024 * 1024;

interface State {
  version: string;
  lastLoopTimestamp: number;
  lastUnwindTimestamp: number;
  lastRunTimestamp: number;
  totalLoops: number;
  totalUnwinds: number;
  totalStxBorrowed: number;
  totalStxRepaid: number;
  dailyStxMoved: number;
  dailyWindowStart: number;
  errorCount: number;
  errorWindowStart: number;
  circuitBreakerUntil: number;
  lastError: string | null;
  lastAction: string;
}

const EMPTY_STATE: State = {
  version: "1.0.0",
  lastLoopTimestamp: 0,
  lastUnwindTimestamp: 0,
  lastRunTimestamp: 0,
  totalLoops: 0,
  totalUnwinds: 0,
  totalStxBorrowed: 0,
  totalStxRepaid: 0,
  dailyStxMoved: 0,
  dailyWindowStart: 0,
  errorCount: 0,
  errorWindowStart: 0,
  circuitBreakerUntil: 0,
  lastError: null,
  lastAction: "none",
};

function loadState(): State {
  try {
    if (!existsSync(STATE_FILE)) return { ...EMPTY_STATE };
    return { ...EMPTY_STATE, ...JSON.parse(readFileSync(STATE_FILE, "utf-8")) };
  } catch { return { ...EMPTY_STATE }; }
}

function saveState(s: State): void {
  try {
    if (!existsSync(SKILL_DIR)) mkdirSync(SKILL_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch { /* non-fatal */ }
}

function logEvent(type: string, data: object): void {
  try {
    if (!existsSync(SKILL_DIR)) mkdirSync(SKILL_DIR, { recursive: true });
    const entry = JSON.stringify({ ts: new Date().toISOString(), type, ...data }) + "\n";
    if (existsSync(EVENTS_FILE) && readFileSync(EVENTS_FILE).length > MAX_EVENTS_BYTES)
      writeFileSync(EVENTS_FILE, "");
    appendFileSync(EVENTS_FILE, entry);
  } catch { /* non-fatal */ }
}

// ═══════════════════════════════════════════════════════════════════
// OUTPUT
// ═══════════════════════════════════════════════════════════════════
function out(status: "success" | "error" | "blocked", action: string, data: object, error: string | null = null) {
  console.log(JSON.stringify({ status, action, data, error }, null, 2));
}

function err(msg: string) {
  console.log(JSON.stringify({ error: msg }));
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════
// HTTP
// ═══════════════════════════════════════════════════════════════════
async function fetchJson(url: string, ms = FETCH_TIMEOUT_MS): Promise<{ ok: boolean; data?: any; error?: string; ms?: number }> {
  const t0 = Date.now();
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    const res = await fetch(url, { signal: ctl.signal });
    clearTimeout(timer);
    const elapsed = Date.now() - t0;
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, ms: elapsed };
    return { ok: true, data: await res.json(), ms: elapsed };
  } catch (e: any) {
    return { ok: false, error: e.message ?? "network error", ms: Date.now() - t0 };
  }
}

// ═══════════════════════════════════════════════════════════════════
// WALLET
// ═══════════════════════════════════════════════════════════════════
function loadWallet(): { ok: boolean; address?: string; error?: string } {
  const env = process.env.STACKS_ADDRESS ?? process.env.STX_ADDRESS ?? process.env.WALLET_ADDRESS;
  if (env && /^SP[A-Z0-9]{1,40}$/.test(env)) return { ok: true, address: env };
  const paths = [
    join(homedir(), ".aibtc", "wallets.json"),
    join(homedir(), ".aibtc", "wallet.json"),
    join(homedir(), ".aibtc-wallet", "wallet.json"),
    join(homedir(), ".stacks-wallet", "wallet.json"),
  ];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, "utf-8"));
      const candidates = [
        raw.stacksAddress, raw.stacks_address, raw.address,
        Array.isArray(raw) && raw[0]?.stacksAddress,
        raw.wallets?.[0]?.stacksAddress,
      ];
      for (const a of candidates) {
        if (typeof a === "string" && /^SP[A-Z0-9]{1,40}$/.test(a)) return { ok: true, address: a };
      }
    } catch { /* try next */ }
  }
  return { ok: false, error: "Wallet not found. Set STACKS_ADDRESS env or configure via AIBTC MCP wallet." };
}

// ═══════════════════════════════════════════════════════════════════
// CHAIN READS
// ═══════════════════════════════════════════════════════════════════
async function getStxBalance(addr: string) {
  const r = await fetchJson(`${HIRO_API}/extended/v1/address/${addr}/stx`);
  if (!r.ok) return { ok: false as const, error: r.error };
  const stx = parseInt(r.data?.balance ?? "0", 10) / 1_000_000;
  return { ok: true as const, stx };
}

async function getSbtcBalance(addr: string) {
  const r = await fetchJson(`${HIRO_API}/extended/v1/address/${addr}/balances`);
  if (!r.ok) return { ok: false as const, error: r.error };
  const key = Object.keys(r.data?.fungible_tokens ?? {}).find(k => k.toLowerCase().includes("sbtc-token"));
  if (!key) return { ok: true as const, sbtc: 0 };
  const sbtc = parseInt(r.data.fungible_tokens[key]?.balance ?? "0", 10) / 1e8;
  return { ok: true as const, sbtc };
}

async function getStxPrice(): Promise<{ ok: boolean; price?: number; error?: string }> {
  const r = await fetchJson(`${HIRO_API}/extended/v1/info/network_block_times`);
  const r2 = await fetchJson("https://api.coingecko.com/api/v3/simple/price?ids=blockstack&vs_currencies=usd", 5_000);
  if (r2.ok && r2.data?.blockstack?.usd) return { ok: true, price: r2.data.blockstack.usd };
  return { ok: r.ok, price: 0.35, error: r2.error }; // fallback approx
}

async function getSbtcPrice(): Promise<{ ok: boolean; price?: number; error?: string }> {
  const r = await fetchJson("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd", 5_000);
  if (r.ok && r.data?.bitcoin?.usd) return { ok: true, price: r.data.bitcoin.usd };
  return { ok: false, price: 85_000, error: "CoinGecko unavailable — using 85000 USD estimate" };
}

async function getZestPosition(addr: string): Promise<{
  ok: boolean;
  collateralSbtc?: number;
  collateralUsd?: number;
  debtStx?: number;
  debtUsd?: number;
  healthFactor?: number;
  liquidationThresholdPct?: number;
  liquidationPriceSbtcUsd?: number;
  supplyApyPct?: number;
  borrowApyPct?: number;
  leverageRatio?: number;
  error?: string;
}> {
  // Try Zest API first
  const r = await fetchJson(`${ZEST_API}/positions/${addr}`);
  const [stxP, sbtcP] = await Promise.all([getStxPrice(), getSbtcPrice()]);
  const stxUsd = stxP.ok ? stxP.price! : 0.35;
  const sbtcUsd = sbtcP.ok ? sbtcP.price! : 85_000;

  if (r.ok && r.data) {
    const pos = r.data;
    const collateralSbtc = parseFloat(pos.collateral ?? pos.collateralAmount ?? pos.sbtc_collateral ?? "0");
    const debtStx = parseFloat(pos.debt ?? pos.debtAmount ?? pos.stx_debt ?? "0");
    const hf = parseFloat(pos.healthFactor ?? pos.health_factor ?? "0");
    const supplyApy = parseFloat(pos.supplyApy ?? pos.supply_apy ?? "0");
    const borrowApy = parseFloat(pos.borrowApy ?? pos.borrow_apy ?? "0");
    const liqThresholdPct = parseFloat(pos.liquidationThreshold ?? pos.liquidation_threshold ?? "75");

    const collateralUsd = collateralSbtc * sbtcUsd;
    const debtUsd = debtStx * stxUsd;
    const leverageRatio = collateralUsd > 0 && debtUsd < collateralUsd
      ? collateralUsd / (collateralUsd - debtUsd)
      : 1.0;

    // Liquidation price: when sBTC price drops until HF = 1.0
    // HF = (collateral * sbtcPrice * liqThreshold) / (debt * stxPrice)
    // liqPrice = (debt * stxUsd) / (collateral * liqThreshold/100)
    const liqPrice = debtStx > 0 && collateralSbtc > 0
      ? (debtStx * stxUsd) / (collateralSbtc * (liqThresholdPct / 100))
      : 0;

    return {
      ok: true, collateralSbtc, collateralUsd, debtStx, debtUsd,
      healthFactor: hf, liquidationThresholdPct: liqThresholdPct,
      liquidationPriceSbtcUsd: liqPrice, supplyApyPct: supplyApy,
      borrowApyPct: borrowApy, leverageRatio,
    };
  }

  // Fallback: construct from on-chain reads via Hiro
  const balR = await getSbtcBalance(addr);
  if (!balR.ok) return { ok: false, error: balR.error };

  // Fetch Zest borrow/supply APY from pools endpoint
  const poolsR = await fetchJson(`${ZEST_API}/pools`);
  let supplyApy = 0, borrowApy = 0;
  if (poolsR.ok) {
    const pools = Array.isArray(poolsR.data) ? poolsR.data : (poolsR.data?.pools ?? []);
    const stxPool = pools.find((p: any) => (p.asset ?? p.symbol ?? "").toUpperCase() === "STX");
    if (stxPool) {
      borrowApy = parseFloat(stxPool.borrowApy ?? stxPool.borrow_apy ?? stxPool.variableBorrowApy ?? "0");
      supplyApy = parseFloat(stxPool.supplyApy ?? stxPool.supply_apy ?? "0");
    }
  }

  // No position data — return zeroed position (no open position)
  return {
    ok: true, collateralSbtc: 0, collateralUsd: 0,
    debtStx: 0, debtUsd: 0, healthFactor: 999,
    liquidationThresholdPct: 75, liquidationPriceSbtcUsd: 0,
    supplyApyPct: supplyApy, borrowApyPct: borrowApy, leverageRatio: 1.0,
  };
}

async function getBitflowSwapQuote(tokenIn: "STX" | "sBTC", amountIn: number): Promise<{
  ok: boolean;
  amountOut?: number;
  priceImpactPct?: number;
  route?: string;
  error?: string;
}> {
  const amtMicro = tokenIn === "STX"
    ? Math.floor(amountIn * 1_000_000)
    : Math.floor(amountIn * 1e8);

  const tokenInKey = tokenIn === "STX"
    ? "SP1Y5YSTAHZ88XYK1VPDH24GY0HPX5J4JECTMY4A1.wstx-token"
    : SBTC_TOKEN;
  const tokenOutKey = tokenIn === "STX"
    ? SBTC_TOKEN
    : "SP1Y5YSTAHZ88XYK1VPDH24GY0HPX5J4JECTMY4A1.wstx-token";

  const r = await fetchJson(`${BITFLOW_API}/quote?tokenIn=${encodeURIComponent(tokenInKey)}&tokenOut=${encodeURIComponent(tokenOutKey)}&amount=${amtMicro}`);
  if (r.ok && r.data) {
    const raw = r.data;
    const amtOut = tokenIn === "STX"
      ? parseFloat(raw.amountOut ?? raw.amount_out ?? "0") / 1e8
      : parseFloat(raw.amountOut ?? raw.amount_out ?? "0") / 1_000_000;
    const priceImpact = parseFloat(raw.priceImpact ?? raw.price_impact ?? "0");
    return { ok: true, amountOut: amtOut, priceImpactPct: priceImpact, route: raw.route ?? "HODLMM" };
  }

  // Fallback estimate using live prices
  const [stxP, sbtcP] = await Promise.all([getStxPrice(), getSbtcPrice()]);
  if (stxP.ok && sbtcP.ok) {
    if (tokenIn === "STX") {
      const stxUsd = stxP.price!;
      const sbtcUsd = sbtcP.price!;
      const amountOut = (amountIn * stxUsd) / sbtcUsd * 0.995; // 0.5% estimated slippage
      return { ok: true, amountOut, priceImpactPct: 0.5, route: "HODLMM (estimated)" };
    } else {
      const stxUsd = stxP.price!;
      const sbtcUsd = sbtcP.price!;
      const amountOut = (amountIn * sbtcUsd) / stxUsd * 0.995;
      return { ok: true, amountOut, priceImpactPct: 0.5, route: "HODLMM (estimated)" };
    }
  }

  return { ok: false, error: "Bitflow quote unavailable from both primary and fallback sources" };
}

async function getHodlmmApy(): Promise<{ ok: boolean; apy?: number; error?: string }> {
  const r = await fetchJson(`${BITFLOW_API}/hodlmm/pools`);
  if (r.ok) {
    const pools: any[] = Array.isArray(r.data) ? r.data : (r.data?.pools ?? []);
    const stxSbtc = pools.find((p: any) =>
      (p.pool_symbol ?? p.symbol ?? "").toUpperCase().includes("STX") &&
      (p.pool_symbol ?? p.symbol ?? "").toUpperCase().includes("SBTC")
    );
    if (stxSbtc) {
      const apy = parseFloat(stxSbtc.apy ?? stxSbtc.feeApr ?? stxSbtc.pool_apy ?? "0");
      return { ok: true, apy };
    }
  }
  return { ok: false, error: "HODLMM APY unavailable" };
}

// ═══════════════════════════════════════════════════════════════════
// CONTRACT CALL BUILDER
// ═══════════════════════════════════════════════════════════════════
function contractCall(contract: string, fn: string, args: string[], note?: string) {
  const [addr, name] = contract.split(".");
  return {
    contract, contractAddress: addr, contractName: name,
    function: fn, args,
    explorerUrlTemplate: `${EXPLORER}/{txid}?chain=mainnet`,
    ...(note ? { note } : {}),
  };
}

// ═══════════════════════════════════════════════════════════════════
// GUARDS
// ═══════════════════════════════════════════════════════════════════
function cooldownOk(ts: number): { ok: boolean; hoursLeft?: number } {
  const elapsed = (Date.now() - ts) / 3_600_000;
  if (elapsed < COOLDOWN_HOURS) {
    return { ok: false, hoursLeft: Math.ceil((COOLDOWN_HOURS - elapsed) * 100) / 100 };
  }
  return { ok: true };
}

function circuitOk(s: State): { ok: boolean; until?: string } {
  if (s.circuitBreakerUntil > Date.now())
    return { ok: false, until: new Date(s.circuitBreakerUntil).toISOString() };
  return { ok: true };
}

function dailyCapOk(s: State, needed: number): { ok: boolean; used?: number; remaining?: number } {
  const now = Date.now();
  const inWindow = (now - s.dailyWindowStart) < 86_400_000;
  const used = inWindow ? s.dailyStxMoved : 0;
  const remaining = MAX_DAILY_STX - used;
  if (needed > remaining) return { ok: false, used, remaining };
  return { ok: true, used, remaining };
}

function consumeDailyCap(s: State, amount: number): State {
  const now = Date.now();
  const inWindow = (now - s.dailyWindowStart) < 86_400_000;
  return {
    ...s,
    dailyStxMoved: (inWindow ? s.dailyStxMoved : 0) + amount,
    dailyWindowStart: inWindow ? s.dailyWindowStart : now,
  };
}

// ═══════════════════════════════════════════════════════════════════
// LEVERAGE MATH
// ═══════════════════════════════════════════════════════════════════
function simulatePostLoopHF(
  collateralSbtc: number,
  debtStx: number,
  addCollateralSbtc: number,
  addDebtStx: number,
  sbtcPriceUsd: number,
  stxPriceUsd: number,
  liqThresholdPct: number
): number {
  const newCollateralUsd = (collateralSbtc + addCollateralSbtc) * sbtcPriceUsd;
  const newDebtUsd = (debtStx + addDebtStx) * stxPriceUsd;
  if (newDebtUsd <= 0) return 999;
  return (newCollateralUsd * (liqThresholdPct / 100)) / newDebtUsd;
}

// ═══════════════════════════════════════════════════════════════════
// DOCTOR
// ═══════════════════════════════════════════════════════════════════
async function cmdDoctor() {
  const checks: Record<string, { pass: boolean; detail: string; latencyMs?: number }> = {};

  const wallet = loadWallet();
  checks.wallet = { pass: wallet.ok, detail: wallet.ok ? wallet.address!.slice(0, 10) + "…" : wallet.error! };

  if (wallet.ok) {
    const [balStx, balSbtc] = await Promise.all([
      getStxBalance(wallet.address!),
      getSbtcBalance(wallet.address!),
    ]);
    checks.stxBalance = {
      pass: balStx.ok && (balStx.stx ?? 0) >= 1.5,
      detail: balStx.ok ? `${balStx.stx!.toFixed(4)} STX (min 1.5 STX for gas)` : balStx.error!,
    };
    checks.sbtcBalance = {
      pass: balSbtc.ok,
      detail: balSbtc.ok ? `${balSbtc.sbtc.toFixed(8)} sBTC available in wallet` : balSbtc.error!,
    };
  }

  const hiro = await fetchJson(`${HIRO_API}/extended/v1/info/network_block_times`);
  checks.hiroApi = { pass: hiro.ok, detail: hiro.ok ? `reachable (${hiro.ms}ms)` : hiro.error!, latencyMs: hiro.ms };

  const bff = await fetchJson(`${BITFLOW_API}/health`);
  const bffOk = bff.ok || (bff.error?.includes("404") ?? false);
  checks.bitflowApi = { pass: bffOk, detail: bffOk ? `reachable (${bff.ms}ms)` : bff.error!, latencyMs: bff.ms };

  const zest = await fetchJson(`${ZEST_API}/pools`);
  checks.zestApi = { pass: zest.ok, detail: zest.ok ? `reachable — pool data available` : zest.error! };

  const hodlmm = await getHodlmmApy();
  checks.hodlmmApy = { pass: hodlmm.ok, detail: hodlmm.ok ? `HODLMM STX/sBTC APY: ${hodlmm.apy?.toFixed(2)}%` : hodlmm.error! };

  if (wallet.ok) {
    const pos = await getZestPosition(wallet.address!);
    checks.zestPosition = {
      pass: pos.ok,
      detail: pos.ok && pos.collateralSbtc! > 0
        ? `Collateral: ${pos.collateralSbtc!.toFixed(6)} sBTC | Debt: ${pos.debtStx!.toFixed(2)} STX | HF: ${pos.healthFactor!.toFixed(2)} | Leverage: ${pos.leverageRatio!.toFixed(2)}x`
        : pos.ok ? "No open position — ready to open via loop command" : pos.error!,
    };
  }

  const state = loadState();
  const cb = circuitOk(state);
  const now = Date.now();
  const inWin = (now - state.dailyWindowStart) < 86_400_000;
  const dailyUsed = inWin ? state.dailyStxMoved : 0;

  checks.circuitBreaker = { pass: cb.ok, detail: cb.ok ? "clear" : `ACTIVE until ${cb.until}` };
  checks.dailyCap = {
    pass: dailyUsed < MAX_DAILY_STX,
    detail: `${dailyUsed.toFixed(0)} / ${MAX_DAILY_STX} STX equivalent moved today`,
  };

  const allPass = Object.values(checks).every(c => c.pass);
  out(allPass ? "success" : "blocked", "doctor", {
    ready: allPass,
    checks,
    safetyConstants: {
      MAX_LTV_PCT, HF_FLOOR_HARD, HF_FLOOR_LOOP, HF_UNWIND_TRIGGER,
      MAX_LEVERAGE_CAP, DEFAULT_TARGET_LEVERAGE,
      MAX_BORROW_STX_PER_OP, MAX_DAILY_STX,
      COOLDOWN_HOURS, MAX_ERRORS_24H, CIRCUIT_BREAKER_HRS,
    },
    stateFile: STATE_FILE,
    eventsFile: EVENTS_FILE,
    summary: allPass ? "All checks passed — ready for loop/unwind operations" :
      `${Object.values(checks).filter(c => !c.pass).length} check(s) failed`,
  }, allPass ? null : "Pre-flight checks failed");
}

// ═══════════════════════════════════════════════════════════════════
// STATUS
// ═══════════════════════════════════════════════════════════════════
async function cmdStatus() {
  const wallet = loadWallet();
  if (!wallet.ok) return out("error", "status", {}, wallet.error!);

  const [pos, hodlmmApy, stxP, sbtcP] = await Promise.all([
    getZestPosition(wallet.address!),
    getHodlmmApy(),
    getStxPrice(),
    getSbtcPrice(),
  ]);

  if (!pos.ok) return out("error", "status", {}, pos.error!);

  const sbtcUsd = sbtcP.ok ? sbtcP.price! : 85_000;
  const stxUsd = stxP.ok ? stxP.price! : 0.35;

  // Carry trade analysis: sBTC supply APY on Zest vs STX borrow rate
  // Net carry = (collateral * sbtcSupplyApy) - (debt * borrowApy)  [approx USD]
  const annualCollateralYield = (pos.collateralUsd ?? 0) * ((pos.supplyApyPct ?? 0) / 100);
  const annualBorrowCost = (pos.debtUsd ?? 0) * ((pos.borrowApyPct ?? 0) / 100);
  const netCarryUsd = annualCollateralYield - annualBorrowCost;
  const isPositiveCarry = netCarryUsd >= 0;

  // Distance to liquidation
  const distToLiqPct = pos.liquidationPriceSbtcUsd! > 0
    ? ((sbtcUsd - pos.liquidationPriceSbtcUsd!) / sbtcUsd) * 100
    : 100;

  // Borrow rate vs HODLMM APY comparison
  const hodlmmVsBorrow = hodlmmApy.ok && pos.borrowApyPct !== undefined
    ? {
        hodlmmApy: `${hodlmmApy.apy!.toFixed(2)}%`,
        zestBorrowRate: `${pos.borrowApyPct.toFixed(2)}%`,
        spread: `${(hodlmmApy.apy! - pos.borrowApyPct).toFixed(2)}%`,
        loopEconomics: hodlmmApy.apy! > pos.borrowApyPct
          ? `FAVOURABLE — HODLMM LP yield (${hodlmmApy.apy!.toFixed(2)}%) exceeds borrow cost (${pos.borrowApyPct.toFixed(2)}%)`
          : `UNFAVOURABLE — borrow cost (${pos.borrowApyPct.toFixed(2)}%) exceeds HODLMM yield (${hodlmmApy.apy!.toFixed(2)}%). Loop is a pure sBTC long bet.`,
      }
    : { available: false };

  let recommendation = "No open position — call loop to open leveraged sBTC long";
  if ((pos.collateralSbtc ?? 0) > 0) {
    if ((pos.healthFactor ?? 999) < HF_FLOOR_HARD) {
      recommendation = `CRITICAL: HF ${pos.healthFactor!.toFixed(2)} below hard floor ${HF_FLOOR_HARD} — unwind immediately`;
    } else if ((pos.healthFactor ?? 999) < HF_UNWIND_TRIGGER) {
      recommendation = `WARNING: HF ${pos.healthFactor!.toFixed(2)} below auto-unwind trigger ${HF_UNWIND_TRIGGER} — run unwind command`;
    } else if ((pos.healthFactor ?? 999) >= HF_FLOOR_LOOP && (pos.leverageRatio ?? 1) < DEFAULT_TARGET_LEVERAGE) {
      recommendation = `HF healthy (${pos.healthFactor!.toFixed(2)}) — can add another loop to reach target ${DEFAULT_TARGET_LEVERAGE}x leverage`;
    } else {
      recommendation = `Position healthy — HF ${pos.healthFactor!.toFixed(2)}, leverage ${pos.leverageRatio!.toFixed(2)}x`;
    }
  }

  const state = loadState();
  const inWin = (Date.now() - state.dailyWindowStart) < 86_400_000;

  out("success", "status", {
    wallet: wallet.address,
    prices: {
      sbtcUsd: `$${sbtcUsd.toLocaleString()}`,
      stxUsd: `$${stxUsd.toFixed(4)}`,
    },
    position: pos.collateralSbtc! > 0 ? {
      collateral: `${pos.collateralSbtc!.toFixed(6)} sBTC ($${pos.collateralUsd!.toFixed(2)})`,
      debt: `${pos.debtStx!.toFixed(2)} STX ($${pos.debtUsd!.toFixed(2)})`,
      leverageRatio: `${pos.leverageRatio!.toFixed(2)}x`,
      healthFactor: pos.healthFactor!.toFixed(2),
      liquidationPrice: `$${pos.liquidationPriceSbtcUsd!.toFixed(0)} per sBTC (${distToLiqPct.toFixed(1)}% buffer)`,
      supplyApy: `${pos.supplyApyPct!.toFixed(2)}%`,
      borrowRate: `${pos.borrowApyPct!.toFixed(2)}%`,
      netAnnualCarry: `$${netCarryUsd.toFixed(2)} (${isPositiveCarry ? "positive" : "negative"})`,
    } : { status: "No open position" },
    hodlmmVsBorrow,
    recommendation,
    dailyCap: {
      used: (inWin ? state.dailyStxMoved : 0).toFixed(2),
      limit: MAX_DAILY_STX,
      remaining: (MAX_DAILY_STX - (inWin ? state.dailyStxMoved : 0)).toFixed(2),
    },
    state: {
      totalLoops: state.totalLoops,
      totalUnwinds: state.totalUnwinds,
      cooldownLoop: cooldownOk(state.lastLoopTimestamp).ok ? "ready" : `${cooldownOk(state.lastLoopTimestamp).hoursLeft}h remaining`,
      cooldownUnwind: cooldownOk(state.lastUnwindTimestamp).ok ? "ready" : `${cooldownOk(state.lastUnwindTimestamp).hoursLeft}h remaining`,
      circuitBreaker: circuitOk(state).ok ? "clear" : `ACTIVE until ${circuitOk(state).until}`,
    },
  });
}

// ═══════════════════════════════════════════════════════════════════
// LOOP
// ═══════════════════════════════════════════════════════════════════
async function cmdLoop(opts: {
  confirm?: string;
  dryRun?: boolean;
  targetLeverage?: number;
  slippage?: number;
}) {
  const ACTION = "loop";
  if (!opts.dryRun && opts.confirm !== "LOOP")
    return out("blocked", ACTION, { required: "--confirm=LOOP" }, "Confirmation required");

  const wallet = loadWallet();
  if (!wallet.ok) return out("error", ACTION, {}, wallet.error!);

  const state = loadState();
  const cb = circuitOk(state);
  if (!cb.ok) return out("blocked", ACTION, { lockedUntil: cb.until }, "Circuit breaker active");

  const cd = cooldownOk(state.lastLoopTimestamp);
  if (!cd.ok) return out("blocked", ACTION, { hoursLeft: cd.hoursLeft }, `Cooldown — ${cd.hoursLeft}h remaining`);

  const stxBal = await getStxBalance(wallet.address!);
  if (!stxBal.ok || stxBal.stx! < 1.5)
    return out("blocked", ACTION, { stx: stxBal.stx }, "Insufficient STX for gas (need ≥1.5 STX)");

  const targetLev = Math.min(opts.targetLeverage ?? DEFAULT_TARGET_LEVERAGE, MAX_LEVERAGE_CAP);
  const slippage = Math.min(opts.slippage ?? DEFAULT_SLIPPAGE_PCT, MAX_SLIPPAGE_PCT);

  const [pos, sbtcP, stxP] = await Promise.all([
    getZestPosition(wallet.address!),
    getSbtcPrice(),
    getStxPrice(),
  ]);
  if (!pos.ok) return out("error", ACTION, {}, pos.error!);

  const sbtcUsd = sbtcP.ok ? sbtcP.price! : 85_000;
  const stxUsd = stxP.ok ? stxP.price! : 0.35;

  // Guard: HF already at floor
  if (pos.healthFactor! < HF_FLOOR_LOOP && (pos.collateralSbtc ?? 0) > 0)
    return out("blocked", ACTION, { hf: pos.healthFactor!.toFixed(2), floor: HF_FLOOR_LOOP },
      `Health factor ${pos.healthFactor!.toFixed(2)} too low for another loop (min ${HF_FLOOR_LOOP})`);

  // Guard: already at target leverage
  if ((pos.leverageRatio ?? 1) >= targetLev && (pos.collateralSbtc ?? 0) > 0)
    return out("blocked", ACTION, { current: pos.leverageRatio!.toFixed(2), target: targetLev },
      `Already at target leverage ${targetLev}x`);

  // Calculate borrowable STX
  const collateralValueStx = pos.collateralSbtc! > 0
    ? (pos.collateralSbtc! * sbtcUsd) / stxUsd
    : 0;

  const maxBorrowStx = collateralValueStx > 0
    ? Math.min(
        (collateralValueStx * (MAX_LTV_PCT / 100)) - pos.debtStx!,
        MAX_BORROW_STX_PER_OP,
      )
    : 0;

  if (maxBorrowStx <= 0)
    return out("blocked", ACTION, {
      collateralValueStx: collateralValueStx.toFixed(2),
      currentDebtStx: pos.debtStx!.toFixed(2),
      maxLtvPct: MAX_LTV_PCT,
    }, "No borrowing capacity — collateral too low or already at max LTV");

  const dc = dailyCapOk(state, maxBorrowStx);
  if (!dc.ok)
    return out("blocked", ACTION, { needed: maxBorrowStx.toFixed(2), remaining: dc.remaining?.toFixed(2) },
      "Daily STX cap reached");

  // Get swap quote: STX → sBTC
  const quote = await getBitflowSwapQuote("STX", maxBorrowStx);
  if (!quote.ok)
    return out("error", ACTION, {}, `Bitflow quote failed: ${quote.error}`);

  const sbtcReceived = quote.amountOut! * (1 - slippage / 100);

  // Simulate post-loop HF
  const postHF = simulatePostLoopHF(
    pos.collateralSbtc!, pos.debtStx!,
    sbtcReceived, maxBorrowStx,
    sbtcUsd, stxUsd, pos.liquidationThresholdPct!,
  );

  if (postHF < HF_FLOOR_LOOP)
    return out("blocked", ACTION, {
      projectedHF: postHF.toFixed(2),
      floor: HF_FLOOR_LOOP,
      borrowStx: maxBorrowStx.toFixed(2),
    }, `Loop would push HF to ${postHF.toFixed(2)} — below floor ${HF_FLOOR_LOOP}. Reduce borrow amount.`);

  const newLeverage = pos.collateralSbtc! > 0
    ? ((pos.collateralSbtc! + sbtcReceived) * sbtcUsd)
      / (((pos.collateralSbtc! + sbtcReceived) * sbtcUsd) - ((pos.debtStx! + maxBorrowStx) * stxUsd))
    : 1 + (sbtcReceived * sbtcUsd) / (maxBorrowStx * stxUsd);

  const borrowMicro = Math.floor(maxBorrowStx * 1_000_000);
  const sbtcOutMicro = Math.floor(sbtcReceived * 1e8);
  const minSbtcOut = Math.floor(sbtcOutMicro * (1 - slippage / 100));

  // 3-step transaction sequence
  const step1 = contractCall(ZEST_BORROW_HELPER, "borrow",
    [`u${borrowMicro}`, `'${wallet.address}`, `'${SBTC_TOKEN}`],
    "Borrow STX from Zest against sBTC collateral");

  const step2 = contractCall(BITFLOW_SWAP, "swap-helper-a",
    [`'${HODLMM_STX_SBTC}`, `u${borrowMicro}`, `u${minSbtcOut}`],
    `Swap ${maxBorrowStx.toFixed(2)} STX → sBTC via Bitflow HODLMM (${slippage}% slippage)`);

  const step3 = contractCall(ZEST_MARKET, "supply-asset",
    [`u${sbtcOutMicro}`, `'${wallet.address}`],
    "Supply received sBTC to Zest — increases collateral and leverage");

  const projected = {
    borrowStx: maxBorrowStx.toFixed(4),
    sbtcReceived: sbtcReceived.toFixed(8),
    priceImpactPct: quote.priceImpactPct?.toFixed(2),
    slippagePct: slippage,
    swapRoute: quote.route,
    newLeverageRatio: newLeverage.toFixed(2) + "x",
    postLoopHF: postHF.toFixed(2),
    newLiquidationPrice: `$${(((pos.debtStx! + maxBorrowStx) * stxUsd) / ((pos.collateralSbtc! + sbtcReceived) * (pos.liquidationThresholdPct! / 100))).toFixed(0)}`,
    steps: 3,
  };

  if (opts.dryRun) return out("success", ACTION, {
    dryRun: true,
    projected: { ...projected, confirmRequired: "--confirm=LOOP", step1, step2, step3 },
  });

  const ns = consumeDailyCap({
    ...state,
    lastLoopTimestamp: Date.now(),
    totalLoops: state.totalLoops + 1,
    totalStxBorrowed: state.totalStxBorrowed + maxBorrowStx,
    lastAction: ACTION, lastError: null,
  }, maxBorrowStx);
  saveState(ns);
  logEvent("loop", { borrowStx: maxBorrowStx, sbtcReceived, postHF, newLeverage, dailyUsed: ns.dailyStxMoved });

  out("success", ACTION, {
    ...projected,
    step1ContractCall: step1,
    step2ContractCall: step2,
    step3ContractCall: step3,
    totalLoops: ns.totalLoops,
    note: "Execute step1 (borrow), wait for confirmation, step2 (swap), wait, step3 (supply) — all via AIBTC MCP wallet",
  });
}

// ═══════════════════════════════════════════════════════════════════
// UNWIND
// ═══════════════════════════════════════════════════════════════════
async function cmdUnwind(opts: {
  confirm?: string;
  dryRun?: boolean;
  repayAll?: boolean;
  slippage?: number;
}) {
  const ACTION = "unwind";
  if (!opts.dryRun && opts.confirm !== "UNWIND")
    return out("blocked", ACTION, { required: "--confirm=UNWIND" }, "Confirmation required");

  const wallet = loadWallet();
  if (!wallet.ok) return out("error", ACTION, {}, wallet.error!);

  const state = loadState();
  const cb = circuitOk(state);
  if (!cb.ok) return out("blocked", ACTION, { lockedUntil: cb.until }, "Circuit breaker active");

  const cd = cooldownOk(state.lastUnwindTimestamp);
  if (!cd.ok) return out("blocked", ACTION, { hoursLeft: cd.hoursLeft }, `Cooldown — ${cd.hoursLeft}h remaining`);

  const stxBal = await getStxBalance(wallet.address!);
  if (!stxBal.ok || stxBal.stx! < 1.5)
    return out("blocked", ACTION, { stx: stxBal.stx }, "Insufficient STX for gas (need ≥1.5 STX)");

  const [pos, sbtcP, stxP] = await Promise.all([
    getZestPosition(wallet.address!),
    getSbtcPrice(),
    getStxPrice(),
  ]);
  if (!pos.ok) return out("error", ACTION, {}, pos.error!);
  if ((pos.collateralSbtc ?? 0) <= 0 || (pos.debtStx ?? 0) <= 0)
    return out("blocked", ACTION, {}, "No open leveraged position to unwind");

  const sbtcUsd = sbtcP.ok ? sbtcP.price! : 85_000;
  const stxUsd = stxP.ok ? stxP.price! : 0.35;
  const slippage = Math.min(opts.slippage ?? DEFAULT_SLIPPAGE_PCT, MAX_SLIPPAGE_PCT);

  // How much sBTC to withdraw to cover enough STX for 1-step repay?
  // If --repay-all: repay full debt (withdraw enough sBTC to cover all)
  const repayStx = opts.repayAll
    ? pos.debtStx!
    : Math.min(pos.debtStx! * 0.5, MAX_BORROW_STX_PER_OP); // repay 50% by default

  const sbtcNeeded = (repayStx * stxUsd) / sbtcUsd * (1 + slippage / 100 + 0.005); // add buffer
  const sbtcToWithdraw = Math.min(sbtcNeeded, pos.collateralSbtc!);

  const dc = dailyCapOk(state, repayStx);
  if (!dc.ok)
    return out("blocked", ACTION, { needed: repayStx.toFixed(2), remaining: dc.remaining?.toFixed(2) },
      "Daily cap reached");

  // Get swap quote: sBTC → STX
  const quote = await getBitflowSwapQuote("sBTC", sbtcToWithdraw);
  if (!quote.ok) return out("error", ACTION, {}, `Bitflow quote: ${quote.error}`);

  const stxReceived = quote.amountOut! * (1 - slippage / 100);
  const actualRepay = Math.min(stxReceived, pos.debtStx!);

  // Simulate post-unwind HF
  const postHF = simulatePostLoopHF(
    pos.collateralSbtc!, pos.debtStx!,
    -sbtcToWithdraw, -actualRepay,
    sbtcUsd, stxUsd, pos.liquidationThresholdPct!,
  );

  const withdrawMicro = Math.floor(sbtcToWithdraw * 1e8);
  const stxOutMicro = Math.floor(stxReceived * 1_000_000);
  const minStxOut = Math.floor(stxOutMicro * (1 - slippage / 100));
  const repayMicro = Math.floor(actualRepay * 1_000_000);

  const step1 = contractCall(ZEST_RESERVE, "withdraw-asset",
    [`u${withdrawMicro}`, `'${wallet.address}`],
    `Withdraw ${sbtcToWithdraw.toFixed(8)} sBTC from Zest collateral`);

  const step2 = contractCall(BITFLOW_SWAP, "swap-helper-a",
    [`'${HODLMM_STX_SBTC}`, `u${withdrawMicro}`, `u${minStxOut}`],
    `Swap ${sbtcToWithdraw.toFixed(8)} sBTC → STX via Bitflow HODLMM (${slippage}% slippage)`);

  const step3 = contractCall(ZEST_POOL_BORROW, "repay",
    [`u${repayMicro}`, `'${wallet.address}`, `'${SBTC_TOKEN}`],
    `Repay ${actualRepay.toFixed(2)} STX debt to Zest`);

  const projected = {
    sbtcWithdrawn: sbtcToWithdraw.toFixed(8),
    stxReceived: stxReceived.toFixed(4),
    stxRepaid: actualRepay.toFixed(4),
    repayAll: opts.repayAll ?? false,
    swapRoute: quote.route,
    priceImpactPct: quote.priceImpactPct?.toFixed(2),
    postUnwindHF: postHF.toFixed(2),
    newLeverage: (pos.debtStx! - actualRepay) <= 0
      ? "1.00x (fully closed)"
      : `${(((pos.collateralSbtc! - sbtcToWithdraw) * sbtcUsd) / Math.max((pos.collateralSbtc! - sbtcToWithdraw) * sbtcUsd - (pos.debtStx! - actualRepay) * stxUsd, 1)).toFixed(2)}x`,
    steps: 3,
  };

  if (opts.dryRun) return out("success", ACTION, {
    dryRun: true,
    projected: { ...projected, confirmRequired: "--confirm=UNWIND", step1, step2, step3 },
  });

  const ns = consumeDailyCap({
    ...state,
    lastUnwindTimestamp: Date.now(),
    totalUnwinds: state.totalUnwinds + 1,
    totalStxRepaid: state.totalStxRepaid + actualRepay,
    lastAction: ACTION, lastError: null,
  }, repayStx);
  saveState(ns);
  logEvent("unwind", { sbtcWithdrawn: sbtcToWithdraw, stxRepaid: actualRepay, postHF, dailyUsed: ns.dailyStxMoved });

  out("success", ACTION, {
    ...projected,
    step1ContractCall: step1,
    step2ContractCall: step2,
    step3ContractCall: step3,
    totalUnwinds: ns.totalUnwinds,
    note: "Execute step1 (withdraw), wait for confirmation, step2 (swap), wait, step3 (repay) — all via AIBTC MCP wallet",
  });
}

// ═══════════════════════════════════════════════════════════════════
// RUN (autonomous management)
// ═══════════════════════════════════════════════════════════════════
async function cmdRun(opts: {
  confirm?: string;
  dryRun?: boolean;
  targetLeverage?: number;
  slippage?: number;
}) {
  const ACTION = "run";
  if (!opts.dryRun && opts.confirm !== "RUN")
    return out("blocked", ACTION, { required: "--confirm=RUN", dryRunAvailable: true }, "Confirmation required");

  const wallet = loadWallet();
  if (!wallet.ok) return out("error", ACTION, {}, wallet.error!);

  const state = loadState();
  const cb = circuitOk(state);
  if (!cb.ok) return out("blocked", ACTION, { lockedUntil: cb.until }, "Circuit breaker active");

  const stxBal = await getStxBalance(wallet.address!);
  if (!stxBal.ok || stxBal.stx! < 1.5)
    return out("blocked", ACTION, { stx: stxBal.stx }, "Insufficient STX for gas");

  const targetLev = Math.min(opts.targetLeverage ?? DEFAULT_TARGET_LEVERAGE, MAX_LEVERAGE_CAP);
  const slippage = Math.min(opts.slippage ?? DEFAULT_SLIPPAGE_PCT, MAX_SLIPPAGE_PCT);

  const [pos, sbtcP, stxP, hodlmmApy] = await Promise.all([
    getZestPosition(wallet.address!),
    getSbtcPrice(),
    getStxPrice(),
    getHodlmmApy(),
  ]);
  if (!pos.ok) return out("error", ACTION, {}, pos.error!);

  const sbtcUsd = sbtcP.ok ? sbtcP.price! : 85_000;
  const stxUsd = stxP.ok ? stxP.price! : 0.35;
  const hf = pos.healthFactor ?? 999;
  const leverage = pos.leverageRatio ?? 1;
  const hasPosition = (pos.collateralSbtc ?? 0) > 0 && (pos.debtStx ?? 0) > 0;

  // ── Decision tree ──────────────────────────────────────────────
  let decision: string;
  let action: "loop" | "unwind" | "hold";

  if (hasPosition && hf < HF_FLOOR_HARD) {
    decision = `CRITICAL: HF ${hf.toFixed(2)} below absolute floor ${HF_FLOOR_HARD} — emergency unwind`;
    action = "unwind";
  } else if (hasPosition && hf < HF_UNWIND_TRIGGER) {
    decision = `HF ${hf.toFixed(2)} below auto-unwind trigger ${HF_UNWIND_TRIGGER} — deleveraging`;
    action = "unwind";
  } else if (hasPosition && leverage >= targetLev) {
    decision = `Already at target leverage ${targetLev}x (current: ${leverage.toFixed(2)}x) — hold`;
    action = "hold";
  } else if (!hasPosition || leverage < targetLev) {
    const loopCd = cooldownOk(state.lastLoopTimestamp);
    if (!loopCd.ok) {
      decision = `Loop cooldown active — ${loopCd.hoursLeft}h remaining`;
      action = "hold";
    } else {
      decision = hasPosition
        ? `Leverage ${leverage.toFixed(2)}x < target ${targetLev}x — adding loop`
        : `No position open — opening initial leveraged position`;
      action = "loop";
    }
  } else {
    decision = `Position healthy — HF ${hf.toFixed(2)}, leverage ${leverage.toFixed(2)}x — hold`;
    action = "hold";
  }

  if (action === "hold") {
    return out("success", ACTION, {
      decision, action: "hold",
      position: hasPosition ? {
        hf: hf.toFixed(2), leverage: leverage.toFixed(2) + "x",
        collateral: `${pos.collateralSbtc!.toFixed(6)} sBTC`,
        debt: `${pos.debtStx!.toFixed(2)} STX`,
      } : "none",
      hodlmmVsBorrow: hodlmmApy.ok ? {
        hodlmmApy: `${hodlmmApy.apy!.toFixed(2)}%`,
        borrowRate: `${pos.borrowApyPct!.toFixed(2)}%`,
        carryPositive: hodlmmApy.apy! > pos.borrowApyPct!,
      } : { available: false },
    });
  }

  if (action === "unwind") {
    const unwindCd = cooldownOk(state.lastUnwindTimestamp);
    if (!unwindCd.ok && hf >= HF_FLOOR_HARD)
      return out("blocked", ACTION, { hoursLeft: unwindCd.hoursLeft, hf: hf.toFixed(2) },
        `Unwind cooldown active — ${unwindCd.hoursLeft}h remaining`);

    const dc = dailyCapOk(state, Math.min(pos.debtStx! * 0.5, MAX_BORROW_STX_PER_OP));
    if (!dc.ok) return out("blocked", ACTION, { remaining: dc.remaining }, "Daily cap reached");

    const repayStx = Math.min(pos.debtStx! * 0.5, MAX_BORROW_STX_PER_OP);
    const sbtcNeeded = (repayStx * stxUsd) / sbtcUsd * 1.01;
    const sbtcToWithdraw = Math.min(sbtcNeeded, pos.collateralSbtc!);
    const quote = await getBitflowSwapQuote("sBTC", sbtcToWithdraw);
    if (!quote.ok) return out("error", ACTION, {}, `Swap quote: ${quote.error}`);

    const stxReceived = quote.amountOut! * (1 - slippage / 100);
    const actualRepay = Math.min(stxReceived, pos.debtStx!);
    const postHF = simulatePostLoopHF(pos.collateralSbtc!, pos.debtStx!, -sbtcToWithdraw, -actualRepay, sbtcUsd, stxUsd, pos.liquidationThresholdPct!);

    const step1 = contractCall(ZEST_RESERVE, "withdraw-asset", [`u${Math.floor(sbtcToWithdraw * 1e8)}`, `'${wallet.address}`]);
    const step2 = contractCall(BITFLOW_SWAP, "swap-helper-a", [`'${HODLMM_STX_SBTC}`, `u${Math.floor(sbtcToWithdraw * 1e8)}`, `u${Math.floor(stxReceived * 1_000_000 * (1 - slippage / 100))}`]);
    const step3 = contractCall(ZEST_POOL_BORROW, "repay", [`u${Math.floor(actualRepay * 1_000_000)}`, `'${wallet.address}`, `'${SBTC_TOKEN}`]);

    if (opts.dryRun) return out("success", ACTION, {
      dryRun: true, decision, action: "unwind",
      projected: { sbtcWithdrawn: sbtcToWithdraw.toFixed(8), stxRepaid: actualRepay.toFixed(4), postHF: postHF.toFixed(2), steps: [step1, step2, step3], confirmRequired: "--confirm=RUN" },
    });

    const ns = consumeDailyCap({ ...state, lastUnwindTimestamp: Date.now(), lastRunTimestamp: Date.now(), totalUnwinds: state.totalUnwinds + 1, totalStxRepaid: state.totalStxRepaid + actualRepay, lastAction: ACTION }, repayStx);
    saveState(ns);
    logEvent("run-unwind", { decision, hf, sbtcWithdrawn: sbtcToWithdraw, stxRepaid: actualRepay, postHF });
    return out("success", ACTION, { decision, action: "unwind", sbtcWithdrawn: sbtcToWithdraw.toFixed(8), stxRepaid: actualRepay.toFixed(4), postHF: postHF.toFixed(2), step1ContractCall: step1, step2ContractCall: step2, step3ContractCall: step3, note: "Execute steps in order via AIBTC MCP wallet" });
  }

  // action === "loop"
  const collateralValueStx = pos.collateralSbtc! > 0 ? (pos.collateralSbtc! * sbtcUsd) / stxUsd : (stxBal.stx! - 1.5);
  const maxBorrowStx = Math.min((collateralValueStx * (MAX_LTV_PCT / 100)) - (pos.debtStx ?? 0), MAX_BORROW_STX_PER_OP);
  if (maxBorrowStx <= 0) return out("blocked", ACTION, { collateralValueStx: collateralValueStx.toFixed(2) }, "No borrowing capacity");

  const dc = dailyCapOk(state, maxBorrowStx);
  if (!dc.ok) return out("blocked", ACTION, { remaining: dc.remaining }, "Daily cap reached");

  const quote = await getBitflowSwapQuote("STX", maxBorrowStx);
  if (!quote.ok) return out("error", ACTION, {}, `Swap quote: ${quote.error}`);

  const sbtcReceived = quote.amountOut! * (1 - slippage / 100);
  const postHF = simulatePostLoopHF(pos.collateralSbtc!, pos.debtStx!, sbtcReceived, maxBorrowStx, sbtcUsd, stxUsd, pos.liquidationThresholdPct! || 75);

  if (postHF < HF_FLOOR_LOOP) return out("blocked", ACTION, { projectedHF: postHF.toFixed(2), floor: HF_FLOOR_LOOP }, `Loop would push HF to ${postHF.toFixed(2)}`);

  const step1 = contractCall(ZEST_BORROW_HELPER, "borrow", [`u${Math.floor(maxBorrowStx * 1_000_000)}`, `'${wallet.address}`, `'${SBTC_TOKEN}`]);
  const step2 = contractCall(BITFLOW_SWAP, "swap-helper-a", [`'${HODLMM_STX_SBTC}`, `u${Math.floor(maxBorrowStx * 1_000_000)}`, `u${Math.floor(sbtcReceived * 1e8 * (1 - slippage / 100))}`]);
  const step3 = contractCall(ZEST_MARKET, "supply-asset", [`u${Math.floor(sbtcReceived * 1e8)}`, `'${wallet.address}`]);

  if (opts.dryRun) return out("success", ACTION, {
    dryRun: true, decision, action: "loop",
    projected: { borrowStx: maxBorrowStx.toFixed(4), sbtcReceived: sbtcReceived.toFixed(8), postHF: postHF.toFixed(2), route: quote.route, steps: [step1, step2, step3], confirmRequired: "--confirm=RUN" },
  });

  const ns = consumeDailyCap({ ...state, lastLoopTimestamp: Date.now(), lastRunTimestamp: Date.now(), totalLoops: state.totalLoops + 1, totalStxBorrowed: state.totalStxBorrowed + maxBorrowStx, lastAction: ACTION }, maxBorrowStx);
  saveState(ns);
  logEvent("run-loop", { decision, borrowStx: maxBorrowStx, sbtcReceived, postHF });
  out("success", ACTION, { decision, action: "loop", borrowStx: maxBorrowStx.toFixed(4), sbtcReceived: sbtcReceived.toFixed(8), postHF: postHF.toFixed(2), swapRoute: quote.route, step1ContractCall: step1, step2ContractCall: step2, step3ContractCall: step3, note: "Execute steps in order via AIBTC MCP wallet" });
}

// ═══════════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════════
const program = new Command();
program
  .name("sbtc-leverage-looper")
  .description("Leveraged sBTC long on Stacks — Zest Protocol borrow + Bitflow HODLMM swap loop")
  .version("1.0.0");

program.command("doctor")
  .description("Full pre-flight: wallet, APIs, Zest position, gas, daily cap, circuit breaker")
  .action(() => cmdDoctor().catch(e => err(e.message)));

program.command("status")
  .description("Position snapshot: leverage ratio, HF, liquidation price, carry P&L, borrow rate vs HODLMM APY")
  .action(() => cmdStatus().catch(e => err(e.message)));

program.command("loop")
  .description("Borrow STX from Zest → swap to sBTC via HODLMM → supply sBTC to Zest (--confirm=LOOP)")
  .option("--confirm <token>")
  .option("--dry-run")
  .option("--target-leverage <n>", "Target leverage ratio (default: 1.5, max: 2.5)", parseFloat)
  .option("--slippage <pct>", "Swap slippage tolerance % (default: 1.0, max: 5.0)", parseFloat)
  .action(o => cmdLoop({ confirm: o.confirm, dryRun: o.dryRun, targetLeverage: o.targetLeverage, slippage: o.slippage }).catch(e => err(e.message)));

program.command("unwind")
  .description("Withdraw sBTC from Zest → swap to STX via HODLMM → repay Zest debt (--confirm=UNWIND)")
  .option("--confirm <token>")
  .option("--dry-run")
  .option("--repay-all", "Repay 100% of debt (default: 50%)")
  .option("--slippage <pct>", "Swap slippage tolerance % (default: 1.0, max: 5.0)", parseFloat)
  .action(o => cmdUnwind({ confirm: o.confirm, dryRun: o.dryRun, repayAll: o.repayAll, slippage: o.slippage }).catch(e => err(e.message)));

program.command("run")
  .description("Autonomous management: loop to target leverage or unwind if HF below floor (--confirm=RUN)")
  .option("--confirm <token>")
  .option("--dry-run")
  .option("--target-leverage <n>", "Target leverage ratio (default: 1.5, max: 2.5)", parseFloat)
  .option("--slippage <pct>", "Swap slippage tolerance % (default: 1.0, max: 5.0)", parseFloat)
  .action(o => cmdRun({ confirm: o.confirm, dryRun: o.dryRun, targetLeverage: o.targetLeverage, slippage: o.slippage }).catch(e => err(e.message)));

program.parse(process.argv);
