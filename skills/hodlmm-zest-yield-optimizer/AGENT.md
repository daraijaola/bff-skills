---
name: hodlmm-zest-yield-optimizer-agent
skill: hodlmm-zest-yield-optimizer
description: "Autonomous agent that manages the full capital cycle between Bitflow HODLMM and Zest Protocol — rebalancing bins, harvesting fees, and moving entire positions to the highest-yield venue — with daily caps, per-action cooldowns, circuit breakers, and 13 explicit refusal conditions enforced in code."
---

# Agent Behavior Rules

## Purpose

This agent optimizes yield by continuously cycling capital between Bitflow HODLMM concentrated
liquidity and Zest Protocol lending. It makes the full routing decision — not just harvesting
fees into one destination, but evaluating whether the **entire position** earns more in HODLMM
or Zest, and executing the move when the spread is wide enough. All decisions follow this
decision tree in strict order.

---

## Decision Tree (strict — do not skip or reorder)

```
START
  │
  ▼
[1] DOCTOR — full pre-flight
  │  wallet valid?            NO  →  REFUSE ("Wallet not configured")
  │  STX ≥ 1.1 STX?          NO  →  REFUSE ("Insufficient gas")
  │  Hiro API reachable?      NO  →  REFUSE ("Hiro API unreachable")
  │  Bitflow API reachable?   NO  →  REFUSE ("Bitflow API unreachable")
  │  Circuit breaker clear?   NO  →  REFUSE ("Circuit breaker active until X")
  │  All pass                 →   CONTINUE
  │
  ▼
[2] COOLDOWN — per action
  │  Last run < 6h ago?       YES →  REFUSE ("Cooldown — Xh remaining")
  │  Expired                  →   CONTINUE
  │
  ▼
[3] DAILY CAP CHECK
  │  dailyCapitalUsed ≥ 5,000?  YES → REFUSE ("Daily capital cap reached")
  │  Cap available             →   CONTINUE
  │
  ▼
[4] READ LIVE DATA — parallel fetch
  │  HODLMM position found?  NO  →  REFUSE ("No HODLMM position")
  │  Zest APY fetched?        NO  →  REFUSE ("Zest APY unavailable")
  │  Zest APY ≤ 0?           YES  →  REFUSE ("Zest APY non-positive")
  │  All data available        →   CONTINUE
  │
  ▼
[5] FULL POSITION EXIT CHECK
  │  Zest APY > HODLMM APY
  │  AND spread ≥ 5.0%?       YES →  PLAN withdraw-to-zest step
  │  Otherwise                →   skip, go to [6]
  │
  ▼
[6] BIN DRIFT CHECK (skip if doing full exit)
  │  drift ≥ 20% threshold?   YES →  PLAN move-liquidity steps (remove + re-add)
  │  In range                 →   skip
  │
  ▼
[7] FEE HARVEST CHECK (skip if doing full exit)
  │  fees < 0.01?             YES →  REFUSE harvest ("Fees below threshold")
  │  fees > 500?              YES →  CAP at 500, WARN, CONTINUE
  │  Daily cap allows it?      NO  →  skip harvest
  │  Otherwise                →   PLAN harvest step
  │
  ▼
[8] APY ROUTING CHECK (skip if full exit or no harvest)
  │  spread < 1.0%?           YES →  skip compound ("Spread too small")
  │  Zest APY higher?         YES →  PLAN compound to Zest
  │  HODLMM APY higher?       YES →  PLAN compound back to HODLMM
  │
  ▼
[9] CONFIRMATION GATE
  │  --confirm=RUN present?   NO  →  REFUSE ("Confirmation required")
  │  dry-run?                YES  →  output projected steps, STOP (no state change)
  │  Confirmed                →   EXECUTE steps in order
  │
  ▼
[10] EXECUTE + LOG
       Execute each step's contractCall via AIBTC MCP wallet.
       Wait for on-chain confirmation between steps.
       Update state file. Append to JSONL event log.
       Record dailyCapitalUsed. Reset per-action cooldown timestamp.
```

---

## Spend Limits (hardcoded in TypeScript)

| Limit | Value | Enforcement |
|-------|-------|-------------|
| `MAX_HARVEST_PER_OP` | 500 tokens | Hard cap in harvest and run logic |
| `MAX_COMPOUND_PER_OP` | 500 tokens | Hard cap in compound and run logic |
| `MAX_DAILY_CAPITAL` | 5,000 tokens | Rolling 24h window tracked in state file |
| `MIN_STX_GAS + GAS_BUFFER` | 1.1 STX | Checked before every write action |

---

## Cooldown Rules

| Action | Cooldown | Timestamp field |
|--------|----------|----------------|
| run (full loop) | 6 hours | `lastRunTimestamp` |
| harvest | 6 hours | `lastHarvestTimestamp` |
| compound | 6 hours | `lastCompoundTimestamp` |
| move-liquidity | 6 hours | `lastMoveTimestamp` |
| withdraw | 6 hours | `lastWithdrawTimestamp` |
| deposit | 6 hours | `lastDepositTimestamp` |

- Each action has its own cooldown timestamp
- `run` resets all relevant timestamps on completion
- `--dry-run` does NOT update any timestamps

---

## Refusal Conditions (agent MUST halt on any of these)

The agent outputs `{ "status": "blocked" }` and stops without execution:

1. Wallet address not configured or invalid format
2. STX balance < 1.1 STX (MIN_STX_GAS + GAS_BUFFER)
3. Hiro API unreachable
4. Bitflow API unreachable
5. Circuit breaker active (≥3 errors in 24h)
6. Per-action cooldown has not expired
7. Daily capital cap reached (5,000 tokens/24h)
8. No HODLMM position found for wallet
9. Zest APY unavailable from both primary and fallback sources
10. Zest APY is zero or negative
11. Accumulated fees below 0.01 minimum threshold
12. `--confirm=TOKEN` missing or mismatched for the operation
13. Bin drift below threshold when running move-liquidity standalone

The agent MUST NOT proceed past any refusal condition, even partially.

---

## Full Position Exit Rules

The `withdraw --destination=zest` path (and the `run` loop when triggering it) moves the
**entire HODLMM position** — not just fees. Additional guards apply:

- Only triggered when Zest APY exceeds HODLMM APY by ≥ `FULL_EXIT_APY_SPREAD` (5.0%)
- `withdraw` always requires `--confirm=WITHDRAW` explicitly
- `run` loop triggers it automatically only when spread ≥ 5.0% AND daily cap permits
- After executing, `lastWithdrawTimestamp` is set — 6h cooldown before another withdrawal
- Agent logs the spread and positionValue to the JSONL event log

---

## Re-entry Rules (deposit)

The `deposit` command re-enters HODLMM from wallet balance or Zest.

- Only executes when `--confirm=DEPOSIT` is provided
- Only meaningful after a prior `withdraw` — agent checks gas, daily cap, cooldown
- `--source=zest`: first withdraws from Zest reserve, then adds liquidity to HODLMM (2-step)
- `--source=wallet`: adds liquidity directly from wallet STX (1-step)
- If the HODLMM position still has open bins, deposit adds to existing position
- Agent does NOT auto-compare APY on deposit — operator decides when to re-enter

---

## Circuit Breaker Protocol

1. Each failed write attempt increments `errorCount` in state file
2. If `errorCount ≥ 3` within 24 hours → set `circuitBreakerUntil = now + 24h`
3. While circuit breaker is active → REFUSE all write actions with explicit error
4. `doctor` always reports circuit-breaker status
5. Circuit breaker resets automatically after 24h (no manual reset needed)
6. `errorCount` resets when 24h window expires on the next successful run

---

## Dry-Run Behavior

When `--dry-run` is set on any write command:
- All API reads execute normally (live data)
- No contract calls are generated or submitted
- Output includes `"dryRun": true` and a `"projected"` block with:
  - All planned steps and their contract calls
  - Expected amounts, destinations, APY comparison
  - `capitalToMove` total and remaining daily cap
  - `confirmRequired` field showing which token to provide
- State file is NOT updated
- No timestamps are changed
- Event log is NOT written

---

## Confirmation Token Rules

| Command | Required Token | Mismatched Token Behavior |
|---------|---------------|--------------------------|
| `harvest` | `HARVEST` | blocked — not executed |
| `compound` | `COMPOUND` | blocked — not executed |
| `move-liquidity` | `MOVE` | blocked — not executed |
| `withdraw` | `WITHDRAW` | blocked — not executed |
| `deposit` | `DEPOSIT` | blocked — not executed |
| `run` | `RUN` | blocked — not executed |

The agent MUST NOT infer, auto-supply, or guess confirmation tokens.
A `--confirm=RUN` passed to a standalone `harvest` command is treated as missing.

---

## Event Audit Log

Every executed write action appends a JSONL record to:
`~/.aibtc-skills/hodlmm-zest-yield-optimizer-events.jsonl`

Each record includes: `ts`, `type`, `amount`/`positionValue`, `destination`/`source`, `spread`, `dailyUsed`.

Log rotates (clears) when it exceeds 5 MB.

---

## What the Agent MUST NOT Do

- Auto-supply or guess `--confirm` tokens
- Execute any write action while circuit breaker is active
- Execute any write action while per-action cooldown is active
- Move capital exceeding `MAX_DAILY_CAPITAL` in any 24h window
- Compound into Zest when Zest APY is zero or negative
- Trigger full position exit when spread < `FULL_EXIT_APY_SPREAD` (5.0%)
- Retry failed transactions without explicit operator instruction
- Override `MAX_HARVEST_PER_OP` or `MAX_DAILY_CAPITAL` via flags

---

## Recommended Invocation Pattern

```
1.  bun run doctor          — verify all systems
2.  bun run status          — check live APY and position health
3.  bun run run --dry-run   — preview all planned steps
4.  Review projected output
5.  bun run run --confirm=RUN  — execute
6.  Record tx hash(es) from contractCall output for on-chain verification
```
