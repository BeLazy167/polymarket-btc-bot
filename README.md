# polymarket-btc-bot

A Bun program that trades Polymarket's BTC up/down markets. Every five minutes (or fifteen minutes, or one hour, depending on `windowDurationSec`) Polymarket opens a market asking whether BTC will finish the window above or below its open price. The bot computes its own probability for the up outcome from a live Binance price feed, compares it to the Polymarket order book, buys whichever side the market is underpricing, and sells before or at window expiry.

## How it works

### Market discovery

The bot polls the Gamma API for the slug `btc-updown-5m-<epoch>` (or the matching prefix for the configured window length) and re-subscribes to the new token IDs on every window rotation. It fetches the window's BTC open price from `polymarket.com/api/crypto/crypto-price`, then waits a cooldown of 5 seconds on 5-minute windows or 30 seconds on 15-minute and longer windows before trading (`src/index.ts:194`).

### Fair value

The bot estimates annualized BTC volatility from one-minute log returns using EWMA (lambda 0.94 by default) and GARCH(1,1) (omega 1e-6, alpha 0.1, beta 0.85 by default), floored at 30 percent and bootstrapped at 60 percent. On each one-second tick it picks a pricing model based on the volatility regime:

- Below `lowVolThreshold` (default sigma 0.40): `classic`, a lognormal model `Phi((ln(S/K) - 0.5*sigma^2*T) / (sigma*sqrt(T)))` (`src/models/classic.ts`).
- Between the thresholds: `fat-tails` with Student-t degrees of freedom `studentTNu` (default 7).
- Above `highVolThreshold` (default sigma 0.65): `fat-tails` with nu fixed at 4.

The fair value of the up token is the model probability that BTC finishes above the window's open price. The down token's fair value is one minus that.

### Sizing and risk

Every trade uses a fixed USDC amount, `risk.positionSizeUsdc` (default 2.50). The risk manager halts all trading for the day once cumulative P&L falls below `-maxDailyLossUsdc` (default 25) and caps open positions at `maxConcurrentPositions` (default 2). `src/index.ts:93` hardcodes a limit of 2 entries per window.

### Strategies

Four strategies are wired into the tick loop. Each returns a signal when its trigger fires, and the first approved signal wins the tick.

| Strategy | What it does | Default |
|----------|--------------|---------|
| `fairValueArb` | Buys a side when `fairValue - marketPrice >= minGap` (10 cents by default). Accepts entries up to 85 cents when the gap is 15 cents or more. | Enabled |
| `lowVolRider` | In the last `activateLastSec` seconds (default 60), buys the winning side when the price gap from the open exceeds `minSigmaGap` (3 sigma) and fair value is at least 0.90. Accepts up to 95 cents at a 7 sigma gap. | Enabled |
| `momentum` | Enters after `entryThreshold` of the window (80 percent) when the last `minConsecutiveMinutes` (3) minute closes moved the same direction, or early when BTC moves more than `earlyMomentumThreshold` dollars (100) in the first 2 minutes. | Enabled |
| `value` | Buys a side priced below `fairValue * (1 - discountThreshold)` (20 percent discount), never above `maxEntryPrice` (10 cents). | Enabled |

### Exits

The tick loop checks open positions against these rules in order:

1. Exit at fair value. When `exitAtFairValue` is on (default) and the best bid reaches the model's fair value, the bot sells.
2. Fixed take profit. The bot sells when the bid reaches entry plus 10 cents (`src/index.ts:421`; the schema's `takeProfitCents` default of 0.10 documents the same number, but the check in `src/index.ts` is hardcoded).
3. Low-vol-rider stop loss. Rider positions sell when the bid drops 10 cents below entry.
4. Trailing stop. Non-rider positions sell when the bid falls `edge * 0.60` below the peak bid, after the peak exceeded entry by `edge * 0.40`.
5. Emergency dump. In the last 10 seconds of the window the bot sells at any positive bid.
6. Window expiry. When the window rolls over, the bot sells whatever remains. If fewer than 5 shares are left it stops retrying and lets the position resolve on-chain.

The live executor buys with a GTC limit order at the current ask (capped at 97 cents), sized at `minOrderSize + 1` shares to absorb the fee, polls `getOrder` every 2 seconds for up to 10 seconds, and cancels the remainder. Sells try FAK first, then fall back to a GTC order one cent below the best bid (`src/execution/executor.ts`).

## Architecture

```
src/
  index.ts                  main 1-second tick loop, wiring, exit logic
  config/
    markets.ts              YAML loader, env var overrides, window metadata
    schema.ts               valibot schema with all defaults
  data/
    binance-ws.ts           BTC/USDT websocket feed
    polymarket-ws.ts        Polymarket order book websocket
    market-discovery.ts     Gamma API lookup, crypto-price open price
    price-store.ts          rolling price history
  models/
    classic.ts              lognormal fair value
    fat-tails.ts            Student-t fair value
    garch.ts, math.ts       EWMA/GARCH variance, distribution functions
  strategies/
    fair-value-arb.ts       buy when market lags fair value
    low-vol-rider.ts        ride near-certain outcomes in the last 60s
    momentum.ts             consecutive-minute trend entries
    value.ts                buy deep discounts below fair value
  risk/manager.ts           position sizing, daily loss halt
  execution/
    executor.ts             live CLOB orders, buy poll, FAK/GTC sell
    paper.ts                simulated fills
    executor.test.ts        bun:test suite for the sell path
  monitoring/
    logger.ts               pino logger, terminal output
    alerts.ts               Telegram alerts and pause/resume polling
scripts/
  setup.ts                  derives Polymarket API keys, writes .env
  close-positions.ts        sells a stuck position by token ID
  test-sell-flow.ts         exercises the sell path on the live CLOB
```

The Binance websocket feeds the volatility models and the current price. The Polymarket websocket feeds best bid and ask. The Gamma API resolves each window's market. On every tick the loop computes a fair value, the strategies produce signals, the risk manager approves them, and the executor places orders.

## Requirements

- Bun. The README targets v1.3 or later. The lockfile (`bun.lock`, `lockfileVersion` 1) comes from Bun 1.3.x.
- A Polymarket account and wallet for live mode. Paper mode needs no credentials.
- Network access to Binance, Polymarket CLOB, and Gamma API endpoints.

## Setup

```bash
git clone https://github.com/BeLazy167/polymarket-btc-bot.git
cd polymarket-btc-bot
bun install
cp .env.example .env
cp config.example.yaml config.yaml
```

The example config ships with `mode: paper`, so a first run places no real orders. Edit `.env` with your credentials for live mode. `bun run setup` (`scripts/setup.ts`) takes a private key and an optional funder address, derives the Polymarket API credentials, writes `.env`, and lists active BTC markets.

## Configuration

Configuration lives in two layers. `config.yaml` holds strategy, risk, and model parameters (see `config.example.yaml` for the full set and `src/config/schema.ts` for every default). Environment variables override the secrets in `config.yaml` and are the only way to set them without putting keys in the YAML file.

| Variable | Required | Default | What it does |
|----------|----------|---------|--------------|
| `POLYMARKET_PRIVATE_KEY` | Live mode only | empty | Wallet private key that signs CLOB orders. `src/config/markets.ts:17` |
| `POLYMARKET_API_KEY` | Live mode only | empty | Polymarket API key. `src/config/markets.ts:18` |
| `POLYMARKET_API_SECRET` | Live mode only | empty | Polymarket API secret. `src/config/markets.ts:19` |
| `POLYMARKET_API_PASSPHRASE` | Live mode only | empty | Polymarket API passphrase. `src/config/markets.ts:20` |
| `POLYMARKET_FUNDER_ADDRESS` | No | empty | Polymarket profile address for magic/email wallets. `src/config/markets.ts:21` |
| `TELEGRAM_BOT_TOKEN` | No | empty | Enables Telegram alerts and pause/resume commands. Only applied when a `telegram:` block exists in the YAML. `src/config/markets.ts:24` |
| `TELEGRAM_CHAT_ID` | No | empty | Chat ID for Telegram alerts. `src/config/markets.ts:25` |
| `LOG_LEVEL` | No | `info` | Pino level (`debug`, `info`, `warn`, `error`). `src/monitoring/logger.ts:4` |

The unmerged `feat/urgent-sell-fv-gate` branch reads three more variables for a second executor, `POLYMARKET_API_KEY_CVD`, `POLYMARKET_API_SECRET_CVD`, `POLYMARKET_API_PASSPHRASE_CVD`, plus `POLYGON_RPC_URL` for on-chain redemption in `src/execution/redeem.ts`. None of them exist on master.

## Running

```bash
# Paper mode (mode: paper in config.yaml)
bun run start

# Live mode (mode: live) with a different config file
bun run src/index.ts my-15m.yaml

# Tests
bun test
```

Paper mode logs simulated fills and estimates P&L as `edge * size` per trade (`src/execution/paper.ts:49`). It does not touch the CLOB for orders, so the Polymarket credentials can be empty. It still connects to the live websocket feeds for prices and books.

The first positional argument selects the config file, defaulting to `config.yaml` (`src/index.ts:23`). For the 15-minute markets, copy `config.example.yaml`, set `windowDurationSec: 900`, and pass that file as the argument.

## Deployment

`deploy.sh` installs Bun, clones the repo to `~/bot`, writes a systemd unit, and enables it as `polybot`. The unit hardcodes `User=root` and `WorkingDirectory=/root/bot`. Edit it before running on your own VPS.

Polymarket geoblocks US IPs. Check `https://polymarket.com/api/geoblock` from the host before running live.

## Tests

`bun test` runs `src/execution/executor.test.ts`, which mocks the CLOB client and covers the sell path: FAK-versus-balance accounting, the GTC fallback price, and positions smaller than the 5-share minimum order.

## Risk disclaimer

This is not financial advice. The bot places real orders with real USDC when `mode` is `live`, and every strategy above can and does lose money. The `maxDailyLossUsdc` halt only stops new entries after losses have already happened.

Polymarket restricts access by jurisdiction and prohibits use from the United States and other blocked regions. Using the bot from a blocked jurisdiction, or through a VPS to evade geoblocking, may violate Polymarket's terms of service and applicable law. Review the terms yourself before running live. You are responsible for your own compliance and your own losses.
