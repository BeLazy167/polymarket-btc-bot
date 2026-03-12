# Strategy Improvements Roadmap

## Current State (updated 2026-03-11)
- 3 fair value models: Classic (lognormal+EWMA), GARCH, Fat Tails (Student-t)
- 4 strategies: momentum, low-vol-rider, fair-value-arb, value
- Single vol input (EWMA or GARCH, one at a time)
- Price-only signals (no order flow)
- Fixed position sizing ($5/trade)
- Dynamic market discovery from Gamma API
- Configurable window duration (5m and 15m supported)
- Exit logic: sell at fair value or take-profit target
- Execution: FAK with GTC fallback at 1¢ for sells
- 5s cooldown after window refresh, window cooldown on exit/fail

### Live Performance (bot.log — 87 paper exits, ~6hr session)
- **93% win rate**, profit factor 6.67, net +$31.79
- Profit targets: 76/76 wins, +$35.04 (the moneymaker)
- FV exits: 5W/6L, -$3.25 (the drag — 3 big losses from selling into empty books)
- Best entry range: <50¢ avg +$0.72/trade; 70¢+ only +$0.19/trade
- Max drawdown: $2.86, max win streak: 35

### Known Bugs (as of 2026-03-11)
- ~~Concurrent window-rotation sells double-counting losses~~ FIXED (sellingInProgress guard)
- Paper settle PnL ignores partial fills — if sell returns `success: false` with `filledShares > 0`, paper settlement records full loss
- No persistent position tracking — crash during open position = lost data

---

## 1. Ensemble Pricing
**Priority: HIGH | Effort: LOW**

Run all 3 models simultaneously, take weighted average. Only trade when 2/3 agree on direction and min edge across all 3 exceeds threshold.

- Track each model's accuracy over last N rounds
- Weight by recent accuracy (Bayesian model averaging)
- Future: add Merton jump-diffusion model (Poisson process for sudden moves)

## 2. Multi-Frequency Volatility
**Priority: HIGH | Effort: MEDIUM**

Don't rely on single σ. Build composite vol from:

- **Multi-frequency realized vol**: EWMA on 1s, 5s, 15s, 1m returns separately. HF vol spiking before LF = early regime shift warning
- **Deribit implied vol**: Pull via API as floor/ceiling. Options market is forward-looking
- **Vol-of-vol**: Track σ stability. Unstable σ → widen required edge
- **Event calendar**: FOMC/CPI/NFP → multiply σ by 1.5–2x pre-emptively

## 3. Order Flow Signals
**Priority: HIGH | Effort: MEDIUM**

- **Polymarket book imbalance**: bid/ask depth ratio. Skewed book = information signal
- **Binance signed order flow**: cumulative (volume × direction) from aggTrade stream (already connected). Large market sells → price will drop
- **Whale alerts**: on-chain large transfers to exchanges (future, needs data source)

## 4. Time-Weighted Edge Threshold
**Priority: MEDIUM | Effort: LOW**

Require larger edge as T→0:
- 4+ min remaining: 3¢ min edge
- 2–4 min: 5¢ min edge
- 1–2 min: 8¢ min edge
- <1 min: low-vol-rider only (specialized strategy for last 60s)

## 5. Kelly Position Sizing
**Priority: MEDIUM | Effort: LOW**

Replace fixed $2.50 with fractional Kelly:
```
f* = (p·b − q) / b
```
where p = FV, b = payout odds. Use quarter-Kelly (f*/4) for safety. Larger edge = larger bet, but capped.

## 6. Drawdown Stop
**Priority: MEDIUM | Effort: LOW**

Already have max daily loss. Add:
- Session drawdown stop (20% of bankroll → halt)
- Streak detection: 5 consecutive losses → pause 1 window

## 7. Walk-Forward Validation
**Priority: LOW | Effort: HIGH**

Backtest framework:
- Replay historical Binance data through strategy engine
- Train params on rounds 1–100, test 101–120, slide forward
- Only out-of-sample performance counts
- Regularize: penalize params far from defaults (λ=0.94, α=0.10, β=0.85, ν=7)

## 8. Edge Erosion Tracking
**Priority: LOW | Effort: MEDIUM**

Track realized vs predicted edge over time:
- Log predicted edge and actual P&L per trade
- Plot rolling edge realization ratio
- Alert when ratio trends toward 0 → market getting efficient

## 9. Independent Verification
**Priority: LOW | Effort: LOW**

- Compare our FV calc against PolyFair browser output
- Verify Polymarket settlement matches expected outcome
- Cross-check Binance price against independent source

---

## Cross-Market Arbitrage (from "Unravelling the Probabilistic Forest" paper)

> Paper analyzed 86M Polymarket transactions (Apr 2024–Apr 2025). Sophisticated traders extracted **$40M in guaranteed arbitrage**. Top trader: $2M from 4,049 trades ($496/trade avg). Three tiers of increasing complexity.

### 10. Single-Condition Arbitrage Scanner
**Priority: HIGH | Effort: LOW**

Scan all active Polymarket binary markets for YES+NO ≠ $1. Buy both when sum < $1 (guaranteed profit on resolution). Paper found **$10.6M** extracted this way.

- Poll Gamma API for all active binary markets (not just BTC 5-min)
- Subscribe to orderbook for each via Polymarket WS
- When `bestAsk_YES + bestAsk_NO < 1.0 - fee` → buy both
- When `bestBid_YES + bestBid_NO > 1.0 + fee` → sell both
- FOK execution on both legs simultaneously
- Requires: multi-market WS subscriptions (already supported), new market scanner module

### 11. Multi-Condition Rebalancing
**Priority: HIGH | Effort: MEDIUM**

For multi-outcome markets (e.g., "Which party wins X?" with 3+ outcomes), all outcome prices must sum to $1. Paper found **$29M** extracted from internal mispricing — median sum was $0.60 (40% mispricing).

- Fetch multi-outcome markets from Gamma API (elections, sports, etc.)
- Check if sum of all outcome best-asks < $1 → buy all outcomes
- Check if sum of all outcome best-bids > $1 → sell all outcomes
- Requires: extending `MarketConfig` to support N-outcome markets, new rebalancing strategy

### 12. Cross-Market Dependency Detection (LLM-Powered)
**Priority: MEDIUM | Effort: HIGH**

Detect logical dependencies between independently-priced markets. Example: "Trump wins PA" implies "Republicans win PA by 5+" — if A→B then P(A) ≤ P(B) must hold. Paper found **$95K** in combinatorial tier.

- Fetch all active market descriptions from Gamma API
- Use Claude API to classify market pairs: dependent vs independent
- Output: JSON of valid/invalid outcome combinations per pair
- Linear constraint check: if A→B, verify price(A) ≤ price(B)
- Paper: out of 46,360 pairs, 1,576 potentially dependent, 13 exploitable
- Requires: new `src/arbitrage/dependency-detector.ts`, Claude API integration

### 13. Bregman Divergence Trade Sizing
**Priority: MEDIUM | Effort: HIGH**

Replace `edge = fairValue - marketPrice` with information-theoretic optimal. Paper proved: **max guaranteed profit = Bregman divergence** between current prices and nearest arbitrage-free prices.

```
D(μ||θ) = R(μ) + C(θ) - θ·μ
Max Profit = D(μ*||θ)  where μ* = closest arb-free price vector
```

- Compute nearest arb-free price vector μ* for each market cluster
- Divergence = exact dollar amount of extractable profit
- Optimal trade = portfolio that moves prices from θ to μ*
- Replaces heuristic edge with computable optimal
- Requires: convex optimization library

### 14. Frank-Wolfe Solver for Exponential Outcome Spaces
**Priority: LOW | Effort: VERY HIGH**

For complex market clusters (NCAA: 63 games = 2^63 outcomes), enumerate valid outcomes via integer programming constraints. Frank-Wolfe iteratively builds working set without enumerating full space.

- Iterative: start with small valid outcome set, solve, add best new vector, repeat
- Converges in 50-150 iterations (minutes, not years)
- Paper used Gurobi (commercial); open-source alternatives: COIN-OR / HiGHS
- Only needed for complex multi-market clusters (>10 interdependent markets)
- Requires: IP solver integration, constraint modeling framework

### 15. Execution Simulation Layer
**Priority: HIGH | Effort: MEDIUM**

Simulate every order against current orderbook before placing. Paper's system only executed when guaranteed profit exceeded threshold after slippage.

- Store full orderbook depth (not just best bid/ask) from Polymarket WS
- Walk the book: calculate avg fill price for desired size
- Expected slippage = avg_fill - best_price
- Only execute if `profit_after_slippage_and_fees > min_threshold`
- Cap position at 50% of book depth to avoid moving market
- Requires: extending `OrderbookState` to store depth levels, new `src/execution/simulator.ts`

### 16. Modified Kelly with Execution Risk
**Priority: MEDIUM | Effort: LOW**

Upgrade item #5 with execution risk from paper:

```
f = (b×p - q) / (b × √p)
```

where p = fill probability (estimated from orderbook depth), not just edge probability. Cap at 50% of book depth. Use quarter-Kelly (f/4) for safety.

### 17. Real-Time Monitoring Dashboard
**Priority: LOW | Effort: MEDIUM**

Web dashboard via `Bun.serve()` tracking:

- Opportunities detected/minute, execution success rate
- Cumulative P&L curve, current drawdown %
- Detection-to-execution latency
- Alerts: drawdown >15%, fill rate <30%, solver timeout
- Paper's top traders ran 24/7 monitoring with automated halts

### 18. Multi-Market Infrastructure
**Priority: HIGH | Effort: HIGH**

Prerequisite for items 10-14. Extend bot from single BTC 5-min to scanning all active Polymarket markets.

- Replace `currentMarket` (single) → `Map<marketId, LiveMarket>`
- Extend Gamma API scanner: fetch all active events, not just `btc-updown-5m-*`
- Parallel Polymarket WS subscriptions per market group
- Per-market vol state, fair value, position tracking
- Risk manager: per-market P&L + portfolio-level exposure limits
- Files: `src/data/market-discovery.ts`, `src/index.ts`, `src/risk/manager.ts`

---

## Immediate Fixes (from 2026-03-11 analysis)
**Priority: CRITICAL | Effort: LOW**

### A. FV Exit Minimum Price Floor
FV exits lost -$3.25 across 11 trades. Worst: 67¢→6¢ (-$2.28) — sell into empty book. Add `minExitPrice` config (e.g., 0.15) so FV exits won't dump below a floor. This alone would have saved ~$4 in the session.

### B. Paper Settle Partial Fill Accounting
When `executor.sell()` returns `success: false` with `filledShares > 0` and `revenue > 0`, the paper settlement fallback ignores those and records full loss (`-sizeUsdc`). Should subtract already-realized revenue.
- File: `src/index.ts` lines 256-279

### C. Tick Re-entrancy Guard
The 1s `setInterval(async)` tick loop has no global re-entrancy guard. We patched the sell path, but other async operations (buy, refresh) could overlap. Add `if (tickRunning) return` at top.

### D. Persistent Trade Log
No trade history survives restart. Append each entry/exit to a JSONL file for audit and analysis.

### E. Tighten maxEntryPrice
Entries <50¢ avg +$0.72/trade, 70¢+ only +$0.19. Consider lowering `maxFairValueArbEntryPrice` from 0.75 to 0.65.

---

## Implementation Order (suggested)

**Phase 0 — Immediate fixes (do first):**
A. FV exit min price floor
B. Paper settle partial fill fix
C. Tick re-entrancy guard
D. Persistent trade log

**Phase 1 — Current BTC improvements:**
1. Ensemble consensus (run all 3 models, require 2/3 agreement)
2. Time-weighted edge threshold
3. Binance order flow (already have aggTrade stream)
4. Kelly sizing
5. Multi-frequency vol
6. Deribit IV integration

**Phase 2 — Low-hanging arbitrage fruit:**
10. Single-condition arb scanner (quick win, highest $/effort)
11. Multi-condition rebalancing
15. Execution simulation layer (needed before scaling capital)
16. Modified Kelly with execution risk

**Phase 3 — Cross-market infrastructure:**
18. Multi-market infrastructure (prerequisite for advanced arb)
12. Cross-market dependency detection (LLM-powered)
13. Bregman divergence trade sizing

**Phase 4 — Advanced & monitoring:**
7. Walk-forward backtesting
8. Edge erosion tracking
9. Independent verification
17. Real-time monitoring dashboard
14. Frank-Wolfe solver (only if market complexity warrants)

---

## Open Questions
- Capital split between directional BTC trades vs arb?
- Gamma API rate limits for scanning all markets?
- Gurobi license ($$$) vs HiGHS/COIN-OR for IP solver?
- Arb scanner: separate process or integrated main loop?
