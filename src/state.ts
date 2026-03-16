import type { LiveMarket } from './data/market-discovery.ts'

export interface OpenTrade {
  side: 'YES' | 'NO'
  entryPrice: number
  sizeUsdc: number
  refPrice: number
  strategy: string
  entryTime: number
  sellFailures?: number
  partialRevenue?: number
  peakBid?: number
  edge: number
}

export interface VolState {
  ewmaVar: number
  garchVar: number
  prevReturn: number
  lastMinutePrice: number
  lastMinuteTimestamp: number
}

export interface BotState {
  // Volatility
  vol: VolState

  // Price
  lastPrice: number
  lastPriceTimestamp: number

  // Market
  currentMarket: LiveMarket | null
  currentEpoch: number
  referencePrice: number

  // Trades
  openTrades: Map<string, OpenTrade>
  sellingInProgress: Set<string>
  buyingInProgress: Set<string>
  windowTradeCount: Map<string, number>
  windowTradeHalf: Map<string, number>
  pendingRedemptions: Map<string, number>

  // Stats
  tradeCount: number
  winCount: number
  lastTickLog: number
  refreshing: boolean
  lastFailedRefresh: number

  // Momentum strategy state (moved from strategy internal)
  momentumPrices: Map<string, number[]>
  momentumLastMinute: Map<string, number>
}

export function initialBotState(): BotState {
  return {
    vol: {
      ewmaVar: 0,
      garchVar: 0,
      prevReturn: 0,
      lastMinutePrice: 0,
      lastMinuteTimestamp: 0,
    },
    lastPrice: 0,
    lastPriceTimestamp: 0,
    currentMarket: null,
    currentEpoch: 0,
    referencePrice: 0,
    openTrades: new Map(),
    sellingInProgress: new Set(),
    buyingInProgress: new Set(),
    windowTradeCount: new Map(),
    windowTradeHalf: new Map(),
    pendingRedemptions: new Map(),
    tradeCount: 0,
    winCount: 0,
    lastTickLog: 0,
    refreshing: false,
    lastFailedRefresh: 0,
    momentumPrices: new Map(),
    momentumLastMinute: new Map(),
  }
}
