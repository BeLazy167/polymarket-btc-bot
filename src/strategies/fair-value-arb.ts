import type { Strategy } from './base.ts'
import type { Signal, StrategyContext } from '../models/types.ts'
import type { FairValueArbConfig } from '../config/schema.ts'

/**
 * Fair value arbitrage: fires when the market price significantly lags
 * behind our calculated fair value from real-time Binance data.
 *
 * This is the purest form of the Chainlink oracle latency trade:
 * - Binance shows BTC moved → our FV model says 99¢
 * - Polymarket still shows 70¢ (stale orderbook)
 * - Buy at 70¢, hold to expiry → collect ~98¢
 *
 * Triggers at ANY point in the window (not just last minute),
 * as long as the FV-market gap exceeds the threshold.
 *
 * The bigger the gap, the more aggressive the entry:
 *   Gap 10-15¢:  normal size
 *   Gap 15-25¢:  this is juicy — high confidence
 *   Gap 25¢+:    market is asleep, maximum edge
 */
export class FairValueArbStrategy implements Strategy {
  readonly name = 'fv-arb'

  constructor(private config: FairValueArbConfig) {}

  evaluate(ctx: StrategyContext): Signal | null {
    // Check YES side: is market underpricing the UP outcome?
    const yesSignal = this.checkSide(ctx, 'YES', ctx.fairValueUp, ctx.marketYesPrice)
    if (yesSignal) return yesSignal

    // Check NO side: is market underpricing the DOWN outcome?
    const noSignal = this.checkSide(ctx, 'NO', ctx.fairValueDown, ctx.marketNoPrice)
    if (noSignal) return noSignal

    return null
  }

  private checkSide(
    ctx: StrategyContext,
    side: 'YES' | 'NO',
    fairValue: number,
    marketPrice: number,
  ): Signal | null {
    if (fairValue < this.config.minFairValue) return null

    const gap = fairValue - marketPrice
    if (gap < this.config.minGap) return null

    // Dynamic max entry: bigger gap = we accept higher prices
    // because the edge is so large that even expensive entries are +EV
    const dynamicMax = this.getDynamicMaxEntry(gap, fairValue)
    if (marketPrice > dynamicMax) return null

    return {
      side,
      confidence: fairValue,
      edge: gap,
      strategy: `${this.name}-gap${(gap * 100).toFixed(0)}¢`,
    }
  }

  /**
   * Bigger FV-market gap = more comfortable paying higher entry.
   *
   * Gap    │ Max entry │ Why
   * ───────┼───────────┼────────────────────────────
   * 10-15¢ │ 75¢       │ Decent edge, stay conservative
   * 15-25¢ │ 85¢       │ Strong edge, can afford higher entry
   * 25¢+   │ 92¢       │ Massive edge, market is clearly stale
   */
  private getDynamicMaxEntry(gap: number, fairValue: number): number {
    // Never pay more than fairValue - minGap (always keep minimum edge)
    const fvCap = fairValue - this.config.minGap * 0.5

    if (gap >= 0.25) return Math.min(0.92, fvCap)
    if (gap >= 0.15) return Math.min(0.85, fvCap)
    return Math.min(this.config.maxEntryPrice, fvCap)
  }
}
