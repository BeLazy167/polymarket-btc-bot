import { eq, lt } from 'drizzle-orm'
import { flaggedTrades, insiderWallets } from '../drizzle/schema.ts'
import type { TrackerConfig } from '../config/schema.ts'
import type { TrackerDb } from '../core/db.ts'
import type { RawOpportunity, DataApiTrade } from '../core/types.ts'
import { rateLimitedFetch } from '../core/rate-limiter.ts'
import { Effect, Schedule } from 'effect'

const DATA_API = 'https://data-api.polymarket.com'

/**
 * Fetches recent large trades from the Polymarket Data API,
 * filters for low-price buys, stores them, and upserts wallets.
 */
function tradeMonitorLoop(config: TrackerConfig, db: TrackerDb): Effect.Effect<never> {
  const { insiderMinTradeUsd, insiderMaxBuyPrice, insiderPollSec } = config.smartMoney
  const blacklist = config.blacklist

  const tick = Effect.gen(function* () {
    const url = `${DATA_API}/trades?filterType=CASH&filterAmount=${insiderMinTradeUsd}&limit=100&takerOnly=true`
    const res = yield* rateLimitedFetch('data', url)
    const trades = yield* Effect.tryPromise({
      try: () => res.json() as Promise<DataApiTrade[]>,
      catch: (e) => new Error(`Failed to parse trades: ${e}`),
    })

    const filtered = trades.filter(
      (t) =>
        t.side === 'BUY' &&
        t.price <= insiderMaxBuyPrice &&
        !blacklist.some((b) => t.title.toLowerCase().includes(b)),
    )

    for (const t of filtered) {
      try {
        db.insert(flaggedTrades)
          .values({
            timestamp: t.timestamp,
            wallet: t.proxyWallet,
            marketTitle: t.title,
            marketSlug: t.slug ?? t.market_slug ?? '',
            conditionId: t.conditionId,
            side: t.side,
            outcome: t.outcome,
            price: t.price,
            size: t.size,
            usdAmount: t.usd_amount ?? t.price * t.size,
            source: 'insider',
            transactionHash: t.transactionHash,
          })
          .run()
      } catch {
        // unique constraint — already stored
      }

      db.insert(insiderWallets)
        .values({ wallet: t.proxyWallet, firstSeen: Date.now(), lastChecked: 0 })
        .onConflictDoNothing()
        .run()
    }
  })

  return tick.pipe(
    Effect.catchAll((e) => Effect.sync(() => console.error('[insider] trade monitor error:', e))),
    Effect.repeat(Schedule.spaced(`${insiderPollSec} seconds`)),
  ) as Effect.Effect<never>
}

/**
 * Periodically analyzes flagged wallets against the insider profile:
 * low position count, bounded PnL, large single position.
 */
function walletAnalyzerLoop(
  config: TrackerConfig,
  db: TrackerDb,
  onOpportunity: (opp: RawOpportunity) => void,
): Effect.Effect<never> {
  const { insiderAnalyzeSec, insiderMaxPositions, insiderPnlMin, insiderPnlMax, insiderMinPositionUsd } =
    config.smartMoney

  const tick = Effect.gen(function* () {
    const cutoff = Date.now() - insiderAnalyzeSec * 1000
    const wallets = db
      .select()
      .from(insiderWallets)
      .where(lt(insiderWallets.lastChecked, cutoff))
      .all()

    let flaggedCount = 0

    for (const w of wallets) {
      const url = `${DATA_API}/trades?user=${w.wallet}&limit=50`
      const res = yield* rateLimitedFetch('data', url)
      const trades = yield* Effect.tryPromise({
        try: () => res.json() as Promise<DataApiTrade[]>,
        catch: (e) => new Error(`Failed to parse wallet trades: ${e}`),
      })

      const conditionIds = new Set(trades.map((t) => t.conditionId))
      const positions = conditionIds.size
      const pnl = trades.reduce((sum, t) => {
        const amt = t.usd_amount ?? t.price * t.size
        return sum + (t.side === 'SELL' ? amt : -amt)
      }, 0)

      const positionSizes = new Map<string, number>()
      for (const t of trades) {
        if (t.side === 'BUY') {
          const amt = t.usd_amount ?? t.price * t.size
          positionSizes.set(t.conditionId, (positionSizes.get(t.conditionId) ?? 0) + amt)
        }
      }
      const maxPositionUsd = Math.max(0, ...positionSizes.values())

      const isInsider =
        positions < insiderMaxPositions &&
        pnl >= insiderPnlMin &&
        pnl <= insiderPnlMax &&
        maxPositionUsd >= insiderMinPositionUsd

      if (isInsider) {
        flaggedCount++

        // find largest position's conditionId
        let largestId = ''
        let largestAmt = 0
        for (const [cid, amt] of positionSizes) {
          if (amt > largestAmt) {
            largestId = cid
            largestAmt = amt
          }
        }
        const largestTrade = trades.find((t) => t.conditionId === largestId && t.side === 'BUY')

        if (largestTrade) {
          onOpportunity({
            conditionId: largestId,
            side: 'YES',
            price: largestTrade.price,
            marketTitle: largestTrade.title,
            marketSlug: largestTrade.slug ?? largestTrade.market_slug ?? '',
            source: 'insider',
            traderWallet: w.wallet,
            usdAmount: largestAmt,
          })
        }

        const score = (insiderMinPositionUsd / maxPositionUsd) * 50 + (positions === 1 ? 30 : 10)
        db.update(insiderWallets)
          .set({ flagged: true, score, positionsCount: positions, pnl, maxPositionUsd, lastChecked: Date.now() })
          .where(eq(insiderWallets.wallet, w.wallet))
          .run()
      } else {
        db.update(insiderWallets)
          .set({ flagged: false, positionsCount: positions, pnl, maxPositionUsd, lastChecked: Date.now() })
          .where(eq(insiderWallets.wallet, w.wallet))
          .run()
      }
    }

    console.log(`[insider] analyzed ${wallets.length} wallets, ${flaggedCount} flagged`)
  })

  return tick.pipe(
    Effect.catchAll((e) => Effect.sync(() => console.error('[insider] wallet analyzer error:', e))),
    Effect.repeat(Schedule.spaced(`${insiderAnalyzeSec} seconds`)),
  ) as Effect.Effect<never>
}

/**
 * Starts the two-loop insider detector: trade monitor + wallet analyzer.
 * Runs both concurrently and never resolves.
 */
export function startInsiderDetector(
  config: TrackerConfig,
  db: TrackerDb,
  onOpportunity: (opp: RawOpportunity) => void,
): Effect.Effect<never> {
  return Effect.all(
    [tradeMonitorLoop(config, db), walletAnalyzerLoop(config, db, onOpportunity)],
    { concurrency: 'unbounded' },
  ) as Effect.Effect<never>
}
