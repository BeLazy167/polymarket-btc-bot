import type { TrackerConfig } from '../config/schema.ts'
import type { TrackerDb } from './db.ts'
import type { RawOpportunity, Opportunity, SignalSource } from './types.ts'
import { opportunities } from '../drizzle/schema.ts'
import { eq, and, lt } from 'drizzle-orm'

const DEDUP_WINDOW_MS = 30 * 60 * 1000
const EXPIRY_MS = 60 * 60 * 1000

const BASE_SCORE: Record<SignalSource, keyof TrackerConfig['scoring']> = {
  'ninety-eight': 'ninetyEightBase',
  'near-resolution': 'nearResolutionBase',
  insider: 'insiderBase',
  sweep: 'sweepBase',
  whale: 'whaleBase',
}

// Cache slug → conditionId lookups to avoid repeated Gamma API calls
const conditionIdCache = new Map<string, string>()

export class OpportunityQueue {
  private map = new Map<string, Opportunity>()
  private config: TrackerConfig
  private db: TrackerDb

  constructor(config: TrackerConfig, db: TrackerDb) {
    this.config = config
    this.db = db
  }

  /**
   * Resolves conditionId for opportunities that lack it (e.g. sweeps).
   * Tries Gamma API lookup by slug, caches result.
   */
  private resolveConditionId(opp: RawOpportunity): void {
    if (opp.conditionId) return
    const cached = conditionIdCache.get(opp.marketSlug)
    if (cached) {
      opp.conditionId = cached
      return
    }
    // Fire-and-forget async resolution — next push with same slug will have it cached
    fetch(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(opp.marketSlug)}&limit=1`)
      .then(r => r.json())
      .then((markets: unknown) => {
        if (Array.isArray(markets) && markets[0]?.conditionId) {
          conditionIdCache.set(opp.marketSlug, markets[0].conditionId as string)
        }
      })
      .catch(() => {})
  }

  /**
   * Push a raw opportunity into the queue.
   * Deduplicates by conditionId/slug + side within a 30-min sliding window,
   * boosting score when multiple sources agree.
   */
  push(opp: RawOpportunity): void {
    this.resolveConditionId(opp)
    const key = `${opp.conditionId || opp.marketSlug}:${opp.side}`
    const now = Date.now()
    const existing = this.map.get(key)

    if (existing && now - existing.lastUpdated < DEDUP_WINDOW_MS) {
      if (!existing.sources.includes(opp.source)) {
        existing.sources.push(opp.source)
        existing.score += this.config.scoring.multiSourceBonus
      }
      existing.lastUpdated = now
      // Keep most extreme price (highest for YES, lowest for NO)
      if (opp.side === 'YES' ? opp.price > existing.price : opp.price < existing.price) {
        existing.price = opp.price
      }
      this.db.update(opportunities)
        .set({
          score: existing.score,
          sources: existing.sources,
          lastUpdated: now,
        })
        .where(eq(opportunities.id, existing.id))
        .run()
      return
    }

    const id = crypto.randomUUID()
    const score = this.config.scoring[BASE_SCORE[opp.source]] as number
    const entry: Opportunity = {
      ...opp,
      id,
      score,
      sources: [opp.source],
      firstSeen: now,
      lastUpdated: now,
    }

    this.map.set(key, entry)
    this.db.insert(opportunities)
      .values({
        id,
        conditionId: opp.conditionId,
        side: opp.side,
        marketTitle: opp.marketTitle,
        marketSlug: opp.marketSlug,
        score,
        sources: [opp.source],
        firstSeen: now,
        lastUpdated: now,
        status: 'pending',
      })
      .run()
  }

  /** Drain all actionable opportunities above the score threshold. */
  drain(): Opportunity[] {
    const threshold = this.config.mode === 'live'
      ? this.config.scoring.liveThreshold
      : this.config.scoring.paperThreshold

    const results: Opportunity[] = []
    for (const [, opp] of this.map) {
      if (opp.score >= threshold) results.push(opp)
    }

    for (const opp of results) {
      this.db.update(opportunities)
        .set({ status: 'executed' })
        .where(eq(opportunities.id, opp.id))
        .run()
      // Remove from memory so they aren't drained twice
      const key = `${opp.conditionId || opp.marketSlug}:${opp.side}`
      this.map.delete(key)
    }

    return results
  }

  /** Expire stale opportunities (>1h) from memory and DB. */
  expire(): void {
    const cutoff = Date.now() - EXPIRY_MS
    for (const [key, opp] of this.map) {
      if (opp.lastUpdated < cutoff) this.map.delete(key)
    }
    this.db.update(opportunities)
      .set({ status: 'expired' })
      .where(and(
        eq(opportunities.status, 'pending'),
        lt(opportunities.lastUpdated, cutoff),
      ))
      .run()
  }
}
