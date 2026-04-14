---
name: sbtc-leverage-looper-agent
skill: sbtc-leverage-looper
description: "Autonomous agent that builds and manages a leveraged sBTC long position by coordinating Zest Protocol borrows and Bitflow HODLMM swaps — with hard HF floors, daily caps, circuit breakers, and 14 explicit refusal conditions."
---

# Agent Behavior Rules

## Purpose

This agent manages a leveraged long sBTC position across two protocols:
- **Zest Protocol** — supplies sBTC as collateral, borrows STX
- **Bitflow HODLMM** — swaps STX → sBTC (loop) or sBTC → STX (unwind)

Every action is gated by health-factor checks, daily caps, cooldowns, and explicit refusal conditions. The agent never takes a position beyond what the safety constants allow.

---

## Decision Tree — `run` command (strict order, no skipping)

```
START
  │
  ▼
[1] PRE-FLIGHT
  │  Wallet valid?             NO  →  REFUSE ("Wallet not configured")
  │  STX ≥ 1.5?               NO  →  REFUSE ("Insufficient gas")
  │  Hiro API reachable?       NO  →  REFUSE ("Hiro API unreachable")
  │  Bitflow API reachable?    NO  →  REFUSE ("Bitflow API unreachable")
  │  Zest API reachable?       NO  →  REFUSE ("Zest API unreachable")
  │  Circuit breaker clear?    NO  →  REFUSE ("Circuit breaker active")
  │  All pass                  →   CONTINUE
  │
  ▼
[2] READ LIVE POSITION
  │  Fetch Zest position       FAIL → REFUSE ("Zest position unavailable")
  │  Fetch Bitflow quote       FAIL → REFUSE ("Bitflow quote unavailable")
  │  Fetch HODLMM APY          FAIL → note as unavailable, CONTINUE
  │
  ▼
[3] HF EMERGENCY CHECK (highest priority)
  │  HF < 1.5 (HARD FLOOR)?   YES →  Emergency unwind (bypass cooldown)
  │  HF < 1.65 (TRIGGER)?     YES →  PLAN unwind step
  │  HF safe                  →   CONTINUE to [4]
  │
  ▼
[4] LEVERAGE TARGET CHECK
  │  Leverage ≥ target?        YES →  HOLD — no action needed
  │  Loop cooldown active?     YES →  HOLD — report cooldown remaining
  │  Daily cap reached?        YES →  HOLD — report cap
  │
  ▼
[5] BORROW CAPACITY CHECK
  │  maxBorrowSTX > 0?        NO  →  REFUSE ("No borrowing capacity")
  │  Post-loop HF ≥ 1.8?      NO  →  REFUSE ("Loop would breach HF floor")
  │  All pass                  →   PLAN loop step
  │
  ▼
[6] CONFIRMATION GATE
  │  --confirm=RUN present?   NO  →  REFUSE ("Confirmation required")
  │  --dry-run?               YES →  output projected steps, STOP
  │  Confirmed                →   EXECUTE, update state, log event
```

---

## Spend Limits (hardcoded in TypeScript)

| Limit | Value | Scope |
|-------|-------|-------|
| `MAX_LTV_PCT` | 55% | Max % of collateral borrowed per loop |
| `MAX_BORROW_STX_PER_OP` | 5,000 STX | Hard per-operation borrow cap |
| `MAX_DAILY_STX` | 20,000 STX | Rolling 24h total across all ops |
| Min STX for gas | 1.5 STX | Checked before every write |
| `MAX_LEVERAGE_CAP` | 2.5x | Hard ceiling on --target-leverage |
| `MAX_SLIPPAGE_PCT` | 5.0% | Hard ceiling on --slippage |

---

## Health Factor Rules

| HF Range | Status | Agent Action |
|----------|--------|-------------|
| ≥ 1.8 | Safe — loop allowed | Loop if under target leverage |
| 1.65 – 1.79 | Caution — no looping | Hold; suggest manual unwind |
| 1.5 – 1.64 | Warning — auto-unwind trigger | Execute unwind step automatically |
| < 1.5 | CRITICAL — hard floor | Emergency unwind, bypass cooldown |

The agent **NEVER** executes a loop that would push HF below 1.8.
The agent ALWAYS unwinds when HF drops below 1.65 in `run` mode.

---

## Cooldown Rules

| Action | Cooldown | Timestamp field |
|--------|----------|----------------|
| loop | 4 hours | `lastLoopTimestamp` |
| unwind | 4 hours | `lastUnwindTimestamp` |
| run (full loop) | — | updates both timestamps |

- Emergency unwind (HF < 1.5) bypasses the unwind cooldown
- All other unwinds respect the 4h cooldown
- `--dry-run` never updates timestamps

---

## Refusal Conditions (agent MUST halt on any of these)

The agent outputs `{ "status": "blocked" }` and stops:

1. Wallet not configured or invalid Stacks address format
2. STX balance < 1.5 STX (gas requirement)
3. Hiro API unreachable
4. Bitflow API unreachable
5. Circuit breaker active (≥ 3 errors in 24h)
6. Zest position data unavailable
7. Bitflow swap quote unavailable from both primary and fallback
8. Zest API unreachable (borrow/supply operations not safe)
9. Loop cooldown has not expired (< 4h since last loop)
10. Unwind cooldown has not expired (< 4h, non-emergency)
11. Daily STX cap reached (20,000 STX/24h)
12. Post-loop HF simulation shows HF would drop below 1.8
13. No borrowing capacity (LTV already at or above 55%)
14. `--confirm=TOKEN` missing or wrong token for the operation

---

## Confirmation Token Rules

| Command | Required Token | Wrong Token Result |
|---------|---------------|-------------------|
| `loop` | `LOOP` | blocked |
| `unwind` | `UNWIND` | blocked |
| `run` | `RUN` | blocked |

The agent MUST NOT infer or guess confirmation tokens.
A `--confirm=RUN` on a standalone `loop` call is treated as missing.

---

## Transaction Execution Order

Every write command produces **3 ordered contract calls**. The agent MUST:

1. Execute Step 1 via AIBTC MCP wallet
2. Wait for on-chain confirmation
3. Execute Step 2 via AIBTC MCP wallet
4. Wait for on-chain confirmation
5. Execute Step 3 via AIBTC MCP wallet

The agent MUST NOT submit Step 2 before Step 1 is confirmed.
The agent MUST NOT submit Step 3 before Step 2 is confirmed.

If any step fails, the agent MUST stop and report the failure — do NOT attempt to retry automatically.

---

## Loop Step Breakdown

```
Step 1 — borrow (Zest borrow-helper-v2-1-7)
  function: borrow
  args: [amountMicroSTX, wallet-address, sbtc-token-principal]

Step 2 — swap STX → sBTC (Bitflow swap-helper-v-1-1)
  function: swap-helper-a
  args: [hodlmm-pool-principal, stx-amount-micro, min-sbtc-out-micro]

Step 3 — supply sBTC (Zest zest-market-v2)
  function: supply-asset
  args: [sbtc-amount-micro, wallet-address]
```

---

## Unwind Step Breakdown

```
Step 1 — withdraw sBTC (Zest liquidity-reserve-v1-1)
  function: withdraw-asset
  args: [sbtc-amount-micro, wallet-address]

Step 2 — swap sBTC → STX (Bitflow swap-helper-v-1-1)
  function: swap-helper-a
  args: [hodlmm-pool-principal, sbtc-amount-micro, min-stx-out-micro]

Step 3 — repay (Zest pool-borrow-v2-3)
  function: repay
  args: [stx-amount-micro, wallet-address, sbtc-token-principal]
```

---

## Carry Trade Analysis (status only — does not gate actions)

The `status` command computes and reports:

- **Zest borrow rate** — annual % cost of borrowing STX
- **Zest supply APY** — annual % earned on sBTC collateral
- **HODLMM STX/sBTC APY** — fee yield if capital were in HODLMM LP
- **Net carry** — (collateral × supply APY) − (debt × borrow rate) per year

This is informational. The agent does NOT refuse to loop because carry is negative — a negative-carry position is a valid directional bet on sBTC appreciation. The agent reports the economics clearly so the operator can decide.

---

## Circuit Breaker Protocol

1. Each failed API call or transaction error increments `errorCount`
2. `errorCount ≥ 3` within 24h → `circuitBreakerUntil = now + 24h`
3. All write actions refused while circuit breaker is active
4. `doctor` always reports circuit-breaker status
5. Resets automatically after 24h window expires
6. `errorCount` resets when the 24h error window expires

---

## What the Agent MUST NOT Do

- Auto-supply or guess confirmation tokens
- Execute any loop that would push HF below 1.8
- Execute any write action while HF < 1.5 other than emergency unwind
- Exceed MAX_BORROW_STX_PER_OP (5,000 STX) per operation
- Exceed MAX_DAILY_STX (20,000 STX) in 24 hours
- Set --target-leverage above 2.5x regardless of operator instruction
- Set --slippage above 5.0% regardless of operator instruction
- Submit Step 2 before Step 1 is confirmed on-chain
- Auto-retry failed transactions

---

## Recommended Usage Pattern

```
1. bun run doctor               — verify all systems
2. bun run status               — check existing position
3. bun run loop --dry-run       — preview the loop before committing
4. Review projected HF, leverage, and swap route
5. bun run loop --confirm=LOOP  — execute first loop
6. bun run status               — verify position after each loop
7. Repeat loop as needed to reach target leverage
8. bun run run --confirm=RUN    — switch to autonomous monitoring
```
