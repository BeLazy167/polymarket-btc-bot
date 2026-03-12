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

  /**
   * Place GTC limit order at current ask, poll for fill up to 10s, cancel if unfilled.
   * Sends inline heartbeats to prevent Polymarket from auto-cancelling the resting order.
   */
  async execute(order: ApprovedOrder, market: MarketConfig): Promise<ExecutionResult> {
    const tokenId = order.side === 'YES' ? market.yesTokenId : market.noTokenId
    const shares = market.minOrderSize ?? 5
    const price = Math.round(Math.min(order.price, 0.97) * 100) / 100

    logger.info({ strategy: order.strategy, side: order.side, price, marketPrice: order.price, shares, market: market.name }, 'Executing GTC buy')

    // Heartbeat keeps GTC order alive (Polymarket cancels all orders if no heartbeat within 10-15s)
    let heartbeatId: string | undefined
    const sendHeartbeat = async () => {
      try {
        const resp = await this.client.postHeartbeat(heartbeatId ?? undefined)
        heartbeatId = resp.heartbeat_id
      } catch { /* heartbeat failed — order may get cancelled */ }
    }

    await sendHeartbeat()

    try {
      const resp: OrderApiResponse = await this.client.createAndPostOrder(
        { tokenID: tokenId, price, size: shares, side: PolySide.BUY },
        { tickSize: market.tickSize as TickSize, negRisk: market.negRisk },
        OrderType.GTC,
      )

      const ok = resp.success !== false && !resp.errorMsg
      logger.info({ orderID: resp.orderID, status: resp.status, errorMsg: resp.errorMsg, ok, market: market.name }, 'GTC buy response')

      if (!ok) {
        return { success: false, status: resp.status, error: resp.errorMsg || 'GTC order rejected', filledShares: 0 }
      }

      // If immediately matched, no need to poll
      if (resp.status === 'matched' && resp.orderID) {
        const matched = Number(resp.takingAmount) || shares
        logger.info({ filledShares: matched, fillPrice: price, market: market.name }, 'GTC buy instant match')
        return { success: true, orderId: resp.orderID, status: 'matched', filledShares: matched, fillPrice: price }
      }

      const orderId = resp.orderID
      if (!orderId) {
        return { success: false, error: 'No orderID returned', filledShares: 0 }
      }

      // Poll getOrder() every 2s for up to 10s, heartbeat mid-poll to stay alive
      let filledShares = 0
      for (let i = 0; i < 5; i++) {
        await Bun.sleep(2_000)
        if (i === 2) await sendHeartbeat() // mid-poll heartbeat at ~6s
        try {
          const o = await this.client.getOrder(orderId)
          const matched = Number(o.size_matched) || 0
          logger.debug({ orderId, poll: i + 1, matched, status: o.status }, 'GTC buy poll')

          if (matched >= shares || o.status === 'matched') {
            filledShares = matched > 0 ? matched : shares
            break
          }
          if (matched > 0) filledShares = matched
        } catch { /* poll failed — retry next iteration */ }
      }

      // Cancel unfilled remainder
      if (filledShares < shares) {
        try { await this.client.cancelOrder({ orderID: orderId }) } catch { /* already filled or cancelled */ }
      }

      if (filledShares === 0) {
        const balance = await this.getTokenBalance(tokenId)
        if (balance > 0) filledShares = balance
      }

      const slippage = filledShares > 0 ? price - order.price : 0
      logger.info({ filledShares, fillPrice: price, signalPrice: order.price, slippage: slippage.toFixed(2), market: market.name }, 'GTC buy fill details')

      if (filledShares === 0) {
        return { success: false, orderId, status: 'no-fill', error: 'GTC matched 0 shares after 10s', filledShares: 0 }
      }
      return { success: true, orderId, status: 'filled', filledShares, fillPrice: price }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error({ err, market: market.name, msg }, 'GTC buy threw')
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
