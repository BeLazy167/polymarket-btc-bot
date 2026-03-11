import type { PriceStore } from '../data/price-store.ts'
import { excessKurtosis, bipowerRatio } from '../models/math.ts'

export interface RegimeSignals {
  kurtosis: number
  volOfVol: number
  jumpRatio: number
  spread: number
}

export interface ReturnSignals {
  kurtosis: number
  volOfVol: number
  jumpRatio: number
}

const RETURN_WINDOW = 15
const VOV_SUBWINDOW = 3
const MINUTES_PER_YEAR = 525_960

interface OrderbookLike {
  bestBid: number
  bestAsk: number
}

export class SignalCache {
  private cached: ReturnSignals = { kurtosis: 0, volOfVol: 0, jumpRatio: 1.0 }
  private lastVersion = -1
  private jumpCooldownUntil = 0
  private spreadMedians = new Map<string, number[]>()

  private jumpRatioThreshold: number
  private jumpCooldownMs: number
  private baselineSpread: number

  constructor(opts: { jumpRatioThreshold: number; jumpCooldownMs: number; baselineSpread: number }) {
    this.jumpRatioThreshold = opts.jumpRatioThreshold
    this.jumpCooldownMs = opts.jumpCooldownMs
    this.baselineSpread = opts.baselineSpread
  }

  /** Recompute return-based signals only when new data arrives */
  updateOnReturn(store: PriceStore, now: number): void {
    const v = store.getVersion()
    if (v === this.lastVersion) return
    this.lastVersion = v

    const returns = store.getReturns(RETURN_WINDOW + 1)
    if (returns.length < 4) return

    const kurt = excessKurtosis(returns)
    const jump = bipowerRatio(returns)
    const vov = this.computeVolOfVol(returns)
    this.cached.kurtosis = Number.isFinite(kurt) ? kurt : 0
    this.cached.jumpRatio = Number.isFinite(jump) ? jump : 1.0
    this.cached.volOfVol = Number.isFinite(vov) ? vov : 0

    // Trigger jump cooldown
    if (this.cached.jumpRatio < this.jumpRatioThreshold) {
      this.jumpCooldownUntil = now + this.jumpCooldownMs
    }
  }

  /** Vol-of-vol: std dev of rolling sub-window vol estimates */
  private computeVolOfVol(returns: number[]): number {
    if (returns.length < VOV_SUBWINDOW * 2) return 0

    const vols: number[] = []
    for (let i = 0; i <= returns.length - VOV_SUBWINDOW; i++) {
      const sub = returns.slice(i, i + VOV_SUBWINDOW)
      const mean = sub.reduce((s, r) => s + r, 0) / sub.length
      const variance = sub.reduce((s, r) => s + (r - mean) ** 2, 0) / (sub.length - 1)
      vols.push(Math.sqrt(variance) * Math.sqrt(MINUTES_PER_YEAR))
    }

    if (vols.length < 2) return 0
    const volMean = vols.reduce((s, v) => s + v, 0) / vols.length
    const volVar = vols.reduce((s, v) => s + (v - volMean) ** 2, 0) / (vols.length - 1)
    return Math.sqrt(volVar)
  }

  getReturnSignals(): ReturnSignals {
    return { ...this.cached }
  }

  /** Compute spread and update running median for the token */
  getSpread(book: OrderbookLike | undefined, tokenId: string): number {
    if (!book || book.bestAsk <= 0 || book.bestBid <= 0) return 0
    const spread = Math.max(0, book.bestAsk - book.bestBid)

    // Update running median samples (keep last 30)
    let samples = this.spreadMedians.get(tokenId)
    if (!samples) {
      samples = []
      this.spreadMedians.set(tokenId, samples)
    }
    samples.push(spread)
    if (samples.length > 30) samples.shift()

    return spread
  }

  /** Get the baseline spread for a token: running median or config default */
  getBaselineSpread(tokenId: string): number {
    const samples = this.spreadMedians.get(tokenId)
    if (!samples || samples.length < 5) return this.baselineSpread

    const sorted = [...samples].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]!
  }

  isJumpCooldown(now: number): boolean {
    return now < this.jumpCooldownUntil
  }

  /** Reset spread medians on window rotation (new token IDs) */
  resetSpreadMedians(): void {
    this.spreadMedians.clear()
  }
}

/** Clamp a value between min and max */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
