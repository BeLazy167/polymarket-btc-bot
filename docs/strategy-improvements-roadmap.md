# Strategy Improvements Roadmap

## Current State
- 3 fair value models: Classic (lognormal+EWMA), GARCH, Fat Tails (Student-t)
- 4 strategies: momentum, low-vol-rider, fair-value-arb, value
- Single vol input (EWMA or GARCH, one at a time)
- Price-only signals (no order flow)
- Fixed position sizing
- Dynamic market discovery from Gamma API
- Exit logic: sell at fair value or +10¢ take-profit

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

## Implementation Order (suggested)
1. Ensemble consensus (run all 3 models, require 2/3 agreement)
2. Time-weighted edge threshold
3. Binance order flow (already have aggTrade stream)
4. Kelly sizing
5. Multi-frequency vol
6. Deribit IV integration
7. Walk-forward backtesting
8. Edge erosion tracking
