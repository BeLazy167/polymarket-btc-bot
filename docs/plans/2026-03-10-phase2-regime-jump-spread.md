# Phase 2: Regime Detection + Jump Diffusion + Microstructure

## Context

Bot uses adaptive vol-based model selection (σ thresholds → classic/fat-tails). Phase 2 adds three signal layers that refine model selection and entry gating using higher-order statistics from the same 1-min return series plus WS spread data.

## Signals

### Computation (`src/signals/regime.ts`)

```ts
interface RegimeSignals {
  kurtosis: number    // excess kurtosis, 15-return window
  volOfVol: number    // σ of rolling vol estimates
  jumpRatio: number   // bipower/realized variation (1.0 = diffusion)
  spread: number      // best ask - best bid, active side
}
```

**Two-tier compute cadence:**
- Return signals (kurtosis, volOfVol, jumpRatio): recomputed on new 1-min return only, cached between. Triggered by `priceStore.getVersion()` monotonic counter.
- Spread: recomputed every tick from OrderbookState.

**Kurtosis**: 4th moment of last 15 log returns, excess (subtract 3). Centers at 0 for normal.

**Vol-of-vol**: Std dev of 5 rolling 3-return vol windows within the 15-return series.

**Bipower ratio**: `BV / RV` where `RV = Σ r²`, `BV = (π/2) Σ |r_i||r_{i-1}|`. Near 1.0 = no jumps.

**Spread**: `bestAsk - bestBid` from active-side OrderbookState. Per-token running median baseline, cold-starts from `config.baselineSpread`, resets on window rotation.

## Interventions

Each signal has one intervention point. No overlap.

### Jump → hard cooldown (entry suppression)

When `jumpRatio < jumpRatioThreshold` on new return: `jumpCooldownUntil = now + jumpCooldownMs`. Suppresses new entries only (exits unchanged). Cooldown is 5-10s, time-bounded, doesn't compound.

Gate is BEFORE the strategy loop — skips entire entry evaluation.

### Kurtosis → dynamic model thresholds

```ts
const kurtShift = clamp(kurtosis / 20, -0.10, 0.10)
effectiveLowVol  = config.lowVolThreshold  - kurtShift
effectiveHighVol = config.highVolThreshold - kurtShift
```

High excess kurtosis → thresholds drop → fat-tails sooner. Zero kurtosis → no shift. Bounded ±0.10.

### Spread → edge requirement adjustment

```ts
const spreadPenalty = Math.max(0, spread - medianSpread) * spreadMultiplier
effectiveMinGap = config.minGap + spreadPenalty
```

Wide spread → higher edge bar. Normal spread → no penalty. Passed via context override so strategies stay regime-unaware.

## Anti-paralysis

- Jump is the only hard gate, time-bounded (max 10s)
- Kurtosis and spread adjust continuous thresholds — never make entry impossible if edge is large enough
- Post-jump dislocation with wide spread but 25¢ edge still enters

## Integration (tick loop changes)

```
0. On new return: signalCache.updateOnReturn(priceStore)
1. Get BTC price, orderbook
2. Compute sigma
2.5. Get regime signals (cached returns + fresh spread)
3. Apply kurtShift to model thresholds → select model → compute FV
4. Check exits (unchanged)
5. Jump gate → if cooling down, skip entries
6. Compute spreadPenalty → adjust minGap
7. Strategy loop with adjusted context
```

## Config (`config.yaml` under `models:`)

```yaml
jumpRatioThreshold: 0.85
jumpCooldownMs: 7000
baselineSpread: 0.02
spreadMultiplier: 1.0
```

## Logging

Tick log: `σ=0.30 [C] │ k:0.2 j:0.95 s:2¢`
Structured log: full RegimeSignals on every signal/entry/skip.

## Files

| File | Action |
|------|--------|
| `src/signals/regime.ts` | NEW — SignalCache class, regime signal computation |
| `src/data/price-store.ts` | ADD monotonic version counter |
| `src/index.ts` | Integrate signals into tick loop |
| `src/config/schema.ts` | Add 4 config fields |
| `config.yaml` | Add defaults |
| `src/models/math.ts` | Add excessKurtosis(), bipowerRatio() helpers |
