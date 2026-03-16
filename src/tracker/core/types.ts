export type SignalSource = 'ninety-eight' | 'near-resolution' | 'insider' | 'sweep' | 'whale'

export interface RawOpportunity {
  conditionId: string
  side: 'YES' | 'NO'
  price: number
  marketTitle: string
  marketSlug: string
  source: SignalSource
  endDate?: string
  traderWallet?: string
  usdAmount?: number
}

export interface Opportunity extends RawOpportunity {
  id: string
  score: number
  sources: SignalSource[]
  firstSeen: number
  lastUpdated: number
}

export interface GammaMarket {
  id: string
  question: string
  slug: string
  conditionId: string
  outcomes: string
  outcomePrices: string
  active: boolean
  closed: boolean
  liquidity: string
  liquidityNum: number
  volume: string
  volumeNum: number
  endDate: string
  startDate: string
  category: string
  tags?: Array<{ id: number; slug: string; label: string }>
}

export interface DataApiTrade {
  proxyWallet: string
  side: 'BUY' | 'SELL'
  size: number
  price: number
  usd_amount?: number
  timestamp: number
  transactionHash: string
  title: string
  slug: string
  market_slug?: string
  eventSlug: string
  outcome: string
  outcomeIndex: number
  conditionId: string
  asset: string
  name?: string
  pseudonym?: string
}

export interface SweepTrade {
  timestamp: number
  outcome: string
  price: number
  size: number
  usd_amount: number
  market: string
  title: string
  market_slug: string
  eventSlug: string
  side: 'BUY' | 'SELL'
  trader: string
  transactionHash: string
}

export interface LeaderboardEntry {
  rank: number
  proxyWallet: string
  userName: string
  vol: number
  pnl: number
  profileImage: string
  xUsername: string
}
