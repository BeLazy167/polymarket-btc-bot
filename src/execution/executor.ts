import { ClobClient, Chain, OrderType, Side as PolySide, AssetType } from '@polymarket/clob-client'
import { Wallet } from '@ethersproject/wallet'
import type { Config, MarketConfig, TickSize } from '../config/schema.ts'
import type { ApprovedOrder } from '../risk/manager.ts'
import { logger } from '../monitoring/logger.ts'

/** Typed wrapper for the CLOB API response (SDK returns Promise<any>) */
interface OrderApiResponse {
  success?: boolean
  errorMsg?: string
  orderID?: string
  status?: string
  takingAmount?: string
  makingAmount?: string
}

export interface ExecutionResult {
  success: boolean
  orderId?: string
  status?: string
  error?: string
  filledShares?: number
  fillPrice?: number
  remaining?: number
  revenue?: number
}

export interface Executor {
  execute(order: ApprovedOrder, market: MarketConfig): Promise<ExecutionResult>
  sell(tokenId: string, shares: number, tickSize: TickSize, negRisk?: boolean): Promise<ExecutionResult>
}

function calcFillPrice(amount: number, shares: number): number {
  return Math.round(amount / shares * 100) / 100
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
    const amount = Math.max(Math.round(shares * maxPrice * 100) / 100, 1)

    logger.info({ strategy: order.strategy, side: order.side, maxPrice, amount, shares, market: market.name }, 'Executing FAK buy')

    try {
      const resp: OrderApiResponse = await this.client.createAndPostMarketOrder(
        { tokenID: tokenId, amount, side: PolySide.BUY, price: maxPrice },
        { tickSize: market.tickSize as TickSize, negRisk: market.negRisk },
        OrderType.FAK,
      )

      const ok = resp.success !== false && !resp.errorMsg
      logger.info({
        orderID: resp.orderID, status: resp.status, errorMsg: resp.errorMsg,
        makingAmount: resp.makingAmount, takingAmount: resp.takingAmount,
        ok, market: market.name,
      }, 'FAK buy response')

      if (!ok) {
        return { success: false, status: resp.status, error: resp.errorMsg || 'FAK order rejected', filledShares: 0 }
      }

      // Verify fill via getOrder() — more reliable than balance timing
      let filledShares = 0
      let fillPrice = maxPrice
      await Bun.sleep(2000)

      if (resp.orderID) {
        try {
          const order = await this.client.getOrder(resp.orderID)
          const matched = Number(order.size_matched) || 0
          logger.info({ orderId: resp.orderID, sizeMatched: matched, originalSize: order.original_size, orderStatus: order.status }, 'FAK buy order query')
          if (matched > 0) {
            filledShares = matched
            fillPrice = calcFillPrice(amount, matched)
          }
        } catch { /* getOrder() failed — fall through to balance */ }
      }

      // Fall back to balance check if getOrder() returned 0
      if (filledShares === 0) {
        const balance = await this.getTokenBalance(tokenId)
        if (balance > 0) {
          filledShares = balance
          fillPrice = calcFillPrice(amount, balance)
        }
      }

      logger.info({ filledShares, fillPrice, amount, market: market.name }, 'FAK buy fill details')
      return { success: true, orderId: resp.orderID, status: resp.status, filledShares, fillPrice }
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
        return { success: true, status: 'already-sold', remaining: 0 }
      }

      const sellSize = Math.floor(realBalance * 100) / 100
      if (sellSize <= 0) {
        logger.warn({ tokenId, realBalance }, 'Dust balance too small to sell')
        return { success: true, status: 'dust-skip', remaining: 0 }
      }

      logger.info({ tokenId, realBalance, sellSize, side: 'SELL' }, 'Executing sell')

      // --- Attempt 1: FAK ---
      let lastOrderId: string | undefined
      let totalUsdcReceived = 0
      try {
        const resp: OrderApiResponse = await this.client.createAndPostMarketOrder(
          { tokenID: tokenId, amount: sellSize, side: PolySide.SELL },
          { tickSize: tickSize, negRisk },
          OrderType.FAK,
        )
        lastOrderId = resp.orderID
        const ok = resp.success !== false && !resp.errorMsg
        const taking = Number(resp.takingAmount) || 0
        if (taking > 0) totalUsdcReceived += taking
        logger.info({
          orderID: resp.orderID, status: resp.status, errorMsg: resp.errorMsg,
          makingAmount: resp.makingAmount, takingAmount: resp.takingAmount, ok,
        }, 'FAK sell response')
      } catch (fakErr) {
        logger.warn({ err: fakErr, tokenId }, 'FAK sell threw')
      }

      // Wait for settlement, then check balance
      await Bun.sleep(2000)
      let remaining = await this.getTokenBalance(tokenId)

      // --- Attempt 2: GTC at 1¢ if FAK didn't clear ---
      if (remaining > 0.5) {
        // Cancel stale orders from previous attempts before placing new GTC
        try { await this.client.cancelAll() } catch { /* no stale orders */ }

        const gtcSize = Math.floor(remaining * 100) / 100
        if (gtcSize > 0) {
          logger.warn({ tokenId, remaining, gtcSize }, 'FAK did not clear — placing GTC sell at 1¢')
          try {
            const gtcResp: OrderApiResponse = await this.client.createAndPostOrder(
              { tokenID: tokenId, price: 0.01, size: gtcSize, side: PolySide.SELL },
              { tickSize: tickSize, negRisk },
              OrderType.GTC,
            )
            lastOrderId = gtcResp.orderID
            const ok = gtcResp.success !== false && !gtcResp.errorMsg
            const gtcTaking = Number(gtcResp.takingAmount) || 0
            if (gtcTaking > 0) totalUsdcReceived += gtcTaking
            logger.info({ orderID: gtcResp.orderID, status: gtcResp.status, errorMsg: gtcResp.errorMsg, takingAmount: gtcResp.takingAmount, ok }, 'GTC sell response')

            await Bun.sleep(2000)
            remaining = await this.getTokenBalance(tokenId)
          } catch (gtcErr) {
            logger.warn({ err: gtcErr, tokenId }, 'GTC sell also threw')
          }
        }
      }

      const sold = realBalance - remaining
      const fillPrice = sold > 0 && totalUsdcReceived > 0
        ? Math.round(totalUsdcReceived / sold * 100) / 100
        : undefined

      // Final truth: balance determines success
      if (remaining > 0.5) {
        logger.warn({ tokenId, remaining, sold, realBalance, totalUsdcReceived }, 'Sell incomplete — shares still in wallet')
        return { success: false, orderId: lastOrderId, status: 'incomplete', filledShares: sold, remaining, fillPrice, revenue: totalUsdcReceived || undefined, error: `${remaining.toFixed(2)} shares remain` }
      }

      logger.info({ sold, remaining, totalUsdcReceived, fillPrice, orderId: lastOrderId }, 'Sell complete')
      return { success: true, orderId: lastOrderId, status: 'filled', filledShares: sold, remaining, fillPrice, revenue: totalUsdcReceived || undefined }
    } catch (err) {
      logger.error({ err, tokenId }, 'Sell threw')
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}
