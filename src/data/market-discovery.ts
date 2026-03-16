import { Effect, Context, Layer, Schedule } from 'effect'
import { ConfigService } from '../config/service.ts'
import { buildSlug } from '../config/markets.ts'
import { MarketDiscoveryError } from '../errors.ts'

export interface LiveMarket {
  epoch: number
  slug: string
  conditionId: string
  yesTokenId: string
  noTokenId: string
  tickSize: string
  negRisk: boolean
  minOrderSize: number
  windowStartMs: number
  windowEndMs: number
}

const GAMMA_BASE = 'https://gamma-api.polymarket.com/events/slug'

/**
 * Computes the current window epoch (floor-aligned to windowSec).
 * Optionally offset by +1 to get the next window.
 */
export function getWindowEpoch(nowMs: number, windowSec: number, offset = 0): number {
  const nowSec = Math.floor(nowMs / 1000)
  return Math.floor(nowSec / windowSec) * windowSec + offset * windowSec
}

export class MarketDiscovery extends Context.Tag('MarketDiscovery')<
  MarketDiscovery,
  {
    readonly fetchCurrentMarket: Effect.Effect<LiveMarket | null, MarketDiscoveryError>
    readonly fetchOpenPrice: (epochSec: number) => Effect.Effect<number | null, MarketDiscoveryError>
  }
>() {}

/**
 * Internal: fetches market data for a specific window epoch from Gamma API.
 */
const fetchMarket = (
  epoch: number,
  windowSec: number,
  _slugPrefix?: string,
): Effect.Effect<LiveMarket | null, MarketDiscoveryError> =>
  Effect.gen(function* () {
    const slug = buildSlug(windowSec, epoch)
    const url = `${GAMMA_BASE}/${slug}`

    const res = yield* Effect.tryPromise({
      try: () => fetch(url),
      catch: (e) => new MarketDiscoveryError({ message: `Gamma fetch failed: ${e}`, slug }),
    })

    if (!res.ok) {
      yield* Effect.logWarning(`Gamma API fetch failed status=${res.status} slug=${slug}`)
      return null
    }

    const data = yield* Effect.tryPromise({
      try: () =>
        res.json() as Promise<{
          negRisk?: boolean
          markets?: Array<{
            conditionId: string
            clobTokenIds: string
            orderPriceMinTickSize?: number
          }>
        }>,
      catch: (e) => new MarketDiscoveryError({ message: `Gamma JSON parse failed: ${e}`, slug }),
    })

    const market = data?.markets?.[0]
    if (!market) {
      yield* Effect.logWarning(`No market in Gamma response slug=${slug}`)
      return null
    }

    const tokenIds: string[] = JSON.parse(market.clobTokenIds)
    if (tokenIds.length < 2) {
      yield* Effect.logWarning(`Unexpected clobTokenIds length slug=${slug} ids=${tokenIds}`)
      return null
    }

    // Fetch min_order_size from CLOB orderbook
    let minOrderSize = 5 // safe fallback
    const obResult = yield* Effect.tryPromise({
      try: () => fetch(`https://clob.polymarket.com/orderbook/${tokenIds[0]}`),
      catch: () => null,
    }).pipe(Effect.catchAll(() => Effect.succeed(null)))

    if (obResult && obResult.ok) {
      const ob = yield* Effect.tryPromise({
        try: () => obResult.json() as Promise<{ min_order_size?: string }>,
        catch: () => null,
      }).pipe(Effect.catchAll(() => Effect.succeed(null)))

      if (ob) {
        const parsed = Number(ob.min_order_size)
        if (Number.isFinite(parsed) && parsed > 0) minOrderSize = parsed
      }
    } else {
      yield* Effect.logWarning(`Failed to fetch min_order_size — using default 5 slug=${slug}`)
    }

    return {
      epoch,
      slug,
      conditionId: market.conditionId,
      yesTokenId: tokenIds[0]!,
      noTokenId: tokenIds[1]!,
      tickSize: String(market.orderPriceMinTickSize ?? '0.01'),
      negRisk: data.negRisk ?? false,
      minOrderSize,
      windowStartMs: epoch * 1000,
      windowEndMs: (epoch + windowSec) * 1000,
    } satisfies LiveMarket
  })

export const MarketDiscoveryLive = Layer.effect(
  MarketDiscovery,
  Effect.gen(function* () {
    const { windowSec, windowMeta } = yield* ConfigService

    return {
      fetchCurrentMarket: Effect.gen(function* () {
        const epoch = getWindowEpoch(Date.now(), windowSec)

        const retrySchedule = Schedule.intersect(
          Schedule.recurs(2),
          Schedule.spaced(2000),
        )

        const result = yield* fetchMarket(epoch, windowSec, windowMeta.slugPrefix).pipe(
          Effect.flatMap((m) =>
            m ? Effect.succeed(m) : Effect.fail('no-market' as const),
          ),
          Effect.retry(retrySchedule),
          Effect.catchAll(() => Effect.succeed(null as LiveMarket | null)),
        )

        return result
      }),

      fetchOpenPrice: (epochSec: number) =>
        Effect.gen(function* () {
          const start = new Date(epochSec * 1000).toISOString()
          const end = new Date((epochSec + windowSec) * 1000).toISOString()
          const url = `https://polymarket.com/api/crypto/crypto-price?symbol=BTC&eventStartTime=${start}&variant=${windowMeta.cryptoVariant}&endDate=${end}`

          const res = yield* Effect.tryPromise({
            try: () => fetch(url),
            catch: (e) =>
              new MarketDiscoveryError({ message: `crypto-price fetch failed: ${e}`, status: 0 }),
          })

          if (!res.ok) {
            yield* Effect.logError(`crypto-price API fetch failed status=${res.status} epochSec=${epochSec}`)
            return null
          }

          const data = yield* Effect.tryPromise({
            try: () => res.json() as Promise<{ openPrice?: number | null }>,
            catch: (e) =>
              new MarketDiscoveryError({ message: `crypto-price JSON parse failed: ${e}` }),
          })

          if (!data.openPrice || !Number.isFinite(data.openPrice)) {
            yield* Effect.logWarning(`crypto-price API returned no openPrice epochSec=${epochSec}`)
            return null
          }

          yield* Effect.log(`Fetched open price from Polymarket epochSec=${epochSec} openPrice=${data.openPrice}`)
          return data.openPrice
        }),
    }
  }),
)
