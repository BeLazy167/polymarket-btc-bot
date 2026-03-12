import { logger } from './logger.ts'

export interface AlertsConfig {
  telegramBotToken: string
  telegramChatId: string
  enabled: boolean
}

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

/**
 * Creates a Telegram alert sender with rich HTML formatting.
 * Tracks running session stats for context in each message.
 */
export function createAlerts(config: AlertsConfig) {
  let sessionPnl = 0
  let sessionTrades = 0
  let sessionWins = 0

  async function send(text: string): Promise<void> {
    if (!config.enabled) {
      logger.info({ text }, 'alert skipped (disabled)')
      return
    }

    const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: config.telegramChatId,
          text,
          parse_mode: 'HTML',
          disable_notification: false,
        }),
      })

      if (!res.ok) {
        const body = await res.text()
        logger.error({ status: res.status, body }, 'telegram alert failed')
      }
    } catch (err) {
      logger.error({ err }, 'telegram alert request error')
    }
  }

  function fmtPnl(pnl: number): string {
    return pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`
  }

  function pnlEmoji(pnl: number): string {
    if (pnl >= 0.20) return '🔥'
    if (pnl > 0) return '✅'
    if (pnl > -0.20) return '📉'
    return '🔴'
  }

  function statsLine(): string {
    const wr = sessionTrades > 0 ? ((sessionWins / sessionTrades) * 100).toFixed(0) : '0'
    return `📊 ${fmtPnl(sessionPnl)} · ${sessionTrades} trades · ${wr}% WR`
  }

  let paused = false
  let pollOffset = 0
  let consecutivePollFailures = 0
  let pollTimer: ReturnType<typeof setInterval> | null = null

  async function startPolling(onStop: () => void, onStart: () => void): Promise<void> {
    if (!config.enabled) return

    // Flush stale updates so old /stop commands don't replay on restart
    try {
      const flushUrl = `https://api.telegram.org/bot${config.telegramBotToken}/getUpdates?offset=-1&timeout=0`
      const flushRes = await fetch(flushUrl)
      if (flushRes.ok) {
        const data = await flushRes.json() as { ok: boolean; result: Array<{ update_id: number }> }
        if (data.ok && data.result.length > 0) {
          pollOffset = data.result[data.result.length - 1]!.update_id + 1
        }
      }
    } catch {
      logger.warn('Failed to flush stale Telegram updates')
    }

    pollTimer = setInterval(async () => {
      const url = `https://api.telegram.org/bot${config.telegramBotToken}/getUpdates?offset=${pollOffset}&timeout=0`
      try {
        const res = await fetch(url)
        if (!res.ok) return
        const data = await res.json() as { ok: boolean; result: Array<{ update_id: number; message?: { chat: { id: number }; text?: string } }> }
        if (!data.ok) return

        for (const update of data.result) {
          pollOffset = update.update_id + 1
          const chatId = String(update.message?.chat?.id)
          if (chatId !== config.telegramChatId) continue
          const text = update.message?.text?.trim()

          if (text === '/stop' && !paused) {
            paused = true
            onStop()
            send('⏸️ <b>BOT PAUSED</b>\n\nSend /start to resume').catch(() => {})
          } else if (text === '/start' && paused) {
            paused = false
            onStart()
            send('▶️ <b>BOT RESUMED</b>').catch(() => {})
          } else if (text === '/status') {
            const status = paused ? '⏸️ Paused' : '🟢 Running'
            send(`${status}\n${statsLine()}`).catch(() => {})
          }
        }
        consecutivePollFailures = 0
      } catch (err) {
        consecutivePollFailures++
        if (consecutivePollFailures === 10) {
          logger.error({ err }, 'Telegram polling failed 10x — /stop /start commands broken')
        }
      }
    }, 3000)
  }

  function stopPolling(): void {
    if (pollTimer) clearInterval(pollTimer)
  }

  return {
    isPaused(): boolean { return paused },
    startPolling,
    stopPolling,
    async sendEntryAlert(data: EntryAlertData): Promise<void> {
      const slipLine = data.signalPrice !== undefined && data.fillPrice !== undefined
        ? `\nFilled ${(data.fillPrice * 100).toFixed(0)}¢ (signal ${(data.signalPrice * 100).toFixed(0)}¢, slip ${((data.fillPrice - data.signalPrice) * 100).toFixed(1)}¢)`
        : ''
      const msg = [
        `🟢 <b>ENTRY</b>`,
        ``,
        `<b>${data.side}</b> @ ${(data.entryPrice * 100).toFixed(0)}¢ · edge ${(data.edge * 100).toFixed(1)}¢${slipLine}`,
        `<i>${data.strategy}</i> · BTC $${data.btcPrice.toFixed(0)}`,
        ``,
        statsLine(),
      ].join('\n')
      await send(msg)
    },

    async sendExitAlert(data: ExitAlertData): Promise<void> {
      sessionTrades++
      sessionPnl += data.pnl
      if (data.pnl > 0) sessionWins++

      const sharesLine = data.soldShares != null ? `\nSold: ${data.soldShares.toFixed(1)} shares · Rev: $${(data.revenue ?? 0).toFixed(2)}` : ''
      const msg = [
        `${pnlEmoji(data.pnl)} <b>EXIT ${fmtPnl(data.pnl)}</b>`,
        ``,
        `<b>${data.side}</b> ${(data.entryPrice * 100).toFixed(0)}¢ → ${(data.exitPrice * 100).toFixed(0)}¢ · ${data.holdSec}s${sharesLine}`,
        `<i>${data.strategy}</i> · ${data.reason}`,
        ``,
        statsLine(),
      ].join('\n')
      await send(msg)
    },

    async sendSellFailureAlert(data: SellFailureData): Promise<void> {
      const msg = [
        `🔴 <b>SELL FAILED</b> (attempt ${data.attempts})`,
        ``,
        `<b>${data.side}</b> @ ${(data.entryPrice * 100).toFixed(0)}¢ · ${data.remaining.toFixed(1)} shares remain`,
        `<i>${data.strategy}</i>`,
        data.error ? `<code>${data.error}</code>` : '',
      ].filter(Boolean).join('\n')
      await send(msg)
    },

    async sendStartAlert(mode: string, sizeUsdc: number, maxLoss: number): Promise<void> {
      const msg = [
        `🚀 <b>BOT STARTED</b>`,
        ``,
        `Mode: <b>${mode}</b> · Size: $${sizeUsdc} · Max loss: $${maxLoss}`,
      ].join('\n')
      await send(msg)
    },

    async sendErrorAlert(message: string): Promise<void> {
      await send(`⚠️ <b>ERROR</b>\n${message}`)
    },

    async sendDailySummary(pnl: number, trades: number, wins: number): Promise<void> {
      const winRate = trades > 0 ? ((wins / trades) * 100).toFixed(1) : '0.0'
      const emoji = pnl >= 0 ? '🏆' : '📉'

      const msg = [
        `${emoji} <b>DAILY SUMMARY</b>`,
        ``,
        `P&amp;L: <b>${fmtPnl(pnl)}</b>`,
        `Trades: ${trades} · Wins: ${wins} · WR: ${winRate}%`,
      ].join('\n')
      await send(msg)
    },
  }
}
