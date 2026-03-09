import { logger } from './logger.ts'

export interface AlertsConfig {
  telegramBotToken: string
  telegramChatId: string
  enabled: boolean
}

/**
 * Creates a Telegram alert sender. No-ops when disabled.
 * Never throws on failure — logs errors instead.
 */
export function createAlerts(config: AlertsConfig) {
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
          parse_mode: 'Markdown',
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

  return {
    async sendTradeAlert(message: string): Promise<void> {
      await send(`📊 Trade: ${message}`)
    },

    async sendErrorAlert(message: string): Promise<void> {
      await send(`🚨 Error: ${message}`)
    },

    async sendDailySummary(pnl: number, trades: number, wins: number): Promise<void> {
      const winRate = trades > 0 ? ((wins / trades) * 100).toFixed(1) : '0.0'
      const pnlStr = pnl >= 0 ? `+${pnl.toFixed(2)}` : pnl.toFixed(2)

      await send(
        `📈 *Daily Summary*\nP&L: ${pnlStr}\nTrades: ${trades}\nWin rate: ${winRate}%`
      )
    },
  }
}
