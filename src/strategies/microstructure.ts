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

    // Try liquidity gap first (last 45s), then imbalance (last 120s) -- both time-gated via config
    return this.evaluateLiquidityGap(ctx, timeRemaining)
        ?? this.evaluateImbalance(ctx, timeRemaining)
  }

  /** Resolve directional context: which side is winning, its FV and market price. */
  private getDirectional(ctx: StrategyContext) {
    const isUp = ctx.currentPrice > ctx.referencePrice
    return {
      side: (isUp ? 'YES' : 'NO') as 'YES' | 'NO',
      fairValue: isUp ? ctx.fairValueUp : ctx.fairValueDown,
      marketPrice: isUp ? ctx.marketYesPrice : ctx.marketNoPrice,
      bidDepth: isUp ? ctx.yesBidDepth : ctx.noBidDepth,
      askDepth: isUp ? ctx.yesAskDepth : ctx.noAskDepth,
      spread: isUp ? ctx.yesSpread : ctx.noSpread,
    }
  }

  /**
   * Strategy B: Orderbook imbalance entry.
   * When bid depth >> ask depth on the winning side, the ask is stale/thin
   * and about to reprice upward. Buy before it does.
   */
  private evaluateImbalance(ctx: StrategyContext, timeRemaining: number): Signal | null {
    if (timeRemaining > this.config.imbalanceActiveSec) return null

    const { side, fairValue, marketPrice, bidDepth, askDepth } = this.getDirectional(ctx)
    if (askDepth <= 0 || bidDepth <= 0) return null

    const depthRatio = bidDepth / askDepth
    if (depthRatio < this.config.minDepthRatio) return null

    const edge = fairValue - marketPrice
    if (fairValue < 0.70) return null // need clear directional signal
    if (edge < this.config.minImbalanceEdge) return null

    return { side, confidence: fairValue, edge, strategy: `${this.name}-imb-${depthRatio.toFixed(1)}x` }
  }

  /**
   * Strategy C: MM withdrawal / liquidity gap.
   * Near expiry, spreads widen as MMs pull quotes. Stale asks on the winning
   * side sit below fair value -- buy them.
   */
  private evaluateLiquidityGap(ctx: StrategyContext, timeRemaining: number): Signal | null {
    if (timeRemaining > this.config.gapActiveSec) return null

    const { side, fairValue, marketPrice, spread } = this.getDirectional(ctx)
    if (spread < this.config.minSpreadForGap) return null

    const edge = fairValue - marketPrice
    if (fairValue < 0.85) return null // need high conviction for gap trades
    if (edge < this.config.minGapEdge) return null

    return { side, confidence: fairValue, edge, strategy: `${this.name}-gap-${(spread * 100).toFixed(0)}¢` }
  }
}
