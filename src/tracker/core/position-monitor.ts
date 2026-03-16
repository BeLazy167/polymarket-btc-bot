import { Effect, Schedule } from 'effect'
import { eq } from 'drizzle-orm'
import { positions } from '../drizzle/schema.ts'
import type { TrackerConfig } from '../config/schema.ts'
import type { TrackerDb } from './db.ts'
import type { PaperExecutor } from './executor.ts'
import type { GammaMarket } from './types.ts'
import { rateLimitedFetch } from './rate-limiter.ts'
import { alertPositionResolved, alertDailySummary, alertError } from './alerts.ts'

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

let lastSummaryDate = ''

// Track failed lookups to avoid spamming alerts
const failedLookups = new Set<string>()

/**
 * Fetches a market from Gamma API. Tries in order:
 * 1. Direct market slug: /markets/slug/{slug}
 * 2. Market slug query: /markets?slug={slug}
 * 3. Event slug (sweeps use event slugs): /events?slug={slug} → match by title
 */
const fetchMarket = (conditionId: string, slug: string, title?: string): Effect.Effect<GammaMarket, Error> =>
  Effect.gen(function* () {
    // 1. Try direct market slug endpoint
    const directRes = yield* rateLimitedFetch('gamma', `https://gamma-api.polymarket.com/markets/slug/${encodeURIComponent(slug)}`)
    if (directRes.ok) {
      const ct = directRes.headers.get('content-type') ?? ''
      if (ct.includes('json')) {
        const market = yield* Effect.tryPromise({
          try: () => directRes.json() as Promise<GammaMarket>,
          catch: () => new Error(`Parse failed`),
        })
        if (market?.conditionId) return market
      }
    }

    // 2. Try as event slug — sweeps/MoonDev uses event slugs, not market slugs
    const eventRes = yield* rateLimitedFetch('gamma', `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}&limit=1`)
    if (eventRes.ok) {
      const ct = eventRes.headers.get('content-type') ?? ''
      if (ct.includes('json')) {
        const events = yield* Effect.tryPromise({
          try: () => eventRes.json() as Promise<Array<{ markets?: GammaMarket[] }>>,
          catch: () => new Error(`Parse failed`),
        })
        const eventMarkets = events[0]?.markets
        if (eventMarkets?.length) {
          // If only one market in event, use it. Otherwise match by title.
          if (eventMarkets.length === 1) return eventMarkets[0]!
          if (title) {
            const match = eventMarkets.find(m => m.question === title)
            if (match) return match
          }
          // Fallback: return first market in event
          return eventMarkets[0]!
        }
      }
    }

    return yield* Effect.fail(new Error(`No market found for ${slug}`))
  })

/**
 * Gets the current price for a given side from outcomePrices.
 * outcomePrices is a JSON string like '["0.95","0.05"]', matching outcomes '["Yes","No"]'.
 */
const getCurrentPrice = (market: GammaMarket, side: 'YES' | 'NO'): number => {
  const prices: string[] = JSON.parse(market.outcomePrices)
  const outcomes: string[] = JSON.parse(market.outcomes)
  const idx = outcomes.findIndex(o => o.toUpperCase() === side)
  return idx >= 0 ? parseFloat(prices[idx]!) : 0
}

/**
 * Determines if the position's side won (resolved to $1).
 */
const didPositionWin = (market: GammaMarket, side: 'YES' | 'NO'): boolean => {
  const price = getCurrentPrice(market, side)
  return price >= 0.99
}

/**
 * Sends a daily summary alert if we've crossed into a new UTC day.
 */
const maybeSendDailySummary = (db: TrackerDb): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const todayUtc = new Date().toISOString().slice(0, 10)
    if (lastSummaryDate === todayUtc) return

    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    lastSummaryDate = todayUtc

    const rows = db
      .select()
      .from(positions)
      .where(eq(positions.status, 'resolved'))
      .all()
      .filter(p => p.exitTime && new Date(p.exitTime).toISOString().slice(0, 10) === yesterday)

    if (!rows.length) return

    const totalPnl = rows.reduce((sum, p) => sum + (p.pnl ?? 0), 0)
    const wins = rows.filter(p => (p.pnl ?? 0) > 0).length
    const losses = rows.length - wins

    yield* alertDailySummary(yesterday, totalPnl, rows.length, wins, losses)
  })

/**
 * Processes a single open position: checks resolution, stop-loss, and staleness.
 */
const processPosition = (
  config: TrackerConfig,
  executor: PaperExecutor,
  pos: typeof positions.$inferSelect,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const market = yield* fetchMarket(pos.conditionId, pos.marketSlug, pos.marketTitle)
    const side = pos.side as 'YES' | 'NO'

    // --- market resolved ---
    if (market.closed) {
      const won = didPositionWin(market, side)
      executor.resolve(pos.id, won)
      const exitPrice = won ? 1.0 : 0.0
      const pnl = (exitPrice - pos.entryPrice) * pos.size
      yield* alertPositionResolved(pos.marketTitle, side, pos.entryPrice, exitPrice, pnl)
      return
    }

    // --- insider stop-loss ---
    if (pos.source.includes('insider')) {
      const currentPrice = getCurrentPrice(market, side)
      if (currentPrice < pos.entryPrice * config.risk.insiderStopLoss) {
        executor.sell(pos.id, currentPrice, 'stop-loss')
        const pnl = (currentPrice - pos.entryPrice) * pos.size
        yield* alertPositionResolved(pos.marketTitle, side, pos.entryPrice, currentPrice, pnl)
        return
      }
    }

    // --- stale position warning ---
    if (Date.now() - pos.entryTime > SEVEN_DAYS_MS) {
      yield* alertError(`Position open >7d: ${pos.marketTitle}`)
    }
  })

/**
 * Starts the position monitor loop. Runs every 30s, checking all open
 * positions for resolution, stop-losses, and staleness. Sends daily summary
 * at first cycle after midnight UTC.
 *
 * @returns Effect that runs forever (never resolves).
 */
export const startPositionMonitor = (
  config: TrackerConfig,
  db: TrackerDb,
  executor: PaperExecutor,
): Effect.Effect<never> => {
  const cycle = Effect.gen(function* () {
    const openPositions = db
      .select()
      .from(positions)
      .where(eq(positions.status, 'open'))
      .all()

    yield* Effect.forEach(openPositions, (pos) =>
      processPosition(config, executor, pos).pipe(
        Effect.catchAll((e) => {
          const key = pos.conditionId || pos.marketSlug
          if (failedLookups.has(key)) return Effect.void // already alerted once
          failedLookups.add(key)
          return alertError(`Monitor error [${pos.marketTitle}]: ${e.message}`).pipe(
            Effect.catchAll(() => Effect.void),
          )
        }),
      ),
      { concurrency: 3 },
    )

    yield* maybeSendDailySummary(db).pipe(
      Effect.catchAll(() => Effect.void),
    )
  })

  return cycle.pipe(
    Effect.catchAll(() => Effect.void),
    Effect.repeat(Schedule.fixed('30 seconds')),
  ) as Effect.Effect<never>
}
