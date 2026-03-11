/**
 * Close all open positions from recent trades.
 * Usage: bun scripts/close-positions.ts [config.yaml]
 */
import { loadConfig } from '../src/config/markets.ts'
import { LiveExecutor } from '../src/execution/executor.ts'
import { fetchMarket } from '../src/data/market-discovery.ts'
import type { TickSize } from '../src/config/schema.ts'

const CONFIG_PATH = process.argv[2] ?? 'config.yaml'

// Known epochs from recent trades
const MARKETS_TO_CHECK = [
  { epoch: 1773207900, windowSec: 900, label: '15m' },   // 5.4 NO shares
  { epoch: 1773204900, windowSec: 300, label: '5m' },    // 5.02 NO (phantom)
  { epoch: 1773205200, windowSec: 300, label: '5m' },    // 5.02 YES (phantom)
]

async function main() {
  const config = await loadConfig(CONFIG_PATH)
  const executor = new LiveExecutor(config)

  for (const { epoch, windowSec, label } of MARKETS_TO_CHECK) {
    console.log(`\n--- Checking ${label} epoch ${epoch} ---`)

    const market = await fetchMarket(epoch, windowSec)
    if (!market) {
      console.log(`  Market not found for epoch ${epoch}`)
      continue
    }

    console.log(`  Slug: ${market.slug}`)
    console.log(`  YES token: ${market.yesTokenId}`)
    console.log(`  NO  token: ${market.noTokenId}`)

    // Check balances
    const yesBal = await executor.getTokenBalance(market.yesTokenId)
    const noBal = await executor.getTokenBalance(market.noTokenId)

    console.log(`  YES balance: ${yesBal}`)
    console.log(`  NO  balance: ${noBal}`)

    const tickSize = (market.tickSize || '0.01') as TickSize

    // Sell YES if any
    if (yesBal > 0.5) {
      console.log(`  Selling ${yesBal} YES shares...`)
      const result = await executor.sell(market.yesTokenId, yesBal, tickSize, market.negRisk)
      console.log(`  YES sell result:`, result)
    }

    // Sell NO if any
    if (noBal > 0.5) {
      console.log(`  Selling ${noBal} NO shares...`)
      const result = await executor.sell(market.noTokenId, noBal, tickSize, market.negRisk)
      console.log(`  NO sell result:`, result)
    }

    if (yesBal <= 0.5 && noBal <= 0.5) {
      console.log(`  No shares to sell`)
    }
  }

  console.log('\nDone.')
  process.exit(0)
}

main()
