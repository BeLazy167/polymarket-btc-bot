/**
 * Setup script: derives Polymarket API keys from wallet private key
 * and lists available BTC markets to find token IDs.
 *
 * Usage: bun run scripts/setup.ts <PRIVATE_KEY> [FUNDER_ADDRESS]
 */
import { ClobClient, Chain } from '@polymarket/clob-client'
import { Wallet } from '@ethersproject/wallet'

const privateKey = process.argv[2]
const funderAddress = process.argv[3] ?? ''

if (!privateKey) {
  console.error('Usage: bun run scripts/setup.ts <PRIVATE_KEY> [FUNDER_ADDRESS]')
  console.error('')
  console.error('  PRIVATE_KEY     Your Ethereum wallet private key (0x...)')
  console.error('  FUNDER_ADDRESS  Your Polymarket profile address (optional)')
  process.exit(1)
}

const host = 'https://clob.polymarket.com'
const wallet = new Wallet(privateKey)

console.log(`\nWallet address: ${wallet.address}`)
console.log('Deriving API credentials...\n')

// Step 1: Derive API key
const tempClient = new ClobClient(host, Chain.POLYGON, wallet)
const creds = await tempClient.createOrDeriveApiKey()

console.log('=== API Credentials (save these!) ===')
console.log(`POLYMARKET_PRIVATE_KEY=${privateKey}`)
console.log(`POLYMARKET_API_KEY=${creds.key}`)
console.log(`POLYMARKET_API_SECRET=${creds.secret}`)
console.log(`POLYMARKET_API_PASSPHRASE=${creds.passphrase}`)
console.log(`POLYMARKET_FUNDER_ADDRESS=${funderAddress}`)
console.log('')

// Step 2: Write .env file
const envContent = [
  `POLYMARKET_PRIVATE_KEY=${privateKey}`,
  `POLYMARKET_API_KEY=${creds.key}`,
  `POLYMARKET_API_SECRET=${creds.secret}`,
  `POLYMARKET_API_PASSPHRASE=${creds.passphrase}`,
  `POLYMARKET_FUNDER_ADDRESS=${funderAddress}`,
  `TELEGRAM_BOT_TOKEN=`,
  `TELEGRAM_CHAT_ID=`,
  `LOG_LEVEL=info`,
].join('\n')

await Bun.write('.env', envContent + '\n')
console.log('✓ Written to .env\n')

// Step 3: Search for BTC markets
console.log('=== Searching for BTC markets ===\n')

const publicClient = new ClobClient(host, Chain.POLYGON)
let cursor: string | undefined
let found = 0

// Paginate through markets looking for BTC-related ones
for (let page = 0; page < 10; page++) {
  const result = await publicClient.getMarkets(cursor ?? undefined)

  for (const market of result.data) {
    const title = (market.question ?? market.description ?? '').toLowerCase()
    if (title.includes('btc') || title.includes('bitcoin')) {
      found++
      console.log(`--- Market ${found} ---`)
      console.log(`  Title: ${market.question ?? market.description}`)
      console.log(`  Condition ID: ${market.condition_id}`)
      console.log(`  Active: ${!market.closed}`)

      // Show tokens if available
      if (market.tokens && market.tokens.length > 0) {
        for (const token of market.tokens) {
          console.log(`  Token [${token.outcome}]: ${token.token_id}`)
        }
      }
      console.log('')
    }
  }

  if (!result.next_cursor) break
  cursor = result.next_cursor
}

if (found === 0) {
  console.log('No BTC markets found in first 10 pages.')
  console.log('Try browsing https://polymarket.com and searching for "BTC" or "Bitcoin"')
}

console.log(`\nFound ${found} BTC market(s). Copy the token IDs into your config.yaml.`)
