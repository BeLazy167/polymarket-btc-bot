import type { Strategy } from './base.ts'
import type { Signal, StrategyContext } from '../models/types.ts'
import type { ValueConfig } from '../config/schema.ts'

/**
 * Value strategy: buy mispriced contracts below fair value, sell at fair value.
 * Runs continuously throughout market lifetime (not just near expiry).
 *
 * Buy when: marketPrice < fairValue * (1 - discountThreshold)
 * Sell when: marketPrice >= fairValue * (1 - exitThreshold)
 * Hard caps: never buy above maxEntryPrice, target minProfitTarget x entry.
 */
export class ValueStrategy implements Strategy {
  readonly name = 'value'
  private entryPrices = new Map<string, number>()

  constructor(private config: ValueConfig) {}

  evaluate(ctx: StrategyContext): Signal | null {
    // Check both YES and NO sides for mispricing
    const yesSignal = this.evaluateSide(ctx, 'YES', ctx.fairValueUp, ctx.marketYesPrice)
    if (yesSignal) return yesSignal

    const noSignal = this.evaluateSide(ctx, 'NO', ctx.fairValueDown, ctx.marketNoPrice)
    if (noSignal) return noSignal

    return null
  }

  private evaluateSide(
    ctx: StrategyContext,
    side: 'YES' | 'NO',
    fairValue: number,
    marketPrice: number,
  ): Signal | null {
    const buyThreshold = fairValue * (1 - this.config.discountThreshold)

    if (fairValue < this.config.minFairValue) return null

    if (marketPrice < buyThreshold && marketPrice <= this.config.maxEntryPrice) {
      const edge = fairValue - marketPrice
      return {
        side,
        confidence: fairValue,
        edge,
        strategy: this.name,
      }
    }

    return null
  }

  /** Track entry price for profit target calculation */
  recordEntry(marketId: string, side: string, price: number): void {
    this.entryPrices.set(`${marketId}-${side}`, price)
  }

  /** Check if we should exit a position */
  shouldExit(marketId: string, side: string, currentPrice: number, fairValue: number): boolean {
    const key = `${marketId}-${side}`
    const entryPrice = this.entryPrices.get(key)
    if (!entryPrice) return false

    // Exit if price reached profit target
    if (currentPrice >= entryPrice * this.config.minProfitTarget) {
      this.entryPrices.delete(key)
      return true
    }

    // Exit if price converged to fair value
    if (currentPrice >= fairValue * (1 - this.config.exitThreshold)) {
      this.entryPrices.delete(key)
      return true
    }

    return false
  }
}
