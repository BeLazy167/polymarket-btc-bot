interface PriceEntry {
  price: number
  timestamp: number
}

const MINUTES_PER_YEAR = 365.25 * 24 * 60 // 525,960

export class PriceStore {
  private buffer: (PriceEntry | null)[]
  private head: number
  private count: number
  private maxSize: number
  private version: number

  constructor(maxSize = 1440) {
    this.maxSize = maxSize
    this.buffer = new Array<PriceEntry | null>(maxSize).fill(null)
    this.head = 0
    this.count = 0
    this.version = 0
  }

  addPrice(price: number, timestamp: number): void {
    this.buffer[this.head] = { price, timestamp }
    this.head = (this.head + 1) % this.maxSize
    if (this.count < this.maxSize) this.count++
    this.version++
  }

  /** Monotonic counter incremented on every addPrice call */
  getVersion(): number {
    return this.version
  }

  getLatest(): PriceEntry | null {
    if (this.count === 0) return null
    const idx = (this.head - 1 + this.maxSize) % this.maxSize
    return this.buffer[idx] ?? null
  }

  /**
   * Returns log returns of the last n price entries.
   * Yields n-1 returns from n prices: ln(p[i]/p[i-1]).
   */
  getReturns(n: number): number[] {
    const len = Math.min(n, this.count)
    if (len < 2) return []

    const prices: number[] = []
    for (let i = 0; i < len; i++) {
      const idx = (this.head - len + i + this.maxSize) % this.maxSize
      const entry = this.buffer[idx]
      if (entry) prices.push(entry.price)
    }

    const returns: number[] = []
    for (let i = 1; i < prices.length; i++) {
      returns.push(Math.log(prices[i]! / prices[i - 1]!))
    }
    return returns
  }

  /**
   * Annualized realized volatility from last n 1-minute returns.
   * sigma_annual = sigma_1min * sqrt(525960)
   */
  getRollingVol(n: number): number {
    const returns = this.getReturns(n)
    if (returns.length < 2) return 0

    const mean = returns.reduce((s, r) => s + r, 0) / returns.length
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1)
    const stdDev = Math.sqrt(variance)

    return stdDev * Math.sqrt(MINUTES_PER_YEAR)
  }

  getSize(): number {
    return this.count
  }
}
