import type { Strategy } from './base.ts'
import type { Signal, StrategyContext } from '../models/types.ts'
import type { CvdDivergenceConfig } from '../config/schema.ts'
import { stdout, color } from '../monitoring/logger.ts'

/**
 * CVD (Cumulative Volume Delta) Divergence strategy.
 *
 * Detects mismatches between price movement and aggressor-side volume
 * over a rolling window of raw trade ticks. Four signal modes:
 *
 * 1. Bullish divergence: price falling but buyers aggressive (CVD rising)
 * 2. Bearish divergence: price rising but sellers aggressive (CVD falling)
 * 3. Strong bull: price + CVD both strongly positive — trend confirmation
 * 4. Strong bear: price + CVD both strongly negative — trend confirmation
 */
export class CvdDivergenceStrategy implements Strategy {
  readonly name = 'cvd-divergence'
  readonly pullbackPct: number
  private config: CvdDivergenceConfig
  private ticks: Array<{ price: number; qty: number; isBuy: boolean; ts: number }> = []

  constructor(config: CvdDivergenceConfig) {
    this.config = config
    this.pullbackPct = config.pullbackPct
  }

  /** Called from index.ts onTrade callback — buffer raw ticks */
  recordTick(price: number, qty: number, isBuyerMaker: boolean, ts: number): void {
    // isBuyerMaker=false means buyer was aggressor (aggressive buy)
    this.ticks.push({ price, qty, isBuy: !isBuyerMaker, ts })
    if (this.ticks.length > this.config.maxTicks) {
      this.ticks = this.ticks.slice(-Math.floor(this.config.maxTicks * 0.8))
    }
  }

  private lastLogTs = 0

  evaluate(ctx: StrategyContext): Signal | null {
    // 1. Prune ticks older than windowSec
    const cutoff = Date.now() - this.config.windowSec * 1000
    this.ticks = this.ticks.filter(t => t.ts >= cutoff)

    // 2. Cold start guard
    if (this.ticks.length < 100) return null

    // 3. Compute CVD (sum of signed quantities)
    let cvd = 0
    for (const t of this.ticks) {
      cvd += t.isBuy ? t.qty : -t.qty
    }

    // 4. Price change over window
    const firstPrice = this.ticks[0]!.price
    const lastPrice = this.ticks[this.ticks.length - 1]!.price
    const priceChange = lastPrice - firstPrice

    // Log CVD status every 10s
    const now = Date.now()
    if (now - this.lastLogTs >= 10_000) {
      this.lastLogTs = now
      const cvdColor = cvd > 0 ? color.green(`+${cvd.toFixed(2)}`) : color.red(cvd.toFixed(2))
      const pcColor = priceChange > 0 ? color.green(`+$${priceChange.toFixed(0)}`) : color.red(`-$${Math.abs(priceChange).toFixed(0)}`)
      stdout(`${color.dim('[CVD]')} ticks=${this.ticks.length} cvd=${cvdColor} Δprice=${pcColor} ${color.dim(`window=${this.config.windowSec}s`)}`)
    }

    // 5. Detect divergence
    const { divPriceThreshold, divCvdThreshold, strongPriceThreshold, strongCvdThreshold } = this.config

    let signalType: string | null = null
    let side: 'YES' | 'NO' | null = null

    // BULLISH DIV: price down but buyers aggressive
    if (priceChange < -divPriceThreshold && cvd > divCvdThreshold) {
      signalType = 'cvd-bullish-div'
      side = 'YES'
    }
    // BEARISH DIV: price up but sellers aggressive
    else if (priceChange > divPriceThreshold && cvd < -divCvdThreshold) {
      signalType = 'cvd-bearish-div'
      side = 'NO'
    }
    // STRONG BULL: price up + CVD strongly positive
    else if (priceChange > strongPriceThreshold && cvd > strongCvdThreshold) {
      signalType = 'cvd-strong-bull'
      side = 'YES'
    }
    // STRONG BEAR: price down + CVD strongly negative
    else if (priceChange < -strongPriceThreshold && cvd < -strongCvdThreshold) {
      signalType = 'cvd-strong-bear'
      side = 'NO'
    }

    if (!signalType || !side) return null

    const marketPrice = side === 'YES' ? ctx.marketYesPrice : ctx.marketNoPrice
    const strength = Math.abs(cvd) / this.config.divCvdThreshold

    stdout(`${color.green('[CVD FIRE]')} ${color.bold(signalType)} ${side} cvd=${cvd.toFixed(2)} Δprice=$${priceChange.toFixed(0)} market=${marketPrice.toFixed(2)} strength=${strength.toFixed(1)}x`)
    return { side, confidence: 1, edge: strength * 0.1, strategy: signalType }
  }
}
