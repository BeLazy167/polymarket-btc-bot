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
  executeStinkBid(order: ApprovedOrder, market: MarketConfig, windowEndMs: number): Promise<ExecutionResult>
  sell(tokenId: string, shares: number, tickSize: TickSize, negRisk?: boolean, bestBid?: number, urgent?: boolean): Promise<ExecutionResult>
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

    // Snapshot balance before buy so settlement wait checks delta, not absolute
    const preFillBalance = await this.getTokenBalance(tokenId)

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

      // If immediately matched, wait for balance settlement then return
      if (resp.status === 'matched' && resp.orderID) {
        const raw = Number(resp.takingAmount)
        const matched = Number.isFinite(raw) && raw > 0 ? raw : shares
        logger.info({ filledShares: matched, fillPrice: price, takingAmount: resp.takingAmount, market: market.name }, 'GTC buy instant match')
        await this.waitForBalanceSettlement(tokenId, matched, preFillBalance)
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
      await this.waitForBalanceSettlement(tokenId, filledShares, preFillBalance)
      return { success: true, orderId, status: 'filled', filledShares, fillPrice: price }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error({ err, market: market.name, msg, orderId: trackedOrderId }, 'GTC buy threw')
      return { success: false, error: msg, orderId: trackedOrderId }
    }
  }

  /**
   * Place a stink bid (GTC limit order) and keep it open until filled or 60s before window end.
   * Polls every 10s with heartbeats. Matches MoonDev's CVD bot timing.
   */
  async executeStinkBid(order: ApprovedOrder, market: MarketConfig, windowEndMs: number): Promise<ExecutionResult> {
    const MIN_TIME_LEFT = 60_000
    const POLL_INTERVAL = 10_000
    const tokenId = order.side === 'YES' ? market.yesTokenId : market.noTokenId
    const shares = (market.minOrderSize ?? 5) + 1
    const price = Math.round(Math.min(order.price, 0.97) * 100) / 100

    logger.info({ strategy: order.strategy, side: order.side, price, shares, market: market.name }, 'Placing stink bid')

    const preFillBalance = await this.getTokenBalance(tokenId)

    let heartbeatId: string | undefined
    const sendHeartbeat = async () => {
      try {
        const resp = await this.client.postHeartbeat(heartbeatId ?? undefined)
        heartbeatId = resp.heartbeat_id
      } catch (err) { logger.warn({ err, market: market.name }, 'Stink bid heartbeat failed') }
    }

    await sendHeartbeat()

    try {
      const resp: OrderApiResponse = await this.client.createAndPostOrder(
        { tokenID: tokenId, price, size: shares, side: PolySide.BUY },
        { tickSize: market.tickSize as TickSize, negRisk: market.negRisk },
        OrderType.GTC,
      )

      const ok = resp.success !== false && !resp.errorMsg
      logger.info({ orderID: resp.orderID, status: resp.status, errorMsg: resp.errorMsg, ok }, 'Stink bid response')

      if (!ok) {
        return { success: false, status: resp.status, error: resp.errorMsg || 'Stink bid rejected', filledShares: 0 }
      }

      // Instant match
      if (resp.status === 'matched' && resp.orderID) {
        const raw = Number(resp.takingAmount)
        const matched = Number.isFinite(raw) && raw > 0 ? raw : shares
        logger.info({ filledShares: matched, fillPrice: price }, 'Stink bid instant match')
        await this.waitForBalanceSettlement(tokenId, matched, preFillBalance)
        return { success: true, orderId: resp.orderID, status: 'matched', filledShares: matched, fillPrice: price }
      }

      const orderId = resp.orderID
      if (!orderId) {
        return { success: false, error: 'No orderID returned', filledShares: 0 }
      }

      // Poll every 10s until 60s before window end
      while (true) {
        const timeLeft = windowEndMs - Date.now()
        if (timeLeft < MIN_TIME_LEFT) {
          logger.info({ orderId, timeLeft: Math.round(timeLeft / 1000) }, 'Stink bid cancelled — window ending')
          try { await this.client.cancelOrder({ orderID: orderId }) } catch {}
          return { success: false, orderId, status: 'cancelled', error: 'Window ending', filledShares: 0 }
        }

        await Bun.sleep(POLL_INTERVAL)
        await sendHeartbeat()

        try {
          const o = await this.client.getOrder(orderId)
          const matched = Number(o.size_matched) || 0
          logger.debug({ orderId, matched, status: o.status, timeLeft: Math.round(timeLeft / 1000) }, 'Stink bid poll')

          if (matched >= shares || (o.status === 'matched' && matched > 0)) {
            logger.info({ filledShares: matched, fillPrice: price }, 'Stink bid filled!')
            await this.waitForBalanceSettlement(tokenId, matched, preFillBalance)
            return { success: true, orderId, status: 'filled', filledShares: matched, fillPrice: price }
          }
          if (o.status === 'CANCELED') {
            logger.info({ orderId }, 'Stink bid was cancelled by exchange')
            return { success: false, orderId, status: 'cancelled', error: 'Order cancelled by exchange', filledShares: 0 }
          }
        } catch (pollErr) {
          logger.warn({ err: pollErr, orderId }, 'Stink bid poll failed')
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error({ err, market: market.name }, 'Stink bid threw')
      return { success: false, error: msg }
    }
  }

  /** Poll balance via CLOB API until filled shares are visible (up to 5s). Uses delta from preFillBalance to handle pre-existing dust. */
  private async waitForBalanceSettlement(tokenId: string, expectedShares: number, preFillBalance: number = 0): Promise<void> {
    for (let i = 0; i < 5; i++) {
      try {
        const bal = await this.getTokenBalance(tokenId)
        if (bal - preFillBalance >= expectedShares * 0.9) return
      } catch (err) {
        logger.warn({ err, tokenId, poll: i + 1 }, 'Balance check failed during settlement wait')
      }
      await Bun.sleep(1000)
    }
    logger.warn({ tokenId, expectedShares, preFillBalance }, 'Balance settlement timeout — shares may not be visible yet')
  }

  /** Compute avg fill price from total revenue / shares sold, rounded to tick. */
  private computeFillPrice(sold: number, totalUsdcReceived: number): number | undefined {
    if (sold <= 0 || totalUsdcReceived <= 0 || !Number.isFinite(sold) || !Number.isFinite(totalUsdcReceived)) return undefined
    return Math.round(totalUsdcReceived / sold * 100) / 100
  }

  /** Parse a FAK/GTC order response into ok/taking/making. */
  private parseOrderResponse(resp: OrderApiResponse): { ok: boolean; taking: number; making: number } {
    const ok = resp.success !== false && !resp.errorMsg
    return { ok, taking: Number(resp.takingAmount) || 0, making: Number(resp.makingAmount) || 0 }
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

  /**
   * Sell shares. When urgent=true, skips GTC and retries FAK 3x at 500ms intervals
   * for time-critical exits (trailing stop, TP, rider SL, emergency dump).
   */
  async sell(tokenId: string, _estimatedShares: number, tickSize: TickSize, negRisk?: boolean, bestBid?: number, urgent?: boolean): Promise<ExecutionResult> {
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

      logger.info({ tokenId, realBalance, sellSize, bestBid, urgent, side: 'SELL' }, 'Executing sell')

      // --- Urgent mode: cancel stale orders, then rapid FAK retries ---
      if (urgent) {
        try { await this.client.cancelAll() } catch (e) { logger.warn({ err: e, tokenId }, 'cancelAll before urgent sell failed — FAK may hit locked shares') }
        return this.urgentSell(tokenId, sellSize, tickSize, negRisk, realBalance)
      }

      // --- Normal mode: FAK then GTC fallback ---
      let lastOrderId: string | undefined
      let totalUsdcReceived = 0
      let fakSoldShares = 0
      try {
        const resp: OrderApiResponse = await this.client.createAndPostMarketOrder(
          { tokenID: tokenId, amount: sellSize, side: PolySide.SELL },
          { tickSize: tickSize, negRisk },
          OrderType.FAK,
        )
        lastOrderId = resp.orderID
        const { ok, taking, making } = this.parseOrderResponse(resp)
        if (taking > 0) totalUsdcReceived += taking
        if (ok && making > 0) fakSoldShares = making
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

      // If FAK said it sold shares but balance hasn't updated, wait longer
      if (fakSoldShares > 0 && remaining >= realBalance - 0.01) {
        logger.info({ fakSoldShares, remaining, realBalance }, 'FAK matched but balance stale — waiting 3s more')
        await Bun.sleep(3000)
        remaining = await this.getTokenBalance(tokenId)
      }

      // --- Attempt 2: GTC at best bid if FAK didn't clear ---
      let gtcSoldShares = 0
      const preGtcBalance = remaining
      if (remaining > 0.5) {
        try { await this.client.cancelAll() } catch (cancelErr) { logger.warn({ err: cancelErr, tokenId }, 'cancelAll failed — stale orders may block GTC sell') }

        const gtcSize = Math.floor(remaining * 100) / 100
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
            const { ok, taking: gtcTaking, making: gtcMaking } = this.parseOrderResponse(gtcResp)
            if (gtcTaking > 0) totalUsdcReceived += gtcTaking
            if (ok && gtcMaking > 0) gtcSoldShares = gtcMaking
            logger.info({ orderID: gtcResp.orderID, status: gtcResp.status, errorMsg: gtcResp.errorMsg, takingAmount: gtcResp.takingAmount, makingAmount: gtcResp.makingAmount, gtcPrice, ok, gtcSoldShares }, 'GTC sell response')

            await Bun.sleep(2000)
            remaining = await this.getTokenBalance(tokenId)

            if (gtcSoldShares > 0 && remaining >= preGtcBalance - 0.01) {
              logger.info({ gtcSoldShares, remaining, preGtcBalance }, 'GTC sell matched but balance stale — waiting 3s more')
              await Bun.sleep(3000)
              remaining = await this.getTokenBalance(tokenId)
            }
          } catch (gtcErr) {
            logger.warn({ err: gtcErr, tokenId }, 'GTC sell also threw')
          }
        } else if (remaining > 0.5) {
          logger.info({ tokenId, remaining, gtcSize }, 'GTC sell skipped — sub-minimum size')
        }
      }

      // Trust max of balance diff, FAK response, and GTC response — clamped to realBalance
      const balanceSold = realBalance - remaining
      const sold = Math.min(Math.max(balanceSold, fakSoldShares, gtcSoldShares), realBalance)
      if ((fakSoldShares > 0 || gtcSoldShares > 0) && balanceSold <= 0) {
        logger.warn({ fakSoldShares, gtcSoldShares, balanceSold, remaining, realBalance }, 'Using order response (balance stale)')
      }

      const fillPrice = this.computeFillPrice(sold, totalUsdcReceived)
      const revenue = totalUsdcReceived > 0 ? totalUsdcReceived : undefined

      if (remaining > 0.5 && remaining < 5) {
        if (sold <= 0) {
          logger.warn({ tokenId, remaining, realBalance }, 'Sub-minimum unsold — FAK no match, will retry')
          return { success: false, orderId: lastOrderId, status: 'no-fill', remaining, error: `Sub-min ${remaining.toFixed(2)} shares — FAK no match` }
        }
        logger.warn({ tokenId, remaining, sold, totalUsdcReceived }, 'Sub-minimum remaining — dust, will settle on-chain')
        return { success: true, orderId: lastOrderId, status: 'dust-remaining', filledShares: sold, remaining, fillPrice, revenue }
      }
      if (remaining > 0.5) {
        logger.warn({ tokenId, remaining, sold, realBalance, totalUsdcReceived }, 'Sell incomplete — shares still in wallet')
        return { success: false, orderId: lastOrderId, status: 'incomplete', filledShares: sold, remaining, fillPrice, revenue, error: `${remaining.toFixed(2)} shares remain` }
      }

      logger.info({ sold, remaining, totalUsdcReceived, fillPrice, orderId: lastOrderId }, 'Sell complete')
      return { success: true, orderId: lastOrderId, status: 'filled', filledShares: sold, remaining, fillPrice, revenue }
    } catch (err) {
      logger.error({ err, tokenId }, 'Sell threw — position state unknown')
      return { success: false, error: err instanceof Error ? err.message : String(err), status: 'error' }
    }
  }

  /** Rapid FAK-only sell: 3 attempts at 500ms intervals, no GTC, no long balance waits. */
  private async urgentSell(tokenId: string, sellSize: number, tickSize: TickSize, negRisk?: boolean, realBalance: number = 0): Promise<ExecutionResult> {
    let lastOrderId: string | undefined
    let totalUsdcReceived = 0
    let totalSoldShares = 0
    let remainingSize = sellSize

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const resp: OrderApiResponse = await this.client.createAndPostMarketOrder(
          { tokenID: tokenId, amount: remainingSize, side: PolySide.SELL },
          { tickSize: tickSize, negRisk },
          OrderType.FAK,
        )
        lastOrderId = resp.orderID
        const { ok, taking, making } = this.parseOrderResponse(resp)
        if (taking > 0) totalUsdcReceived += taking
        if (ok && making > 0) {
          totalSoldShares += making
          remainingSize = Math.max(Math.floor((remainingSize - making) * 100) / 100, 0)
        }
        logger.info({ attempt: attempt + 1, orderID: resp.orderID, ok, making, taking, totalSoldShares, remainingSize }, 'Urgent FAK sell')

        if (!ok) break  // hard rejection (market halted, auth error) — don't retry
        if (remainingSize <= 0.5) break  // fully sold or dust remaining
      } catch (err) {
        logger.warn({ err, attempt: attempt + 1 }, 'Urgent FAK threw')
      }
      await Bun.sleep(500)
    }

    // Wait 1s for settlement then check actual balance
    await Bun.sleep(1000)
    let remaining: number
    let balanceSold: number
    try {
      remaining = await this.getTokenBalance(tokenId)
      balanceSold = realBalance - remaining
    } catch (err) {
      logger.warn({ err, tokenId, totalSoldShares, totalUsdcReceived }, 'Balance check after urgent sell failed — using FAK response data')
      remaining = Math.max(realBalance - totalSoldShares, 0)
      balanceSold = totalSoldShares
    }
    // Trust FAK makingAmount when balance lags — prevents stale-balance retries
    if (remaining > 0.5 && totalSoldShares >= sellSize * 0.9) {
      logger.info({ remaining, totalSoldShares, sellSize }, 'Urgent sell: trusting FAK (balance stale)')
      remaining = 0
      balanceSold = totalSoldShares
    }

    const sold = Math.min(Math.max(balanceSold, totalSoldShares), realBalance)
    const fillPrice = this.computeFillPrice(sold, totalUsdcReceived)
    const revenue = totalUsdcReceived > 0 ? totalUsdcReceived : undefined

    if (remaining > 0.5) {
      logger.warn({ remaining, sold, totalUsdcReceived, attempts: 3 }, 'Urgent sell incomplete')
      return { success: false, orderId: lastOrderId, status: 'incomplete', filledShares: sold, remaining, fillPrice, revenue, error: `Urgent: ${remaining.toFixed(2)} remain after 3 FAK` }
    }

    if (sold <= 0) {
      logger.warn({ remaining, realBalance, totalSoldShares }, 'Urgent sell: balance gone but no confirmed fills')
      return { success: false, orderId: lastOrderId, status: 'unknown', remaining, error: 'Balance zero but no confirmed fills' }
    }

    logger.info({ sold, remaining, totalUsdcReceived, fillPrice }, 'Urgent sell complete')
    return { success: true, orderId: lastOrderId, status: 'filled', filledShares: sold, remaining, fillPrice, revenue }
  }
}
