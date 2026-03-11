import type { Executor, ExecutionResult } from './executor.ts'
import type { ApprovedOrder } from '../risk/manager.ts'
import type { MarketConfig, TickSize } from '../config/schema.ts'
import { logger } from '../monitoring/logger.ts'

export class PaperExecutor implements Executor {
  private trades: Array<{
    timestamp: number
    market: string
    side: string
    sizeUsdc: number
    strategy: string
    edge: number
  }> = []

  async execute(order: ApprovedOrder, market: MarketConfig): Promise<ExecutionResult> {
    const trade = {
      timestamp: Date.now(),
      market: market.name,
      side: order.side,
      sizeUsdc: order.sizeUsdc,
      strategy: order.strategy,
      edge: order.edge,
    }

    this.trades.push(trade)

    logger.info({
      ...trade,
      mode: 'PAPER',
    }, 'Paper trade executed')

    return {
      success: true,
      orderId: `paper-${Date.now()}`,
      status: 'simulated',
    }
  }

  async sell(tokenId: string, shares: number, _tickSize: TickSize): Promise<ExecutionResult> {
    logger.info({ tokenId, shares, side: 'SELL', mode: 'PAPER' }, 'Paper SELL executed')
    return { success: true, orderId: `paper-sell-${Date.now()}`, status: 'simulated' }
  }

  getTrades() {
    return this.trades
  }

  getSimulatedPnl(): number {
    // Simplified: assume edge = realized profit per dollar
    return this.trades.reduce((sum, t) => sum + t.edge * t.sizeUsdc, 0)
  }
}
