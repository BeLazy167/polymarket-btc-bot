import { Effect, Context, Layer } from 'effect'
import { parse } from 'yaml'
import * as v from 'valibot'
import { ConfigSchema, type Config } from './schema.ts'
import { getWindowMeta } from './markets.ts'
import { ConfigError } from '../errors.ts'

export class ConfigService extends Context.Tag('ConfigService')<
  ConfigService,
  {
    readonly config: Config
    readonly windowSec: number
    readonly windowMeta: ReturnType<typeof getWindowMeta>
  }
>() {}

export const ConfigServiceLive = (configPath: string) =>
  Layer.effect(
    ConfigService,
    Effect.gen(function* () {
      const text = yield* Effect.tryPromise({
        try: () => Bun.file(configPath).text(),
        catch: (e) => new ConfigError({ message: `Failed to read config: ${e}` }),
      })

      const raw = yield* Effect.try({
        try: () => parse(text),
        catch: (e) => new ConfigError({ message: `YAML parse failed: ${e}` }),
      })

      // Allow env var overrides for secrets
      if (!raw.polymarket) raw.polymarket = {}
      raw.polymarket.privateKey = process.env.POLYMARKET_PRIVATE_KEY ?? raw.polymarket.privateKey
      raw.polymarket.apiKey = process.env.POLYMARKET_API_KEY ?? raw.polymarket.apiKey
      raw.polymarket.apiSecret = process.env.POLYMARKET_API_SECRET ?? raw.polymarket.apiSecret
      raw.polymarket.apiPassphrase = process.env.POLYMARKET_API_PASSPHRASE ?? raw.polymarket.apiPassphrase
      raw.polymarket.funderAddress = process.env.POLYMARKET_FUNDER_ADDRESS ?? raw.polymarket.funderAddress ?? ''

      if (raw.telegram) {
        raw.telegram.botToken = process.env.TELEGRAM_BOT_TOKEN || raw.telegram.botToken
        raw.telegram.chatId = process.env.TELEGRAM_CHAT_ID || raw.telegram.chatId
      }

      const result = v.safeParse(ConfigSchema, raw)
      if (!result.success) {
        const issues = v.flatten(result.issues)
        return yield* new ConfigError({ message: `Invalid config: ${JSON.stringify(issues.nested)}`, issues })
      }

      const config = result.output
      const windowSec = config.windowDurationSec
      const windowMeta = getWindowMeta(windowSec)

      return { config, windowSec, windowMeta }
    }),
  )
