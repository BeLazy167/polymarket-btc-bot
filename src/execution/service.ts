import { Effect, Context, Layer } from 'effect'
import { ClobClient, Chain, OrderType, Side as PolySide, AssetType } from '@polymarket/clob-client'
import { Wallet } from '@ethersproject/wallet'
import type { MarketConfig, TickSize } from '../config/schema.ts'
import type { ApprovedOrder } from '../risk/service.ts'
import { ExecutionError } from '../errors.ts'
import { ConfigService } from '../config/service.ts'

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

export class Executor extends Context.Tag('Executor')<
  Executor,
  {
    readonly execute: (order: ApprovedOrder, market: MarketConfig) => Effect.Effect<ExecutionResult, ExecutionError>
    readonly sell: (tokenId: string, shares: number, tickSize: TickSize, negRisk?: boolean, bestBid?: number, urgent?: boolean) => Effect.Effect<ExecutionResult, ExecutionError>
  }
>() {}

// ── helpers ──

const parseOrderResponse = (resp: OrderApiResponse): { ok: boolean; taking: number; making: number } => {
  const ok = resp.success !== false && !resp.errorMsg
  return { ok, taking: Number(resp.takingAmount) || 0, making: Number(resp.makingAmount) || 0 }
}

const computeFillPrice = (sold: number, totalUsdcReceived: number): number | undefined => {
  if (sold <= 0 || totalUsdcReceived <= 0 || !Number.isFinite(sold) || !Number.isFinite(totalUsdcReceived)) return undefined
  return Math.round(totalUsdcReceived / sold * 100) / 100
}

// ── Live layer ──

export const ExecutorLive = Layer.effect(
  Executor,
  Effect.gen(function* () {
    const { config } = yield* ConfigService
    const wallet = new Wallet(config.polymarket.privateKey)
    const client = new ClobClient(
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

    const getTokenBalance = (tokenId: string): Effect.Effect<number, ExecutionError> =>
      Effect.tryPromise({
        try: () => client.getBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id: tokenId }),
        catch: (e) => new ExecutionError({ message: `getBalanceAllowance failed: ${e}` }),
      }).pipe(
        Effect.map((resp) => {
          const rawBalance = Number(resp.balance)
          if (!Number.isFinite(rawBalance)) return 0
          return rawBalance / 1e6
        }),
      )

    const waitForBalanceSettlement = (tokenId: string, expectedShares: number, preFillBalance: number = 0): Effect.Effect<void, ExecutionError> =>
      Effect.gen(function* () {
        for (let i = 0; i < 5; i++) {
          const bal = yield* getTokenBalance(tokenId).pipe(Effect.catchAll(() => Effect.succeed(0)))
          if (bal - preFillBalance >= expectedShares * 0.9) return
          yield* Effect.sleep(1000)
        }
        yield* Effect.logWarning('Balance settlement timeout — shares may not be visible yet', { tokenId, expectedShares, preFillBalance })
      })

    /**
     * Rapid FAK-only sell: 3 attempts at 500ms intervals, no GTC, no long balance waits.
     */
    const urgentSell = (tokenId: string, sellSize: number, tickSize: TickSize, negRisk?: boolean, realBalance: number = 0): Effect.Effect<ExecutionResult, ExecutionError> =>
      Effect.gen(function* () {
        let lastOrderId: string | undefined
        let totalUsdcReceived = 0
        let totalSoldShares = 0
        let remainingSize = sellSize

        for (let attempt = 0; attempt < 3; attempt++) {
          const resp = yield* Effect.tryPromise({
            try: () => client.createAndPostMarketOrder(
              { tokenID: tokenId, amount: remainingSize, side: PolySide.SELL },
              { tickSize: tickSize, negRisk },
              OrderType.FAK,
            ) as Promise<OrderApiResponse>,
            catch: () => new ExecutionError({ message: 'FAK threw' }),
          }).pipe(Effect.catchAll(() => Effect.succeed(null as OrderApiResponse | null)))

          if (resp) {
            lastOrderId = resp.orderID
            const { ok, taking, making } = parseOrderResponse(resp)
            if (taking > 0) totalUsdcReceived += taking
            if (ok && making > 0) {
              totalSoldShares += making
              remainingSize = Math.max(Math.floor((remainingSize - making) * 100) / 100, 0)
            }
            yield* Effect.log('Urgent FAK sell', { attempt: attempt + 1, orderID: resp.orderID, ok, making, taking, totalSoldShares, remainingSize })
            if (!ok) break
            if (remainingSize <= 0.5) break
          } else {
            yield* Effect.logWarning('Urgent FAK threw', { attempt: attempt + 1 })
          }
          yield* Effect.sleep(500)
        }

        // Wait 1s for settlement then check actual balance
        yield* Effect.sleep(1000)
        let remaining: number
        let balanceSold: number
        const balResult = yield* getTokenBalance(tokenId).pipe(Effect.either)
        if (balResult._tag === 'Right') {
          remaining = balResult.right
          balanceSold = realBalance - remaining
        } else {
          yield* Effect.logWarning('Balance check after urgent sell failed — using FAK response data', { tokenId, totalSoldShares, totalUsdcReceived })
          remaining = Math.max(realBalance - totalSoldShares, 0)
          balanceSold = totalSoldShares
        }

        // Trust FAK makingAmount when balance lags
        if (remaining > 0.5 && totalSoldShares >= sellSize * 0.9) {
          yield* Effect.log('Urgent sell: trusting FAK (balance stale)', { remaining, totalSoldShares, sellSize })
          remaining = 0
          balanceSold = totalSoldShares
        }

        const sold = Math.min(Math.max(balanceSold, totalSoldShares), realBalance)
        const fillPrice = computeFillPrice(sold, totalUsdcReceived)
        const revenue = totalUsdcReceived > 0 ? totalUsdcReceived : undefined

        if (remaining > 0.5) {
          yield* Effect.logWarning('Urgent sell incomplete', { remaining, sold, totalUsdcReceived, attempts: 3 })
          return { success: false, orderId: lastOrderId, status: 'incomplete', filledShares: sold, remaining, fillPrice, revenue, error: `Urgent: ${remaining.toFixed(2)} remain after 3 FAK` }
        }

        if (sold <= 0) {
          yield* Effect.logWarning('Urgent sell: balance gone but no confirmed fills', { remaining, realBalance, totalSoldShares })
          return { success: false, orderId: lastOrderId, status: 'unknown', remaining, error: 'Balance zero but no confirmed fills' }
        }

        yield* Effect.log('Urgent sell complete', { sold, remaining, totalUsdcReceived, fillPrice })
        return { success: true, orderId: lastOrderId, status: 'filled', filledShares: sold, remaining, fillPrice, revenue }
      })

    return {
      execute: (order: ApprovedOrder, market: MarketConfig): Effect.Effect<ExecutionResult, ExecutionError> =>
        Effect.gen(function* () {
          const tokenId = order.side === 'YES' ? market.yesTokenId : market.noTokenId
          const shares = (market.minOrderSize ?? 5) + 1
          const price = Math.round(Math.min(order.price, 0.97) * 100) / 100

          yield* Effect.log('Executing GTC buy', { strategy: order.strategy, side: order.side, price, marketPrice: order.price, shares, market: market.name })

          const preFillBalance = yield* getTokenBalance(tokenId)

          // Heartbeat keeps GTC order alive
          let heartbeatId: string | undefined
          const sendHeartbeat = Effect.tryPromise({
            try: async () => {
              const resp = await client.postHeartbeat(heartbeatId ?? undefined)
              heartbeatId = resp.heartbeat_id
            },
            catch: () => null,
          }).pipe(Effect.catchAll(() => Effect.logWarning('Heartbeat failed — GTC order may be auto-cancelled')))

          yield* sendHeartbeat

          let trackedOrderId: string | undefined
          const result = yield* Effect.tryPromise({
            try: () => client.createAndPostOrder(
              { tokenID: tokenId, price, size: shares, side: PolySide.BUY },
              { tickSize: market.tickSize as TickSize, negRisk: market.negRisk },
              OrderType.GTC,
            ) as Promise<OrderApiResponse>,
            catch: (e) => new ExecutionError({ message: `GTC buy threw: ${e}`, orderId: trackedOrderId }),
          })
          trackedOrderId = result.orderID

          const ok = result.success !== false && !result.errorMsg
          yield* Effect.log('GTC buy response', { orderID: result.orderID, status: result.status, errorMsg: result.errorMsg, ok, market: market.name })

          if (!ok) {
            return { success: false, status: result.status, error: result.errorMsg || 'GTC order rejected', filledShares: 0 }
          }

          // Immediate match
          if (result.status === 'matched' && result.orderID) {
            const raw = Number(result.takingAmount)
            const matched = Number.isFinite(raw) && raw > 0 ? raw : shares
            yield* Effect.log('GTC buy instant match', { filledShares: matched, fillPrice: price, takingAmount: result.takingAmount, market: market.name })
            yield* waitForBalanceSettlement(tokenId, matched, preFillBalance)
            return { success: true, orderId: result.orderID, status: 'matched', filledShares: matched, fillPrice: price }
          }

          const orderId = result.orderID
          if (!orderId) {
            return { success: false, error: 'No orderID returned', filledShares: 0 }
          }

          // Poll getOrder() every 2s for up to 10s, heartbeat mid-poll
          let filledShares = 0
          let pollFailures = 0
          for (let i = 0; i < 5; i++) {
            yield* Effect.sleep(2_000)
            if (i === 2) yield* sendHeartbeat
            const pollResult = yield* Effect.tryPromise({
              try: () => client.getOrder(orderId),
              catch: () => null,
            }).pipe(Effect.catchAll(() => Effect.succeed(null)))

            if (pollResult) {
              const matched = Number(pollResult.size_matched) || 0
              yield* Effect.logDebug('GTC buy poll', { orderId, poll: i + 1, matched, status: pollResult.status })
              if (matched >= shares || (pollResult.status === 'matched' && matched > 0)) {
                filledShares = matched
                break
              }
              if (matched > 0) filledShares = matched
            } else {
              pollFailures++
              if (pollFailures >= 3) yield* Effect.logWarning('getOrder poll failed 3+ times', { orderId, poll: i + 1, pollFailures })
            }
          }

          // Cancel unfilled remainder
          if (filledShares > 0 && filledShares < shares) {
            yield* Effect.tryPromise({
              try: () => client.cancelOrder({ orderID: orderId }),
              catch: () => null,
            }).pipe(Effect.catchAll(() => Effect.logWarning('cancelOrder failed — GTC buy may still be live', { orderId, filledShares, shares })))
          }

          if (filledShares === 0) {
            yield* Effect.tryPromise({
              try: () => client.cancelOrder({ orderID: orderId }),
              catch: () => null,
            }).pipe(Effect.catchAll(() => Effect.logWarning('cancelOrder failed on zero-fill', { orderId })))
            const balance = yield* getTokenBalance(tokenId).pipe(Effect.catchAll(() => Effect.succeed(0)))
            if (Number.isFinite(balance) && balance > 0) filledShares = balance
          }

          const slippage = filledShares > 0 ? price - order.price : 0
          yield* Effect.log('GTC buy fill details', { filledShares, fillPrice: price, signalPrice: order.price, slippage: slippage.toFixed(2), market: market.name })

          if (filledShares === 0) {
            return { success: false, orderId, status: 'no-fill', error: 'GTC matched 0 shares after 10s', filledShares: 0 }
          }
          yield* waitForBalanceSettlement(tokenId, filledShares, preFillBalance)
          return { success: true, orderId, status: 'filled', filledShares, fillPrice: price }
        }).pipe(
          Effect.catchTag('ExecutionError', (e) => Effect.succeed({ success: false, error: e.message, orderId: e.orderId } as ExecutionResult)),
        ),

      sell: (tokenId: string, _estimatedShares: number, tickSize: TickSize, negRisk?: boolean, bestBid?: number, urgent?: boolean): Effect.Effect<ExecutionResult, ExecutionError> =>
        Effect.gen(function* () {
          const realBalance = yield* getTokenBalance(tokenId)
          if (realBalance <= 0) {
            yield* Effect.logWarning('No token balance — already sold', { tokenId, realBalance })
            return { success: true, status: 'already-sold', remaining: 0 }
          }

          const sellSize = Math.floor(realBalance * 100) / 100
          if (sellSize <= 0) {
            yield* Effect.logWarning('Dust balance too small to sell', { tokenId, realBalance })
            return { success: true, status: 'dust-skip', remaining: 0 }
          }

          yield* Effect.log('Executing sell', { tokenId, realBalance, sellSize, bestBid, urgent, side: 'SELL' })

          // --- Urgent mode ---
          if (urgent) {
            yield* Effect.tryPromise({
              try: () => client.cancelAll(),
              catch: () => null,
            }).pipe(Effect.catchAll(() => Effect.logWarning('cancelAll before urgent sell failed', { tokenId })))
            return yield* urgentSell(tokenId, sellSize, tickSize, negRisk, realBalance)
          }

          // --- Normal mode: FAK then GTC fallback ---
          let lastOrderId: string | undefined
          let totalUsdcReceived = 0
          let fakSoldShares = 0

          const fakResp = yield* Effect.tryPromise({
            try: () => client.createAndPostMarketOrder(
              { tokenID: tokenId, amount: sellSize, side: PolySide.SELL },
              { tickSize: tickSize, negRisk },
              OrderType.FAK,
            ) as Promise<OrderApiResponse>,
            catch: () => new ExecutionError({ message: 'FAK sell threw' }),
          }).pipe(Effect.catchAll(() => Effect.succeed(null as OrderApiResponse | null)))

          if (fakResp) {
            lastOrderId = fakResp.orderID
            const { ok, taking, making } = parseOrderResponse(fakResp)
            if (taking > 0) totalUsdcReceived += taking
            if (ok && making > 0) fakSoldShares = making
            yield* Effect.log('FAK sell response', {
              orderID: fakResp.orderID, status: fakResp.status, errorMsg: fakResp.errorMsg,
              makingAmount: fakResp.makingAmount, takingAmount: fakResp.takingAmount, ok, fakSoldShares,
            })
          } else {
            yield* Effect.logWarning('FAK sell threw', { tokenId })
          }

          // Wait for settlement, then check balance
          yield* Effect.sleep(2000)
          let remaining = yield* getTokenBalance(tokenId).pipe(Effect.catchAll(() => Effect.succeed(realBalance)))

          // If FAK said it sold shares but balance hasn't updated, wait longer
          if (fakSoldShares > 0 && remaining >= realBalance - 0.01) {
            yield* Effect.log('FAK matched but balance stale — waiting 3s more', { fakSoldShares, remaining, realBalance })
            yield* Effect.sleep(3000)
            remaining = yield* getTokenBalance(tokenId).pipe(Effect.catchAll(() => Effect.succeed(remaining)))
          }

          // --- Attempt 2: GTC at best bid if FAK didn't clear ---
          let gtcSoldShares = 0
          const preGtcBalance = remaining
          if (remaining > 0.5) {
            yield* Effect.tryPromise({
              try: () => client.cancelAll(),
              catch: () => null,
            }).pipe(Effect.catchAll(() => Effect.logWarning('cancelAll failed — stale orders may block GTC sell', { tokenId })))

            const gtcSize = Math.floor(remaining * 100) / 100
            const gtcPrice = bestBid && Number.isFinite(bestBid) ? Math.round(Math.max(bestBid - 0.01, 0.01) * 100) / 100 : 0.01
            if (gtcSize >= 5) {
              yield* Effect.logWarning('FAK did not clear — placing GTC sell', { tokenId, remaining, gtcSize, gtcPrice })
              const gtcResp = yield* Effect.tryPromise({
                try: () => client.createAndPostOrder(
                  { tokenID: tokenId, price: gtcPrice, size: gtcSize, side: PolySide.SELL },
                  { tickSize: tickSize, negRisk },
                  OrderType.GTC,
                ) as Promise<OrderApiResponse>,
                catch: () => new ExecutionError({ message: 'GTC sell threw' }),
              }).pipe(Effect.catchAll(() => Effect.succeed(null as OrderApiResponse | null)))

              if (gtcResp) {
                lastOrderId = gtcResp.orderID
                const { ok, taking: gtcTaking, making: gtcMaking } = parseOrderResponse(gtcResp)
                if (gtcTaking > 0) totalUsdcReceived += gtcTaking
                if (ok && gtcMaking > 0) gtcSoldShares = gtcMaking
                yield* Effect.log('GTC sell response', { orderID: gtcResp.orderID, status: gtcResp.status, errorMsg: gtcResp.errorMsg, takingAmount: gtcResp.takingAmount, makingAmount: gtcResp.makingAmount, gtcPrice, ok, gtcSoldShares })

                yield* Effect.sleep(2000)
                remaining = yield* getTokenBalance(tokenId).pipe(Effect.catchAll(() => Effect.succeed(remaining)))

                if (gtcSoldShares > 0 && remaining >= preGtcBalance - 0.01) {
                  yield* Effect.log('GTC sell matched but balance stale — waiting 3s more', { gtcSoldShares, remaining, preGtcBalance })
                  yield* Effect.sleep(3000)
                  remaining = yield* getTokenBalance(tokenId).pipe(Effect.catchAll(() => Effect.succeed(remaining)))
                }
              } else {
                yield* Effect.logWarning('GTC sell also threw', { tokenId })
              }
            } else if (remaining > 0.5) {
              yield* Effect.log('GTC sell skipped — sub-minimum size', { tokenId, remaining, gtcSize })
            }
          }

          // Trust max of balance diff, FAK response, and GTC response — clamped to realBalance
          const balanceSold = realBalance - remaining
          const sold = Math.min(Math.max(balanceSold, fakSoldShares, gtcSoldShares), realBalance)
          if ((fakSoldShares > 0 || gtcSoldShares > 0) && balanceSold <= 0) {
            yield* Effect.logWarning('Using order response (balance stale)', { fakSoldShares, gtcSoldShares, balanceSold, remaining, realBalance })
          }

          const fillPrice = computeFillPrice(sold, totalUsdcReceived)
          const revenue = totalUsdcReceived > 0 ? totalUsdcReceived : undefined

          if (remaining > 0.5 && remaining < 5) {
            if (sold <= 0) {
              yield* Effect.logWarning('Sub-minimum unsold — FAK no match, will retry', { tokenId, remaining, realBalance })
              return { success: false, orderId: lastOrderId, status: 'no-fill', remaining, error: `Sub-min ${remaining.toFixed(2)} shares — FAK no match` }
            }
            yield* Effect.logWarning('Sub-minimum remaining — dust, will settle on-chain', { tokenId, remaining, sold, totalUsdcReceived })
            return { success: true, orderId: lastOrderId, status: 'dust-remaining', filledShares: sold, remaining, fillPrice, revenue }
          }
          if (remaining > 0.5) {
            yield* Effect.logWarning('Sell incomplete — shares still in wallet', { tokenId, remaining, sold, realBalance, totalUsdcReceived })
            return { success: false, orderId: lastOrderId, status: 'incomplete', filledShares: sold, remaining, fillPrice, revenue, error: `${remaining.toFixed(2)} shares remain` }
          }

          yield* Effect.log('Sell complete', { sold, remaining, totalUsdcReceived, fillPrice, orderId: lastOrderId })
          return { success: true, orderId: lastOrderId, status: 'filled', filledShares: sold, remaining, fillPrice, revenue }
        }).pipe(
          Effect.catchTag('ExecutionError', (e) => Effect.succeed({ success: false, error: e.message } as ExecutionResult)),
        ),
    }
  }),
)

// ── Paper layer ──

export const ExecutorPaper = Layer.succeed(
  Executor,
  (() => {
    const trades: Array<{ timestamp: number; market: string; side: string; sizeUsdc: number; strategy: string; edge: number }> = []

    return {
      execute: (order: ApprovedOrder, market: MarketConfig) =>
        Effect.gen(function* () {
          const trade = { timestamp: Date.now(), market: market.name, side: order.side, sizeUsdc: order.sizeUsdc, strategy: order.strategy, edge: order.edge }
          trades.push(trade)
          yield* Effect.log('Paper trade executed', { ...trade, mode: 'PAPER' })
          return { success: true, orderId: `paper-${Date.now()}`, status: 'simulated' } satisfies ExecutionResult
        }),

      sell: (tokenId: string, shares: number, _tickSize: TickSize, _negRisk?: boolean, _bestBid?: number, _urgent?: boolean) =>
        Effect.gen(function* () {
          yield* Effect.log('Paper SELL executed', { tokenId, shares, side: 'SELL', mode: 'PAPER' })
          return { success: true, orderId: `paper-sell-${Date.now()}`, status: 'simulated', filledShares: shares, remaining: 0 } satisfies ExecutionResult
        }),
    }
  })(),
)
