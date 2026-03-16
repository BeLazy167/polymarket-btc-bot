import { Effect } from 'effect'
import type { Opportunity } from './types.ts'

const TELEGRAM_API = 'https://api.telegram.org'

const send = (token: string, chatId: string, text: string): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    try: () =>
      fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      }),
    catch: (e) => new Error(`Telegram send failed: ${e}`),
  }).pipe(Effect.asVoid)

const botToken = () => process.env.TELEGRAM_BOT_TOKEN ?? ''
const chatId = () => process.env.TELEGRAM_CHAT_ID ?? ''

export const alertInsiderFlagged = (wallet: string, market: string, price: number, usdAmount: number, posCount: number): Effect.Effect<void, Error> =>
  send(botToken(), chatId(), [
    `🕵️ <b>INSIDER FLAGGED</b>`,
    `<b>Market:</b> ${market}`,
    `<b>Wallet:</b> <code>${wallet.slice(0, 10)}…</code>`,
    `<b>Price:</b> ${(price * 100).toFixed(0)}¢  <b>Size:</b> $${usdAmount.toFixed(0)}`,
    `<b>Positions:</b> ${posCount}`,
  ].join('\n'))

export const alertOpportunity = (opp: Opportunity, size: number): Effect.Effect<void, Error> =>
  send(botToken(), chatId(), [
    `📡 <b>OPPORTUNITY</b> [${opp.sources.join('+')}]`,
    `<b>Market:</b> ${opp.marketTitle}`,
    `<b>Side:</b> ${opp.side}  <b>Price:</b> ${(opp.price * 100).toFixed(0)}¢`,
    `<b>Score:</b> ${opp.score}  <b>Size:</b> $${size.toFixed(0)}`,
  ].join('\n'))

export const alertPositionResolved = (market: string, side: string, entryPrice: number, exitPrice: number, pnl: number): Effect.Effect<void, Error> =>
  send(botToken(), chatId(), [
    pnl >= 0 ? `✅ <b>RESOLVED +$${pnl.toFixed(2)}</b>` : `❌ <b>RESOLVED -$${Math.abs(pnl).toFixed(2)}</b>`,
    `<b>Market:</b> ${market}`,
    `<b>Side:</b> ${side}  ${(entryPrice * 100).toFixed(0)}¢ → ${(exitPrice * 100).toFixed(0)}¢`,
  ].join('\n'))

export const alertDailySummary = (date: string, pnl: number, trades: number, wins: number, losses: number): Effect.Effect<void, Error> =>
  send(botToken(), chatId(), [
    `📊 <b>DAILY SUMMARY</b> ${date}`,
    `<b>P&L:</b> ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`,
    `<b>Trades:</b> ${trades}  <b>W:</b> ${wins}  <b>L:</b> ${losses}`,
  ].join('\n'))

export const alertError = (msg: string): Effect.Effect<void, Error> =>
  send(botToken(), chatId(), `⚠️ <b>TRACKER ERROR</b>\n<code>${msg}</code>`)
