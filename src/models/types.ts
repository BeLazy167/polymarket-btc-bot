export type Side = 'YES' | 'NO'

export interface FairValueResult {
  fairValueUp: number
  fairValueDown: number
  sigma: number
  model: 'classic' | 'garch' | 'fat-tails' | 'ensemble'
}

export interface Signal {
  side: Side
  /** Fair value probability (0-1) for this side */
  confidence: number
  edge: number
  strategy: string
}

export interface StrategyContext {
  currentPrice: number
  referencePrice: number
  timeRemainingYears: number
  sigma: number
  fairValueUp: number
  fairValueDown: number
  marketYesPrice: number
  marketNoPrice: number
  windowDurationSec: number
  elapsedSec: number
  /** Total size on top 5 YES bid levels */
  yesBidDepth: number
  /** Total size on top 5 YES ask levels */
  yesAskDepth: number
  /** Total size on top 5 NO bid levels */
  noBidDepth: number
  /** Total size on top 5 NO ask levels */
  noAskDepth: number
  /** Current YES spread (ask - bid) */
  yesSpread: number
  /** Current NO spread (ask - bid) */
  noSpread: number
}
