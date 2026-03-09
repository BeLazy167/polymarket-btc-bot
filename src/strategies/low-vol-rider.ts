import type { Strategy } from './base.ts'
import type { Signal, StrategyContext } from '../models/types.ts'
import type { LowVolRiderConfig } from '../config/schema.ts'

/**
 * Ride-to-expiry strategy: In the last ~60s, if BTC is significantly past
 * the reference price and vol is too low for a reversal, buy the winning
 * side and hold to expiry (~99¢).
 *
 * Key insight: "risk" is NOT the entry price — it's the probability of
 * reversal. At 6σ+ gap with low vol, buying at 85¢ is essentially riskless
 * because the probability of losing is ~0.
 *
 * Dynamic entry cap: the higher the σ gap, the higher entry price we accept.
 *   3σ gap (99.9% certain)  → accept up to 85¢
 *   5σ gap (99.99997%)      → accept up to 92¢
 *   7σ+ gap (essentially 1) → accept up to 95¢
 */
export class LowVolRiderStrategy implements Strategy {
  readonly name = 'low-vol-rider'

  constructor(private config: LowVolRiderConfig) {}

  evaluate(ctx: StrategyContext): Signal | null {
    const timeRemaining = ctx.windowDurationSec - ctx.elapsedSec
    if (timeRemaining > this.config.activateLastSec) return null

    // How many σ away is current price from reference?
    const timeRemainingMin = timeRemaining / 60
    const sigmaPerMin = ctx.sigma / Math.sqrt(525960) // annualized → per-minute
    const sigmaRemaining = sigmaPerMin * Math.sqrt(timeRemainingMin) * ctx.referencePrice
    if (sigmaRemaining <= 0) return null

    const priceDelta = Math.abs(ctx.currentPrice - ctx.referencePrice)
    const sigmaGap = priceDelta / sigmaRemaining

    if (sigmaGap < this.config.minSigmaGap) return null

    const isUp = ctx.currentPrice > ctx.referencePrice
    const fairValue = isUp ? ctx.fairValueUp : ctx.fairValueDown
    const marketPrice = isUp ? ctx.marketYesPrice : ctx.marketNoPrice

    if (fairValue < this.config.minFairValue) return null

    // Dynamic max entry: higher σ gap → we accept higher entry price
    // because the actual risk (probability of losing) is near zero
    const dynamicMaxEntry = this.getDynamicMaxEntry(sigmaGap)
    if (marketPrice > dynamicMaxEntry) return null

    const edge = fairValue - marketPrice

    return {
      side: isUp ? 'YES' : 'NO',
      confidence: fairValue,
      edge,
      strategy: `${this.name}-${sigmaGap.toFixed(1)}σ`,
    }
  }

  /**
   * Higher σ gap = lower actual risk = we can accept higher entry prices.
   *
   * σ gap | Reversal prob | Max entry | Profit/share | Actual risk/share
   * ------|---------------|-----------|--------------|------------------
   *   3σ  |   0.1%        |    85¢    |    13¢       |   0.085¢
   *   4σ  |   0.003%      |    88¢    |    10¢       |   0.003¢
   *   5σ  |   0.00003%    |    92¢    |     6¢       |   0.00003¢
   *   7σ+ |   ~0%         |    95¢    |     3¢       |   ~0¢
   */
  private getDynamicMaxEntry(sigmaGap: number): number {
    if (sigmaGap >= 7) return 0.95
    if (sigmaGap >= 5) return 0.92
    if (sigmaGap >= 4) return 0.88
    return this.config.maxEntryPrice // default 0.85 for 3σ
  }
}
