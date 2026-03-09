import { parse } from 'yaml'
import * as v from 'valibot'
import { ConfigSchema, type Config } from './schema.ts'
import { logger } from '../monitoring/logger.ts'

/**
 * Loads and validates config from a YAML file.
 * Env vars override: POLYMARKET_PRIVATE_KEY, POLYMARKET_API_KEY, etc.
 */
export async function loadConfig(path: string): Promise<Config> {
  const file = Bun.file(path)
  const text = await file.text()
  const raw = parse(text)

  // Allow env var overrides for secrets
  if (!raw.polymarket) raw.polymarket = {}
  raw.polymarket.privateKey = process.env.POLYMARKET_PRIVATE_KEY ?? raw.polymarket.privateKey
  raw.polymarket.apiKey = process.env.POLYMARKET_API_KEY ?? raw.polymarket.apiKey
  raw.polymarket.apiSecret = process.env.POLYMARKET_API_SECRET ?? raw.polymarket.apiSecret
  raw.polymarket.apiPassphrase = process.env.POLYMARKET_API_PASSPHRASE ?? raw.polymarket.apiPassphrase
  raw.polymarket.funderAddress = process.env.POLYMARKET_FUNDER_ADDRESS ?? raw.polymarket.funderAddress ?? ''

  if (raw.telegram) {
    raw.telegram.botToken = process.env.TELEGRAM_BOT_TOKEN ?? raw.telegram.botToken
    raw.telegram.chatId = process.env.TELEGRAM_CHAT_ID ?? raw.telegram.chatId
  }

  const result = v.safeParse(ConfigSchema, raw)
  if (!result.success) {
    const issues = v.flatten(result.issues)
    logger.error({ issues }, 'Config validation failed')
    throw new Error(`Invalid config: ${JSON.stringify(issues.nested)}`)
  }

  return result.output
}

/** Maps window duration to model timeframe bucket */
export function getTimeframeBucket(windowDurationSec: number): 'fiveMin' | 'fifteenMin' | 'oneHour' | 'oneDay' {
  if (windowDurationSec <= 300) return 'fiveMin'
  if (windowDurationSec <= 900) return 'fifteenMin'
  if (windowDurationSec <= 3600) return 'oneHour'
  return 'oneDay'
}
