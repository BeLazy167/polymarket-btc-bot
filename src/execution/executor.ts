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

    logger.info({
      strategy: order.strategy,
      side: order.side,
      size: order.sizeUsdc,
      edge: order.edge,
      market: market.name,
    }, 'Executing live order')

    try {
      // GTC = limit order: needs price + size (shares), not amount (USDC)
      const price = Math.round(order.price * 100) / 100
      const minSize = market.minOrderSize ?? 5
      const size = Math.max(minSize, Math.ceil((order.sizeUsdc / price) * 100) / 100)

      const response = await this.client.createAndPostOrder(
        {
          tokenID: tokenId,
          price,
          size,
          side: PolySide.BUY,
        },
        { tickSize: market.tickSize as TickSize, negRisk: market.negRisk },
        OrderType.GTC,
      )

      // "matched" = filled immediately; anything else = sitting on the book
      if (response.orderID && response.status !== 'matched') {
        const balanceBefore = await this.getTokenBalance(tokenId)
        return this.waitForFillOrCancel(response.orderID, tokenId, balanceBefore, false, 'GTC buy')
      }

      const result: ExecutionResult = {
        success: response.status === 'matched',
        orderId: response.orderID,
        status: response.status,
      }

      logger.info({ result, market: market.name }, 'Order result')
      return result
    } catch (err) {
      logger.error({ err, market: market.name }, 'Order execution threw')
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** Post GTC, wait 2s, check balance delta, cancel if unfilled */
  private async waitForFillOrCancel(
    orderId: string,
    tokenId: string,
    balanceBefore: number,
    expectDecrease: boolean,
    label: string,
  ): Promise<ExecutionResult> {
    await Bun.sleep(2000)
    let balanceAfter: number
    try {
      balanceAfter = await this.getTokenBalance(tokenId)
    } catch (err) {
      logger.error({ err, orderId }, `Balance check failed during ${label} wait`)
      try { await this.client.cancelOrder({ orderID: orderId }) } catch {}
      return { success: false, orderId, status: 'cancel-failed', error: 'balance check failed' }
    }
    const delta = expectDecrease ? balanceBefore - balanceAfter : balanceAfter - balanceBefore
    if (delta > 0) {
      logger.info({ orderId, delta }, `${label} filled after wait`)
      return { success: true, orderId, status: 'filled-after-wait' }
    }
    try {
      await this.client.cancelOrder({ orderID: orderId })
      logger.info({ orderId }, `${label} cancelled after 2s`)
    } catch (cancelErr) {
      logger.error({ cancelErr, orderId }, `Failed to cancel ${label} — may be orphaned`)
      return { success: false, orderId, status: 'cancel-failed', error: 'cancel failed' }
    }
    return { success: false, orderId, status: 'cancelled-timeout' }
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
        logger.warn({ tokenId, realBalance }, 'No token balance to sell')
        return { success: false, error: 'no balance' }
      }

      const sellSize = Math.floor(realBalance * 100) / 100
      if (sellSize <= 0) {
        logger.warn({ tokenId, realBalance }, 'Dust balance too small to sell')
        return { success: true, status: 'dust-skip' }
      }

      logger.info({ tokenId, realBalance, sellSize, side: 'SELL' }, 'Executing live SELL order')

      // GTC limit sell at low price — same pattern as buy: post, wait 2s, check, cancel
      const price = 0.01
      const response = await this.client.createAndPostOrder(
        {
          tokenID: tokenId,
          price,
          size: sellSize,
          side: PolySide.SELL,
        },
        { tickSize: tickSize, negRisk },
        OrderType.GTC,
      )

      if (response.orderID && response.status !== 'matched') {
        return this.waitForFillOrCancel(response.orderID, tokenId, realBalance, true, 'GTC sell')
      }

      const result: ExecutionResult = {
        success: response.status === 'matched',
        orderId: response.orderID,
        status: response.status,
      }

      logger.info({ result }, 'Sell order result')
      return result
    } catch (err) {
      logger.error({ err, tokenId }, 'Sell order execution threw')
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}
