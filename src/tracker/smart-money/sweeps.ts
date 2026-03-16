import type { TrackerConfig } from '../config/schema.ts'
import type { TrackerDb } from '../core/db.ts'
import type { RawOpportunity, SweepTrade } from '../core/types.ts'
import { rateLimitedFetch } from '../core/rate-limiter.ts'
import { flaggedTrades } from '../drizzle/schema.ts'
import { Effect, Schedule } from 'effect'

const SWEEPS_URL = 'https://moondev.com/api/polymarket/sweeps'
const MAX_SEEN = 5000

/**
 * Starts the sweeps monitor — polls MoonDev for large Polymarket trades,
 * stores flagged buys in DB and emits RawOpportunity for trades > $1000.
 * Runs forever via Effect.repeat with a fixed schedule.
 */
export function startSweepsMonitor(
  config: TrackerConfig,
  db: TrackerDb,
  onOpportunity: (opp: RawOpportunity) => void,
): Effect.Effect<never> {
  const seen = new Set<string>()
  const blacklist = config.blacklist.map((t) => t.toLowerCase())

  const tick = Effect.gen(function* () {
    const res = yield* rateLimitedFetch('moondev', SWEEPS_URL)
    const trades = yield* Effect.tryPromise({
      try: async () => {
        const r = await res.json()
        return (Array.isArray(r) ? r : (r as { data?: SweepTrade[] }).data ?? []) as SweepTrade[]
      },
      catch: (e) => new Error(`Failed to parse sweeps response: ${e}`),
    })

    let newTrades = 0
    let signals = 0

    for (const trade of trades) {
      if (seen.has(trade.transactionHash)) continue

      seen.add(trade.transactionHash)

      // Evict oldest hashes when set exceeds limit
      if (seen.size > MAX_SEEN) {
        const first = seen.values().next().value!
        seen.delete(first)
      }

      if (!trade.title || !trade.trader || !trade.transactionHash) continue
      const titleLower = trade.title.toLowerCase()
      if (blacklist.some((term) => titleLower.includes(term))) continue
      if (trade.side !== 'BUY') continue

      newTrades++

      // Insert into flaggedTrades, skip duplicates via unique constraint
      db.insert(flaggedTrades).values({
        timestamp: trade.timestamp,
        wallet: trade.trader,
        marketTitle: trade.title,
        marketSlug: trade.market_slug,
        conditionId: trade.market_slug,
        side: trade.side,
        outcome: trade.outcome,
        price: trade.price,
        size: trade.size,
        usdAmount: trade.usd_amount,
        source: 'sweep',
        transactionHash: trade.transactionHash,
      }).onConflictDoNothing().run()

      if (trade.usd_amount > 1000) {
        signals++
        onOpportunity({
          conditionId: '', // MoonDev API doesn't provide conditionId — queue resolves via Gamma lookup
          side: trade.outcome === 'Yes' ? 'YES' : 'NO',
          price: trade.price,
          marketTitle: trade.title,
          marketSlug: trade.market_slug,
          source: 'sweep',
          traderWallet: trade.trader,
          usdAmount: trade.usd_amount,
        })
      }
    }

    console.log(`[sweeps] ${newTrades} new trades, ${signals} signals`)
  })

  const safeTick = tick.pipe(
    Effect.catchAll((e) => Effect.sync(() => console.error(`[sweeps] error: ${e}`))),
  )

  return safeTick.pipe(
    Effect.repeat(Schedule.fixed(`${config.smartMoney.sweepsPollSec} seconds`)),
  ) as Effect.Effect<never>
}
