import type { TrackerConfig } from '../config/schema.ts'
import type { TrackerDb } from '../core/db.ts'
import type { RawOpportunity, DataApiTrade, LeaderboardEntry } from '../core/types.ts'
import { rateLimitedFetch } from '../core/rate-limiter.ts'
import { flaggedTrades } from '../drizzle/schema.ts'
import { Effect, Schedule } from 'effect'

const LEADERBOARD_URL = 'https://data-api.polymarket.com/v1/leaderboard'
const TRADES_URL = 'https://data-api.polymarket.com/trades'

/**
 * Fetches top wallets from Polymarket leaderboard for a given time period.
 */
function fetchLeaderboard(limit: number, timePeriod: 'WEEK' | 'MONTH'): Effect.Effect<LeaderboardEntry[], Error> {
  const url = `${LEADERBOARD_URL}?category=OVERALL&timePeriod=${timePeriod}&orderBy=PNL&limit=${limit}`
  return Effect.gen(function* () {
    const res = yield* rateLimitedFetch('data', url)
    return yield* Effect.tryPromise({
      try: () => res.json() as Promise<LeaderboardEntry[]>,
      catch: (e) => new Error(`Failed to parse leaderboard: ${e}`),
    })
  })
}

/**
 * Fetches last 10 trades for a given wallet.
 */
function fetchWalletTrades(wallet: string): Effect.Effect<DataApiTrade[], Error> {
  const url = `${TRADES_URL}?user=${wallet}&limit=10`
  return Effect.gen(function* () {
    const res = yield* rateLimitedFetch('data', url)
    return yield* Effect.tryPromise({
      try: () => res.json() as Promise<DataApiTrade[]>,
      catch: (e) => new Error(`Failed to parse trades for ${wallet}: ${e}`),
    })
  })
}

/**
 * Two-loop whale tracker: refreshes leaderboard wallets daily, polls
 * tracked wallets for new large BUY trades on a configurable interval.
 * Stores flagged trades in DB and emits RawOpportunity for each.
 */
export function startWhaleTracker(
  config: TrackerConfig,
  db: TrackerDb,
  onOpportunity: (opp: RawOpportunity) => void,
): Effect.Effect<never> {
  const trackedWallets: Array<{ wallet: string; pnl: number }> = []
  const lastSeenTx = new Map<string, string>()
  const blacklist = config.blacklist.map((t) => t.toLowerCase())
  let pollIndex = 0

  // Loop 1: leaderboard refresh every 24h — 20 monthly + 10 weekly, deduped
  const refreshTick = Effect.gen(function* () {
    const [monthly, weekly] = yield* Effect.all([
      fetchLeaderboard(20, 'MONTH'),
      fetchLeaderboard(10, 'WEEK'),
    ])
    const seen = new Set<string>()
    trackedWallets.length = 0
    for (const entry of [...monthly, ...weekly]) {
      if (seen.has(entry.proxyWallet)) continue
      seen.add(entry.proxyWallet)
      trackedWallets.push({ wallet: entry.proxyWallet, pnl: entry.pnl })
    }
    console.log(`[whale] refreshed leaderboard: ${trackedWallets.length} wallets (20 monthly + 10 weekly, deduped)`)
  })

  const safeRefresh = refreshTick.pipe(
    Effect.catchAll((e) => Effect.sync(() => console.error(`[whale] leaderboard error: ${e}`))),
  )

  // Run once immediately then repeat every 24h
  const leaderboardLoop = safeRefresh.pipe(
    Effect.repeat(Schedule.fixed('24 hours')),
  )

  // Loop 2: wallet polling every whalePollSec
  const pollTick = Effect.gen(function* () {
    if (trackedWallets.length === 0) return

    // Rotate through 2-3 wallets per cycle
    const batchSize = Math.min(3, trackedWallets.length)
    const batch: Array<{ wallet: string; pnl: number }> = []
    for (let i = 0; i < batchSize; i++) {
      batch.push(trackedWallets[pollIndex % trackedWallets.length]!)
      pollIndex++
    }

    for (const { wallet } of batch) {
      const trades = yield* fetchWalletTrades(wallet)
      const lastTx = lastSeenTx.get(wallet)

      const newTrades: DataApiTrade[] = []
      for (const trade of trades) {
        if (trade.transactionHash === lastTx) break
        newTrades.push(trade)
      }

      if (trades.length > 0) {
        lastSeenTx.set(wallet, trades[0]!.transactionHash)
      }

      for (const trade of newTrades) {
        if (trade.side !== 'BUY') continue

        const usdAmount = trade.size * trade.price
        if (usdAmount <= 1000) continue

        const titleLower = trade.title.toLowerCase()
        if (blacklist.some((term) => titleLower.includes(term))) continue

        // Store in DB
        yield* Effect.tryPromise({
          try: () =>
            db.insert(flaggedTrades).values({
              timestamp: trade.timestamp,
              wallet: trade.proxyWallet,
              marketTitle: trade.title,
              marketSlug: trade.market_slug ?? trade.eventSlug,
              conditionId: trade.conditionId,
              side: trade.side,
              outcome: trade.outcome,
              price: trade.price,
              size: trade.size,
              usdAmount,
              source: 'whale',
              transactionHash: trade.transactionHash,
            }).onConflictDoNothing(),
          catch: (e) => new Error(`Failed to insert flagged trade: ${e}`),
        })

        onOpportunity({
          conditionId: trade.conditionId,
          side: trade.outcome === 'Yes' ? 'YES' : 'NO',
          price: trade.price,
          marketTitle: trade.title,
          marketSlug: trade.market_slug ?? trade.eventSlug,
          source: 'whale',
          traderWallet: trade.proxyWallet,
          usdAmount,
        })
      }
    }
  })

  const safePoll = pollTick.pipe(
    Effect.catchAll((e) => Effect.sync(() => console.error(`[whale] poll error: ${e}`))),
  )

  const walletLoop = safePoll.pipe(
    Effect.repeat(Schedule.fixed(`${config.smartMoney.whalePollSec} seconds`)),
  )

  return Effect.all([leaderboardLoop, walletLoop], { concurrency: 'unbounded' }) as Effect.Effect<never>
}
