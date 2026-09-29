#!/bin/bash
set -e

echo "=== Installing Bun ==="
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc

echo "=== Cloning repo ==="
git clone https://github.com/BeLazy167/polymarket-btc-bot.git ~/bot
cd ~/bot

echo "=== Installing deps ==="
bun install

echo "=== Create .env (fill in your keys) ==="
cp .env.example .env
echo ">>> Edit .env with your keys: nano .env"

echo "=== Setting up systemd service ==="
cat > /etc/systemd/system/polybot.service << 'EOF'
[Unit]
Description=Polymarket BTC Bot
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/bot
ExecStart=/root/.bun/bin/bun run src/index.ts
Restart=always
RestartSec=5
Environment=PATH=/root/.bun/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable polybot

echo "=== Done ==="
echo "1. Edit .env: nano ~/bot/.env"
echo "2. Start bot: systemctl start polybot"
echo "3. View logs: journalctl -u polybot -f"
