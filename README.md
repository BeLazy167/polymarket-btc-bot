# polymarket-btc-bot

Automated BTC 5-minute up/down trading bot for Polymarket. Uses ensemble fair value pricing (Classic + Fat Tails) to find +EV trades and exit at profit targets.

## Requirements

- [Bun](https://bun.sh) v1.3+
- Polymarket account with API credentials (for live trading)
- Alchemy account for Polygon RPC (free tier works)

## Quick Start

```bash
# 1. Clone
git clone git@github.com:BeLazy167/polymarket-btc-bot.git
cd polymarket-btc-bot

# 2. Install dependencies
bun install

# 3. Create .env from example
cp .env.example .env
# Edit .env with your keys

# 4. Run (paper trading)
bun run src/index.ts
```

## .env

```env
POLYMARKET_PRIVATE_KEY=0x...
POLYMARKET_API_KEY=...
POLYMARKET_API_SECRET=...
POLYMARKET_API_PASSPHRASE=...
POLYMARKET_FUNDER_ADDRESS=0x...
POLYGON_RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY
TELEGRAM_BOT_TOKEN=         # optional
TELEGRAM_CHAT_ID=           # optional
LOG_LEVEL=debug
```

## Config

Edit `config.yaml`:

- `mode: paper` — paper trading (no real orders)
- `mode: live` — real orders via Polymarket CLOB

Markets are auto-discovered from Gamma API every 5-min window. No manual token IDs needed.

### Strategies

| Strategy | Description | Default |
|----------|-------------|---------|
| `fairValueArb` | Buy below FV, sell at FV or +10¢ profit | Enabled |
| `lowVolRider` | Last 60s: ride locked-in positions to expiry | Enabled |
| `momentum` | Bet with trend after 80% of window | Disabled |
| `value` | Buy deep discounts, sell at 2x | Disabled |

### Risk

| Param | Default |
|-------|---------|
| `positionSizeUsdc` | $2.50 per trade |
| `maxDailyLossUsdc` | $25 (halt) |
| `maxConcurrentPositions` | 2 |

## Architecture

```
Binance WS (BTC price) ─┐
                         ├─→ Ensemble FV (Classic + Fat Tails ν=7 + ν=4)
Chainlink (ref price) ──┘         │
                                  ├─→ Strategies → Risk Manager → Executor
Polymarket WS (orderbook) ────────┘

Gamma API ─→ Market Discovery (auto-rotate every 5min)
```

## VPS Deployment (systemd)

```bash
# On VPS (Ubuntu)
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc

git clone git@github.com:BeLazy167/polymarket-btc-bot.git
cd polymarket-btc-bot
bun install

# Create .env with your keys
nano .env

# Create systemd service
sudo tee /etc/systemd/system/polybot.service << 'EOF'
[Unit]
Description=Polymarket BTC Bot
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/polymarket-btc-bot
ExecStart=/root/.bun/bin/bun run src/index.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable polybot
sudo systemctl start polybot

# View logs
journalctl -u polybot -f
```

## Geoblocking

Polymarket blocks US IPs. Run on a VPS in a non-blocked region (e.g. Montreal, Canada).

```bash
# Verify not blocked
curl https://polymarket.com/api/geoblock
# Should return {"blocked": false}
```
