# Agent Behavior — Bitflow HODLMM Manager

## Decision order

1. Run `doctor` first. If wallet lacks gas or Bitflow API is unreachable, surface the blocker.
2. Run `run --action=status` to check Keeper contract and active orders.
3. Decide based on state:
   - No Keeper contract → initialize one (read-only check, contract created on first order)
   - Active orders → monitor fills, check if rebalance needed
   - No active orders + idle tokens → scan pools, get quotes, consider creating an order
   - Order filled → log result, consider next position
4. Parse JSON output and route on `status` field.

## Guardrails

- **Never create orders without explicit `--action=create-order` flag.** Scanning and quoting are always safe.
- **Never exceed `--max-order` limit** (default 500,000 sats sBTC / 100 STX). Split larger orders.
- **Always check pool liquidity** before creating orders. Skip pools with < $1,000 liquidity.
- **Never expose secrets or private keys** in args or logs.
- **Respect slippage protection.** Default 2% auto-adjust. Tighten for stablecoin pairs.
- **One active order per pair.** Don't stack orders on the same trading pair.

## Strategy patterns

**DCA (Dollar Cost Average):**
- Create recurring small orders (e.g., 10 STX → sBTC daily)
- Use Keeper for automated execution at market price
- Best for accumulation without timing the market

**Rebalance:**
- Monitor portfolio allocation (e.g., 60% sBTC / 40% STX)
- When allocation drifts > 5%, create order to rebalance
- Use `--action=quote` to check current rates before committing

**Yield harvesting:**
- After claiming rewards from other protocols (Zest, stacking), route excess to Bitflow
- Use quotes to find best rates across pairs

## Output contract

Return structured JSON every time. No ambiguous success states.

```json
{
  "status": "success | error | blocked",
  "action": "next recommended action for the agent",
  "data": {},
  "error": { "code": "", "message": "", "next": "" }
}
```

## On error

- If `insufficient_balance`: agent should acquire tokens before retrying
- If `keeper_not_initialized`: first order will initialize it — this is expected
- If `low_liquidity`: skip this pool, try alternative pairs
- If `order_failed`: check Keeper status, may need to wait for execution
- Do not retry silently. Surface to user with the `action` field guidance.

## On success

- Log the action: "Created order: X STX → sBTC via Keeper" / "Cancelled order #Y"
- Update portfolio tracking with new allocations
- If order created, set a follow-up to check status next cycle
