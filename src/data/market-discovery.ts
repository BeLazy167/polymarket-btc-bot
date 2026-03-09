import { logger } from '../monitoring/logger.ts'

export interface LiveMarket {
  epoch: number
  slug: string
  conditionId: string
  yesTokenId: string
  noTokenId: string
  tickSize: string
  negRisk: boolean
  windowStartMs: number
  windowEndMs: number
  priceToBeat: number | null
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
    eventMetadata?: { priceToBeat?: number }
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

  return {
    epoch,
    slug,
    conditionId: market.conditionId,
    yesTokenId: tokenIds[0]!,
    noTokenId: tokenIds[1]!,
    tickSize: String(market.orderPriceMinTickSize ?? '0.01'),
    negRisk: data.negRisk ?? false,
    windowStartMs: epoch * 1000,
    windowEndMs: (epoch + WINDOW_SEC) * 1000,
    priceToBeat: data.eventMetadata?.priceToBeat ?? null,
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
 * Polls Gamma API for `eventMetadata.priceToBeat` for a given epoch.
 * Returns the exact reference price Polymarket uses, or null if not yet available.
 * priceToBeat typically appears ~60-90s after the window starts.
 */
export async function fetchPriceToBeat(epoch: number): Promise<number | null> {
  const slug = `btc-updown-5m-${epoch}`
  const url = `${GAMMA_BASE}/${slug}`

  const res = await fetch(url)
  if (!res.ok) return null

  const data = await res.json() as { eventMetadata?: { priceToBeat?: number } }
  const ptb = data?.eventMetadata?.priceToBeat
  if (typeof ptb === 'number' && ptb > 1000) {
    logger.info({ epoch, priceToBeat: ptb }, 'Got priceToBeat from Gamma')
    return ptb
  }
  return null
}
