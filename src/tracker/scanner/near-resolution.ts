import type { TrackerConfig } from '../config/schema.ts'
import type { RawOpportunity, GammaMarket } from '../core/types.ts'
import { rateLimitedFetch } from '../core/rate-limiter.ts'
import { Effect, Schedule } from 'effect'

const BASE_URL = 'https://gamma-api.polymarket.com/markets'
const PAGE_SIZE = 100

/**
 * Fetches a single page of markets ending before the given date.
 */
function fetchPage(minLiquidity: number, endDateMax: string, offset: number): Effect.Effect<GammaMarket[], Error> {
  const url = `${BASE_URL}?closed=false&active=true&end_date_max=${encodeURIComponent(endDateMax)}&liquidity_num_min=${minLiquidity}&limit=${PAGE_SIZE}&offset=${offset}`
  return Effect.gen(function* () {
    const res = yield* rateLimitedFetch('gamma', url)
    if (!res.ok) return yield* Effect.fail(new Error(`Gamma API ${res.status} at offset=${offset}`))
    const ct = res.headers.get('content-type') ?? ''
    if (!ct.includes('json')) return yield* Effect.fail(new Error(`Gamma non-JSON response at offset=${offset}`))
    return yield* Effect.tryPromise({
      try: () => res.json() as Promise<GammaMarket[]>,
      catch: (e) => new Error(`Failed to parse Gamma response: ${e}`),
    })
  })
}

/**
 * Paginates through all Gamma markets ending before endDateMax.
 */
const MAX_PAGES = 10

function fetchAllMarkets(minLiquidity: number, endDateMax: string): Effect.Effect<GammaMarket[], Error> {
  return Effect.gen(function* () {
    const all: GammaMarket[] = []
    let offset = 0
    for (let page_num = 0; page_num < MAX_PAGES; page_num++) {
      const page = yield* fetchPage(minLiquidity, endDateMax, offset)
      all.push(...page)
      if (page.length < PAGE_SIZE) break
      offset += PAGE_SIZE
    }
    return all
  })
}

/**
 * Starts the near-resolution sniper — polls Gamma for markets approaching
 * their end date where one side is >= nearResolutionMinPrice. Emits
 * RawOpportunity for each candidate. Runs forever via Effect.repeat.
 */
export function startNearResolutionSniper(
  config: TrackerConfig,
  onOpportunity: (opp: RawOpportunity) => void,
): Effect.Effect<never> {
  const minPrice = config.scanner.nearResolutionMinPrice
  const blacklist = config.blacklist.map((t) => t.toLowerCase())

  const tick = Effect.gen(function* () {
    const now = Date.now()
    const endDateMax = new Date(now + config.scanner.nearResolutionWindowMin * 60_000).toISOString()
    const markets = yield* fetchAllMarkets(config.scanner.minLiquidity, endDateMax)
    let candidates = 0

    for (const market of markets) {
      const titleLower = market.question.toLowerCase()

      if (titleLower.includes('up or down')) continue
      if (blacklist.some((term) => titleLower.includes(term))) continue

      const prices: number[] = JSON.parse(market.outcomePrices)
      const outcomes: string[] = JSON.parse(market.outcomes)
      const endTime = new Date(market.endDate).getTime()
      const timeRemaining = endTime - Date.now()

      if (timeRemaining <= 0) continue

      const highIdx = prices.findIndex((p) => p >= minPrice)
      if (highIdx === -1) continue

      // For time-based markets: also require 80%+ of duration elapsed
      if (market.startDate && market.endDate) {
        const startTime = new Date(market.startDate).getTime()
        const totalDuration = endTime - startTime
        if (totalDuration > 0) {
          const elapsed = Date.now() - startTime
          if (elapsed / totalDuration < 0.8) continue
        }
      }

      candidates++
      onOpportunity({
        conditionId: market.conditionId,
        side: outcomes[highIdx] === 'Yes' ? 'YES' : 'NO',
        price: prices[highIdx]!,
        marketTitle: market.question,
        marketSlug: market.slug,
        source: 'near-resolution',
        endDate: market.endDate,
      })
    }

    console.log(`[near-res] scanned ${markets.length} markets, ${candidates} candidates`)
  })

  const safeTick = tick.pipe(
    Effect.catchAll((e) => Effect.sync(() => console.error(`[near-res] error: ${e}`))),
  )

  return safeTick.pipe(
    Effect.repeat(Schedule.fixed(`${config.scanner.nearResolutionPollSec} seconds`)),
  ) as Effect.Effect<never>
}
