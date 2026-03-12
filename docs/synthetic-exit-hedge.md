# Plan: Synthetic Exit via Opposite Token Hedge

## Context
When the bot can't sell its position (FAK no-match due to illiquid book during fast BTC moves), it currently retries FAK every tick until emergency dump in last 10s. This led to a -$2.04 loss on a trade where hedging via buying YES at 46¢ would have capped the loss at -$0.70.

In a binary market, YES + NO always = $1 at settlement. So **buying the opposite token IS selling your position** — it's a synthetic close. When one side of the book is illiquid during a fast move, the other side is often liquid because that's where the momentum traders are buying.

## Feature: Buy opposite token as hedge when sell fails

### Trigger
- FAK sell returns "no match" (no liquidity on the book)
- Check opposite token ask price
- If `entryPrice + oppositeAsk < 1.00 + maxHedgeCost` → buy opposite token immediately

### Logic
1. In sell retry path (`index.ts:457-470`), after FAK no-match:
   - Read opposite token's ask price from the order book
   - Calculate synthetic exit price: `syntheticSellPrice = 1.00 - oppositeAsk`
   - Compare: if `syntheticSellPrice > currentNoBid` (or NO bid is 0/empty), prefer hedge
   - Buy opposite token via FAK (market order — we want instant fill)
2. Both tokens settle on-chain at expiry. One pays $1, guaranteed.
3. No need to sell the original position — just hold both to settlement.

### Key decisions (TBD)
- Max hedge cost cap (e.g. only if total pair cost < $1.15)
- Whether to try NO sell first then hedge, or go straight to hedge when book looks thin
- Hedge sizing: match original position size or partial

### Files to modify
- `src/execution/executor.ts` — new `hedgeViaOpposite()` method
- `src/index.ts` — call hedge in sell-failure retry path (~line 457-470)
- Need opposite token ID available (YES tokenId when holding NO, vice versa)

### Verification
- Unit test: mock FAK no-match → verify hedge buy triggers
- Integration test: simulate illiquid NO book + liquid YES ask → confirm hedge executes
- Backtest against the logged trade: entry NO@68¢, hedge YES@46¢ → verify -$0.70 vs -$2.04

### Example
Bot held NO at 68¢, NO book went empty, YES ask was liquid at 46¢. Buying YES at 46¢ locks in a guaranteed -14¢/share loss (-$0.70 total) instead of -40¢/share (-$2.04) from waiting for NO liquidity.
