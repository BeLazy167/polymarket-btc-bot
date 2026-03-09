# Fair Value Models

## The Problem Being Solved

The Polymarket binary market asks: "Will BTC's price at time T be above or below the strike price K?" You can buy "Up" or "Down" shares. The bot's job is to compute the theoretically correct probability — the fair value (FV) — that the spot price S finishes above K before expiry. This fair value is then compared to what Polymarket is charging, and the difference is your edge.

All three models share the same core setup: given the current spot price S, the strike K, the estimated volatility σ, and the time remaining T, compute P(S_T > K).

## Model 1: Classic (Lognormal + EWMA)

**Assumption**: Log-returns of the crypto price are normally distributed, which means the price follows a Geometric Brownian Motion (GBM). This is the same foundational assumption behind Black-Scholes option pricing.

Under GBM, the log of the future price is:

```
ln(S_T) ~ N( ln(S) − ½σ²T,  σ²T )
```

The probability that the price ends above the strike K is:

```
FV_UP = Φ( (ln(S/K) − ½σ²T) / (σ√T) )
```

where Φ is the cumulative distribution function (CDF) of the standard normal distribution. This is essentially asking: "How many standard deviations away is the strike from where we expect the price to be?" The −½σ²T term is the drift correction (under a risk-neutral or realized-volatility framework, the expected log-return is adjusted downward by half the variance — this is the convexity adjustment that arises from Ito's lemma).

### Volatility estimation via EWMA

The σ in the formula needs to be estimated from recent price data. The Classic model uses an Exponentially Weighted Moving Average of squared returns:

```
σ²_t = λ · σ²_{t-1} + (1 − λ) · r²_t
```

where r_t is the most recent log-return (ln(S_t / S_{t-1})) and λ (lambda) is the decay factor. This is a recursive formula — each new variance estimate is a blend of the previous estimate and the latest squared return, with λ controlling the blend. At λ = 0.94 (the default, which is also the RiskMetrics standard), approximately 6% of the weight goes to the most recent observation and 94% to the historical estimate. Lower λ values (0.85–0.88) make the model react faster to sudden moves; higher values (0.98–0.99) smooth things out.

The key intuition: the EWMA produces a real-time rolling volatility estimate without needing a fixed lookback window. Recent data always matters more than old data, with the rate of decay controlled by λ.

FV_DOWN is simply 1 − FV_UP, since the two outcomes are exhaustive.

## Model 2: Adaptive / GARCH (Lognormal + GARCH(1,1))

**Assumption**: Same lognormal probability formula as Classic (same Φ formula above), but the volatility estimation is upgraded from EWMA to GARCH(1,1) (Generalized Autoregressive Conditional Heteroskedasticity).

The GARCH(1,1) variance equation is:

```
σ²_t = ω + α · r²_{t-1} + β · σ²_{t-1}
```

where:

- **ω (omega)** is a constant (long-run variance floor), auto-calibrated by the system
- **α (alpha) — "Shock Reaction"** controls how much weight the model gives to the most recent squared return (the "shock"). Higher α means every sudden spike or crash instantly shifts the volatility estimate upward. Default is 0.10. At 0.02–0.05 ("calm mode"), the model barely reacts to individual ticks. At 0.20–0.30 ("panic mode"), it immediately prices in extreme volatility when it sees cascading liquidations.
- **β (beta) — "Volatility Memory"** controls how persistent past volatility is. Higher β means if the market was volatile recently, the model assumes it stays volatile for longer. Default is 0.85. At 0.50–0.65 ("short memory"), volatility calms down quickly after a spike. At 0.93–0.97 ("long memory"), the model stays in "storm mode" for extended periods during macro events.

The constraint α + β < 1.0 must hold for the model to be stationary (meaning volatility mean-reverts to a long-run level rather than exploding to infinity). The long-run variance the model reverts to is ω / (1 − α − β).

The key difference from EWMA: GARCH captures volatility clustering — the empirical observation that large moves tend to be followed by more large moves, and calm periods by more calm periods. EWMA is actually a special case of GARCH where ω = 0 and α + β = 1 (integrated GARCH/IGARCH). By having α + β < 1, GARCH introduces mean-reversion in volatility, which makes it more appropriate for longer timeframes where you expect vol to normalize.

## Model 3: Fat Tails (Student-t + EWMA)

**Assumption**: Instead of assuming log-returns are normally distributed, this model assumes they follow a Student-t distribution with ν degrees of freedom. The normal distribution underestimates the probability of extreme moves (crypto regularly has 5–10 sigma moves that should be virtually impossible under normality). The Student-t distribution has heavier tails, assigning higher probability to these extreme outcomes.

The fair value formula changes to:

```
FV_UP = 1 − F_{t,ν}( ln(K/S) / (σ√T) )
```

where F_{t,ν} is the CDF of the Student-t distribution with ν degrees of freedom. Note the formula structure is inverted compared to Classic — it computes the probability of the standardized log-return being less than the threshold (that price ends below strike), then subtracts from 1 to get the probability of finishing above.

The **ν (nu) — "Fat Tail Intensity"** parameter controls how heavy the tails are. Lower ν means fatter tails (more probability mass in extreme outcomes). Default is 7.

- At ν = 3–5 ("maximum fat tails"), the model prices in extreme tail scenarios — useful before FOMC, CPI, NFP, or ETF decisions where binary outcomes can cause massive moves.
- At ν = 15–30 ("thin tails, ~normal"), the Student-t distribution converges toward the normal distribution, effectively making this model behave like Classic.
- Mathematically, as ν → ∞, Student-t → Normal.

Volatility is still estimated via EWMA (same as Classic), so the only difference from Classic is the distributional assumption used when converting the standardized distance-to-strike into a probability.

## How the Fair Value Becomes a Trading Signal

Once FV_UP is computed (regardless of which model):

1. **Fair Price in cents** = FV_UP × 100 (e.g., 0.507 → 50.7¢)
2. **Market Price** = the current Polymarket ask price (e.g., 55.5¢)
3. **Diff** = Fair Price − Market Price (e.g., 50.7 − 55.5 = −4.8¢)
4. If Diff is negative for UP (market charges more than fair value), UP is OVERPRICED and DOWN is correspondingly UNDERVALUED. The magnitude of the diff tells you the size of the edge. A diff of ±1–2¢ is labeled NEUTRAL (essentially fair value, no edge). Larger deviations trigger directional signals like "BUY UP" or "BUY DOWN."

## Model Selection per Timeframe

| Timeframe | Default Model | Rationale |
|-----------|--------------|-----------|
| 5m        | Fat Tails    | Short timeframes see more extreme moves relative to σ |
| 15m       | Fat Tails    | Same reasoning |
| 1h        | Classic      | Normal distribution is more appropriate |
| 1d        | GARCH        | Vol clustering matters over longer periods |

## A Concrete Example

BTC Spot was ~$66,934, Strike was $67,238.79 (BTC was $304 below strike), volatility was 1.07%, and only ~5 minutes remained. The Classic model computed FV_UP ≈ 22.7¢ (22.7% chance BTC recovers $304 in the remaining time), but Polymarket was pricing UP at only 0.5¢. The diff was +22.2¢ — massive undervaluation of UP. The signal was "UP IS UNDERVALUED — BUY UP." In practice, recovering $304 in a few minutes with only 1% volatility is still very unlikely, so both the model and the market agreed it was a long shot, but the model thought the market was too extreme in pricing it at near-zero.
