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
console.log('\nRaw response:', JSON.stringify(creds, null, 2))
console.log('\nNew API credentials:')
const key = (creds as Record<string, string>).apiKey ?? (creds as Record<string, string>).key ?? (creds as Record<string, string>).api_key
const secret = (creds as Record<string, string>).apiSecret ?? (creds as Record<string, string>).secret ?? (creds as Record<string, string>).api_secret
const passphrase = (creds as Record<string, string>).apiPassphrase ?? (creds as Record<string, string>).passphrase ?? (creds as Record<string, string>).api_passphrase
console.log(`POLYMARKET_API_KEY_CVD=${key}`)
console.log(`POLYMARKET_API_SECRET_CVD=${secret}`)
console.log(`POLYMARKET_API_PASSPHRASE_CVD=${passphrase}`)
