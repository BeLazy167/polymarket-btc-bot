import type { Signal } from '../models/types.ts'
import type { RiskConfig } from '../config/schema.ts'
import { logger } from '../monitoring/logger.ts'

export interface ApprovedOrder {
  side: 'YES' | 'NO'
  sizeUsdc: number
  strategy: string
  confidence: number
  edge: number
  price: number
}

export class RiskManager {
  private dailyPnl = 0
  private activePositions = new Map<string, number>() // marketId -> count
  private halted = false
  private lastResetDate = ''

  constructor(private config: RiskConfig) {}

  approve(signal: Signal, marketId: string): ApprovedOrder | null {
    this.maybeResetDaily()

    if (this.halted) {
      logger.warn('Trading halted — daily loss limit reached')
      return null
    }

    const positions = this.activePositions.get(marketId) ?? 0
    if (positions >= this.config.maxConcurrentPositions) {
      logger.debug({ marketId, positions }, 'Max concurrent positions reached')
      return null
    }

    return {
      side: signal.side,
      sizeUsdc: this.config.positionSizeUsdc,
      strategy: signal.strategy,
      confidence: signal.confidence,
      edge: signal.edge,
      price: 0,
    }
  }

  recordTrade(marketId: string, pnl: number): void {
    this.dailyPnl += pnl
    if (this.dailyPnl <= -this.config.maxDailyLossUsdc) {
      this.halted = true
      logger.error({ dailyPnl: this.dailyPnl }, 'Daily loss limit hit — halting')
    }
  }

  openPosition(marketId: string): void {
    const current = this.activePositions.get(marketId) ?? 0
    this.activePositions.set(marketId, current + 1)
  }

  closePosition(marketId: string): void {
    const current = this.activePositions.get(marketId) ?? 0
    this.activePositions.set(marketId, Math.max(0, current - 1))
  }

  getDailyPnl(): number {
    return this.dailyPnl
  }

  isHalted(): boolean {
    return this.halted
  }

  private maybeResetDaily(): void {
    const today = new Date().toISOString().slice(0, 10)
    if (today !== this.lastResetDate) {
      this.dailyPnl = 0
      this.halted = false
      this.lastResetDate = today
      logger.info('Daily P&L reset')
    }
  }
}
