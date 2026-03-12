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
  sell(tokenId: string, shares: number, tickSize: TickSize, negRisk?: boolean, bestBid?: number): Promise<ExecutionResult>
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
    const shares = (market.minOrderSize ?? 5) + 1  // +1 to cover fee deduction, ensures post-fee balance > minOrderSize
    const price = Math.round(Math.min(order.price, 0.97) * 100) / 100

    logger.info({ strategy: order.strategy, side: order.side, price, marketPrice: order.price, shares, market: market.name }, 'Executing GTC buy')

    // Heartbeat keeps GTC order alive (Polymarket cancels all orders if no heartbeat within 10-15s)
    let heartbeatId: string | undefined
    const sendHeartbeat = async () => {
      try {
        const resp = await this.client.postHeartbeat(heartbeatId ?? undefined)
        heartbeatId = resp.heartbeat_id
      } catch (err) { logger.warn({ err, heartbeatId, market: market.name }, 'Heartbeat failed — GTC order may be auto-cancelled') }
    }

    await sendHeartbeat()

    let trackedOrderId: string | undefined
    try {
      const resp: OrderApiResponse = await this.client.createAndPostOrder(
        { tokenID: tokenId, price, size: shares, side: PolySide.BUY },
        { tickSize: market.tickSize as TickSize, negRisk: market.negRisk },
        OrderType.GTC,
      )
      trackedOrderId = resp.orderID

      const ok = resp.success !== false && !resp.errorMsg
      logger.info({ orderID: resp.orderID, status: resp.status, errorMsg: resp.errorMsg, ok, market: market.name }, 'GTC buy response')

      if (!ok) {
        return { success: false, status: resp.status, error: resp.errorMsg || 'GTC order rejected', filledShares: 0 }
      }

      // If immediately matched, no need to poll
      if (resp.status === 'matched' && resp.orderID) {
        const raw = Number(resp.takingAmount)
        const matched = Number.isFinite(raw) && raw > 0 ? raw : shares
        logger.info({ filledShares: matched, fillPrice: price, takingAmount: resp.takingAmount, market: market.name }, 'GTC buy instant match')
        return { success: true, orderId: resp.orderID, status: 'matched', filledShares: matched, fillPrice: price }
      }

      const orderId = resp.orderID
      if (!orderId) {
        return { success: false, error: 'No orderID returned', filledShares: 0 }
      }

      // Poll getOrder() every 2s for up to 10s, heartbeat mid-poll to stay alive
      let filledShares = 0
      let pollFailures = 0
      for (let i = 0; i < 5; i++) {
        await Bun.sleep(2_000)
        if (i === 2) await sendHeartbeat() // mid-poll heartbeat at ~6s
        try {
          const o = await this.client.getOrder(orderId)
          const matched = Number(o.size_matched) || 0
          logger.debug({ orderId, poll: i + 1, matched, status: o.status }, 'GTC buy poll')

          if (matched >= shares || (o.status === 'matched' && matched > 0)) {
            filledShares = matched
            break
          }
          if (matched > 0) filledShares = matched
        } catch (pollErr) {
          pollFailures++
          if (pollFailures >= 3) logger.warn({ err: pollErr, orderId, poll: i + 1, pollFailures }, 'getOrder poll failed 3+ times')
        }
      }

      // Cancel unfilled remainder (skip if fully filled)
      if (filledShares > 0 && filledShares < shares) {
        try { await this.client.cancelOrder({ orderID: orderId }) } catch (cancelErr) { logger.warn({ err: cancelErr, orderId, filledShares, shares }, 'cancelOrder failed — GTC buy may still be live') }
      }

      if (filledShares === 0) {
        // Cancel first, then check balance
        try { await this.client.cancelOrder({ orderID: orderId }) } catch (cancelErr) { logger.warn({ err: cancelErr, orderId }, 'cancelOrder failed on zero-fill') }
        const balance = await this.getTokenBalance(tokenId)
        if (Number.isFinite(balance) && balance > 0) filledShares = balance
      }

      const slippage = filledShares > 0 ? price - order.price : 0
      logger.info({ filledShares, fillPrice: price, signalPrice: order.price, slippage: slippage.toFixed(2), market: market.name }, 'GTC buy fill details')

      if (filledShares === 0) {
        return { success: false, orderId, status: 'no-fill', error: 'GTC matched 0 shares after 10s', filledShares: 0 }
      }
      return { success: true, orderId, status: 'filled', filledShares, fillPrice: price }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error({ err, market: market.name, msg, orderId: trackedOrderId }, 'GTC buy threw')
      return { success: false, error: msg, orderId: trackedOrderId }
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

  async sell(tokenId: string, _estimatedShares: number, tickSize: TickSize, negRisk?: boolean, bestBid?: number): Promise<ExecutionResult> {
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

      logger.info({ tokenId, realBalance, sellSize, bestBid, side: 'SELL' }, 'Executing sell')

      // --- Attempt 1: FAK ---
      let lastOrderId: string | undefined
      let totalUsdcReceived = 0
      let fakSoldShares = 0  // B1: trust FAK response, not just balance diff
      try {
        const resp: OrderApiResponse = await this.client.createAndPostMarketOrder(
          { tokenID: tokenId, amount: sellSize, side: PolySide.SELL },
          { tickSize: tickSize, negRisk },
          OrderType.FAK,
        )
        lastOrderId = resp.orderID
        const ok = resp.success !== false && !resp.errorMsg
        const taking = Number(resp.takingAmount) || 0
        const making = Number(resp.makingAmount) || 0
        if (taking > 0) totalUsdcReceived += taking
        if (ok && making > 0) fakSoldShares = making  // B1: shares FAK claims it sold
        logger.info({
          orderID: resp.orderID, status: resp.status, errorMsg: resp.errorMsg,
          makingAmount: resp.makingAmount, takingAmount: resp.takingAmount, ok, fakSoldShares,
        }, 'FAK sell response')
      } catch (fakErr) {
        logger.warn({ err: fakErr, tokenId }, 'FAK sell threw')
      }

      // Wait for settlement, then check balance
      await Bun.sleep(2000)
      let remaining = await this.getTokenBalance(tokenId)

      // B1: if FAK said it sold shares but balance hasn't updated, wait longer
      if (fakSoldShares > 0 && remaining >= realBalance - 0.01) {
        logger.info({ fakSoldShares, remaining, realBalance }, 'FAK matched but balance stale — waiting 3s more')
        await Bun.sleep(3000)
        remaining = await this.getTokenBalance(tokenId)
      }

      // --- Attempt 2: GTC at best bid if FAK didn't clear ---
      if (remaining > 0.5) {
        try { await this.client.cancelAll() } catch (cancelErr) { logger.warn({ err: cancelErr, tokenId }, 'cancelAll failed — stale orders may block GTC sell') }

        const gtcSize = Math.floor(remaining * 100) / 100
        // B2: use bestBid for GTC price instead of 1¢ — actually gets filled
        const gtcPrice = bestBid && Number.isFinite(bestBid) ? Math.round(Math.max(bestBid - 0.01, 0.01) * 100) / 100 : 0.01
        if (gtcSize >= 5) {
          logger.warn({ tokenId, remaining, gtcSize, gtcPrice }, 'FAK did not clear — placing GTC sell')
          try {
            const gtcResp: OrderApiResponse = await this.client.createAndPostOrder(
              { tokenID: tokenId, price: gtcPrice, size: gtcSize, side: PolySide.SELL },
              { tickSize: tickSize, negRisk },
              OrderType.GTC,
            )
            lastOrderId = gtcResp.orderID
            const ok = gtcResp.success !== false && !gtcResp.errorMsg
            const gtcTaking = Number(gtcResp.takingAmount) || 0
            if (gtcTaking > 0) totalUsdcReceived += gtcTaking
            logger.info({ orderID: gtcResp.orderID, status: gtcResp.status, errorMsg: gtcResp.errorMsg, takingAmount: gtcResp.takingAmount, gtcPrice, ok }, 'GTC sell response')

            await Bun.sleep(2000)
            remaining = await this.getTokenBalance(tokenId)
          } catch (gtcErr) {
            logger.warn({ err: gtcErr, tokenId }, 'GTC sell also threw')
          }
        } else if (remaining > 0.5) {
          logger.info({ tokenId, remaining, gtcSize }, 'GTC sell skipped — sub-minimum size')
        }
      }

      // B1: use max of balance diff and FAK-reported sold shares, clamped to realBalance
      const balanceSold = realBalance - remaining
      const sold = Math.min(Math.max(balanceSold, fakSoldShares), realBalance)
      if (fakSoldShares > 0 && balanceSold <= 0) {
        logger.warn({ fakSoldShares, balanceSold, remaining, realBalance }, 'Using FAK response (balance stale)')
      }

      const fillPrice = sold > 0 && totalUsdcReceived > 0 && Number.isFinite(sold) && Number.isFinite(totalUsdcReceived)
        ? Math.round(totalUsdcReceived / sold * 100) / 100
        : undefined

      // Final truth: balance determines success (with FAK trust override)
      if (remaining > 0.5 && remaining < 5) {
        if (sold <= 0) {
          logger.warn({ tokenId, remaining, realBalance }, 'Sub-minimum unsold — FAK no match, will retry')
          return { success: false, orderId: lastOrderId, status: 'no-fill', remaining, error: `Sub-min ${remaining.toFixed(2)} shares — FAK no match` }
        }
        logger.warn({ tokenId, remaining, sold, totalUsdcReceived }, 'Sub-minimum remaining — dust, will settle on-chain')
        return { success: true, orderId: lastOrderId, status: 'dust-remaining', filledShares: sold, remaining, fillPrice, revenue: totalUsdcReceived > 0 ? totalUsdcReceived : undefined }
      }
      if (remaining > 0.5) {
        logger.warn({ tokenId, remaining, sold, realBalance, totalUsdcReceived }, 'Sell incomplete — shares still in wallet')
        return { success: false, orderId: lastOrderId, status: 'incomplete', filledShares: sold, remaining, fillPrice, revenue: totalUsdcReceived > 0 ? totalUsdcReceived : undefined, error: `${remaining.toFixed(2)} shares remain` }
      }

      logger.info({ sold, remaining, totalUsdcReceived, fillPrice, orderId: lastOrderId }, 'Sell complete')
      return { success: true, orderId: lastOrderId, status: 'filled', filledShares: sold, remaining, fillPrice, revenue: totalUsdcReceived > 0 ? totalUsdcReceived : undefined }
    } catch (err) {
      logger.error({ err, tokenId }, 'Sell threw')
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}
