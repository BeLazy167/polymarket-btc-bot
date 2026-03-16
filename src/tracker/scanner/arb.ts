import type { TrackerConfig } from '../config/schema.ts'
import type { RawOpportunity } from '../core/types.ts'
import { rateLimitedFetch } from '../core/rate-limiter.ts'
import { Effect, Schedule } from 'effect'

const GAMMA_URL = 'https://gamma-api.polymarket.com/markets'
const CLOB_URL = 'https://clob.polymarket.com/book'
const PAGE_SIZE = 100

interface GammaMarketSlim {
  conditionId: string
  question: string
  slug: string
  active: boolean
  closed: boolean
  liquidityNum: number
  clobTokenIds: string // JSON string like '["tokenId1","tokenId2"]'
}

interface OrderbookResponse {
  asks: Array<{ price: string; size: string }>
  bids: Array<{ price: string; size: string }>
}

function fetchMarketPage(minLiquidity: number, offset: number): Effect.Effect<GammaMarketSlim[], Error> {
  const url = `${GAMMA_URL}?closed=false&active=true&liquidity_num_min=${minLiquidity}&limit=${PAGE_SIZE}&offset=${offset}`
  return Effect.gen(function* () {
    const res = yield* rateLimitedFetch('gamma', url)
    if (!res.ok) return yield* Effect.fail(new Error(`Gamma API ${res.status} at offset=${offset}`))
    const ct = res.headers.get('content-type') ?? ''
    if (!ct.includes('json')) return yield* Effect.fail(new Error(`Gamma non-JSON response at offset=${offset}`))
    return yield* Effect.tryPromise({
      try: () => res.json() as Promise<GammaMarketSlim[]>,
      catch: (e) => new Error(`Failed to parse markets: ${e}`),
    })
  })
}

function fetchOrderbook(tokenId: string): Effect.Effect<OrderbookResponse, Error> {
  const url = `${CLOB_URL}?token_id=${tokenId}`
  return Effect.gen(function* () {
    const res = yield* rateLimitedFetch('gamma', url)
    return yield* Effect.tryPromise({
      try: () => res.json() as Promise<OrderbookResponse>,
      catch: (e) => new Error(`Failed to parse orderbook: ${e}`),
    })
  })
}

/**
 * Scans all active markets for arbitrage: YES best ask + NO best ask < $1.00.
 * Any gap is risk-free profit — buy both sides, collect $1 at resolution.
 */
export function startArbScanner(
  config: TrackerConfig,
  onOpportunity: (opp: RawOpportunity) => void,
): Effect.Effect<never> {
  const blacklist = config.blacklist.map((t) => t.toLowerCase())

  const tick = Effect.gen(function* () {
    // Paginate through all markets
    let offset = 0
    let scanned = 0
    let arbs = 0

    while (true) {
      const markets = yield* fetchMarketPage(config.scanner.minLiquidity, offset)
      if (markets.length === 0) break

      for (const market of markets) {
        scanned++

        const questionLower = market.question.toLowerCase()
        if (blacklist.some((term) => questionLower.includes(term))) continue

        // Parse token IDs
        let tokenIds: string[]
        try {
          tokenIds = JSON.parse(market.clobTokenIds) as string[]
        } catch {
          continue
        }
        if (!tokenIds[0] || !tokenIds[1]) continue

        // Fetch both orderbooks
        const [yesBook, noBook] = yield* Effect.all([
          fetchOrderbook(tokenIds[0]),
          fetchOrderbook(tokenIds[1]),
        ])

        const yesBestAsk = yesBook.asks[0]
        const noBestAsk = noBook.asks[0]
        if (!yesBestAsk || !noBestAsk) continue

        const yesAsk = parseFloat(yesBestAsk.price)
        const noAsk = parseFloat(noBestAsk.price)
        const total = yesAsk + noAsk

        if (total < 1.0) {
          const gap = ((1.0 - total) * 100).toFixed(1)
          const minSize = Math.min(parseFloat(yesBestAsk.size), parseFloat(noBestAsk.size))
          console.log(`[arb] ${market.question.slice(0, 60)} — YES ${yesAsk} + NO ${noAsk} = ${total.toFixed(3)} — gap ${gap}¢ — depth ${minSize.toFixed(0)} shares`)

          arbs++
          onOpportunity({
            conditionId: market.conditionId,
            side: 'YES', // buying both sides
            price: total, // combined cost
            marketTitle: market.question,
            marketSlug: market.slug,
            source: 'ninety-eight', // reuse scoring bucket
            usdAmount: minSize * (1.0 - total), // potential profit at full depth
          })
        }
      }

      if (markets.length < PAGE_SIZE) break
      offset += PAGE_SIZE
    }

    console.log(`[arb] scanned ${scanned} markets, ${arbs} arb opportunities`)
  })

  const safeTick = tick.pipe(
    Effect.catchAll((e) => Effect.sync(() => console.error(`[arb] error: ${e}`))),
  )

  return safeTick.pipe(
    Effect.repeat(Schedule.fixed(`${config.scanner.ninetyEightPollSec} seconds`)),
  ) as Effect.Effect<never>
}
