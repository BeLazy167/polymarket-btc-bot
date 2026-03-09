import type { Strategy } from './base.ts'
import type { Signal, StrategyContext } from '../models/types.ts'
import type { MomentumConfig } from '../config/schema.ts'

/**
 * Momentum strategy based on direction consistency (the "4-minute rule").
 *
 * Two entry modes:
 * 1. Standard: Wait until 80% of window, check trailing consecutive
 *    same-direction minutes. 3 consecutive = ~80% win rate, 4 = ~96%.
 * 2. Early momentum: If BTC moves >$100 in first 2 minutes, enter early
 *    without waiting for 80% mark (~88% win rate).
 */
export class MomentumStrategy implements Strategy {
  readonly name = 'momentum'
  /** Per-window minute prices: windowId → price[] (one per minute) */
  private windowPrices = new Map<string, number[]>()
  /** Track last recorded minute per window to throttle to 1/min */
  private lastMinute = new Map<string, number>()

  constructor(private config: MomentumConfig) {}

  /** Call on each price tick — only records one price per minute per window */
  recordMinutePrice(price: number, windowId: string, nowMs: number): void {
    const currentMinute = Math.floor(nowMs / 60_000)
    const lastMin = this.lastMinute.get(windowId)

    if (lastMin === currentMinute) return // already recorded this minute

    if (!this.windowPrices.has(windowId)) {
      this.windowPrices.set(windowId, [])
    }
    this.windowPrices.get(windowId)!.push(price)
    this.lastMinute.set(windowId, currentMinute)

    // Cleanup old windows (keep max 3)
    if (this.windowPrices.size > 3) {
      const oldest = this.windowPrices.keys().next().value!
      this.windowPrices.delete(oldest)
      this.lastMinute.delete(oldest)
    }
  }

  evaluate(ctx: StrategyContext, windowId?: string): Signal | null {
    const prices = windowId ? this.windowPrices.get(windowId) ?? [] : []

    // Early momentum check: big move in first 2 minutes
    const earlySignal = this.checkEarlyMomentum(ctx, prices)
    if (earlySignal) return earlySignal

    // Standard: wait until entry threshold
    const elapsed = ctx.elapsedSec / ctx.windowDurationSec
    if (elapsed < this.config.entryThreshold) return null

    // Check trailing minute-by-minute consistency
    const consecutive = this.getTrailingConsecutive(prices)
    if (consecutive.count < this.config.minConsecutiveMinutes) return null

    const isUp = consecutive.direction === 'up'
    const fairValue = isUp ? ctx.fairValueUp : ctx.fairValueDown
    const marketPrice = isUp ? ctx.marketYesPrice : ctx.marketNoPrice
    const edge = fairValue - marketPrice

    if (edge < this.config.minEdge) return null

    return {
      side: isUp ? 'YES' : 'NO',
      confidence: fairValue,
      edge,
      strategy: `${this.name}-${consecutive.count}min`,
    }
  }

  private checkEarlyMomentum(ctx: StrategyContext, prices: number[]): Signal | null {
    if (ctx.elapsedSec < 60 || ctx.elapsedSec > 150) return null
    if (prices.length < 2) return null

    const firstPrice = prices[0]!
    const move = Math.abs(ctx.currentPrice - firstPrice)

    if (move < this.config.earlyMomentumThreshold) return null

    const isUp = ctx.currentPrice > firstPrice
    const fairValue = isUp ? ctx.fairValueUp : ctx.fairValueDown
    const marketPrice = isUp ? ctx.marketYesPrice : ctx.marketNoPrice
    const edge = fairValue - marketPrice

    if (edge < this.config.minEdge) return null

    return {
      side: isUp ? 'YES' : 'NO',
      confidence: fairValue,
      edge,
      strategy: `${this.name}-early-$${move.toFixed(0)}`,
    }
  }

  /**
   * Count trailing consecutive same-direction minutes (from the end).
   * E.g., prices [100, 99, 101, 102, 103] → 3 trailing 'up' minutes.
   */
  private getTrailingConsecutive(prices: number[]): { direction: 'up' | 'down'; count: number } {
    if (prices.length < 2) return { direction: 'up', count: 0 }

    const lastIdx = prices.length - 1
    const direction: 'up' | 'down' = prices[lastIdx]! >= prices[lastIdx - 1]! ? 'up' : 'down'
    let count = 1

    for (let i = lastIdx - 1; i >= 1; i--) {
      const thisDir: 'up' | 'down' = prices[i]! >= prices[i - 1]! ? 'up' : 'down'
      if (thisDir !== direction) break
      count++
    }

    return { direction, count }
  }
}
