import { Effect, Context, Layer } from 'effect'
import { parse as parseYaml } from 'yaml'
import * as v from 'valibot'
import { TrackerConfigSchema, type TrackerConfig } from './schema.ts'

export class TrackerConfigService extends Context.Tag('tracker/ConfigService')<
  TrackerConfigService,
  { readonly config: TrackerConfig }
>() {}

export const TrackerConfigLive = (configPath: string) =>
  Layer.effect(
    TrackerConfigService,
    Effect.gen(function* () {
      const raw = yield* Effect.tryPromise({
        try: () => Bun.file(configPath).text(),
        catch: (e) => new Error(`Failed to read config: ${e}`),
      })
      const parsed = parseYaml(raw)
      const config = v.parse(TrackerConfigSchema, parsed)
      return { config }
    }),
  )
