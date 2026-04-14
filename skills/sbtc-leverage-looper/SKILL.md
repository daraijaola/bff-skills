---
name: sbtc-leverage-looper
description: "The first leveraged sBTC position manager on Stacks — borrows STX from Zest Protocol, swaps to sBTC via Bitflow HODLMM, re-deposits to Zest, and loops to target leverage with autonomous health-factor monitoring and emergency unwind."
metadata:
  author: "daraijaola"
  author-agent: "Agentr"
  user-invocable: "false"
  arguments: "doctor | status | loop | unwind | run"
  entry: "sbtc-leverage-looper/sbtc-leverage-looper.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, requires-funds"
---

## What it does

The first skill on Stacks that lets an AI agent build and manage a **leveraged long sBTC position** using existing DeFi protocols.

The loop is simple and composable:

```
User supplies sBTC to Zest (collateral)
  → Agent borrows STX against collateral (Zest borrow)
  → Agent swaps STX → sBTC via Bitflow HODLMM (HODLMM bonus eligible)
  → Agent deposits received sBTC back to Zest (increases collateral)
  → Repeat to target leverage ratio
```

To deleverage (unwind):
```
Agent withdraws sBTC from Zest
  → Agent swaps sBTC → STX via Bitflow HODLMM
  → Agent repays STX debt to Zest
```

Every swap routes through the Bitflow HODLMM STX/sBTC pool. All positions are managed with health-factor monitoring and automatic unwind triggers.

## Why agents need it

Every existing skill manages a single position in a single protocol. This skill does something qualitatively different: it uses cross-protocol coordination (Zest + Bitflow) to build up leverage in a way that no existing Stacks skill has done. The agent does not just read and report — it makes the capital work harder.

For an agent that believes sBTC will appreciate:
- 1.5x leverage means a 10% sBTC price gain returns 15% (minus borrow cost)
- 2x leverage returns 20% on the same move
- Position closes cleanly via unwind with no manual intervention

## Safety notes

- **Writes to chain.** `loop`, `unwind`, and `run` each submit between 1 and 3 Stacks transactions. Always dry-run first.
- **Moves funds and takes on debt.** Each loop borrows STX from Zest and swaps it on Bitflow HODLMM. Losses are real and mainnet-only.
- **Mainnet only.** All contracts are Stacks mainnet. Do not use with testnet wallets.
- **Leverage amplifies losses.** A 2x leveraged position loses twice as fast as spot. HF can drop to liquidation if sBTC price falls sharply.
- **Liquidation risk.** If health factor drops below Zest's liquidation threshold, the position will be liquidated by the protocol. The auto-unwind trigger (HF 1.65) provides a buffer but does not guarantee liquidation prevention.
- **Confirmation tokens required.** `loop` requires `--confirm=LOOP`, `unwind` requires `--confirm=UNWIND`, `run` requires `--confirm=RUN`. No confirmation = no execution.
- **Daily STX cap.** No more than 20,000 STX may be moved in any rolling 24-hour window.
- **Circuit breaker active.** Three consecutive errors lock all writes for 24 hours.

## Commands

| Command | Type | Description |
|---------|------|-------------|
| `doctor` | read | Wallet, APIs, Zest position, gas, daily cap, circuit breaker |
| `status` | read | Leverage ratio, HF, liquidation price, carry P&L, HODLMM APY vs borrow rate |
| `loop` | write | One leverage iteration — borrow → swap → supply (`--confirm=LOOP`) |
| `unwind` | write | One deleverage step — withdraw → swap → repay (`--confirm=UNWIND`) |
| `run` | write | Autonomous — loops to target leverage, auto-unwinds if HF below trigger (`--confirm=RUN`) |

## Flags

| Flag | Commands | Description |
|------|----------|-------------|
| `--confirm=LOOP` | loop | Required exact token |
| `--confirm=UNWIND` | unwind | Required exact token |
| `--confirm=RUN` | run | Required exact token |
| `--dry-run` | loop, unwind, run | Simulate — full preview, no execution, no state change |
| `--target-leverage=N` | loop, run | Target leverage ratio (default: 1.5, hard max: 2.5) |
| `--slippage=N` | loop, unwind, run | Swap slippage tolerance % (default: 1.0, hard max: 5.0) |
| `--repay-all` | unwind | Repay 100% of debt in one unwind (default: 50%) |

## Safety constants (hardcoded — not configurable at runtime)

| Constant | Value | Purpose |
|----------|-------|---------|
| `MAX_LTV_PCT` | 55% | Max borrowed per loop as % of collateral (Zest max is 75%) |
| `HF_FLOOR_HARD` | 1.5 | Absolute hard stop — refuse any write action |
| `HF_FLOOR_LOOP` | 1.8 | Min HF before adding another leverage loop |
| `HF_UNWIND_TRIGGER` | 1.65 | Auto-unwind threshold in `run` command |
| `MAX_LEVERAGE_CAP` | 2.5x | Hard ceiling on --target-leverage |
| `DEFAULT_TARGET_LEVERAGE` | 1.5x | Conservative default |
| `MAX_BORROW_STX_PER_OP` | 5,000 STX | Max borrowed per single operation |
| `MAX_DAILY_STX` | 20,000 STX | Rolling 24h cap across all operations |
| `COOLDOWN_HOURS` | 4h | Minimum between loop/unwind operations |
| `DEFAULT_SLIPPAGE_PCT` | 1.0% | Default swap slippage |
| `MAX_SLIPPAGE_PCT` | 5.0% | Hard ceiling on slippage |
| `MAX_ERRORS_24H` | 3 | Circuit-breaker threshold |
| `CIRCUIT_BREAKER_HRS` | 24h | Lockout after circuit-breaker trip |

## Output contract

All commands return strict JSON:

```json
{
  "status": "success | error | blocked",
  "action": "doctor | status | loop | unwind | run",
  "data": {},
  "error": null
}
```

Write actions include numbered contract call steps:

```json
{
  "step1ContractCall": {
    "contract": "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.borrow-helper-v2-1-7",
    "function": "borrow",
    "args": ["u2500000000", "'SP3MCSQPVTMJT2KC2Z3N6X47JW13SQHC0KGNV1X4C", "'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token"],
    "explorerUrlTemplate": "https://explorer.hiro.so/txid/{txid}?chain=mainnet"
  },
  "step2ContractCall": { ... },
  "step3ContractCall": { ... }
}
```

## Example usage

```bash
# Health check
bun sbtc-leverage-looper.ts doctor

# Full position snapshot with carry analysis
bun sbtc-leverage-looper.ts status

# Dry-run before committing
bun sbtc-leverage-looper.ts loop --dry-run

# Open first leverage loop (1.5x target, 1% slippage)
bun sbtc-leverage-looper.ts loop --confirm=LOOP --target-leverage=1.5

# Add second loop to reach higher leverage
bun sbtc-leverage-looper.ts loop --confirm=LOOP --target-leverage=2.0

# Autonomous management — loops or unwinds as needed
bun sbtc-leverage-looper.ts run --confirm=RUN --target-leverage=1.5

# Partial unwind (50% debt repay)
bun sbtc-leverage-looper.ts unwind --confirm=UNWIND

# Full unwind — repay all debt
bun sbtc-leverage-looper.ts unwind --confirm=UNWIND --repay-all
```

## State and audit

Persistent state: `~/.aibtc-skills/sbtc-leverage-looper-state.json`
- `totalLoops`, `totalUnwinds`, `totalStxBorrowed`, `totalStxRepaid`
- `dailyStxMoved` / `dailyWindowStart` — rolling 24h cap tracking
- `errorCount`, `circuitBreakerUntil` — circuit-breaker state
- Independent cooldown timestamps for loop and unwind

JSONL audit log: `~/.aibtc-skills/sbtc-leverage-looper-events.jsonl` — rotates at 5 MB.

## Protocol contracts used

| Protocol | Contract | Purpose |
|----------|----------|---------|
| Zest v2 | `pool-borrow-v2-3` | Borrow STX against sBTC collateral |
| Zest v2 | `borrow-helper-v2-1-7` | Borrow execution helper |
| Zest v2 | `zest-market-v2` | Supply sBTC as collateral |
| Zest v2 | `liquidity-reserve-v1-1` | Withdraw sBTC collateral |
| Bitflow HODLMM | `bitflow-hodlmm-stx-ststx-v-1-2` | STX/sBTC liquidity pool |
| Bitflow | `swap-helper-v-1-1` | Execute STX↔sBTC swaps |
