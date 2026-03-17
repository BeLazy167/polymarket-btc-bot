import { ClobClient, Chain } from '@polymarket/clob-client'
import { Wallet } from '@ethersproject/wallet'

const wallet = new Wallet(process.env.POLYMARKET_PRIVATE_KEY!)
const client = new ClobClient(
  'https://clob.polymarket.com',
  Chain.POLYGON,
  wallet,
  undefined,
  1,
  process.env.POLYMARKET_FUNDER_ADDRESS || undefined,
)

const nonce = parseInt(process.argv[2] ?? '1')
console.log(`Creating API key with nonce=${nonce}...`)

const creds = await client.createApiKey(nonce)
console.log('\nNew API credentials:')
console.log(`POLYMARKET_API_KEY_CVD=${creds.apiKey}`)
console.log(`POLYMARKET_API_SECRET_CVD=${creds.apiSecret}`)
console.log(`POLYMARKET_API_PASSPHRASE_CVD=${creds.apiPassphrase}`)
