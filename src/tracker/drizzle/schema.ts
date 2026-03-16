import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core'

export const flaggedTrades = sqliteTable('flagged_trades', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  timestamp: integer('timestamp').notNull(),
  wallet: text('wallet').notNull(),
  marketTitle: text('market_title').notNull(),
  marketSlug: text('market_slug').notNull(),
  conditionId: text('condition_id').notNull(),
  side: text('side', { enum: ['BUY', 'SELL'] }).notNull(),
  outcome: text('outcome').notNull(),
  price: real('price').notNull(),
  size: real('size').notNull(),
  usdAmount: real('usd_amount').notNull(),
  source: text('source', { enum: ['insider', 'sweep', 'whale'] }).notNull(),
  transactionHash: text('transaction_hash').notNull().unique(),
})

export const insiderWallets = sqliteTable('insider_wallets', {
  wallet: text('wallet').primaryKey(),
  firstSeen: integer('first_seen').notNull(),
  positionsCount: integer('positions_count').default(0),
  pnl: real('pnl').default(0),
  maxPositionUsd: real('max_position_usd').default(0),
  score: real('score').default(0),
  lastChecked: integer('last_checked').default(0),
  flagged: integer('flagged', { mode: 'boolean' }).default(false),
})

export const opportunities = sqliteTable('opportunities', {
  id: text('id').primaryKey(),
  conditionId: text('condition_id').notNull(),
  side: text('side', { enum: ['YES', 'NO'] }).notNull(),
  marketTitle: text('market_title').notNull(),
  marketSlug: text('market_slug').notNull(),
  score: real('score').notNull(),
  sources: text('sources', { mode: 'json' }).$type<string[]>().notNull(),
  firstSeen: integer('first_seen').notNull(),
  lastUpdated: integer('last_updated').notNull(),
  status: text('status', { enum: ['pending', 'executed', 'expired', 'resolved'] }).default('pending'),
})

export const positions = sqliteTable('positions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  conditionId: text('condition_id').notNull(),
  side: text('side', { enum: ['YES', 'NO'] }).notNull(),
  marketTitle: text('market_title').notNull(),
  marketSlug: text('market_slug').notNull(),
  entryPrice: real('entry_price').notNull(),
  size: real('size').notNull(),
  usdAmount: real('usd_amount').notNull(),
  entryTime: integer('entry_time').notNull(),
  source: text('source').notNull(),
  status: text('status', { enum: ['open', 'resolved', 'stopped'] }).default('open'),
  exitPrice: real('exit_price'),
  exitTime: integer('exit_time'),
  pnl: real('pnl'),
})

export const dailyPnl = sqliteTable('daily_pnl', {
  date: text('date').primaryKey(),
  totalPnl: real('total_pnl').default(0),
  tradesCount: integer('trades_count').default(0),
  wins: integer('wins').default(0),
  losses: integer('losses').default(0),
})
