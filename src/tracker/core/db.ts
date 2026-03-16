import { Effect, Context, Layer } from 'effect'
import { Database } from 'bun:sqlite'
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import { sql } from 'drizzle-orm'
import * as schema from '../drizzle/schema.ts'

export type TrackerDb = BunSQLiteDatabase<typeof schema>

export class Db extends Context.Tag('tracker/Db')<Db, TrackerDb>() {}

export const DbLive = (dbPath: string) =>
  Layer.effect(Db,
    Effect.sync(() => {
      const sqlite = new Database(dbPath)
      sqlite.run('PRAGMA journal_mode = WAL')
      sqlite.run('PRAGMA foreign_keys = ON')

      const db = drizzle(sqlite, { schema })

      // Auto-create tables via raw SQL
      const createTables = `
        CREATE TABLE IF NOT EXISTS flagged_trades (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER NOT NULL,
          wallet TEXT NOT NULL,
          market_title TEXT NOT NULL,
          market_slug TEXT NOT NULL,
          condition_id TEXT NOT NULL,
          side TEXT NOT NULL,
          outcome TEXT NOT NULL,
          price REAL NOT NULL,
          size REAL NOT NULL,
          usd_amount REAL NOT NULL,
          source TEXT NOT NULL,
          transaction_hash TEXT NOT NULL UNIQUE
        );
        CREATE TABLE IF NOT EXISTS insider_wallets (
          wallet TEXT PRIMARY KEY,
          first_seen INTEGER NOT NULL,
          positions_count INTEGER DEFAULT 0,
          pnl REAL DEFAULT 0,
          max_position_usd REAL DEFAULT 0,
          score REAL DEFAULT 0,
          last_checked INTEGER DEFAULT 0,
          flagged INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS opportunities (
          id TEXT PRIMARY KEY,
          condition_id TEXT NOT NULL,
          side TEXT NOT NULL,
          market_title TEXT NOT NULL,
          market_slug TEXT NOT NULL,
          score REAL NOT NULL,
          sources TEXT NOT NULL,
          first_seen INTEGER NOT NULL,
          last_updated INTEGER NOT NULL,
          status TEXT DEFAULT 'pending'
        );
        CREATE TABLE IF NOT EXISTS positions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          condition_id TEXT NOT NULL,
          side TEXT NOT NULL,
          market_title TEXT NOT NULL,
          market_slug TEXT NOT NULL,
          entry_price REAL NOT NULL,
          size REAL NOT NULL,
          usd_amount REAL NOT NULL,
          entry_time INTEGER NOT NULL,
          source TEXT NOT NULL,
          status TEXT DEFAULT 'open',
          exit_price REAL,
          exit_time INTEGER,
          pnl REAL
        );
        CREATE TABLE IF NOT EXISTS daily_pnl (
          date TEXT PRIMARY KEY,
          total_pnl REAL DEFAULT 0,
          trades_count INTEGER DEFAULT 0,
          wins INTEGER DEFAULT 0,
          losses INTEGER DEFAULT 0
        );
      `
      for (const stmt of createTables.split(';').filter(s => s.trim())) {
        sqlite.run(stmt)
      }

      return db
    })
  )
