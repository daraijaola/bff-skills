---
name: bitflow-hodlmm-manager
description: Autonomous HODLMM position management on Bitflow — monitor pools, create keeper orders, track positions, and rebalance with safety controls.
author: secret-mars
author_agent: Secret Mars
user-invocable: true
arguments: doctor | run | install-packs
entry: bitflow-hodlmm-manager/bitflow-hodlmm-manager.ts
requires: [wallet, signing, settings]
tags: [defi, write, mainnet-only, requires-funds, l2]
---

# Bitflow HODLMM Manager

## What it does

Manages concentrated liquidity positions on Bitflow's HODLMM protocol (Stacks L2). Agents can scan available pools and ticker data, create automated Keeper orders for DCA or swap execution, monitor existing orders, cancel positions, and get real-time quotes across 44+ trading pairs. Leverages Bitflow's Keeper contract system for automated, trustless order execution.

## Why agents need it

Bitflow's HODLMM offers 3-5x capital efficiency over standard AMMs by concentrating liquidity in active trading ranges. This skill lets agents autonomously manage their DeFi positions — creating automated orders, monitoring fills, and rebalancing based on market conditions. Without it, agents holding sBTC or STX leave yield on the table.

## Safety notes

- **Writes to chain.** Creating and cancelling orders submit Stacks transactions.
- **Moves funds.** Tokens are locked in Keeper contracts during active orders. Cancellation returns funds.
- **Mainnet only.** Bitflow is deployed on Stacks mainnet.
- **Spend limit enforced.** Default max order size: 500,000 sats (sBTC) or 100 STX. Override with `--max-order`.
- **No auto-create.** Orders require explicit `--action=create-order` — the skill never creates orders autonomously without the flag.
- **Slippage protection.** Default 2% slippage via `autoAdjust`. Override with `--min-received`.

## Commands

### doctor
Checks wallet balances, Bitflow API availability, Keeper contract status, and active orders. Read-only.
```bash
bun run skills/bitflow-hodlmm-manager/bitflow-hodlmm-manager.ts doctor
```

### run
Core execution. Accepts sub-commands:

**Scan pools and liquidity (read-only):**
```bash
bun run skills/bitflow-hodlmm-manager/bitflow-hodlmm-manager.ts run --action=scan
```

**Get swap quote:**
```bash
bun run skills/bitflow-hodlmm-manager/bitflow-hodlmm-manager.ts run --action=quote --from=token-stx --to=token-sbtc --amount=100
```

**Check Keeper contract and orders:**
```bash
bun run skills/bitflow-hodlmm-manager/bitflow-hodlmm-manager.ts run --action=status
```

**Create automated order via Keeper:**
```bash
bun run skills/bitflow-hodlmm-manager/bitflow-hodlmm-manager.ts run --action=create-order --from=token-stx --to=token-sbtc --amount=50
```

**Cancel pending order:**
```bash
bun run skills/bitflow-hodlmm-manager/bitflow-hodlmm-manager.ts run --action=cancel --order-id=ORDER_ID
```

### install-packs
Installs required dependencies.
```bash
bun run skills/bitflow-hodlmm-manager/bitflow-hodlmm-manager.ts install-packs --pack all
```

## Output contract
All outputs are JSON to stdout.

```json
{
  "status": "success | error | blocked",
  "action": "what the agent should do next",
  "data": {
    "pools": [],
    "quote": {},
    "keeper": {},
    "orders": []
  },
  "error": null
}
```

## Known constraints

- Bitflow is mainnet only — no testnet pools.
- Keeper contracts must be initialized per wallet before creating orders.
- Order execution depends on Bitflow's keeper service — timing is not guaranteed.
- Pool liquidity varies significantly — check `liquidity_in_usd` before large orders.
- Auto-adjust slippage uses real-time market data but may still fail in volatile conditions.
