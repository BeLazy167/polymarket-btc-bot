# Polymarket Tracker — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a standalone Polymarket scanner/trader bot that detects 98%-sure outcomes, near-resolution opportunities, and insider/whale activity across ALL markets (politics, sports, news, events), starting in paper mode with Telegram alerts.

**Architecture:** Five concurrent signal sources (async loops in single Bun event loop) feed a shared opportunity queue with sliding-window dedup scoring. Risk manager gates entries. Paper executor logs + alerts. SQLite for persistence.

**Tech Stack:** Bun, bun:sqlite, valibot, WebSocket (built-in), Telegram Bot API, @polymarket/clob-client (for future live mode).

**Project location:** `/Users/belazy/personal/polymarket-tracker/` (NEW repo, separate from BTC bot)

---

## Batch 1: Project Scaffolding + Core Infra

### Task 1: Project Init

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `config.yaml`

**Step 1: Create project directory and init**

```bash
mkdir -p /Users/belazy/personal/polymarket-tracker
cd /Users/belazy/personal/polymarket-tracker
git init
bun init -y
```

**Step 2: Install dependencies**

```bash
bun add valibot yaml
bun add -d bun-types @types/bun
```

**Step 3: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleDetection": "force",
    "allowJs": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "noUncheckedIndexedAccess": true
  }
}
```

**Step 4: Write .gitignore**

```
node_modules/
data/
.env
*.db
```

**Step 5: Write .env.example**

```
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
POLYMARKET_API_KEY=
POLYMARKET_API_SECRET=
POLYMARKET_API_PASSPHRASE=
POLYMARKET_PRIVATE_KEY=
```

**Step 6: Commit**

```bash
git add -A && git commit -m "init project scaffolding"
```

---

### Task 2: Config Schema + Loader

**Files:**
- Create: `src/config/schema.ts`
- Create: `src/config/loader.ts`
- Create: `config.yaml`

**Step 1: Write config schema with valibot**

`src/config/schema.ts`:
```ts
import * as v from 'valibot'

const RiskSchema = v.object({
  maxTotalExposure: v.optional(v.pipe(v.number(), v.minValue(0)), 200),
  maxPerMarket: v.optional(v.pipe(v.number(), v.minValue(0)), 20),
  maxInsiderTail: v.optional(v.pipe(v.number(), v.minValue(0)), 50),
  maxConcurrentPositions: v.optional(v.pipe(v.number(), v.minValue(1)), 20),
  maxDailyLoss: v.optional(v.pipe(v.number(), v.minValue(0)), 100),
  maxBuyPrice: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1)), 0.98),
  insiderStopLoss: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1)), 0.50),
})

const ScannerSchema = v.object({
  ninetyEightPollSec: v.optional(v.pipe(v.number(), v.minValue(5)), 30),
  ninetyEightMinPrice: v.optional(v.pipe(v.number(), v.minValue(0.9), v.maxValue(1)), 0.95),
  nearResolutionPollSec: v.optional(v.pipe(v.number(), v.minValue(5)), 30),
  nearResolutionWindowMin: v.optional(v.pipe(v.number(), v.minValue(1)), 30),
  nearResolutionMinPrice: v.optional(v.pipe(v.number(), v.minValue(0.5), v.maxValue(1)), 0.85),
  minLiquidity: v.optional(v.pipe(v.number(), v.minValue(0)), 1000),
})

const SmartMoneySchema = v.object({
  insiderMaxBuyPrice: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1)), 0.20),
  insiderMinTradeUsd: v.optional(v.pipe(v.number(), v.minValue(0)), 500),
  insiderMaxPositions: v.optional(v.pipe(v.number(), v.minValue(1)), 5),
  insiderPnlRange: v.optional(v.tuple([v.number(), v.number()]), [-20000, 20000]),
  insiderMinPositionUsd: v.optional(v.pipe(v.number(), v.minValue(0)), 2000),
  insiderPollSec: v.optional(v.pipe(v.number(), v.minValue(1)), 5),
  insiderAnalyzeSec: v.optional(v.pipe(v.number(), v.minValue(5)), 60),
  sweepsPollSec: v.optional(v.pipe(v.number(), v.minValue(5)), 10),
  whalePollSec: v.optional(v.pipe(v.number(), v.minValue(5)), 10),
  whaleCount: v.optional(v.pipe(v.number(), v.minValue(1)), 20),
  whaleMinWinRate: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1)), 0.55),
})

const ScoringSchema = v.object({
  ninetyEightBase: v.optional(v.pipe(v.number(), v.minValue(0)), 80),
  nearResolutionBase: v.optional(v.pipe(v.number(), v.minValue(0)), 60),
  insiderBase: v.optional(v.pipe(v.number(), v.minValue(0)), 70),
  sweepBase: v.optional(v.pipe(v.number(), v.minValue(0)), 30),
  whaleBase: v.optional(v.pipe(v.number(), v.minValue(0)), 40),
  multiSourceBonus: v.optional(v.pipe(v.number(), v.minValue(0)), 20),
  paperThreshold: v.optional(v.pipe(v.number(), v.minValue(0)), 60),
  liveThreshold: v.optional(v.pipe(v.number(), v.minValue(0)), 80),
})

export const ConfigSchema = v.object({
  mode: v.optional(v.picklist(['paper', 'live']), 'paper'),
  risk: v.optional(RiskSchema, {}),
  scanner: v.optional(ScannerSchema, {}),
  smartMoney: v.optional(SmartMoneySchema, {}),
  scoring: v.optional(ScoringSchema, {}),
  blacklist: v.optional(v.array(v.string()), ['elon', 'tweet', 'musk']),
  telegram: v.object({
    botToken: v.string(),
    chatId: v.string(),
  }),
})

export type Config = v.InferOutput<typeof ConfigSchema>
```

**Step 2: Write config loader**

`src/config/loader.ts`:
```ts
import * as v from 'valibot'
import { parse as parseYaml } from 'yaml'
import { ConfigSchema, type Config } from './schema.ts'

export async function loadConfig(path: string): Promise<Config> {
  const raw = await Bun.file(path).text()
  const parsed = parseYaml(raw)
  // Override telegram secrets from env
  parsed.telegram = {
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? parsed.telegram?.botToken ?? '',
    chatId: process.env.TELEGRAM_CHAT_ID ?? parsed.telegram?.chatId ?? '',
  }
  return v.parse(ConfigSchema, parsed)
}
```

**Step 3: Write default config.yaml**

```yaml
mode: paper

risk:
  maxTotalExposure: 200
  maxPerMarket: 20
  maxDailyLoss: 100

scanner:
  ninetyEightPollSec: 30
  nearResolutionPollSec: 30
  minLiquidity: 1000

smartMoney:
  insiderPollSec: 5
  sweepsPollSec: 10
  whalePollSec: 10
  whaleCount: 20

blacklist:
  - elon
  - tweet
  - musk

telegram:
  botToken: ""
  chatId: ""
```

**Step 4: Commit**

```bash
git add -A && git commit -m "add config schema + loader"
```

---

### Task 3: SQLite Database

**Files:**
- Create: `src/core/db.ts`

**Step 1: Write database module**

`src/core/db.ts` — tables for flagged_trades, insider_wallets, opportunities, positions, daily_pnl.

Schema:
- `flagged_trades`: id, timestamp, wallet, market_slug, condition_id, side, outcome, price, size, usd_amount, source (insider/sweep/whale)
- `insider_wallets`: wallet, first_seen, positions_count, pnl, max_position_usd, score, last_checked
- `opportunities`: id, condition_id, side, market_title, market_slug, score, sources (JSON array), first_seen, last_updated, status (pending/executed/expired/resolved)
- `positions`: id, condition_id, side, market_title, entry_price, size, usd_amount, entry_time, source, status (open/resolved/stopped), exit_price, exit_time, pnl
- `daily_pnl`: date, total_pnl, trades_count, wins, losses

Use `Database` from `bun:sqlite`. Synchronous API, single event loop, no locking issues.

**Step 2: Commit**

```bash
git add -A && git commit -m "add SQLite database schema"
```

---

### Task 4: Rate Limiter

**Files:**
- Create: `src/core/rate-limiter.ts`

**Step 1: Write token bucket rate limiter**

Shared across all API callers. Two buckets:
- `gamma`: 2 tokens/sec, burst 5
- `data`: 3 tokens/sec, burst 10
- `moondev`: 1 token/10sec, burst 1

Exposes `async acquire(bucket: string): Promise<void>` that awaits until a token is available.

**Step 2: Commit**

```bash
git add -A && git commit -m "add shared rate limiter"
```

---

### Task 5: Telegram Alerts

**Files:**
- Create: `src/core/alerts.ts`

**Step 1: Write alerts module**

Functions:
- `sendAlert(config, message)` — sends HTML-formatted Telegram message
- `alertInsiderFlagged(config, data)` — wallet, market, size, price, position count
- `alertOpportunity(config, data)` — market name, price, source, score, time to resolution
- `alertPositionResolved(config, data)` — market, outcome, PnL
- `alertDailySummary(config, data)` — total trades, wins, losses, PnL

Reuse the BTC bot's Telegram HTTP pattern: `POST https://api.telegram.org/bot{token}/sendMessage` with `parse_mode: 'HTML'`.

**Step 2: Commit**

```bash
git add -A && git commit -m "add Telegram alerts"
```

---

## Batch 2: Signal Sources (PARALLEL — 5 agents)

All 5 tasks in this batch are independent and can be built concurrently.

### Task 6: 98% Sure Scanner

**Files:**
- Create: `src/scanner/ninety-eight.ts`

**Dependencies:** `src/core/db.ts`, `src/core/rate-limiter.ts`, config types.

**Implementation:**
- `startNinetyEightScanner(config, db, rateLimiter, onOpportunity)` — async loop
- Polls `GET https://gamma-api.polymarket.com/markets?closed=false&active=true&liquidity_num_min={config.scanner.minLiquidity}&limit=100`
- Paginate with offset to scan all markets
- For each market: parse `outcomePrices` (JSON string of numbers), check if any ≥ `config.scanner.ninetyEightMinPrice`
- Skip if market title matches any blacklist term (case-insensitive)
- Skip if market has tag "crypto" AND contains "up or down" (BTC bot territory)
- If candidate: call `onOpportunity({ conditionId, side, price, marketTitle, marketSlug, source: 'ninety-eight' })`
- Sleep `config.scanner.ninetyEightPollSec * 1000` between cycles
- Log cycle stats: markets scanned, candidates found

---

### Task 7: Near-Resolution Sniper

**Files:**
- Create: `src/scanner/near-resolution.ts`

**Dependencies:** `src/core/db.ts`, `src/core/rate-limiter.ts`, config types.

**Implementation:**
- `startNearResolutionSniper(config, db, rateLimiter, onOpportunity)` — async loop
- Polls Gamma API with `end_date_max` = now + `config.scanner.nearResolutionWindowMin` minutes, `closed=false`, `active=true`
- For each market: calculate time remaining, check if one side ≥ `config.scanner.nearResolutionMinPrice`
- For time-based markets: check if 80%+ elapsed
- Skip blacklisted terms
- Call `onOpportunity({ conditionId, side, price, marketTitle, marketSlug, source: 'near-resolution', endDate })` for candidates
- Sleep `config.scanner.nearResolutionPollSec * 1000` between cycles

---

### Task 8: Insider Detector

**Files:**
- Create: `src/smart-money/insider-detector.ts`

**Dependencies:** `src/core/db.ts`, `src/core/rate-limiter.ts`, `src/core/alerts.ts`, config types.

**Implementation — two loops:**

**Loop 1: Trade monitor (every `insiderPollSec`)**
- `GET https://data-api.polymarket.com/trades?filterType=CASH&filterAmount={config.smartMoney.insiderMinTradeUsd}&limit=100&takerOnly=true`
- Filter: `side === 'BUY'` AND `price <= config.smartMoney.insiderMaxBuyPrice`
- Skip blacklisted market titles
- Store flagged trade in `flagged_trades` table
- Extract `proxyWallet`, add to `insider_wallets` table if not exists

**Loop 2: Wallet analyzer (every `insiderAnalyzeSec`)**
- For each wallet in `insider_wallets` where `last_checked` is stale:
  - `GET https://data-api.polymarket.com/trades?user={wallet}&limit=50`
  - Count unique positions, calculate rough PnL, find max position USD
  - If matches insider profile (< 5 positions, PnL in range, position > $2K):
    - Update wallet score in DB
    - Call `alertInsiderFlagged()`
    - Call `onOpportunity()` for their largest position
  - Update `last_checked` timestamp

---

### Task 9: MoonDev Sweeps

**Files:**
- Create: `src/smart-money/sweeps.ts`

**Dependencies:** `src/core/db.ts`, `src/core/rate-limiter.ts`, config types.

**Implementation:**
- `startSweepsMonitor(config, db, rateLimiter, onOpportunity)` — async loop
- `GET https://moondev.com/api/polymarket/sweeps`
- Track last seen `transactionHash` to avoid re-processing
- For each new trade: extract trader, market, side, size, usd_amount, price
- Skip blacklisted market titles
- Store in `flagged_trades` with `source: 'sweep'`
- If `usd_amount > 1000`: call `onOpportunity({ conditionId (derive from market_slug via Gamma API lookup), side, price, marketTitle, marketSlug, source: 'sweep', traderWallet })`
- Wrap in try/catch — this is a third-party API, log errors and continue
- Sleep `config.smartMoney.sweepsPollSec * 1000` between cycles

---

### Task 10: Leaderboard Whale Tracker

**Files:**
- Create: `src/smart-money/whale-tracker.ts`

**Dependencies:** `src/core/db.ts`, `src/core/rate-limiter.ts`, config types.

**Implementation — two loops:**

**Loop 1: Leaderboard refresh (every 24h)**
- `GET https://data-api.polymarket.com/v1/leaderboard?category=OVERALL&timePeriod=MONTH&orderBy=PNL&limit={config.smartMoney.whaleCount}`
- Store/update wallet list in memory (array of `{ proxyWallet, pnl, vol }`)

**Loop 2: Wallet polling (every `whalePollSec`, rotate through wallets)**
- For each wallet in tracked list:
  - `GET https://data-api.polymarket.com/trades?user={wallet}&limit=10`
  - Compare against last known trades (track by transactionHash)
  - For new trades: store in `flagged_trades` with `source: 'whale'`
  - Call `onOpportunity()` for any new BUY with `usd_amount > 500`
- Rotate: poll 2-3 wallets per cycle to stay within rate limits

---

## Batch 3: Core Pipeline

### Task 11: Opportunity Queue

**Files:**
- Create: `src/core/opportunity-queue.ts`

**Dependencies:** `src/core/db.ts`, config types.

**Implementation:**
- `OpportunityQueue` class
- `push(opp: RawOpportunity)` — dedup by `conditionId + side`
  - If exists in sliding window (last 30 min): boost score by `config.scoring.multiSourceBonus`, add source to sources array, update `last_updated`
  - If new: insert with base score from source type
- `drain(): Opportunity[]` — returns all opportunities with score ≥ threshold, marks as `executed`
- `expire()` — remove opportunities older than 1 hour that weren't acted on
- Internal: store in `opportunities` SQLite table + in-memory map for fast lookup

**Types:**
```ts
interface RawOpportunity {
  conditionId: string
  side: 'YES' | 'NO'
  price: number
  marketTitle: string
  marketSlug: string
  source: 'ninety-eight' | 'near-resolution' | 'insider' | 'sweep' | 'whale'
  endDate?: string
  traderWallet?: string
}

interface Opportunity extends RawOpportunity {
  id: string
  score: number
  sources: string[]
  firstSeen: number
  lastUpdated: number
}
```

---

### Task 12: Risk Manager

**Files:**
- Create: `src/core/risk-manager.ts`

**Dependencies:** `src/core/db.ts`, config types.

**Implementation:**
- `RiskManager` class, constructed with `config` and `db`
- `evaluate(opp: Opportunity): { approved: boolean, size: number, reason?: string }`
  - Check: total open exposure < `maxTotalExposure`
  - Check: concurrent positions < `maxConcurrentPositions`
  - Check: daily loss < `maxDailyLoss`
  - Check: price ≤ `maxBuyPrice` (never buy above 98c)
  - Check: not blacklisted
  - Size: `maxPerMarket` for scanner sources, proportional sizing for insider tails (capped at `maxInsiderTail`)
  - Return approval + calculated size

---

### Task 13: Executor (Paper Mode)

**Files:**
- Create: `src/core/executor.ts`

**Dependencies:** `src/core/db.ts`, `src/core/alerts.ts`, config types.

**Implementation:**
- `PaperExecutor` class
- `execute(opp: Opportunity, size: number)`:
  - Log to console: market, side, price, size, score, sources
  - Insert into `positions` table with `status: 'open'`
  - Call `alertOpportunity()` via Telegram
  - Return position ID
- `sell(positionId: string, reason: string)`:
  - Update `positions` row with exit_price, exit_time, pnl, status
  - Call Telegram alert
- Future: `LiveExecutor` class wrapping CLOB client (not built in Phase 1)

---

### Task 14: Position Monitor

**Files:**
- Create: `src/core/position-monitor.ts`

**Dependencies:** `src/core/db.ts`, `src/core/alerts.ts`, `src/core/rate-limiter.ts`, config types.

**Implementation:**
- `startPositionMonitor(config, db, rateLimiter, executor, alerts)` — async loop, every 30s
- For each open position in DB:
  - Fetch market status from Gamma API: `GET https://gamma-api.polymarket.com/markets/{conditionId}`
  - If `closed === true`: market resolved
    - Determine winning outcome, calculate PnL
    - Update position: `status: 'resolved'`, exit_price, pnl
    - Update `daily_pnl` table
    - Alert via Telegram
  - If insider tail and current price < entry_price * `insiderStopLoss`:
    - Call `executor.sell()` with reason "stop-loss"
  - If open > 7 days: alert for manual review
- Daily at midnight UTC: send daily summary alert

---

## Batch 4: Composition + Integration

### Task 15: Main Entry Point

**Files:**
- Create: `src/index.ts`

**Dependencies:** All of the above.

**Implementation:**
```ts
import { loadConfig } from './config/loader.ts'
import { createDb } from './core/db.ts'
import { createRateLimiter } from './core/rate-limiter.ts'
import { OpportunityQueue } from './core/opportunity-queue.ts'
import { RiskManager } from './core/risk-manager.ts'
import { PaperExecutor } from './core/executor.ts'
import { startPositionMonitor } from './core/position-monitor.ts'
import { startNinetyEightScanner } from './scanner/ninety-eight.ts'
import { startNearResolutionSniper } from './scanner/near-resolution.ts'
import { startInsiderDetector } from './smart-money/insider-detector.ts'
import { startSweepsMonitor } from './smart-money/sweeps.ts'
import { startWhaleTracker } from './smart-money/whale-tracker.ts'

const CONFIG_PATH = process.argv[2] ?? 'config.yaml'

async function main() {
  const config = await loadConfig(CONFIG_PATH)
  const db = createDb('data/tracker.db')
  const rateLimiter = createRateLimiter()
  const queue = new OpportunityQueue(config, db)
  const risk = new RiskManager(config, db)
  const executor = new PaperExecutor(config, db)

  // Opportunity handler — shared callback for all signal sources
  const onOpportunity = (opp: RawOpportunity) => {
    queue.push(opp)
  }

  // Process queue every 5s
  setInterval(() => {
    const ready = queue.drain()
    for (const opp of ready) {
      const result = risk.evaluate(opp)
      if (result.approved) {
        executor.execute(opp, result.size)
      }
    }
    queue.expire()
  }, 5_000)

  // Start all signal sources concurrently
  startNinetyEightScanner(config, db, rateLimiter, onOpportunity)
  startNearResolutionSniper(config, db, rateLimiter, onOpportunity)
  startInsiderDetector(config, db, rateLimiter, onOpportunity)
  startSweepsMonitor(config, db, rateLimiter, onOpportunity)
  startWhaleTracker(config, db, rateLimiter, onOpportunity)

  // Start position monitor
  startPositionMonitor(config, db, rateLimiter, executor)

  console.log(`[polymarket-tracker] running in ${config.mode} mode`)
  console.log(`[polymarket-tracker] 5 signal sources active`)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
```

**Step 2: Verify**

```bash
bunx tsc --noEmit
bun run src/index.ts
```

**Step 3: Commit**

```bash
git add -A && git commit -m "wire up main entry point"
```

---

## Batch 5: Verify + Deploy

### Task 16: Type Check + Smoke Test

- `bunx tsc --noEmit` — zero errors
- `bun run src/index.ts` — starts without crash, logs signal source activity
- Verify Telegram alert fires on startup
- Let it run 5 minutes, confirm:
  - 98% scanner finds candidates (or logs "0 candidates" per cycle)
  - Near-resolution sniper polls successfully
  - Insider detector connects to Data API
  - Sweeps endpoint returns data (or gracefully handles failure)
  - Whale tracker loads leaderboard

### Task 17: Systemd Service + Deploy to VPS

- Create `polytracker.service` systemd unit
- Symlink `.env` from BTC bot
- `scp` project to `~/polymarket-tracker/` on VPS
- Start service, tail logs

---

## Agent Team Assignment

| Batch | Tasks | Parallelizable | Agent Count |
|-------|-------|----------------|-------------|
| 1 | 1-5 | Sequential (foundations) | 1 (me) |
| 2 | 6-10 | **All 5 parallel** | 5 agents |
| 3 | 11-14 | 11-12 parallel, 13-14 after | 2 then 2 |
| 4 | 15 | Sequential | 1 (me) |
| 5 | 16-17 | Sequential | 1 (me) |

**Total: 15 tasks, 5 parallel agents for signal sources.**
