import type { Strategy } from './base.ts'
import type { Signal, StrategyContext } from '../models/types.ts'
import type { MicrostructureConfig } from '../config/schema.ts'

/**
 * Exploits orderbook microstructure near expiry:
 *
 * 1. Orderbook imbalance: When one side has heavy depth and the other is thin,
 *    the thin side will reprice faster. Buy the thick (supported) side when
 *    the ask is below fair value — MMs haven't caught up yet.
 *
 * 2. MM withdrawal (liquidity gap): Near expiry, MMs pull quotes to avoid
 *    settlement risk. Spreads widen 3-5x, leaving stale asks on the winning
 *    side below fair value. Buy those before they're cancelled.
 */
export class MicrostructureStrategy implements Strategy {
  readonly name = 'microstructure'

  constructor(private config: MicrostructureConfig) {}

  evaluate(ctx: StrategyContext): Signal | null {
    const timeRemaining = ctx.windowDurationSec - ctx.elapsedSec

    // Try liquidity gap first (last 45s only), then imbalance (anytime)
    return this.evaluateLiquidityGap(ctx, timeRemaining)
        ?? this.evaluateImbalance(ctx, timeRemaining)
  }

  /**
   * Strategy B: Orderbook imbalance entry.
   * When bid depth >> ask depth on the winning side, the ask is stale/thin
   * and about to reprice upward. Buy before it does.
   */
  private evaluateImbalance(ctx: StrategyContext, timeRemaining: number): Signal | null {
    if (timeRemaining > this.config.imbalanceActiveSec) return null

    const isUp = ctx.currentPrice > ctx.referencePrice

    // Depth on the side we want to buy
    const bidDepth = isUp ? ctx.yesBidDepth : ctx.noBidDepth
    const askDepth = isUp ? ctx.yesAskDepth : ctx.noAskDepth
    if (askDepth <= 0 || bidDepth <= 0) return null

    const depthRatio = bidDepth / askDepth
    if (depthRatio < this.config.minDepthRatio) return null

    const fairValue = isUp ? ctx.fairValueUp : ctx.fairValueDown
    const marketPrice = isUp ? ctx.marketYesPrice : ctx.marketNoPrice
    const edge = fairValue - marketPrice

    if (fairValue < 0.70) return null // need clear directional signal
    if (edge < this.config.minImbalanceEdge) return null

    return {
      side: isUp ? 'YES' : 'NO',
      confidence: fairValue,
      edge,
      strategy: `${this.name}-imb-${depthRatio.toFixed(1)}x`,
    }
  }

  /**
   * Strategy C: MM withdrawal / liquidity gap.
   * Near expiry, spreads widen as MMs pull quotes. Stale asks on the winning
   * side sit below fair value — buy them.
   */
  private evaluateLiquidityGap(ctx: StrategyContext, timeRemaining: number): Signal | null {
    if (timeRemaining > this.config.gapActiveSec) return null

    const isUp = ctx.currentPrice > ctx.referencePrice
    const spread = isUp ? ctx.yesSpread : ctx.noSpread

    // Detect widened spread (MM withdrawal signal)
    if (spread < this.config.minSpreadForGap) return null

    const fairValue = isUp ? ctx.fairValueUp : ctx.fairValueDown
    const marketPrice = isUp ? ctx.marketYesPrice : ctx.marketNoPrice
    const edge = fairValue - marketPrice

    if (fairValue < 0.85) return null // need high conviction for gap trades
    if (edge < this.config.minGapEdge) return null

    return {
      side: isUp ? 'YES' : 'NO',
      confidence: fairValue,
      edge,
      strategy: `${this.name}-gap-${(spread * 100).toFixed(0)}¢`,
    }
  }
}
