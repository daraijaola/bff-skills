#!/usr/bin/env bun
/**
 * hodlmm-zest-yield-optimizer
 *
 * Autonomous yield router — Bitflow HODLMM + Zest Protocol on Stacks mainnet.
 *
 * The only skill that closes the full capital cycle:
 *   1. Detects HODLMM bin drift  →  rebalances (move-liquidity)
 *   2. Harvests accumulated fees  →  routes to best APY venue
 *   3. Compares HODLMM vs Zest for the FULL position
 *   4. Withdraws entire position to Zest when Zest materially outperforms
 *   5. Re-deposits back to HODLMM when HODLMM recovers
 *
 * Commands:
 *   doctor          —  full pre-flight health check
 *   status          —  live position snapshot + live APY comparison
 *   harvest         —  claim accumulated HODLMM fees  (--confirm=HARVEST)
 *   compound        —  deposit fees into highest-APY venue  (--confirm=COMPOUND)
 *   move-liquidity  —  rebalance drifted bins  (--confirm=MOVE)
 *   withdraw        —  exit full HODLMM position → hold or route to Zest  (--confirm=WITHDRAW)
 *   deposit         —  re-enter HODLMM from wallet balance  (--confirm=DEPOSIT)
 *   run             —  full autonomous loop  (--confirm=RUN)
 *
 * All write commands support --dry-run.
 * All writes require an exact --confirm=TOKEN per action.
 */

import { Command } from "commander";
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ═══════════════════════════════════════════════════════════════════════════════
// SAFETY CONSTANTS — hardcoded, never configurable at runtime
// ═══════════════════════════════════════════════════════════════════════════════
const MAX_HARVEST_PER_OP   = 500;          // max tokens harvested per operation
const MAX_COMPOUND_PER_OP  = 500;          // mirrors harvest cap
const MAX_DAILY_CAPITAL    = 5_000;        // max tokens moved across ALL ops per 24 h
const MIN_STX_GAS          = 1;            // STX floor before any write
const GAS_BUFFER_STX       = 0.1;         // extra buffer on top of MIN_STX_GAS
const COOLDOWN_HOURS       = 6;           // minimum hours between write ops
const MIN_FEE_THRESHOLD    = 0.01;        // minimum fees before harvest
const DEFAULT_DRIFT_PCT    = 20;          // bin drift % to trigger move-liquidity
const DEFAULT_APY_SPREAD   = 1.0;         // APY spread % to justify venue switch
const FULL_EXIT_APY_SPREAD = 5.0;         // APY spread % to justify FULL position exit
const MAX_ERRORS_24H       = 3;           // circuit-breaker error threshold
const CIRCUIT_BREAKER_HRS  = 24;          // lockout duration on circuit-breaker trip
const FETCH_TIMEOUT_MS     = 8_000;

// ═══════════════════════════════════════════════════════════════════════════════
// CONTRACT ADDRESSES — Stacks mainnet
// ═══════════════════════════════════════════════════════════════════════════════
const HODLMM_DEFAULT   = "SP2F4QC563WN0A0949WPH5W1YBTSC5AV92B2S3KY.bitflow-hodlmm-stx-ststx-v-1-2";
const HODLMM_ROUTER    = "SP2F4QC563WN0A0949WPH5W1YBTSC5AV92B2S3KY.bitflow-liquidity-router-v-1-2";
const ZEST_MARKET      = "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.zest-market-v2";
const ZEST_RESERVE     = "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.liquidity-reserve-v1-1";
const EXPLORER_BASE    = "https://explorer.hiro.so/txid";

// ═══════════════════════════════════════════════════════════════════════════════
// API ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════
const HIRO_API        = "https://api.hiro.so";
const BITFLOW_API     = "https://bff.bitflowapis.finance/api";
const ZEST_API        = "https://app.zestprotocol.com/api";

// ═══════════════════════════════════════════════════════════════════════════════
// PATHS
// ═══════════════════════════════════════════════════════════════════════════════
const SKILL_DIR   = join(homedir(), ".aibtc-skills");
const STATE_FILE  = join(SKILL_DIR, "hodlmm-zest-yield-optimizer-state.json");
const EVENTS_FILE = join(SKILL_DIR, "hodlmm-zest-yield-optimizer-events.jsonl");
const MAX_EVENTS_BYTES = 5 * 1024 * 1024; // rotate events log at 5 MB

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════
interface State {
  version: string;
  lastRunTimestamp: number;
  lastHarvestTimestamp: number;
  lastCompoundTimestamp: number;
  lastMoveTimestamp: number;
  lastWithdrawTimestamp: number;
  lastDepositTimestamp: number;
  totalHarvested: number;
  totalCompounded: number;
  totalMoves: number;
  totalWithdrawn: number;
  totalDeposited: number;
  dailyCapitalUsed: number;
  dailyCapitalWindowStart: number;
  errorCount: number;
  errorWindowStart: number;
  circuitBreakerUntil: number;
  lastError: string | null;
  lastTxHash: string | null;
  lastAction: string;
}

const EMPTY_STATE: State = {
  version: "3.0.0",
  lastRunTimestamp: 0,
  lastHarvestTimestamp: 0,
  lastCompoundTimestamp: 0,
  lastMoveTimestamp: 0,
  lastWithdrawTimestamp: 0,
  lastDepositTimestamp: 0,
  totalHarvested: 0,
  totalCompounded: 0,
  totalMoves: 0,
  totalWithdrawn: 0,
  totalDeposited: 0,
  dailyCapitalUsed: 0,
  dailyCapitalWindowStart: 0,
  errorCount: 0,
  errorWindowStart: 0,
  circuitBreakerUntil: 0,
  lastError: null,
  lastTxHash: null,
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
    // Rotate if too large
    if (existsSync(EVENTS_FILE)) {
      const size = readFileSync(EVENTS_FILE).length;
      if (size > MAX_EVENTS_BYTES) writeFileSync(EVENTS_FILE, ""); // reset
    }
    appendFileSync(EVENTS_FILE, entry);
  } catch { /* non-fatal */ }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DAILY CAPITAL GUARD
// ═══════════════════════════════════════════════════════════════════════════════
function checkDailyCap(state: State, needed: number): { ok: boolean; remaining?: number; used?: number } {
  const now = Date.now();
  const inWindow = (now - state.dailyCapitalWindowStart) < 86_400_000;
  const used = inWindow ? state.dailyCapitalUsed : 0;
  const remaining = MAX_DAILY_CAPITAL - used;
  if (needed > remaining) return { ok: false, remaining, used };
  return { ok: true, remaining, used };
}

function consumeDailyCap(state: State, amount: number): State {
  const now = Date.now();
  const inWindow = (now - state.dailyCapitalWindowStart) < 86_400_000;
  return {
    ...state,
    dailyCapitalUsed: (inWindow ? state.dailyCapitalUsed : 0) + amount,
    dailyCapitalWindowStart: inWindow ? state.dailyCapitalWindowStart : now,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// OUTPUT
// ═══════════════════════════════════════════════════════════════════════════════
function out(status: "success" | "error" | "blocked", action: string, data: object, error: string | null = null) {
  console.log(JSON.stringify({ status, action, data, error }, null, 2));
}

function err(msg: string) {
  console.log(JSON.stringify({ error: msg }));
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP
// ═══════════════════════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════════════════════
// WALLET
// ═══════════════════════════════════════════════════════════════════════════════
function loadWallet(): { ok: boolean; address?: string; error?: string } {
  const env = process.env.STACKS_ADDRESS ?? process.env.STX_ADDRESS ?? process.env.WALLET_ADDRESS;
  if (env && /^SP[A-Z0-9]{1,40}$/.test(env)) return { ok: true, address: env };

  const candidates = [
    join(homedir(), ".aibtc", "wallets.json"),
    join(homedir(), ".aibtc", "wallet.json"),
    join(homedir(), ".aibtc-wallet", "wallet.json"),
    join(homedir(), ".stacks-wallet", "wallet.json"),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, "utf-8"));
      const candidates2 = [
        raw.stacksAddress, raw.stacks_address, raw.address,
        Array.isArray(raw) && raw[0]?.stacksAddress,
        raw.wallets?.[0]?.stacksAddress,
      ];
      for (const addr of candidates2) {
        if (typeof addr === "string" && /^SP[A-Z0-9]{1,40}$/.test(addr)) return { ok: true, address: addr };
      }
    } catch { /* try next */ }
  }
  return { ok: false, error: "Wallet not found. Set STACKS_ADDRESS env or configure via AIBTC MCP wallet." };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHAIN READS
// ═══════════════════════════════════════════════════════════════════════════════
async function getStxBalance(addr: string) {
  const r = await fetchJson(`${HIRO_API}/extended/v1/address/${addr}/stx`);
  if (!r.ok) return { ok: false as const, error: r.error };
  const stx = parseInt(r.data?.balance ?? "0", 10) / 1_000_000;
  return { ok: true as const, stx };
}

async function getHodlmmPosition(addr: string) {
  const r = await fetchJson(`${BITFLOW_API}/hodlmm/positions?address=${addr}`);
  if (!r.ok) return { ok: false as const, error: r.error };

  const list: any[] = Array.isArray(r.data) ? r.data : (r.data?.positions ?? []);
  if (!list.length) return { ok: false as const, error: "No HODLMM positions found" };

  const pos = list.reduce((best: any, p: any) => {
    const v  = parseFloat(p.positionValue ?? p.position_value ?? p.tvl ?? "0");
    const bv = parseFloat(best?.positionValue ?? best?.position_value ?? best?.tvl ?? "0");
    return v > bv ? p : best;
  }, list[0]);

  const fees         = parseFloat(pos.unclaimedFees ?? pos.unclaimed_fees ?? pos.fees ?? "0");
  const positionValue= parseFloat(pos.positionValue ?? pos.position_value ?? pos.tvl ?? "0");
  const binMin       = parseFloat(pos.binRangeMin ?? pos.bin_range_min ?? pos.lowerBin ?? "0");
  const binMax       = parseFloat(pos.binRangeMax ?? pos.bin_range_max ?? pos.upperBin ?? "0");
  const currentBin   = parseFloat(pos.currentBin ?? pos.current_bin ?? pos.activeBin ?? "0");
  const poolApy      = parseFloat(pos.poolApy ?? pos.pool_apy ?? pos.apy ?? pos.feeApr ?? "0");
  const poolContract = pos.poolContract ?? pos.pool_contract ?? HODLMM_DEFAULT;
  const dlpShares    = parseFloat(pos.dlpShares ?? pos.dlp_shares ?? pos.shares ?? "0");

  let drift = 0;
  if (binMax > binMin && currentBin > 0) {
    const center = (binMin + binMax) / 2;
    const range  = binMax - binMin;
    drift = range > 0 ? Math.abs((currentBin - center) / range) * 100 : 0;
  }

  return { ok: true as const, fees, positionValue, binMin, binMax, currentBin, drift, poolApy, poolContract, dlpShares };
}

async function getZestApy() {
  const r1 = await fetchJson(`${ZEST_API}/pools`);
  if (r1.ok) {
    const pools: any[] = Array.isArray(r1.data) ? r1.data : (r1.data?.pools ?? []);
    const stx = pools.find((p: any) => (p.asset ?? p.symbol ?? "").toUpperCase() === "STX");
    if (stx) {
      const apy = parseFloat(stx.supplyApy ?? stx.supply_apy ?? stx.apy ?? "0");
      return { ok: true as const, apy };
    }
  }
  // Fallback: Hiro read-only call
  const r2 = await fetchJson(`${HIRO_API}/v2/contracts/call-read/${ZEST_MARKET.split(".")[0]}/${ZEST_MARKET.split(".")[1]}/get-supply-apy`);
  if (r2.ok) {
    const raw = r2.data?.result ?? r2.data?.value ?? "u0";
    const apy = parseInt(raw.replace(/[^0-9]/g, ""), 10) / 100;
    return { ok: true as const, apy };
  }
  return { ok: false as const, error: "Zest APY unavailable from both primary and fallback sources" };
}

// ═══════════════════════════════════════════════════════════════════════════════
// GUARDS
// ═══════════════════════════════════════════════════════════════════════════════
function cooldownOk(ts: number): { ok: boolean; hoursLeft?: number; next?: string } {
  const elapsed = (Date.now() - ts) / 3_600_000;
  if (elapsed < COOLDOWN_HOURS) {
    const left = COOLDOWN_HOURS - elapsed;
    return { ok: false, hoursLeft: Math.ceil(left * 100) / 100, next: new Date(ts + COOLDOWN_HOURS * 3_600_000).toISOString() };
  }
  return { ok: true };
}

function circuitOk(s: State): { ok: boolean; until?: string } {
  if (s.circuitBreakerUntil > Date.now()) return { ok: false, until: new Date(s.circuitBreakerUntil).toISOString() };
  return { ok: true };
}

function tripError(s: State, msg: string): State {
  const now = Date.now();
  const inWin = (now - s.errorWindowStart) < 86_400_000;
  const count = inWin ? s.errorCount + 1 : 1;
  return {
    ...s,
    lastError: msg,
    errorCount: count,
    errorWindowStart: inWin ? s.errorWindowStart : now,
    circuitBreakerUntil: count >= MAX_ERRORS_24H ? now + CIRCUIT_BREAKER_HRS * 3_600_000 : s.circuitBreakerUntil,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONTRACT CALL BUILDER
// ═══════════════════════════════════════════════════════════════════════════════
function contractCall(contract: string, fn: string, args: string[], postConditions: any[] = []) {
  const [addr, name] = contract.split(".");
  return {
    contract, contractAddress: addr, contractName: name,
    function: fn, args, postConditions,
    explorerUrlTemplate: `${EXPLORER_BASE}/{txid}?chain=mainnet`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// GAS PRE-FLIGHT
// ═══════════════════════════════════════════════════════════════════════════════
async function gasOk(addr: string): Promise<{ ok: boolean; stx?: number; required?: number; error?: string }> {
  const b = await getStxBalance(addr);
  if (!b.ok) return { ok: false, error: b.error };
  const required = MIN_STX_GAS + GAS_BUFFER_STX;
  if (b.stx < required) return { ok: false, stx: b.stx, required };
  return { ok: true, stx: b.stx, required };
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMMANDS
// ═══════════════════════════════════════════════════════════════════════════════

// ── doctor ────────────────────────────────────────────────────────────────────
async function cmdDoctor() {
  const checks: Record<string, { pass: boolean; detail: string; latencyMs?: number }> = {};
  const wallet = loadWallet();
  checks.wallet = { pass: wallet.ok, detail: wallet.ok ? wallet.address!.slice(0, 10) + "…" : wallet.error! };

  let stxBal = 0;
  if (wallet.ok) {
    const b = await getStxBalance(wallet.address!);
    stxBal = b.ok ? b.stx : 0;
    checks.stxBalance = {
      pass: b.ok && stxBal >= MIN_STX_GAS + GAS_BUFFER_STX,
      detail: b.ok ? `${stxBal.toFixed(4)} STX (min ${MIN_STX_GAS + GAS_BUFFER_STX} STX required)` : b.error!,
    };
  } else {
    checks.stxBalance = { pass: false, detail: "skipped — no wallet" };
  }

  const hiro = await fetchJson(`${HIRO_API}/extended/v1/info/network_block_times`);
  checks.hiroApi = { pass: hiro.ok, detail: hiro.ok ? `reachable (${hiro.ms}ms)` : hiro.error!, latencyMs: hiro.ms };

  const bff = await fetchJson(`${BITFLOW_API}/health`);
  const bffUp = bff.ok || (bff.error?.includes("404") ?? false);
  checks.bitflowApi = { pass: bffUp, detail: bffUp ? `reachable (${bff.ms}ms)` : bff.error!, latencyMs: bff.ms };

  const zest = await getZestApy();
  checks.zestApi = { pass: zest.ok, detail: zest.ok ? `STX supply APY: ${zest.apy?.toFixed(2)}%` : zest.error! };

  if (wallet.ok) {
    const pos = await getHodlmmPosition(wallet.address!);
    checks.hodlmmPosition = {
      pass: pos.ok,
      detail: pos.ok
        ? `fees: ${pos.fees.toFixed(4)}, drift: ${pos.drift.toFixed(1)}%, posValue: ${pos.positionValue.toFixed(2)}, poolAPY: ${pos.poolApy.toFixed(2)}%`
        : pos.error!,
    };
  } else {
    checks.hodlmmPosition = { pass: false, detail: "skipped — no wallet" };
  }

  const state = loadState();
  const cb = circuitOk(state);
  const cd = cooldownOk(state.lastRunTimestamp);

  const now = Date.now();
  const inWin = (now - state.dailyCapitalWindowStart) < 86_400_000;
  const dailyUsed = inWin ? state.dailyCapitalUsed : 0;

  checks.circuitBreaker = { pass: cb.ok, detail: cb.ok ? "clear" : `ACTIVE — locked until ${cb.until}` };
  checks.cooldown = { pass: cd.ok, detail: cd.ok ? "ready" : `active — ${cd.hoursLeft}h remaining` };
  checks.dailyCap = {
    pass: dailyUsed < MAX_DAILY_CAPITAL,
    detail: `${dailyUsed.toFixed(2)} / ${MAX_DAILY_CAPITAL} tokens used today`,
  };

  const allPass = Object.values(checks).every(c => c.pass);
  out(allPass ? "success" : "blocked", "doctor", {
    ready: allPass,
    checks,
    safetyConstants: {
      MAX_HARVEST_PER_OP, MAX_COMPOUND_PER_OP, MAX_DAILY_CAPITAL,
      MIN_STX_GAS, GAS_BUFFER_STX, COOLDOWN_HOURS,
      DEFAULT_DRIFT_PCT, DEFAULT_APY_SPREAD, FULL_EXIT_APY_SPREAD,
      MAX_ERRORS_24H, CIRCUIT_BREAKER_HRS,
    },
    stateFile: STATE_FILE,
    eventsFile: EVENTS_FILE,
    summary: allPass ? "All checks passed — ready for write operations" :
      `${Object.values(checks).filter(c => !c.pass).length} check(s) failed`,
  }, allPass ? null : "Pre-flight checks failed");
}

// ── status ────────────────────────────────────────────────────────────────────
async function cmdStatus() {
  const wallet = loadWallet();
  if (!wallet.ok) return out("error", "status", {}, wallet.error!);

  const [balR, posR, zestR] = await Promise.all([
    getStxBalance(wallet.address!),
    getHodlmmPosition(wallet.address!),
    getZestApy(),
  ]);
  const state = loadState();
  const now = Date.now();
  const inWin = (now - state.dailyCapitalWindowStart) < 86_400_000;

  let apyComparison: object = { available: false };
  let positionRecommendation = "insufficient data";

  if (posR.ok && zestR.ok) {
    const spread = Math.abs(posR.poolApy - zestR.apy);
    const winner = posR.poolApy >= zestR.apy ? "hodlmm" : "zest";
    const fullExitRecommended = spread >= FULL_EXIT_APY_SPREAD && winner === "zest";
    const switchRecommended   = spread >= DEFAULT_APY_SPREAD && winner === "zest";

    positionRecommendation = fullExitRecommended
      ? `FULL EXIT recommended — Zest outperforms HODLMM by ${spread.toFixed(2)}% (>${FULL_EXIT_APY_SPREAD}% threshold). Withdraw entire position to Zest.`
      : switchRecommended
        ? `Compound fees to Zest — ${spread.toFixed(2)}% spread favours Zest.`
        : winner === "hodlmm"
          ? `Stay in HODLMM — outperforms Zest by ${spread.toFixed(2)}%.`
          : `Spread ${spread.toFixed(2)}% too small — hold current allocation.`;

    apyComparison = {
      available: true,
      hodlmmPoolApy: posR.poolApy.toFixed(2) + "%",
      zestSupplyApy: zestR.apy.toFixed(2) + "%",
      spread: spread.toFixed(2) + "%",
      winner,
      fullExitRecommended,
      feeRoutingRecommended: switchRecommended,
      positionRecommendation,
    };
  }

  out("success", "status", {
    wallet: wallet.address,
    stxBalance: balR.ok ? `${balR.stx.toFixed(4)} STX` : "unavailable",
    hodlmmPosition: posR.ok ? {
      fees: posR.fees.toFixed(4),
      positionValue: posR.positionValue.toFixed(4),
      dlpShares: posR.dlpShares.toFixed(4),
      binRange: `${posR.binMin} – ${posR.binMax}`,
      currentBin: posR.currentBin,
      drift: `${posR.drift.toFixed(1)}%`,
      poolApy: `${posR.poolApy.toFixed(2)}%`,
      poolContract: posR.poolContract,
    } : { error: posR.error },
    zest: zestR.ok ? { supplyApy: `${zestR.apy.toFixed(2)}%` } : { error: zestR.error },
    apyComparison,
    dailyCapital: {
      used: (inWin ? state.dailyCapitalUsed : 0).toFixed(2),
      limit: MAX_DAILY_CAPITAL,
      remaining: (MAX_DAILY_CAPITAL - (inWin ? state.dailyCapitalUsed : 0)).toFixed(2),
    },
    state: {
      cooldown: cooldownOk(state.lastRunTimestamp).ok ? "ready" : `active — ${cooldownOk(state.lastRunTimestamp).hoursLeft}h left`,
      circuitBreaker: circuitOk(state).ok ? "clear" : `ACTIVE until ${circuitOk(state).until}`,
      totalHarvested: state.totalHarvested.toFixed(4),
      totalCompounded: state.totalCompounded.toFixed(4),
      totalMoves: state.totalMoves,
      totalWithdrawn: state.totalWithdrawn.toFixed(4),
      totalDeposited: state.totalDeposited.toFixed(4),
      lastAction: state.lastAction,
    },
  });
}

// ── harvest ───────────────────────────────────────────────────────────────────
async function cmdHarvest(opts: { confirm?: string; dryRun?: boolean; minAmount?: number; maxAmount?: number }) {
  const ACTION = "harvest";
  if (!opts.dryRun && opts.confirm !== "HARVEST")
    return out("blocked", ACTION, { required: "--confirm=HARVEST" }, "Confirmation required");

  const wallet = loadWallet();
  if (!wallet.ok) return out("error", ACTION, {}, wallet.error!);

  const state = loadState();
  const cb = circuitOk(state); if (!cb.ok) return out("blocked", ACTION, { lockedUntil: cb.until }, "Circuit breaker active");
  const cd = cooldownOk(state.lastHarvestTimestamp); if (!cd.ok) return out("blocked", ACTION, { hoursLeft: cd.hoursLeft }, `Cooldown — ${cd.hoursLeft}h remaining`);

  const gas = await gasOk(wallet.address!);
  if (!gas.ok) return out("blocked", ACTION, { stx: gas.stx, required: gas.required }, "Insufficient STX for gas");

  const pos = await getHodlmmPosition(wallet.address!);
  if (!pos.ok) return out("error", ACTION, {}, pos.error!);

  const minAmt = opts.minAmount ?? MIN_FEE_THRESHOLD;
  if (pos.fees < minAmt) return out("blocked", ACTION, { fees: pos.fees, minAmount: minAmt }, "Fees below minimum threshold");

  const amount = Math.min(pos.fees, opts.maxAmount ?? MAX_HARVEST_PER_OP, MAX_HARVEST_PER_OP);
  const capped = amount < pos.fees;
  const dc = checkDailyCap(state, amount);
  if (!dc.ok) return out("blocked", ACTION, { needed: amount, remaining: dc.remaining }, `Daily capital cap reached (${MAX_DAILY_CAPITAL} tokens/day)`);

  if (opts.dryRun) return out("success", ACTION, {
    dryRun: true,
    projected: { amount: amount.toFixed(4), capped, availableFees: pos.fees.toFixed(4), poolContract: pos.poolContract, confirmRequired: "--confirm=HARVEST" },
  });

  const call = contractCall(pos.poolContract, "claim-fees", [`u${Math.floor(amount * 1_000_000)}`]);
  const ns = consumeDailyCap({ ...state, lastHarvestTimestamp: Date.now(), totalHarvested: state.totalHarvested + amount, lastAction: ACTION, lastError: null }, amount);
  saveState(ns);
  logEvent("harvest", { amount, poolContract: pos.poolContract, dailyUsed: ns.dailyCapitalUsed });
  out("success", ACTION, { amount: amount.toFixed(4), capped, contractCall: call, totalHarvested: ns.totalHarvested.toFixed(4), note: "Submit contractCall via AIBTC MCP wallet" });
}

// ── compound ──────────────────────────────────────────────────────────────────
async function cmdCompound(opts: { confirm?: string; dryRun?: boolean; minAmount?: number; minApySpread?: number }) {
  const ACTION = "compound";
  if (!opts.dryRun && opts.confirm !== "COMPOUND")
    return out("blocked", ACTION, { required: "--confirm=COMPOUND" }, "Confirmation required");

  const wallet = loadWallet();
  if (!wallet.ok) return out("error", ACTION, {}, wallet.error!);

  const state = loadState();
  const cb = circuitOk(state); if (!cb.ok) return out("blocked", ACTION, { lockedUntil: cb.until }, "Circuit breaker active");
  const cd = cooldownOk(state.lastCompoundTimestamp); if (!cd.ok) return out("blocked", ACTION, { hoursLeft: cd.hoursLeft }, `Cooldown — ${cd.hoursLeft}h remaining`);
  const gas = await gasOk(wallet.address!); if (!gas.ok) return out("blocked", ACTION, { stx: gas.stx }, "Insufficient STX for gas");

  const [posR, zestR] = await Promise.all([getHodlmmPosition(wallet.address!), getZestApy()]);
  if (!zestR.ok) return out("error", ACTION, {}, zestR.error!);
  if (zestR.apy <= 0) return out("blocked", ACTION, { zestApy: zestR.apy }, "Zest APY non-positive — refusing");
  if (!posR.ok) return out("error", ACTION, {}, posR.error!);

  const minAmt = opts.minAmount ?? MIN_FEE_THRESHOLD;
  if (posR.fees < minAmt) return out("blocked", ACTION, { fees: posR.fees, minAmt }, "Fees below threshold");

  const spread = Math.abs(posR.poolApy - zestR.apy);
  const minSpread = opts.minApySpread ?? DEFAULT_APY_SPREAD;
  if (spread < minSpread) return out("blocked", ACTION, { spread: spread.toFixed(2), minSpread }, `APY spread ${spread.toFixed(2)}% < ${minSpread}% minimum`);

  const dest = zestR.apy > posR.poolApy ? "zest" : "hodlmm";
  const amount = Math.min(posR.fees, MAX_COMPOUND_PER_OP);
  const dc = checkDailyCap(state, amount);
  if (!dc.ok) return out("blocked", ACTION, { needed: amount, remaining: dc.remaining }, "Daily capital cap reached");

  const call = dest === "zest"
    ? contractCall(ZEST_MARKET, "supply-asset", [`u${Math.floor(amount * 1_000_000)}`, `'${wallet.address}`])
    : contractCall(HODLMM_ROUTER, "add-liquidity", [`u${Math.floor(amount * 1_000_000)}`, `u0`]);

  const estGain = ((amount * Math.max(posR.poolApy, zestR.apy)) / 100).toFixed(4);

  if (opts.dryRun) return out("success", ACTION, {
    dryRun: true,
    projected: { destination: dest, amount: amount.toFixed(4), hodlmmApy: `${posR.poolApy.toFixed(2)}%`, zestApy: `${zestR.apy.toFixed(2)}%`, spread: `${spread.toFixed(2)}%`, estimatedAnnualGain: `${estGain} tokens/yr`, confirmRequired: "--confirm=COMPOUND" },
  });

  const ns = consumeDailyCap({ ...state, lastCompoundTimestamp: Date.now(), totalCompounded: state.totalCompounded + amount, lastAction: ACTION, lastError: null }, amount);
  saveState(ns);
  logEvent("compound", { amount, destination: dest, spread, dailyUsed: ns.dailyCapitalUsed });
  out("success", ACTION, { destination: dest, amount: amount.toFixed(4), apyComparison: { hodlmmApy: `${posR.poolApy.toFixed(2)}%`, zestApy: `${zestR.apy.toFixed(2)}%`, spread: `${spread.toFixed(2)}%`, winner: dest }, estimatedAnnualGain: `${estGain} tokens/yr`, contractCall: call, totalCompounded: ns.totalCompounded.toFixed(4), note: "Submit contractCall via AIBTC MCP wallet" });
}

// ── move-liquidity ────────────────────────────────────────────────────────────
async function cmdMoveLiquidity(opts: { confirm?: string; dryRun?: boolean; driftThreshold?: number; pool?: string }) {
  const ACTION = "move-liquidity";
  if (!opts.dryRun && opts.confirm !== "MOVE")
    return out("blocked", ACTION, { required: "--confirm=MOVE" }, "Confirmation required");

  const wallet = loadWallet();
  if (!wallet.ok) return out("error", ACTION, {}, wallet.error!);

  const state = loadState();
  const cb = circuitOk(state); if (!cb.ok) return out("blocked", ACTION, { lockedUntil: cb.until }, "Circuit breaker active");
  const cd = cooldownOk(state.lastMoveTimestamp); if (!cd.ok) return out("blocked", ACTION, { hoursLeft: cd.hoursLeft }, `Cooldown — ${cd.hoursLeft}h remaining`);
  const gas = await gasOk(wallet.address!); if (!gas.ok) return out("blocked", ACTION, { stx: gas.stx }, "Insufficient STX for gas");

  const pos = await getHodlmmPosition(wallet.address!);
  if (!pos.ok) return out("error", ACTION, {}, pos.error!);

  const threshold = opts.driftThreshold ?? DEFAULT_DRIFT_PCT;
  if (pos.drift < threshold) return out("blocked", ACTION, { drift: `${pos.drift.toFixed(1)}%`, threshold: `${threshold}%`, binRange: `${pos.binMin}–${pos.binMax}`, currentBin: pos.currentBin }, `Bins in range — drift ${pos.drift.toFixed(1)}% < ${threshold}% threshold`);

  const pool = opts.pool ?? pos.poolContract;
  const valMicro = Math.floor(pos.positionValue * 1_000_000);
  const step1 = contractCall(pool, "remove-liquidity", [`u${valMicro}`, `u0`, `u0`]);
  const step2 = contractCall(HODLMM_ROUTER, "move-liquidity-to-active-bins", [`u${valMicro}`, `u${threshold}`]);

  if (opts.dryRun) return out("success", ACTION, {
    dryRun: true,
    projected: { drift: `${pos.drift.toFixed(1)}%`, threshold: `${threshold}%`, positionValue: pos.positionValue.toFixed(4), binRange: `${pos.binMin}–${pos.binMax}`, currentBin: pos.currentBin, steps: 2, confirmRequired: "--confirm=MOVE" },
  });

  const ns = { ...state, lastMoveTimestamp: Date.now(), totalMoves: state.totalMoves + 1, lastAction: ACTION, lastError: null };
  saveState(ns);
  logEvent("move-liquidity", { drift: pos.drift, threshold, positionValue: pos.positionValue });
  out("success", ACTION, { drift: `${pos.drift.toFixed(1)}%`, threshold: `${threshold}%`, step1ContractCall: step1, step2ContractCall: step2, totalMoves: ns.totalMoves, note: "Execute step1 first, wait for confirmation, then execute step2 via AIBTC MCP wallet" });
}

// ── withdraw ──────────────────────────────────────────────────────────────────
async function cmdWithdraw(opts: { confirm?: string; dryRun?: boolean; destination?: string; pool?: string }) {
  const ACTION = "withdraw";
  if (!opts.dryRun && opts.confirm !== "WITHDRAW")
    return out("blocked", ACTION, { required: "--confirm=WITHDRAW" }, "Confirmation required: --confirm=WITHDRAW");

  const wallet = loadWallet();
  if (!wallet.ok) return out("error", ACTION, {}, wallet.error!);

  const state = loadState();
  const cb = circuitOk(state); if (!cb.ok) return out("blocked", ACTION, { lockedUntil: cb.until }, "Circuit breaker active");
  const cd = cooldownOk(state.lastWithdrawTimestamp); if (!cd.ok) return out("blocked", ACTION, { hoursLeft: cd.hoursLeft }, `Cooldown — ${cd.hoursLeft}h remaining`);
  const gas = await gasOk(wallet.address!); if (!gas.ok) return out("blocked", ACTION, { stx: gas.stx }, "Insufficient STX for gas");

  const [posR, zestR] = await Promise.all([getHodlmmPosition(wallet.address!), getZestApy()]);
  if (!posR.ok) return out("error", ACTION, {}, posR.error!);

  // Validate destination
  const dest = opts.destination ?? "hold";
  if (!["hold", "zest"].includes(dest)) return out("blocked", ACTION, { destination: dest }, "destination must be 'hold' or 'zest'");
  if (dest === "zest" && !zestR.ok) return out("error", ACTION, {}, `Zest APY unavailable: ${zestR.error}`);
  if (dest === "zest" && (zestR.apy ?? 0) <= 0) return out("blocked", ACTION, { zestApy: zestR.apy }, "Zest APY non-positive — refusing deposit to Zest");

  const dc = checkDailyCap(state, posR.positionValue);
  if (!dc.ok) return out("blocked", ACTION, { needed: posR.positionValue.toFixed(2), remaining: dc.remaining?.toFixed(2) }, "Daily capital cap reached");

  const pool = opts.pool ?? posR.poolContract;
  const valMicro = Math.floor(posR.positionValue * 1_000_000);

  // Step 1: Remove all liquidity from HODLMM
  const removeCall = contractCall(pool, "remove-liquidity", [`u${valMicro}`, `u0`, `u0`]);

  // Step 2 (optional): Supply to Zest
  const supplyCall = dest === "zest"
    ? contractCall(ZEST_MARKET, "supply-asset", [`u${valMicro}`, `'${wallet.address}`])
    : null;

  const spread = posR.ok && zestR.ok ? Math.abs(posR.poolApy - (zestR.apy ?? 0)) : null;

  if (opts.dryRun) return out("success", ACTION, {
    dryRun: true,
    projected: {
      positionValue: posR.positionValue.toFixed(4),
      dlpShares: posR.dlpShares.toFixed(4),
      destination: dest,
      hodlmmApy: `${posR.poolApy.toFixed(2)}%`,
      zestApy: zestR.ok ? `${zestR.apy.toFixed(2)}%` : "unavailable",
      spread: spread != null ? `${spread.toFixed(2)}%` : "n/a",
      steps: dest === "zest" ? 2 : 1,
      step1: "remove-liquidity (all DLP shares)",
      step2: dest === "zest" ? "supply-asset to Zest" : "hold in wallet",
      confirmRequired: "--confirm=WITHDRAW",
    },
  });

  const ns = consumeDailyCap({
    ...state,
    lastWithdrawTimestamp: Date.now(),
    totalWithdrawn: state.totalWithdrawn + posR.positionValue,
    lastAction: ACTION, lastError: null,
  }, posR.positionValue);
  saveState(ns);
  logEvent("withdraw", { positionValue: posR.positionValue, destination: dest, poolApy: posR.poolApy, zestApy: zestR.ok ? zestR.apy : null });

  out("success", ACTION, {
    positionValue: posR.positionValue.toFixed(4),
    destination: dest,
    step1ContractCall: removeCall,
    ...(supplyCall ? { step2ContractCall: supplyCall } : { step2: "Tokens held in wallet — run deposit when HODLMM APY recovers" }),
    totalWithdrawn: ns.totalWithdrawn.toFixed(4),
    note: dest === "zest"
      ? "Execute step1 first, wait for confirmation, then step2 via AIBTC MCP wallet"
      : "Execute step1 via AIBTC MCP wallet. Run deposit to re-enter HODLMM when APY recovers.",
  });
}

// ── deposit ───────────────────────────────────────────────────────────────────
async function cmdDeposit(opts: { confirm?: string; dryRun?: boolean; amount?: number; pool?: string; source?: string }) {
  const ACTION = "deposit";
  if (!opts.dryRun && opts.confirm !== "DEPOSIT")
    return out("blocked", ACTION, { required: "--confirm=DEPOSIT" }, "Confirmation required: --confirm=DEPOSIT");

  const wallet = loadWallet();
  if (!wallet.ok) return out("error", ACTION, {}, wallet.error!);

  const state = loadState();
  const cb = circuitOk(state); if (!cb.ok) return out("blocked", ACTION, { lockedUntil: cb.until }, "Circuit breaker active");
  const cd = cooldownOk(state.lastDepositTimestamp); if (!cd.ok) return out("blocked", ACTION, { hoursLeft: cd.hoursLeft }, `Cooldown — ${cd.hoursLeft}h remaining`);
  const gas = await gasOk(wallet.address!); if (!gas.ok) return out("blocked", ACTION, { stx: gas.stx }, "Insufficient STX for gas");

  const [posR, zestR] = await Promise.all([getHodlmmPosition(wallet.address!), getZestApy()]);

  const source = opts.source ?? "wallet";
  if (!["wallet", "zest"].includes(source)) return out("blocked", ACTION, { source }, "source must be 'wallet' or 'zest'");

  // Determine deposit amount
  const depositAmount = opts.amount ?? (gas.stx! - MIN_STX_GAS - GAS_BUFFER_STX);
  if (depositAmount <= 0) return out("blocked", ACTION, { depositAmount }, "No funds available to deposit");

  const dc = checkDailyCap(state, depositAmount);
  if (!dc.ok) return out("blocked", ACTION, { needed: depositAmount.toFixed(2), remaining: dc.remaining?.toFixed(2) }, "Daily capital cap reached");

  const pool = opts.pool ?? (posR.ok ? posR.poolContract : HODLMM_DEFAULT);
  const amtMicro = Math.floor(depositAmount * 1_000_000);

  // If source is Zest, first withdraw from Zest reserve
  const withdrawZestCall = source === "zest"
    ? contractCall(ZEST_RESERVE, "withdraw-asset", [`u${amtMicro}`, `'${wallet.address}`])
    : null;

  // Then add liquidity to HODLMM
  const addLiqCall = contractCall(HODLMM_ROUTER, "add-liquidity", [`u${amtMicro}`, `u0`]);

  const spread = posR.ok && zestR.ok ? Math.abs(posR.poolApy - zestR.apy) : null;

  if (opts.dryRun) return out("success", ACTION, {
    dryRun: true,
    projected: {
      depositAmount: depositAmount.toFixed(4),
      source,
      pool,
      hodlmmApy: posR.ok ? `${posR.poolApy.toFixed(2)}%` : "unavailable",
      zestApy: zestR.ok ? `${zestR.apy.toFixed(2)}%` : "unavailable",
      spread: spread != null ? `${spread.toFixed(2)}%` : "n/a",
      steps: source === "zest" ? 2 : 1,
      confirmRequired: "--confirm=DEPOSIT",
    },
  });

  const ns = consumeDailyCap({
    ...state,
    lastDepositTimestamp: Date.now(),
    totalDeposited: state.totalDeposited + depositAmount,
    lastAction: ACTION, lastError: null,
  }, depositAmount);
  saveState(ns);
  logEvent("deposit", { depositAmount, source, pool, poolApy: posR.ok ? posR.poolApy : null });

  out("success", ACTION, {
    depositAmount: depositAmount.toFixed(4),
    source,
    ...(withdrawZestCall ? { step1ContractCall: withdrawZestCall, step2ContractCall: addLiqCall } : { step1ContractCall: addLiqCall }),
    totalDeposited: ns.totalDeposited.toFixed(4),
    note: source === "zest"
      ? "Execute step1 (Zest withdrawal) first, then step2 (add liquidity) via AIBTC MCP wallet"
      : "Execute step1 via AIBTC MCP wallet",
  });
}

// ── run (full autonomous loop) ────────────────────────────────────────────────
async function cmdRun(opts: { confirm?: string; dryRun?: boolean; driftThreshold?: number; minApySpread?: number; minAmount?: number }) {
  const ACTION = "run";
  if (!opts.dryRun && opts.confirm !== "RUN")
    return out("blocked", ACTION, { required: "--confirm=RUN", dryRunAvailable: true }, "Confirmation required: --confirm=RUN");

  const wallet = loadWallet();
  if (!wallet.ok) return out("error", ACTION, {}, wallet.error!);

  const state = loadState();
  const cb = circuitOk(state); if (!cb.ok) return out("blocked", ACTION, { lockedUntil: cb.until }, "Circuit breaker active");
  const cd = cooldownOk(state.lastRunTimestamp); if (!cd.ok) return out("blocked", ACTION, { hoursLeft: cd.hoursLeft }, `Cooldown — ${cd.hoursLeft}h remaining`);
  const gas = await gasOk(wallet.address!); if (!gas.ok) return out("blocked", ACTION, { stx: gas.stx }, "Insufficient STX for gas");

  const [posR, zestR] = await Promise.all([getHodlmmPosition(wallet.address!), getZestApy()]);
  if (!posR.ok) return out("error", ACTION, {}, `HODLMM: ${posR.error}`);
  if (!zestR.ok) return out("error", ACTION, {}, `Zest APY: ${zestR.error}`);
  if (zestR.apy <= 0) return out("blocked", ACTION, { zestApy: zestR.apy }, "Zest APY non-positive");

  const drift       = posR.drift;
  const fees        = posR.fees;
  const hodlmmApy   = posR.poolApy;
  const zestApy     = zestR.apy;
  const spread      = Math.abs(hodlmmApy - zestApy);
  const driftThr    = opts.driftThreshold ?? DEFAULT_DRIFT_PCT;
  const spreadThr   = opts.minApySpread ?? DEFAULT_APY_SPREAD;
  const minAmt      = opts.minAmount ?? MIN_FEE_THRESHOLD;

  const steps: object[] = [];
  let capitalMoved = 0;

  // Step: Check full-position exit (Zest >> HODLMM by FULL_EXIT_APY_SPREAD)
  const fullExitRecommended = zestApy > hodlmmApy && spread >= FULL_EXIT_APY_SPREAD;
  if (fullExitRecommended) {
    const dc = checkDailyCap(state, posR.positionValue);
    if (dc.ok) {
      const valMicro = Math.floor(posR.positionValue * 1_000_000);
      steps.push({
        step: steps.length + 1,
        action: "withdraw-to-zest",
        reason: `Zest (${zestApy.toFixed(2)}%) outperforms HODLMM (${hodlmmApy.toFixed(2)}%) by ${spread.toFixed(2)}% — exceeds full-exit threshold (${FULL_EXIT_APY_SPREAD}%)`,
        positionValue: posR.positionValue.toFixed(4),
        step1ContractCall: contractCall(posR.poolContract, "remove-liquidity", [`u${valMicro}`, `u0`, `u0`]),
        step2ContractCall: contractCall(ZEST_MARKET, "supply-asset", [`u${valMicro}`, `'${wallet.address}`]),
        estimatedAnnualGain: `${((posR.positionValue * (zestApy - hodlmmApy)) / 100).toFixed(4)} tokens/yr gained`,
      });
      capitalMoved += posR.positionValue;
    } else {
      steps.push({ step: steps.length + 1, action: "withdraw-to-zest-skipped", reason: `Daily cap reached (${dc.remaining?.toFixed(2)} remaining)` });
    }
  }

  // Step: Move-liquidity if drifted and NOT doing full exit
  if (!fullExitRecommended && drift >= driftThr) {
    const valMicro = Math.floor(posR.positionValue * 1_000_000);
    steps.push({
      step: steps.length + 1,
      action: "move-liquidity",
      reason: `Drift ${drift.toFixed(1)}% ≥ ${driftThr}%`,
      step1ContractCall: contractCall(posR.poolContract, "remove-liquidity", [`u${valMicro}`, `u0`, `u0`]),
      step2ContractCall: contractCall(HODLMM_ROUTER, "move-liquidity-to-active-bins", [`u${valMicro}`, `u${driftThr}`]),
    });
  }

  // Step: Harvest fees
  if (!fullExitRecommended && fees >= minAmt) {
    const harvestAmt = Math.min(fees, MAX_HARVEST_PER_OP);
    const dc = checkDailyCap(state, capitalMoved + harvestAmt);
    if (dc.ok) {
      steps.push({
        step: steps.length + 1,
        action: "harvest",
        amount: harvestAmt.toFixed(4),
        contractCall: contractCall(posR.poolContract, "claim-fees", [`u${Math.floor(harvestAmt * 1_000_000)}`]),
      });
      capitalMoved += harvestAmt;

      // Step: Compound fees if spread justifies
      if (spread >= spreadThr) {
        const dest = zestApy > hodlmmApy ? "zest" : "hodlmm";
        const compoundAmt = Math.min(harvestAmt, MAX_COMPOUND_PER_OP);
        const dc2 = checkDailyCap(state, capitalMoved + compoundAmt - harvestAmt);
        if (dc2.ok) {
          const call = dest === "zest"
            ? contractCall(ZEST_MARKET, "supply-asset", [`u${Math.floor(compoundAmt * 1_000_000)}`, `'${wallet.address}`])
            : contractCall(HODLMM_ROUTER, "add-liquidity", [`u${Math.floor(compoundAmt * 1_000_000)}`, `u0`]);
          steps.push({
            step: steps.length + 1,
            action: "compound",
            destination: dest,
            amount: compoundAmt.toFixed(4),
            apyComparison: { hodlmmApy: `${hodlmmApy.toFixed(2)}%`, zestApy: `${zestApy.toFixed(2)}%`, spread: `${spread.toFixed(2)}%`, winner: dest },
            estimatedAnnualGain: `${((compoundAmt * Math.max(hodlmmApy, zestApy)) / 100).toFixed(4)} tokens/yr`,
            contractCall: call,
          });
        } else {
          steps.push({ step: steps.length + 1, action: "compound-skipped", reason: "Daily capital cap reached" });
        }
      } else {
        steps.push({ step: steps.length + 1, action: "compound-skipped", reason: `Spread ${spread.toFixed(2)}% < min ${spreadThr}%` });
      }
    } else {
      steps.push({ step: steps.length + 1, action: "harvest-skipped", reason: "Daily capital cap reached" });
    }
  }

  if (steps.length === 0) return out("blocked", ACTION, {
    drift: `${drift.toFixed(1)}%`,
    fees: fees.toFixed(4),
    hodlmmApy: `${hodlmmApy.toFixed(2)}%`,
    zestApy: `${zestApy.toFixed(2)}%`,
    spread: `${spread.toFixed(2)}%`,
  }, "No actions required — all thresholds within bounds");

  if (opts.dryRun) return out("success", ACTION, {
    dryRun: true,
    projected: {
      stepsPlanned: steps.length,
      fullExitRecommended,
      drift: `${drift.toFixed(1)}%`,
      fees: fees.toFixed(4),
      hodlmmApy: `${hodlmmApy.toFixed(2)}%`,
      zestApy: `${zestApy.toFixed(2)}%`,
      spread: `${spread.toFixed(2)}%`,
      capitalToMove: capitalMoved.toFixed(4),
      dailyCapRemaining: (MAX_DAILY_CAPITAL - (state.dailyCapitalUsed || 0) - capitalMoved).toFixed(2),
      steps,
      confirmRequired: "--confirm=RUN",
    },
  });

  const ns = consumeDailyCap({
    ...state,
    lastRunTimestamp: Date.now(),
    lastHarvestTimestamp: steps.some((s: any) => s.action === "harvest") ? Date.now() : state.lastHarvestTimestamp,
    lastCompoundTimestamp: steps.some((s: any) => s.action === "compound") ? Date.now() : state.lastCompoundTimestamp,
    lastMoveTimestamp: steps.some((s: any) => s.action === "move-liquidity") ? Date.now() : state.lastMoveTimestamp,
    lastWithdrawTimestamp: steps.some((s: any) => s.action === "withdraw-to-zest") ? Date.now() : state.lastWithdrawTimestamp,
    totalHarvested: state.totalHarvested + (steps.find((s: any) => s.action === "harvest") ? parseFloat((steps.find((s: any) => s.action === "harvest") as any).amount) : 0),
    totalCompounded: state.totalCompounded + (steps.find((s: any) => s.action === "compound") ? parseFloat((steps.find((s: any) => s.action === "compound") as any).amount) : 0),
    totalMoves: state.totalMoves + (steps.some((s: any) => s.action === "move-liquidity") ? 1 : 0),
    totalWithdrawn: state.totalWithdrawn + (steps.some((s: any) => s.action === "withdraw-to-zest") ? posR.positionValue : 0),
    lastAction: ACTION, lastError: null,
  }, capitalMoved);

  saveState(ns);
  logEvent("run", { stepsExecuted: steps.length, capitalMoved, fullExitRecommended, spread, drift });

  out("success", ACTION, {
    stepsExecuted: steps.length,
    steps,
    totals: {
      totalHarvested: ns.totalHarvested.toFixed(4),
      totalCompounded: ns.totalCompounded.toFixed(4),
      totalMoves: ns.totalMoves,
      totalWithdrawn: ns.totalWithdrawn.toFixed(4),
      dailyCapitalUsed: ns.dailyCapitalUsed.toFixed(2),
      dailyCapitalRemaining: (MAX_DAILY_CAPITAL - ns.dailyCapitalUsed).toFixed(2),
    },
    note: "Execute each step's contractCall in order via AIBTC MCP wallet. Wait for tx confirmation between steps.",
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════════════════════
const program = new Command();
program
  .name("hodlmm-zest-yield-optimizer")
  .description("Autonomous HODLMM fee harvester, bin rebalancer, and Zest yield router for Stacks mainnet")
  .version("3.0.0");

program.command("doctor").description("Full pre-flight health check — wallet, APIs, gas, daily cap, circuit breaker").action(() => cmdDoctor().catch(e => err(e.message)));
program.command("status").description("Live HODLMM position + Zest APY comparison + routing recommendation").action(() => cmdStatus().catch(e => err(e.message)));

program.command("harvest")
  .description("Claim accumulated HODLMM fees (--confirm=HARVEST)")
  .option("--confirm <token>").option("--dry-run").option("--min-amount <n>", "", parseFloat).option("--max-amount <n>", "", parseFloat)
  .action(o => cmdHarvest({ confirm: o.confirm, dryRun: o.dryRun, minAmount: o.minAmount, maxAmount: o.maxAmount }).catch(e => err(e.message)));

program.command("compound")
  .description("Route harvested fees to highest-APY venue: HODLMM or Zest (--confirm=COMPOUND)")
  .option("--confirm <token>").option("--dry-run").option("--min-amount <n>", "", parseFloat).option("--min-apy-spread <n>", "", parseFloat)
  .action(o => cmdCompound({ confirm: o.confirm, dryRun: o.dryRun, minAmount: o.minAmount, minApySpread: o.minApySpread }).catch(e => err(e.message)));

program.command("move-liquidity")
  .description("Rebalance drifted HODLMM bins to active price range (--confirm=MOVE)")
  .option("--confirm <token>").option("--dry-run").option("--drift-threshold <n>", "", parseFloat).option("--pool <address>")
  .action(o => cmdMoveLiquidity({ confirm: o.confirm, dryRun: o.dryRun, driftThreshold: o.driftThreshold, pool: o.pool }).catch(e => err(e.message)));

program.command("withdraw")
  .description("Exit full HODLMM position — hold or route to Zest (--confirm=WITHDRAW)")
  .option("--confirm <token>").option("--dry-run").option("--destination <dest>", "hold | zest (default: hold)").option("--pool <address>")
  .action(o => cmdWithdraw({ confirm: o.confirm, dryRun: o.dryRun, destination: o.destination, pool: o.pool }).catch(e => err(e.message)));

program.command("deposit")
  .description("Re-enter HODLMM from wallet or Zest (--confirm=DEPOSIT)")
  .option("--confirm <token>").option("--dry-run").option("--amount <n>", "", parseFloat).option("--pool <address>").option("--source <src>", "wallet | zest (default: wallet)")
  .action(o => cmdDeposit({ confirm: o.confirm, dryRun: o.dryRun, amount: o.amount, pool: o.pool, source: o.source }).catch(e => err(e.message)));

program.command("run")
  .description("Full autonomous loop: drift→rebalance→harvest→APY compare→compound/exit (--confirm=RUN)")
  .option("--confirm <token>").option("--dry-run").option("--drift-threshold <n>", "", parseFloat).option("--min-apy-spread <n>", "", parseFloat).option("--min-amount <n>", "", parseFloat)
  .action(o => cmdRun({ confirm: o.confirm, dryRun: o.dryRun, driftThreshold: o.driftThreshold, minApySpread: o.minApySpread, minAmount: o.minAmount }).catch(e => err(e.message)));

program.parse(process.argv);
