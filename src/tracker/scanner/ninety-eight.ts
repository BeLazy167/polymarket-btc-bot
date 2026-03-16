import type { TrackerConfig } from '../config/schema.ts'
import type { RawOpportunity, GammaMarket } from '../core/types.ts'
import { rateLimitedFetch } from '../core/rate-limiter.ts'
import { Effect, Schedule } from 'effect'

const BASE_URL = 'https://gamma-api.polymarket.com/markets'
const PAGE_SIZE = 100

/**
 * Fetches a single page of active, unclosed markets from the Gamma API.
 */
function fetchPage(minLiquidity: number, offset: number): Effect.Effect<GammaMarket[], Error> {
  const url = `${BASE_URL}?closed=false&active=true&liquidity_num_min=${minLiquidity}&limit=${PAGE_SIZE}&offset=${offset}`
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
 * Paginates through all Gamma markets until a page returns fewer than PAGE_SIZE items.
 */
const MAX_PAGES = 10

function fetchAllMarkets(minLiquidity: number): Effect.Effect<GammaMarket[], Error> {
  return Effect.gen(function* () {
    const all: GammaMarket[] = []
    let offset = 0
    for (let page_num = 0; page_num < MAX_PAGES; page_num++) {
      const page = yield* fetchPage(minLiquidity, offset)
      all.push(...page)
      if (page.length < PAGE_SIZE) break
      offset += PAGE_SIZE
    }
    return all
  })
}

/**
 * Starts the 98% scanner — polls Gamma for markets where one outcome is
 * >= ninetyEightMinPrice and emits RawOpportunity for each candidate.
 * Runs forever via Effect.repeat with a fixed schedule.
 */
export function startNinetyEightScanner(
  config: TrackerConfig,
  onOpportunity: (opp: RawOpportunity) => void,
): Effect.Effect<never> {
  const minPrice = config.scanner.ninetyEightMinPrice
  const blacklist = config.blacklist.map((t) => t.toLowerCase())

  const tick = Effect.gen(function* () {
    const markets = yield* fetchAllMarkets(config.scanner.minLiquidity)
    let candidates = 0

    for (const market of markets) {
      const titleLower = market.question.toLowerCase()

      if (titleLower.includes('up or down')) continue
      if (blacklist.some((term) => titleLower.includes(term))) continue

      const prices: number[] = JSON.parse(market.outcomePrices)
      const outcomes: string[] = JSON.parse(market.outcomes)

      const highIdx = prices.findIndex((p) => p >= minPrice)
      if (highIdx === -1) continue

      candidates++
      onOpportunity({
        conditionId: market.conditionId,
        side: outcomes[highIdx] === 'Yes' ? 'YES' : 'NO',
        price: prices[highIdx]!,
        marketTitle: market.question,
        marketSlug: market.slug,
        source: 'ninety-eight',
        endDate: market.endDate,
      })
    }

    console.log(`[98%] scanned ${markets.length} markets, ${candidates} candidates`)
  })

  const safeTick = tick.pipe(
    Effect.catchAll((e) => Effect.sync(() => console.error(`[98%] error: ${e}`))),
  )

  return safeTick.pipe(
    Effect.repeat(Schedule.fixed(`${config.scanner.ninetyEightPollSec} seconds`)),
  ) as Effect.Effect<never>
}
