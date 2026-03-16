import { positions, dailyPnl } from '../drizzle/schema.ts'
import { eq, sql } from 'drizzle-orm'
import type { TrackerConfig } from '../config/schema.ts'
import type { TrackerDb } from './db.ts'
import type { Opportunity, SignalSource } from './types.ts'

interface RiskVerdict {
  approved: boolean
  size: number
  reason?: string
}

const SIZE_MAP: Record<string, 'maxPerMarket' | 'maxInsiderTail'> = {
  'ninety-eight': 'maxPerMarket',
  'near-resolution': 'maxPerMarket',
  insider: 'maxInsiderTail',
  sweep: 'maxPerMarket',
  whale: 'maxPerMarket',
}

export class RiskManager {
  constructor(
    private config: TrackerConfig,
    private db: TrackerDb,
  ) {}

  /**
   * Gates an opportunity against exposure limits, position counts,
   * daily loss, and price ceiling. Returns sizing if approved.
   */
  evaluate(opp: Opportunity): RiskVerdict {
    const { risk } = this.config

    // --- price ceiling ---
    if (opp.price > risk.maxBuyPrice) {
      return { approved: false, size: 0, reason: `price ${opp.price} > maxBuyPrice ${risk.maxBuyPrice}` }
    }

    // --- total exposure ---
    const { total } = this.db
      .select({ total: sql<number>`COALESCE(SUM(${positions.usdAmount}), 0)` })
      .from(positions)
      .where(eq(positions.status, 'open'))
      .all()[0]!

    const size = this.computeSize(opp.sources)

    if (total + size > risk.maxTotalExposure) {
      return { approved: false, size: 0, reason: `exposure ${total}+${size} > ${risk.maxTotalExposure}` }
    }

    // --- concurrent positions ---
    const { count } = this.db
      .select({ count: sql<number>`COUNT(*)` })
      .from(positions)
      .where(eq(positions.status, 'open'))
      .all()[0]!

    if (count >= risk.maxConcurrentPositions) {
      return { approved: false, size: 0, reason: `${count} open positions >= max ${risk.maxConcurrentPositions}` }
    }

    // --- daily loss ---
    const today = new Date().toISOString().slice(0, 10)
    const rows = this.db
      .select({ totalPnl: dailyPnl.totalPnl })
      .from(dailyPnl)
      .where(eq(dailyPnl.date, today))
      .all()

    if (rows.length && (rows[0]!.totalPnl ?? 0) <= -risk.maxDailyLoss) {
      return { approved: false, size: 0, reason: `daily loss ${rows[0]!.totalPnl} hit limit -${risk.maxDailyLoss}` }
    }

    return { approved: true, size }
  }

  private computeSize(sources: SignalSource[]): number {
    const { risk } = this.config
    let size = 0
    for (const src of sources) {
      const key = SIZE_MAP[src]
      if (key) size = Math.max(size, risk[key])
    }
    return size || risk.maxPerMarket
  }
}
