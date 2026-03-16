import type { ModelConfig } from './config/schema.ts'
import type { PriceStore } from './data/price-store.ts'
import { getTimeframeBucket } from './config/markets.ts'

const MINUTES_PER_YEAR = 365.25 * 24 * 60

/** Default BTC annualized vol ~60% — used as bootstrap before enough data */
const DEFAULT_SIGMA = 0.60
/** BTC annualized vol never below ~30% — prevents EWMA from collapsing on sparse data */
const MIN_SIGMA = 0.30

export function getSigma(
  models: ModelConfig,
  store: PriceStore,
  ewmaVar: number,
  garchVar: number,
  windowSec: number,
): number {
  const bucket = getTimeframeBucket(windowSec)
  const varianceToUse = (models[bucket] === 'garch' && garchVar > 0) ? garchVar
    : ewmaVar > 0 ? ewmaVar
    : 0

  if (varianceToUse > 0) {
    return Math.max(Math.sqrt(varianceToUse) * Math.sqrt(MINUTES_PER_YEAR), MIN_SIGMA)
  }

  const rolling = store.getRollingVol(60)
  return rolling > 0 ? Math.max(rolling, MIN_SIGMA) : DEFAULT_SIGMA
}
