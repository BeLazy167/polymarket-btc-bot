# Polymarket Tracker — Design Document

## Overview

Separate bot that scans ALL Polymarket markets (politics, sports, news, crypto events) for three types of opportunities: near-certain outcomes (98% strategy), near-resolution sniping, and smart money / insider detection. Runs alongside the existing BTC 15-min bot as an independent process sharing the same wallet.

## Architecture

```
┌──────────────┐  ┌──────────────────┐  ┌────────────────┐
│  98% Sure    │  │ Near-Resolution  │  │  Smart Money   │
│  Scanner     │  │    Sniper        │  │  (3 sources)   │
└──────┬───────┘  └────────┬─────────┘  └───────┬────────┘
       │                   │                     │
       └───────────┬───────┘                     │
                   │  ┌──────────────────────────┘
                   │  │
           ┌───────▼──▼──────┐
           │ Opportunity Queue│
           │ (dedup + score)  │
           └────────┬────────┘
                    │
              ┌─────▼──────┐
              │ Risk Manager│
              └─────┬──────┘
                    │
              ┌─────▼──────┐
              │  Executor   │
              │ (paper/live)│
              └─────┬──────┘
                    │
              ┌─────▼──────┐
              │  Telegram   │
              │   Alerts    │
              └─────────────┘
```

All signal sources run as concurrent async loops in a single Bun event loop (NOT child process forks) to avoid SQLite locking.

---

## Signal Sources

### 1. 98% Sure Scanner

**Purpose:** Find markets where one outcome is ≥95c but not yet resolved.

**Data source:** `GET https://gamma-api.polymarket.com/markets?closed=false&active=true&liquidity_num_min=1000`

**Polling:** Every 30-60s.

**Entry logic:**
- Parse `outcomePrices` — flag any outcome ≥ 0.95
- Verify ask-side liquidity can absorb the order without slippage
- Skip crypto price markets (BTC bot territory), skip Elon tweet markets

**Risk:** Market at 96c can crash to 0c if "obvious" outcome reverses. Sports mid-game (team up 5-0, 2 mins left) is safer than politics.

**Target:** Event-based markets — politics, news, sports outcomes where the result is practically decided but hasn't officially resolved.

### 2. Near-Resolution Sniper

**Purpose:** Find markets approaching resolution where one side is clearly winning (85-95c range).

**Data source:** Same Gamma API, filtered by `end_date_max` within next 30 mins.

**Polling:** Every 30s.

**Entry logic:**
- Time-based markets (crypto up/down, sports): if 80%+ of time elapsed and one side ≥ 0.85, evaluate
- Event-based markets: check if the event has effectively occurred but market hasn't officially settled
- Cross-check with external data where possible (live scores, news feeds, price feeds)

**Key difference from 98% scanner:** Catches markets at 85-95c where resolution timing gives an edge. Slightly more risk, slightly more reward.

**Target:** Both time-based and event-based markets.

### 3. Smart Money — Three Sub-Sources

#### 3a. Insider Detector

**Purpose:** Find fresh wallets making suspicious high-conviction bets (the Venezuelan $30K → $400K pattern).

**Data sources:**
- Polymarket WebSocket for real-time trade stream
- `GET https://data-api.polymarket.com/trades?filterType=CASH&filterAmount=500&limit=100` as backup polling (every 5s)
- `GET https://data-api.polymarket.com/trades?user={wallet}` for position analysis of flagged wallets

**Insider profile criteria:**
- Buy price ≤ 20c (high-conviction low-probability bet)
- < 5 positions (fresh account)
- PnL between -$20K and +$20K (new account)
- At least one position sized > $2K
- Skip crypto price markets and Elon tweet markets

**Detection flow:**
1. Monitor all incoming trades via WebSocket
2. Flag any buy at ≤ 20c with size > $500
3. Fetch flagged wallet's full profile from Data API
4. If profile matches insider criteria → flag in SQLite, alert via Telegram, push to opportunity queue

**Analysis cadence:** Check flagged wallets every 60s for updated positions.

#### 3b. MoonDev Sweeps

**Purpose:** Firehose of large trades across all markets as supplementary signal.

**Data source:** `GET https://moondev.com/api/polymarket/sweeps`

**Polling:** Every 10s.

**Caveat:** Third-party, no SLA. Treat as supplementary — if it goes down, other sources still work. Validate data against official Polymarket APIs.

**Processing:** Extract trader, market, side, size, price. Cross-reference with insider detector and whale tracker for dedup/conviction boost.

#### 3c. Leaderboard Wallet Tracker

**Purpose:** Follow known profitable traders' new positions.

**Data sources:**
- `GET https://data-api.polymarket.com/v1/leaderboard?category=OVERALL&timePeriod=MONTH&orderBy=PNL&limit=20` — seed list
- `GET https://data-api.polymarket.com/trades?user={wallet}&limit=20` — poll each wallet

**Polling:** Every 10s, rotate through 15-20 wallets.

**Wallet curation:**
- Seed from top 20 monthly PnL leaderboard (refreshed weekly)
- Can filter by category: POLITICS, SPORTS, CRYPTO, etc.
- Track each wallet's rolling 30-day ROI
- Prune wallets that drop below 55% win rate

---

## Opportunity Queue

**Dedup logic:** Key by `conditionId` (market ID) + `side` (YES/NO).

**Sliding window scoring:** Same market surfacing from multiple sources within a time window accumulates conviction rather than being silently dropped.

| Source | Base Score |
|--------|-----------|
| 98% scanner (price ≥ 0.95) | 80 |
| Near-resolution (price ≥ 0.85, < 30 min left) | 60 |
| Insider detector (profile match) | 70 |
| MoonDev sweep (large trade) | 30 |
| Leaderboard whale (known profitable wallet) | 40 |
| Multiple sources agree | +20 per additional source |

**Threshold to act:** Score ≥ 60 for paper logging, ≥ 80 for live execution (when enabled).

---

## Risk Manager

**Hard ceiling:** `maxTotalExposure: 200` USDC. No shared DB with BTC bot needed — just keep this well below wallet balance minus BTC bot's needs.

| Strategy | Max Per Market | Max Concurrent |
|----------|---------------|----------------|
| 98% Sure | $20 | 10 |
| Near-Resolution | $20 | 10 |
| Insider Tail | $50 (configurable) | 5 |

**Rules:**
- Max daily loss: $100 (configurable)
- Never buy above 98c
- Insider tailing: size proportional to insider's conviction (bigger insider bet → bigger tail), capped
- Blacklist: crypto price markets (BTC bot handles), Elon tweet markets
- Stop-loss for insider tails: 50% of entry price

---

## Execution

**Phase 1 (Paper):**
- All strategies log to SQLite + Telegram alerts
- No real trades executed
- Track what *would have* happened for P&L validation

**Phase 2 (Live):**
- 98% + near-resolution: auto-trade via CLOB API
- Insider signals: auto-tail with configurable sizing
- All trades still alert via Telegram

**Shared infra with BTC bot:**
- Same Polymarket wallet / API keys (env vars)
- Same Telegram bot token
- Reuse CLOB client pattern from BTC bot's `execution/service.ts`

---

## Position Lifecycle

**`position-monitor.ts`** — polls open positions, tracks through resolution.

1. **Entry:** buy shares via CLOB (or log in paper mode)
2. **Monitor:** poll market status every 30s for open positions
3. **Resolution:** market resolves → record outcome, calculate P&L
4. **Stop-loss:** (insider tails only) if price drops below 50% of entry, sell
5. **Timeout:** if position is open > 7 days with no resolution, alert for manual review

**P&L tracking:** All entries/exits stored in SQLite with timestamps, prices, outcomes. Used to tune signal weights over time.

---

## Rate Limiting

**Shared fetch wrapper** with token bucket for Gamma API (used by both 98% scanner and near-resolution sniper). Prevents throttling when both poll on independent intervals.

**Per-source rate awareness:**
- Gamma API: max 2 req/s shared across scanners
- Data API: max 3 req/s shared across smart money sources
- MoonDev: conservative 1 req/10s (unknown limits)
- CLOB API: 60 orders/min (Polymarket documented limit)

---

## Tech Stack

- **Runtime:** Bun
- **Database:** `bun:sqlite` — single process, all async loops in one event loop
- **WebSocket:** built-in `WebSocket` for Polymarket trade stream
- **HTTP:** built-in `fetch` for API polling
- **Alerts:** Telegram Bot API (reuse pattern from BTC bot)
- **Execution:** `@polymarket/clob-client` (reuse from BTC bot)
- **Config:** YAML + valibot validation (same pattern as BTC bot)

---

## Project Structure

```
polymarket-tracker/
  src/
    scanner/
      ninety-eight.ts        # 98% sure scanner (Gamma API)
      near-resolution.ts     # near-resolution sniper (Gamma API)
    smart-money/
      insider-detector.ts    # WS + Data API, flag fresh wallets
      sweeps.ts              # MoonDev endpoint polling
      whale-tracker.ts       # Leaderboard wallet polling
    core/
      opportunity-queue.ts   # dedup, sliding window scoring
      risk-manager.ts        # sizing, limits, blacklist, ceiling
      executor.ts            # paper log or CLOB execution
      position-monitor.ts    # track open positions through resolution
      alerts.ts              # Telegram notifications
      db.ts                  # SQLite schema + queries
      rate-limiter.ts        # shared token bucket for API calls
    config/
      schema.ts              # valibot config schema
      service.ts             # YAML loader
    index.ts                 # compose and run all services
  data/
    tracker.db               # SQLite database (gitignored)
  config.yaml                # runtime config
  package.json
  tsconfig.json
```

---

## Deployment

- Separate directory on VPS: `~/polymarket-tracker/`
- Separate systemd service: `polytracker.service`
- Runs alongside `polybot.service` (BTC bot)
- Same `.env` file for wallet keys (symlinked or shared)

---

## Open Questions

- MoonDev sweeps API reliability? Have fallback if it goes down
- Gamma API undocumented rate limits? Need to discover empirically
- Insider detector WebSocket: which Polymarket WS channel carries all trades with wallet info? Need to verify the market channel includes `proxyWallet` field
- Scoring weights: initial values are guesses, need tuning after paper trading phase
- Multi-outcome markets: the 98% scanner needs to handle markets with >2 outcomes (not just binary YES/NO)
