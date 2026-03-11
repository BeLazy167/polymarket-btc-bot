#!/bin/bash
pkill -f 'bun run src/index' 2>/dev/null
sleep 1
pgrep -f 'bun run src/index' && kill -9 $(pgrep -f 'bun run src/index') 2>/dev/null
echo "Bot stopped"
