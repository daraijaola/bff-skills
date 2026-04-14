---
name: hodlmm-zest-yield-optimizer
description: "Full-cycle autonomous yield router: harvests HODLMM fees, rebalances drifted bins, compares live APY, and moves entire positions between HODLMM and Zest Protocol based on real-time yield data."
metadata:
  author: "daraijaola"
  author-agent: "Agentr"
  user-invocable: "false"
  arguments: "doctor | status | harvest | compound | move-liquidity | withdraw | deposit | run"
  entry: "hodlmm-zest-yield-optimizer/hodlmm-zest-yield-optimizer.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, hodlmm, zest, yield, rebalance, liquidity, mainnet-only"
---

## What it does

The only skill that closes the complete capital cycle between Bitflow HODLMM and Zest Protocol:

1. **Detects bin drift** — checks if the HODLMM position has drifted from the active price range
2. **Rebalances bins** — moves liquidity back to the active bin when drift exceeds threshold
3. **Harvests fees** — claims all accumulated trading fees from the HODLMM position
4. **Compares live APY** — fetches real-time HODLMM pool APY vs Zest supply APY simultaneously
5. **Routes fees** — compounds harvested fees into whichever venue offers higher yield
6. **Exits full positions** — when Zest materially outperforms (≥5% spread), withdraws the entire HODLMM position to Zest
7. **Re-enters HODLMM** — when HODLMM APY recovers, deposits capital back into HODLMM liquidity

Every write command supports `--dry-run`. All writes require an exact `--confirm=TOKEN`.

## Why agents need it

Every HODLMM skill in this competition hits the same wall: read-only. They detect drift, score risk, recommend action — then stop. Capital sits in dead bins earning nothing while the active bin moves on.

This skill closes that loop completely. It does not just harvest fees and park them in one place. It continuously evaluates where the capital earns more — fee income in HODLMM or lending yield in Zest — and executes the optimal move, including full position exits when the spread is large enough.

## Commands

| Command | Type | Description |
|---------|------|-------------|
| `doctor` | read | Full pre-flight: wallet, APIs, gas, daily cap, circuit breaker |
| `status` | read | Live position snapshot + HODLMM vs Zest APY comparison + recommendation |
| `harvest` | write | Claim accumulated HODLMM fees |
| `compound` | write | Route harvested fees to highest-APY venue |
| `move-liquidity` | write | Rebalance drifted bins to active price range |
| `withdraw` | write | Exit entire HODLMM position — hold or route to Zest |
| `deposit` | write | Re-enter HODLMM from wallet balance or Zest withdrawal |
| `run` | write | Full autonomous loop — all of the above in one command |

## Flags

| Flag | Commands | Description |
|------|----------|-------------|
| `--confirm=HARVEST` | harvest | Required confirmation token |
| `--confirm=COMPOUND` | compound | Required confirmation token |
| `--confirm=MOVE` | move-liquidity | Required confirmation token |
| `--confirm=WITHDRAW` | withdraw | Required confirmation token |
| `--confirm=DEPOSIT` | deposit | Required confirmation token |
| `--confirm=RUN` | run | Required confirmation token |
| `--dry-run` | all write cmds | Simulate — shows projected output, no on-chain execution |
| `--min-amount=N` | harvest, compound | Skip if available amount below N |
| `--max-amount=N` | harvest | Override per-op cap (capped by MAX_HARVEST_PER_OP=500) |
| `--drift-threshold=N` | move-liquidity, run | Rebalance only if drift ≥ N% (default: 20) |
| `--pool=ADDRESS` | move-liquidity, withdraw, deposit | Override HODLMM pool principal |
| `--min-apy-spread=N` | compound, run | Min APY spread % to justify switching venue (default: 1.0) |
| `--destination=zest\|hold` | withdraw | Where to route withdrawn capital (default: hold) |
| `--source=wallet\|zest` | deposit | Where to source capital for deposit (default: wallet) |
| `--amount=N` | deposit | Override deposit amount |

## Safety constants (hardcoded — not configurable at runtime)

| Constant | Value | Purpose |
|----------|-------|---------|
| `MAX_HARVEST_PER_OP` | 500 tokens | Hard per-operation cap on harvest |
| `MAX_COMPOUND_PER_OP` | 500 tokens | Hard per-operation cap on compound |
| `MAX_DAILY_CAPITAL` | 5,000 tokens | Total capital moved across all ops per 24h |
| `MIN_STX_GAS` | 1 STX | Minimum STX balance for any write action |
| `GAS_BUFFER_STX` | 0.1 STX | Additional buffer on top of gas minimum |
| `COOLDOWN_HOURS` | 6h | Minimum hours between write operations |
| `DEFAULT_DRIFT_PCT` | 20% | Drift threshold for bin rebalancing |
| `DEFAULT_APY_SPREAD` | 1.0% | Minimum spread to justify fee routing switch |
| `FULL_EXIT_APY_SPREAD` | 5.0% | Minimum spread to justify full position exit |
| `MAX_ERRORS_24H` | 3 | Circuit-breaker error threshold per 24h |
| `CIRCUIT_BREAKER_HRS` | 24h | Lockout duration when circuit breaker trips |

## Output contract

All commands return strict JSON to stdout:

```json
{
  "status": "success | error | blocked",
  "action": "doctor | status | harvest | compound | move-liquidity | withdraw | deposit | run",
  "data": {},
  "error": null
}
```

Write actions include a `contractCall` field:
```json
{
  "contractCall": {
    "contract": "SP2F4QC563WN0A0949WPH5W1YBTSC5AV92B2S3KY.bitflow-hodlmm-stx-ststx-v-1-2",
    "function": "claim-fees",
    "args": ["u2184000"],
    "postConditions": [],
    "explorerUrlTemplate": "https://explorer.hiro.so/txid/{txid}?chain=mainnet"
  }
}
```

## Example usage

```bash
# Health check
bun hodlmm-zest-yield-optimizer.ts doctor

# Live APY comparison + recommendation
bun hodlmm-zest-yield-optimizer.ts status

# Full dry-run before committing
bun hodlmm-zest-yield-optimizer.ts run --dry-run

# Full autonomous run
bun hodlmm-zest-yield-optimizer.ts run --confirm=RUN

# Withdraw entire position to Zest (when Zest APY dominates)
bun hodlmm-zest-yield-optimizer.ts withdraw --confirm=WITHDRAW --destination=zest

# Re-enter HODLMM from Zest when HODLMM recovers
bun hodlmm-zest-yield-optimizer.ts deposit --confirm=DEPOSIT --source=zest

# Harvest only, minimum 10 tokens
bun hodlmm-zest-yield-optimizer.ts harvest --confirm=HARVEST --min-amount=10

# Rebalance only if drift ≥ 30%
bun hodlmm-zest-yield-optimizer.ts move-liquidity --confirm=MOVE --drift-threshold=30
```

## State tracking

Persistent state at `~/.aibtc-skills/hodlmm-zest-yield-optimizer-state.json`:
- `totalHarvested`, `totalCompounded`, `totalMoves`, `totalWithdrawn`, `totalDeposited`
- `dailyCapitalUsed` / `dailyCapitalWindowStart` — rolling 24h cap tracking
- `errorCount`, `circuitBreakerUntil` — circuit-breaker state
- Per-action timestamps for independent cooldown enforcement

JSONL audit log at `~/.aibtc-skills/hodlmm-zest-yield-optimizer-events.jsonl` — rotates at 5 MB.
