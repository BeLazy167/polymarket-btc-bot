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
  fillPrice?: number
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
    const maxPrice = Math.round((order.price + 0.03) * 100) / 100
    const amount = Math.round(shares * maxPrice * 100) / 100

    logger.info({ strategy: order.strategy, side: order.side, maxPrice, amount, shares, market: market.name }, 'Executing FAK buy')

    try {
      const response = await this.client.createAndPostMarketOrder(
        { tokenID: tokenId, amount, side: PolySide.BUY, price: maxPrice },
        { tickSize: market.tickSize as TickSize, negRisk: market.negRisk },
        OrderType.FAK,
      )

      const ok = response.success !== false && !response.errorMsg
      logger.info({ orderID: response.orderID, status: response.status, errorMsg: response.errorMsg, ok, market: market.name }, 'FAK buy response')

      if (!ok) {
        return { success: false, status: response.status, error: response.errorMsg || 'FAK order rejected', filledShares: 0 }
      }

      // Check actual balance to get real fill price
      await Bun.sleep(300)
      const filledShares = await this.getTokenBalance(tokenId)
      const fillPrice = filledShares > 0 ? Math.round(amount / filledShares * 100) / 100 : maxPrice
      logger.info({ filledShares, fillPrice, amount, market: market.name }, 'FAK buy fill details')

      return { success: true, orderId: response.orderID, status: response.status, filledShares, fillPrice }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error({ err, market: market.name, msg }, 'FAK buy threw')
      return { success: false, error: msg }
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

      let response: { orderID?: string; status?: string }
      try {
        response = await this.client.createAndPostMarketOrder(
          { tokenID: tokenId, amount: sellSize, side: PolySide.SELL },
          { tickSize: tickSize, negRisk },
          OrderType.FAK,
        )
      } catch (fakErr) {
        // FAK fails on empty book — fall back to GTC limit sell at 1¢
        logger.warn({ err: fakErr, tokenId }, 'FAK sell failed — falling back to GTC at 1¢')
        response = await this.client.createAndPostOrder(
          { tokenID: tokenId, price: 0.01, size: sellSize, side: PolySide.SELL },
          { tickSize: tickSize, negRisk },
          OrderType.GTC,
        )
      }

      await Bun.sleep(500)
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
