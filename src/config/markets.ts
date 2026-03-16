/** Maps window duration to model timeframe bucket */
export function getTimeframeBucket(windowDurationSec: number): 'fiveMin' | 'fifteenMin' | 'oneHour' | 'oneDay' {
  if (windowDurationSec <= 300) return 'fiveMin'
  if (windowDurationSec <= 900) return 'fifteenMin'
  if (windowDurationSec <= 3600) return 'oneHour'
  return 'oneDay'
}

const BUCKET_META = {
  fiveMin:    { slugPrefix: 'btc-updown-5m-',  cryptoVariant: 'fiveminute',    marketId: 'btc-5m',  label: '5m',  slugFn: null },
  fifteenMin: { slugPrefix: 'btc-updown-15m-', cryptoVariant: 'fifteen',       marketId: 'btc-15m', label: '15m', slugFn: null },
  oneHour:    { slugPrefix: '',                 cryptoVariant: 'onehour',       marketId: 'btc-1h',  label: '1h',  slugFn: buildHourlySlug },
  oneDay:     { slugPrefix: 'btc-updown-1d-',  cryptoVariant: 'oneday',        marketId: 'btc-1d',  label: '1d',  slugFn: null },
} as const

/**
 * 1hr markets use human-readable ET slugs: bitcoin-up-or-down-march-16-2026-2am-et
 */
function buildHourlySlug(epochSec: number): string {
  const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december']
  // Convert UTC epoch to ET (UTC-4 EDT / UTC-5 EST). Polymarket uses ET.
  const utcMs = epochSec * 1000
  const etStr = new Date(utcMs).toLocaleString('en-US', { timeZone: 'America/New_York' })
  const et = new Date(etStr)
  const month = MONTHS[et.getMonth()]!
  const day = et.getDate()
  const year = et.getFullYear()
  const hour24 = et.getHours()
  const ampm = hour24 < 12 ? 'am' : 'pm'
  const h12 = hour24 % 12 || 12
  return `bitcoin-up-or-down-${month}-${day}-${year}-${h12}${ampm}-et`
}

/** Single source of truth for window-duration-derived metadata */
export function getWindowMeta(windowSec: number) {
  return BUCKET_META[getTimeframeBucket(windowSec)]
}

/** Builds the slug for a given epoch. Uses slugFn if defined, otherwise slugPrefix+epoch. */
export function buildSlug(windowSec: number, epochSec: number): string {
  const meta = getWindowMeta(windowSec)
  if (meta.slugFn) return meta.slugFn(epochSec)
  return `${meta.slugPrefix}${epochSec}`
}
