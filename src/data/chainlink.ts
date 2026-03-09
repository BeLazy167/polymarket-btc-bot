import { logger } from '../monitoring/logger.ts'

/** Chainlink BTC/USD Price Feed on Polygon PoS */
const CHAINLINK_BTC_USD = '0xc907E116054Ad103354f2D350FD2514433D57F6f'

/** latestRoundData() selector */
const SELECTOR = '0xfeaf968c'

const RPC_URL = process.env.POLYGON_RPC_URL ?? ''

/**
 * Reads the latest BTC/USD price from Chainlink on Polygon.
 * Returns price in USD (e.g., 67000.12) or null on failure.
 * Chainlink BTC/USD has 8 decimals.
 */
export async function readChainlinkBtcPrice(): Promise<number | null> {
  if (!RPC_URL) {
    logger.debug('No POLYGON_RPC_URL set — skipping Chainlink read')
    return null
  }

  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{ to: CHAINLINK_BTC_USD, data: SELECTOR }, 'latest'],
  })

  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })

  if (!res.ok) {
    logger.warn({ status: res.status }, 'Chainlink RPC request failed')
    return null
  }

  const json = await res.json() as { result?: string }
  if (!json.result || json.result === '0x') {
    logger.warn('Chainlink returned empty result')
    return null
  }

  // latestRoundData returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
  // answer is at offset 32 bytes (slots are 32 bytes each, answer is 2nd return value)
  const hex = json.result.slice(2) // remove 0x
  const answerHex = hex.slice(64, 128) // 2nd 32-byte slot
  const answer = BigInt('0x' + answerHex)

  // Chainlink BTC/USD uses 8 decimals
  const price = Number(answer) / 1e8

  if (price < 1000 || price > 1_000_000) {
    logger.warn({ price }, 'Chainlink price out of range')
    return null
  }

  return price
}
