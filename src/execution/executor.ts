import { ClobClient, Chain, OrderType, Side as PolySide, AssetType } from '@polymarket/clob-client'
import { Wallet } from '@ethersproject/wallet'
import type { Config, MarketConfig, TickSize } from '../config/schema.ts'
import type { ApprovedOrder } from '../risk/manager.ts'
import { logger } from '../monitoring/logger.ts'

export interface ExecutionResult {
  success: boolean
  orderId?: string
  status?: string
  error?: string
  filledShares?: number
}

export interface Executor {
  execute(order: ApprovedOrder, market: MarketConfig): Promise<ExecutionResult>
  sell(tokenId: string, shares: number, tickSize: TickSize, negRisk?: boolean): Promise<ExecutionResult>
}

export class LiveExecutor implements Executor {
  private client: ClobClient

  constructor(config: Config) {
    const wallet = new Wallet(config.polymarket.privateKey)
    this.client = new ClobClient(
      'https://clob.polymarket.com',
      Chain.POLYGON,
      wallet,
      {
        key: config.polymarket.apiKey,
        secret: config.polymarket.apiSecret,
        passphrase: config.polymarket.apiPassphrase,
      },
      config.polymarket.signatureType,
      config.polymarket.funderAddress || undefined,
    )
  }

  async execute(order: ApprovedOrder, market: MarketConfig): Promise<ExecutionResult> {
    const tokenId = order.side === 'YES' ? market.yesTokenId : market.noTokenId
    const shares = market.minOrderSize ?? 5
    const amount = Math.round(order.price * shares * 100) / 100

    logger.info({
      strategy: order.strategy,
      side: order.side,
      amount,
      shares,
      edge: order.edge,
      market: market.name,
    }, 'Executing live order')

    try {
      const balanceBefore = await this.getTokenBalance(tokenId)

      const response = await this.client.createAndPostMarketOrder(
        {
          tokenID: tokenId,
          amount,
          side: PolySide.BUY,
        },
        { tickSize: market.tickSize as TickSize, negRisk: market.negRisk },
        OrderType.FAK,
      )

      // FAK can partially fill — measure actual shares received
      const balanceAfter = await this.getTokenBalance(tokenId)
      const filledShares = balanceAfter - balanceBefore

      if (filledShares < 1) {
        logger.warn({ filledShares, amount, market: market.name }, 'FAK fill < 1 share — skipping')
        return { success: false, status: 'partial-too-small', filledShares: 0 }
      }

      const result: ExecutionResult = {
        success: true,
        orderId: response.orderID,
        status: response.status,
        filledShares,
      }

      logger.info({ result, market: market.name }, 'Order result')
      return result
    } catch (err) {
      logger.error({ err, market: market.name }, 'Order execution threw')
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async getTokenBalance(tokenId: string): Promise<number> {
    const resp = await this.client.getBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id: tokenId })
    const rawBalance = Number(resp.balance)
    if (!Number.isFinite(rawBalance)) {
      logger.error({ tokenId, rawBalance: resp.balance }, 'getBalanceAllowance returned non-numeric balance')
      return 0
    }
    return rawBalance / 1e6
  }

  async sell(tokenId: string, _estimatedShares: number, tickSize: TickSize, negRisk?: boolean): Promise<ExecutionResult> {
    try {
      const realBalance = await this.getTokenBalance(tokenId)
      if (realBalance <= 0) {
        logger.warn({ tokenId, realBalance }, 'No token balance — already sold')
        return { success: true, status: 'already-sold' }
      }

      const sellSize = Math.floor(realBalance * 100) / 100
      if (sellSize <= 0) {
        logger.warn({ tokenId, realBalance }, 'Dust balance too small to sell')
        return { success: true, status: 'dust-skip' }
      }

      logger.info({ tokenId, realBalance, sellSize, side: 'SELL' }, 'Executing live SELL order')

      const response = await this.client.createAndPostMarketOrder(
        {
          tokenID: tokenId,
          amount: sellSize,
          side: PolySide.SELL,
        },
        { tickSize: tickSize, negRisk },
        OrderType.FAK,
      )

      // Check remaining balance after FAK sell
      const remaining = await this.getTokenBalance(tokenId)
      if (remaining > 0.5) {
        logger.warn({ tokenId, remaining, sold: sellSize - remaining }, 'Partial sell — shares remain')
      }

      const result: ExecutionResult = {
        success: true,
        orderId: response.orderID,
        status: response.status,
        filledShares: sellSize - remaining,
      }

      logger.info({ result }, 'Sell order result')
      return result
    } catch (err) {
      logger.error({ err, tokenId }, 'Sell order execution threw')
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}
