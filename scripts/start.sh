#!/bin/bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

cd ~/bot
nohup bun run src/index.ts >> bot.log 2>&1 &
echo "Bot started PID: $!"
