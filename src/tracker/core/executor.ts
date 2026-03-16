import { eq, sql } from 'drizzle-orm'
import { positions, dailyPnl } from '../drizzle/schema.ts'
import type { TrackerConfig } from '../config/schema.ts'
import type { TrackerDb } from './db.ts'
import type { Opportunity } from './types.ts'

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export class PaperExecutor {
  constructor(
    private config: TrackerConfig,
    private db: TrackerDb,
  ) {}

  /** Opens a paper position, inserts into DB, returns position ID. */
  execute(opp: Opportunity, size: number): number {
    const shares = size / opp.price

    const [row] = this.db
      .insert(positions)
      .values({
        conditionId: opp.conditionId,
        side: opp.side,
        marketTitle: opp.marketTitle,
        marketSlug: opp.marketSlug,
        entryPrice: opp.price,
        size: shares,
        usdAmount: size,
        entryTime: Date.now(),
        source: opp.sources.join('+'),
        status: 'open',
      })
      .returning({ id: positions.id })
      .all()

    console.log(
      `[PAPER BUY] ${opp.side} ${opp.marketTitle} @ ${(opp.price * 100).toFixed(0)}¢ $${size.toFixed(0)} [${opp.sources.join('+')}] score=${opp.score}`,
    )

    return row!.id
  }

  /** Sells (stops) an open position at exitPrice. */
  sell(positionId: number, exitPrice: number, reason: string): void {
    const pos = this.db.select().from(positions).where(eq(positions.id, positionId)).get()!
    const pnl = (exitPrice - pos.entryPrice) * pos.size

    this.db
      .update(positions)
      .set({ status: 'stopped', exitPrice, exitTime: Date.now(), pnl })
      .where(eq(positions.id, positionId))
      .run()

    this.updateDailyPnl(pnl)

    console.log(`[PAPER SELL] ${reason} PnL: $${pnl.toFixed(2)}`)
  }

  /** Resolves a position after market settlement. */
  resolve(positionId: number, won: boolean): void {
    const pos = this.db.select().from(positions).where(eq(positions.id, positionId)).get()!
    const exitPrice = won ? 1.0 : 0.0
    const pnl = (exitPrice - pos.entryPrice) * pos.size

    this.db
      .update(positions)
      .set({ status: 'resolved', exitPrice, exitTime: Date.now(), pnl })
      .where(eq(positions.id, positionId))
      .run()

    this.updateDailyPnl(pnl)

    console.log(`[PAPER ${won ? 'WIN' : 'LOSS'}] ${pos.marketTitle} PnL: $${pnl.toFixed(2)}`)
  }

  private updateDailyPnl(pnl: number): void {
    const date = today()
    const win = pnl > 0

    this.db
      .insert(dailyPnl)
      .values({
        date,
        totalPnl: pnl,
        tradesCount: 1,
        wins: win ? 1 : 0,
        losses: win ? 0 : 1,
      })
      .onConflictDoUpdate({
        target: dailyPnl.date,
        set: {
          tradesCount: sql`${dailyPnl.tradesCount} + 1`,
          totalPnl: sql`${dailyPnl.totalPnl} + ${pnl}`,
          wins: sql`${dailyPnl.wins} + ${win ? 1 : 0}`,
          losses: sql`${dailyPnl.losses} + ${win ? 0 : 1}`,
        },
      })
      .run()
  }
}
