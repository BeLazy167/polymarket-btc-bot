#!/bin/bash
# Kill any existing bot instances, then start a fresh one
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

pkill -f 'bun run src/index' 2>/dev/null
sleep 1

cd ~/bot
nohup bun run src/index.ts >> bot.log 2>&1 &
echo "Bot started with PID: $!"
