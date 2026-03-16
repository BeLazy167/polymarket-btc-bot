import { Effect, Context, Layer, Ref, Schedule, Fiber, type Scope } from 'effect'
import { ConfigService } from '../config/service.ts'
import { AlertError } from '../errors.ts'

// ---------------------------------------------------------------------------
// Interfaces (re-exported as before)
// ---------------------------------------------------------------------------

export interface EntryAlertData {
  strategy: string
  side: 'YES' | 'NO'
  entryPrice: number
  edge: number
  btcPrice: number
  signalPrice?: number
  fillPrice?: number
}

export interface ExitAlertData {
  strategy: string
  side: 'YES' | 'NO'
  entryPrice: number
  exitPrice: number
  pnl: number
  reason: string
  holdSec: number
  soldShares?: number
  revenue?: number
}

export interface SellFailureData {
  side: 'YES' | 'NO'
  entryPrice: number
  strategy: string
  remaining: number
  attempts: number
  error?: string
}

// ---------------------------------------------------------------------------
// Session stats tracked in Ref
// ---------------------------------------------------------------------------

interface SessionStats {
  pnl: number
  trades: number
  wins: number
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface AlertsService {
  readonly isPaused: Effect.Effect<boolean>
  readonly startPolling: (
    onStop: () => void,
    onStart: () => void,
  ) => Effect.Effect<void, AlertError, Scope.Scope>
  readonly stopPolling: Effect.Effect<void>
  readonly sendEntryAlert: (data: EntryAlertData) => Effect.Effect<void, AlertError>
  readonly sendExitAlert: (data: ExitAlertData) => Effect.Effect<void, AlertError>
  readonly sendSellFailureAlert: (data: SellFailureData) => Effect.Effect<void, AlertError>
  readonly sendStartAlert: (mode: string, sizeUsdc: number, maxLoss: number) => Effect.Effect<void, AlertError>
  readonly sendErrorAlert: (message: string) => Effect.Effect<void, AlertError>
  readonly sendDailySummary: (pnl: number, trades: number, wins: number) => Effect.Effect<void, AlertError>
}

export class Alerts extends Context.Tag('Alerts')<Alerts, AlertsService>() {}

// ---------------------------------------------------------------------------
// Helpers (pure)
// ---------------------------------------------------------------------------

function fmtPnl(pnl: number): string {
  return pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`
}

function pnlEmoji(pnl: number): string {
  if (pnl >= 0.20) return '🔥'
  if (pnl > 0) return '✅'
  if (pnl > -0.20) return '📉'
  return '🔴'
}

function statsLine(s: SessionStats): string {
  const wr = s.trades > 0 ? ((s.wins / s.trades) * 100).toFixed(0) : '0'
  return `📊 ${fmtPnl(s.pnl)} · ${s.trades} trades · ${wr}% WR`
}

// ---------------------------------------------------------------------------
// Live layer
// ---------------------------------------------------------------------------

export const AlertsLive = Layer.effect(
  Alerts,
  Effect.gen(function* () {
    const { config } = yield* ConfigService
    const tg = config.telegram
    const enabled = tg.enabled && tg.botToken !== '' && tg.chatId !== ''

    const pausedRef = yield* Ref.make(false)
    const statsRef = yield* Ref.make<SessionStats>({ pnl: 0, trades: 0, wins: 0 })
    const pollFiberRef = yield* Ref.make<Fiber.RuntimeFiber<void, never> | null>(null)
    const pollOffsetRef = yield* Ref.make(0)

    // -- private send helper ------------------------------------------------
    const send = (text: string): Effect.Effect<void, AlertError> =>
      !enabled
        ? Effect.log('alert skipped (disabled)').pipe(Effect.annotateLogs('text', text))
        : Effect.tryPromise({
            try: async () => {
              const url = `https://api.telegram.org/bot${tg.botToken}/sendMessage`
              const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  chat_id: tg.chatId,
                  text,
                  parse_mode: 'HTML',
                  disable_notification: false,
                }),
              })
              if (!res.ok) {
                const body = await res.text()
                throw new Error(`telegram ${res.status}: ${body}`)
              }
            },
            catch: (e) => new AlertError({ message: `${e}` }),
          })

    // -- getStats helper for message formatting -----------------------------
    const getStats = Ref.get(statsRef)

    // -- service implementation ---------------------------------------------
    const service: AlertsService = {
      isPaused: Ref.get(pausedRef),

      startPolling: (onStop, onStart) =>
        Effect.gen(function* () {
          if (!enabled) return

          // Flush stale updates
          yield* Effect.tryPromise({
            try: async () => {
              const flushUrl = `https://api.telegram.org/bot${tg.botToken}/getUpdates?offset=-1&timeout=0`
              const res = await fetch(flushUrl)
              if (res.ok) {
                const data = (await res.json()) as {
                  ok: boolean
                  result: Array<{ update_id: number }>
                }
                if (data.ok && data.result.length > 0) {
                  return data.result[data.result.length - 1]!.update_id + 1
                }
              }
              return 0
            },
            catch: () => new AlertError({ message: 'Failed to flush stale Telegram updates' }),
          }).pipe(
            Effect.tap((offset) => Ref.set(pollOffsetRef, offset)),
            Effect.catchAll((e) => Effect.log(`flush warning: ${e.message}`)),
          )

          let consecutiveFailures = 0

          const pollOnce = Effect.gen(function* () {
            const offset = yield* Ref.get(pollOffsetRef)
            const url = `https://api.telegram.org/bot${tg.botToken}/getUpdates?offset=${offset}&timeout=0`

            const updates = yield* Effect.tryPromise({
              try: async () => {
                const res = await fetch(url)
                if (!res.ok) return []
                const data = (await res.json()) as {
                  ok: boolean
                  result: Array<{
                    update_id: number
                    message?: { chat: { id: number }; text?: string }
                  }>
                }
                return data.ok ? data.result : []
              },
              catch: (e) => new AlertError({ message: `poll error: ${e}` }),
            })

            for (const update of updates) {
              yield* Ref.set(pollOffsetRef, update.update_id + 1)
              const chatId = String(update.message?.chat?.id)
              if (chatId !== tg.chatId) continue
              const text = update.message?.text?.trim()

              const isPaused = yield* Ref.get(pausedRef)
              if (text === '/stop' && !isPaused) {
                yield* Ref.set(pausedRef, true)
                onStop()
                yield* send('⏸️ <b>BOT PAUSED</b>\n\nSend /start to resume').pipe(
                  Effect.catchAll(() => Effect.void),
                )
              } else if (text === '/start' && isPaused) {
                yield* Ref.set(pausedRef, false)
                onStart()
                yield* send('▶️ <b>BOT RESUMED</b>').pipe(
                  Effect.catchAll(() => Effect.void),
                )
              } else if (text === '/status') {
                const status = isPaused ? '⏸️ Paused' : '🟢 Running'
                const s = yield* getStats
                yield* send(`${status}\n${statsLine(s)}`).pipe(
                  Effect.catchAll(() => Effect.void),
                )
              }
            }
            consecutiveFailures = 0
          }).pipe(
            Effect.catchAll((e) => {
              consecutiveFailures++
              return consecutiveFailures === 10
                ? Effect.logError(`Telegram polling failed 10x: ${e.message}`)
                : Effect.void
            }),
          )

          const fiber = yield* pollOnce.pipe(
            Effect.repeat(Schedule.fixed('3 seconds')),
            Effect.asVoid,
            Effect.forkScoped,
          )
          yield* Ref.set(pollFiberRef, fiber)
        }),

      stopPolling: Effect.gen(function* () {
        const fiber = yield* Ref.get(pollFiberRef)
        if (fiber) {
          yield* Fiber.interrupt(fiber)
          yield* Ref.set(pollFiberRef, null)
        }
      }),

      sendEntryAlert: (data) =>
        Effect.gen(function* () {
          const s = yield* getStats
          const slipLine =
            data.signalPrice !== undefined && data.fillPrice !== undefined
              ? `\nFilled ${(data.fillPrice * 100).toFixed(0)}¢ (signal ${(data.signalPrice * 100).toFixed(0)}¢, slip ${((data.fillPrice - data.signalPrice) * 100).toFixed(1)}¢)`
              : ''
          const msg = [
            `🟢 <b>ENTRY</b>`,
            ``,
            `<b>${data.side}</b> @ ${(data.entryPrice * 100).toFixed(0)}¢ · edge ${(data.edge * 100).toFixed(1)}¢${slipLine}`,
            `<i>${data.strategy}</i> · BTC $${data.btcPrice.toFixed(0)}`,
            ``,
            statsLine(s),
          ].join('\n')
          yield* send(msg)
        }),

      sendExitAlert: (data) =>
        Effect.gen(function* () {
          yield* Ref.update(statsRef, (s) => ({
            pnl: s.pnl + data.pnl,
            trades: s.trades + 1,
            wins: s.wins + (data.pnl > 0 ? 1 : 0),
          }))
          const s = yield* getStats

          const sharesLine =
            data.soldShares != null
              ? `\nSold: ${data.soldShares.toFixed(1)} shares · Rev: $${(data.revenue ?? 0).toFixed(2)}`
              : ''
          const msg = [
            `${pnlEmoji(data.pnl)} <b>EXIT ${fmtPnl(data.pnl)}</b>`,
            ``,
            `<b>${data.side}</b> ${(data.entryPrice * 100).toFixed(0)}¢ → ${(data.exitPrice * 100).toFixed(0)}¢ · ${data.holdSec}s${sharesLine}`,
            `<i>${data.strategy}</i> · ${data.reason}`,
            ``,
            statsLine(s),
          ].join('\n')
          yield* send(msg)
        }),

      sendSellFailureAlert: (data) =>
        Effect.gen(function* () {
          const msg = [
            `🔴 <b>SELL FAILED</b> (attempt ${data.attempts})`,
            ``,
            `<b>${data.side}</b> @ ${(data.entryPrice * 100).toFixed(0)}¢ · ${data.remaining.toFixed(1)} shares remain`,
            `<i>${data.strategy}</i>`,
            data.error ? `<code>${data.error}</code>` : '',
          ]
            .filter(Boolean)
            .join('\n')
          yield* send(msg)
        }),

      sendStartAlert: (mode, sizeUsdc, maxLoss) => {
        const msg = [
          `🚀 <b>BOT STARTED</b>`,
          ``,
          `Mode: <b>${mode}</b> · Size: $${sizeUsdc} · Max loss: $${maxLoss}`,
        ].join('\n')
        return send(msg)
      },

      sendErrorAlert: (message) => send(`⚠️ <b>ERROR</b>\n${message}`),

      sendDailySummary: (pnl, trades, wins) => {
        const winRate = trades > 0 ? ((wins / trades) * 100).toFixed(1) : '0.0'
        const emoji = pnl >= 0 ? '🏆' : '📉'
        const msg = [
          `${emoji} <b>DAILY SUMMARY</b>`,
          ``,
          `P&amp;L: <b>${fmtPnl(pnl)}</b>`,
          `Trades: ${trades} · Wins: ${wins} · WR: ${winRate}%`,
        ].join('\n')
        return send(msg)
      },
    }

    return service
  }),
)
