import { logger } from '../monitoring/logger.ts'
import { getWindowMeta } from '../config/markets.ts'

export interface LiveMarket {
  epoch: number
  slug: string
  conditionId: string
  yesTokenId: string
  noTokenId: string
  tickSize: string
  negRisk: boolean
  minOrderSize: number
  windowStartMs: number
  windowEndMs: number
}

const GAMMA_BASE = 'https://gamma-api.polymarket.com/events/slug'

/**
 * Computes the current window epoch (floor-aligned to windowSec).
 * Optionally offset by +1 to get the next window.
 */
export function getWindowEpoch(nowMs: number, windowSec: number, offset = 0): number {
  const nowSec = Math.floor(nowMs / 1000)
  return Math.floor(nowSec / windowSec) * windowSec + offset * windowSec
}

/**
 * Fetches market data for a specific window epoch from Gamma API.
 * Returns null if market doesn't exist yet (e.g. too far in future).
 */
export async function fetchMarket(epoch: number, windowSec: number): Promise<LiveMarket | null> {
  const { slugPrefix } = getWindowMeta(windowSec)
  const slug = `${slugPrefix}${epoch}`
  const url = `${GAMMA_BASE}/${slug}`

  const res = await fetch(url)
  if (!res.ok) {
    logger.warn({ status: res.status, slug }, 'Gamma API fetch failed')
    return null
  }

  const data = await res.json() as {
    negRisk?: boolean
    markets?: Array<{
      conditionId: string
      clobTokenIds: string
      orderPriceMinTickSize?: number
    }>
  }

  const market = data?.markets?.[0]
  if (!market) {
    logger.warn({ slug }, 'No market in Gamma response')
    return null
  }

  const tokenIds: string[] = JSON.parse(market.clobTokenIds)
  if (tokenIds.length < 2) {
    logger.warn({ slug, tokenIds }, 'Unexpected clobTokenIds length')
    return null
  }

  // Fetch min_order_size from CLOB orderbook
  let minOrderSize = 5 // safe fallback
  try {
    const obRes = await fetch(`https://clob.polymarket.com/orderbook/${tokenIds[0]}`)
    if (obRes.ok) {
      const ob = await obRes.json() as { min_order_size?: string }
      const parsed = Number(ob.min_order_size)
      if (Number.isFinite(parsed) && parsed > 0) minOrderSize = parsed
    }
  } catch {
    logger.warn({ slug }, 'Failed to fetch min_order_size — using default 5')
  }

  return {
    epoch,
    slug,
    conditionId: market.conditionId,
    yesTokenId: tokenIds[0]!,
    noTokenId: tokenIds[1]!,
    tickSize: String(market.orderPriceMinTickSize ?? '0.01'),
    negRisk: data.negRisk ?? false,
    minOrderSize,
    windowStartMs: epoch * 1000,
    windowEndMs: (epoch + windowSec) * 1000,
  }
}

/**
 * Fetches current window market. Retries up to 3 times with 2s delay.
 */
export async function fetchCurrentMarket(windowSec: number): Promise<LiveMarket | null> {
  const epoch = getWindowEpoch(Date.now(), windowSec)
  for (let attempt = 0; attempt < 3; attempt++) {
    const market = await fetchMarket(epoch, windowSec)
    if (market) return market
    if (attempt < 2) await Bun.sleep(2000)
  }
  return null
}

/**
 * Fetches BTC open price from Polymarket's crypto-price API.
 * Uses ISO dates and correct variant names (e.g. 'fifteen' not 'fifteenminute').
 */
export async function fetchOpenPrice(epochSec: number, windowSec: number): Promise<number | null> {
  const { cryptoVariant } = getWindowMeta(windowSec)
  const start = new Date(epochSec * 1000).toISOString()
  const end = new Date((epochSec + windowSec) * 1000).toISOString()
  const url = `https://polymarket.com/api/crypto/crypto-price?symbol=BTC&eventStartTime=${start}&variant=${cryptoVariant}&endDate=${end}`

  const res = await fetch(url)
  if (!res.ok) {
    logger.error({ status: res.status, epochSec }, 'crypto-price API fetch failed')
    return null
  }

  const data = await res.json() as { openPrice?: number | null }
  if (!data.openPrice || !Number.isFinite(data.openPrice)) {
    logger.warn({ epochSec, data }, 'crypto-price API returned no openPrice')
    return null
  }

  logger.info({ epochSec, openPrice: data.openPrice }, 'Fetched open price from Polymarket')
  return data.openPrice
}
