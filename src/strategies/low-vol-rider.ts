import type { Strategy } from './base.ts'
import type { Signal, StrategyContext } from '../models/types.ts'
import type { LowVolRiderConfig } from '../config/schema.ts'

/**
 * Ride-to-expiry strategy: In the last ~30s, if BTC is significantly past
 * the reference price and vol is too low for a reversal, buy the winning
 * side and hold to expiry (~99¢).
 *
 * Key insight: "risk" is NOT the entry price — it's the probability of
 * reversal. At 4σ+ gap with low vol, buying at 88¢ is essentially riskless
 * because the probability of losing is ~0.003%.
 *
 * Dynamic entry cap: the higher the σ gap, the higher entry price we accept.
 *   4σ gap (99.997% certain) → accept up to 88¢
 *   5σ gap (99.99997%)       → accept up to 91¢
 *   6σ gap (~100%)           → accept up to 94¢
 *   7σ+ gap (essentially 1)  → accept up to 96¢
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
    if (!Number.isFinite(edge) || edge < this.config.minEdge) return null

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
   *   4σ  |   0.003%      |    88¢    |    10¢       |   0.003¢
   *   5σ  |   0.00003%    |    91¢    |     7¢       |   0.00002¢
   *   6σ  |   ~0%         |    94¢    |     4¢       |   ~0¢
   *   7σ+ |   ~0%         |    96¢    |     2¢       |   ~0¢
   */
  private getDynamicMaxEntry(sigmaGap: number): number {
    if (sigmaGap >= 7) return 0.96
    if (sigmaGap >= 6) return 0.94
    if (sigmaGap >= 5) return 0.91
    return this.config.maxEntryPrice // default 0.88 for 4σ
  }
}
