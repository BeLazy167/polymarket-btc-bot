import { logger } from '../monitoring/logger.ts'

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
const WINDOW_SEC = 300

/**
 * Computes the current 5-min window epoch (floor-aligned to 300s).
 * Optionally offset by +1 to get the next window.
 */
export function getWindowEpoch(nowMs: number, offset = 0): number {
  const nowSec = Math.floor(nowMs / 1000)
  return Math.floor(nowSec / WINDOW_SEC) * WINDOW_SEC + offset * WINDOW_SEC
}

/**
 * Fetches market data for a specific 5-min window epoch from Gamma API.
 * Returns null if market doesn't exist yet (e.g. too far in future).
 */
export async function fetchMarket(epoch: number): Promise<LiveMarket | null> {
  const slug = `btc-updown-5m-${epoch}`
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
    windowEndMs: (epoch + WINDOW_SEC) * 1000,
  }
}

/**
 * Fetches current window market. Retries up to 3 times with 2s delay.
 */
export async function fetchCurrentMarket(): Promise<LiveMarket | null> {
  const epoch = getWindowEpoch(Date.now())
  for (let attempt = 0; attempt < 3; attempt++) {
    const market = await fetchMarket(epoch)
    if (market) return market
    if (attempt < 2) await Bun.sleep(2000)
  }
  return null
}

/**
 * Fetches the exact BTC open price for a 5-min window from Polymarket's crypto-price API.
 * This is the same price Polymarket uses for settlement.
 */
export async function fetchOpenPrice(epochSec: number): Promise<number | null> {
  const start = new Date(epochSec * 1000).toISOString()
  const end = new Date((epochSec + WINDOW_SEC) * 1000).toISOString()
  const url = `https://polymarket.com/api/crypto/crypto-price?symbol=BTC&eventStartTime=${start}&variant=fiveminute&endDate=${end}`

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
