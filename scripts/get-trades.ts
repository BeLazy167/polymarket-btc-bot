/**
 * Fetch all trades from Polymarket CLOB API.
 * Usage: bun scripts/get-trades.ts [config.yaml]
 */
import { ClobClient, Chain } from '@polymarket/clob-client'
import { Wallet } from '@ethersproject/wallet'
import { loadConfig } from '../src/config/markets.ts'

const CONFIG_PATH = process.argv[2] ?? 'config.yaml'

async function main() {
  const config = await loadConfig(CONFIG_PATH)
  const wallet = new Wallet(config.polymarket.privateKey)
  const client = new ClobClient(
    'https://clob.polymarket.com',
    Chain.POLYGON,
    wallet,
    {
      key: config.polymarket.apiKey,
      secret: config.polymarket.apiSecret,
      passphrase: config.polymarket.apiPassphrase,
    },
    config.polymarket.signatureType,
    config.polymarket.funderAddress || undefined,
  )

  console.log('Fetching all trades...\n')
  const trades = await client.getTrades()

  if (!trades || trades.length === 0) {
    console.log('No trades found.')
    process.exit(0)
  }

  console.log(`Found ${trades.length} trades:\n`)

  // Group buys and sells by asset to compute PnL
  let totalSpent = 0
  let totalReceived = 0

  for (const t of trades) {
    const time = new Date(Number(t.match_time) * 1000).toISOString().replace('T', ' ').slice(0, 19)
    const side = t.side.toUpperCase().padEnd(4)
    const price = Number(t.price)
    const size = Number(t.size)
    const cost = price * size
    const feeBps = Number(t.fee_rate_bps)
    const fee = cost * feeBps / 10000

    if (t.side === 'BUY') {
      totalSpent += cost + fee
    } else {
      totalReceived += cost - fee
    }

    console.log(`${time}  ${side}  ${size.toFixed(2).padStart(7)} @ ${(price * 100).toFixed(0).padStart(3)}¢  $${cost.toFixed(2).padStart(6)}  fee=$${fee.toFixed(2)}  ${t.outcome.padEnd(4)}  ${t.asset_id.slice(0, 10)}…`)
  }

  const buys = trades.filter(t => t.side === 'BUY').length
  const sells = trades.filter(t => t.side === 'SELL').length

  console.log(`\n--- Summary ---`)
  console.log(`Trades: ${trades.length} (${buys} buys, ${sells} sells)`)
  console.log(`Total spent:    $${totalSpent.toFixed(2)}`)
  console.log(`Total received: $${totalReceived.toFixed(2)}`)
  console.log(`Net PnL:        $${(totalReceived - totalSpent).toFixed(2)}`)

  process.exit(0)
}

main()
