import * as v from 'valibot'

const RiskSchema = v.object({
  maxTotalExposure: v.optional(v.pipe(v.number(), v.minValue(0)), 200),
  maxPerMarket: v.optional(v.pipe(v.number(), v.minValue(0)), 20),
  maxInsiderTail: v.optional(v.pipe(v.number(), v.minValue(0)), 50),
  maxConcurrentPositions: v.optional(v.pipe(v.number(), v.minValue(1)), 20),
  maxDailyLoss: v.optional(v.pipe(v.number(), v.minValue(0)), 100),
  maxBuyPrice: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1)), 0.98),
  insiderStopLoss: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1)), 0.50),
})

const ScannerSchema = v.object({
  ninetyEightPollSec: v.optional(v.pipe(v.number(), v.minValue(5)), 30),
  ninetyEightMinPrice: v.optional(v.pipe(v.number(), v.minValue(0.9), v.maxValue(1)), 0.95),
  nearResolutionPollSec: v.optional(v.pipe(v.number(), v.minValue(5)), 30),
  nearResolutionWindowMin: v.optional(v.pipe(v.number(), v.minValue(1)), 30),
  nearResolutionMinPrice: v.optional(v.pipe(v.number(), v.minValue(0.5), v.maxValue(1)), 0.85),
  minLiquidity: v.optional(v.pipe(v.number(), v.minValue(0)), 1000),
})

const SmartMoneySchema = v.object({
  insiderMaxBuyPrice: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1)), 0.20),
  insiderMinTradeUsd: v.optional(v.pipe(v.number(), v.minValue(0)), 500),
  insiderMaxPositions: v.optional(v.pipe(v.number(), v.minValue(1)), 5),
  insiderPnlMin: v.optional(v.number(), -20000),
  insiderPnlMax: v.optional(v.number(), 20000),
  insiderMinPositionUsd: v.optional(v.pipe(v.number(), v.minValue(0)), 2000),
  insiderPollSec: v.optional(v.pipe(v.number(), v.minValue(1)), 5),
  insiderAnalyzeSec: v.optional(v.pipe(v.number(), v.minValue(5)), 60),
  sweepsPollSec: v.optional(v.pipe(v.number(), v.minValue(5)), 10),
  whalePollSec: v.optional(v.pipe(v.number(), v.minValue(5)), 10),
  whaleCount: v.optional(v.pipe(v.number(), v.minValue(1)), 20),
})

const ScoringSchema = v.object({
  ninetyEightBase: v.optional(v.pipe(v.number(), v.minValue(0)), 80),
  nearResolutionBase: v.optional(v.pipe(v.number(), v.minValue(0)), 60),
  insiderBase: v.optional(v.pipe(v.number(), v.minValue(0)), 70),
  sweepBase: v.optional(v.pipe(v.number(), v.minValue(0)), 30),
  whaleBase: v.optional(v.pipe(v.number(), v.minValue(0)), 40),
  multiSourceBonus: v.optional(v.pipe(v.number(), v.minValue(0)), 20),
  paperThreshold: v.optional(v.pipe(v.number(), v.minValue(0)), 60),
  liveThreshold: v.optional(v.pipe(v.number(), v.minValue(0)), 80),
})

export const TrackerConfigSchema = v.object({
  mode: v.optional(v.picklist(['paper', 'live']), 'paper'),
  risk: v.optional(RiskSchema, {}),
  scanner: v.optional(ScannerSchema, {}),
  smartMoney: v.optional(SmartMoneySchema, {}),
  scoring: v.optional(ScoringSchema, {}),
  blacklist: v.optional(v.array(v.string()), ['elon', 'tweet', 'musk']),
})

export type TrackerConfig = v.InferOutput<typeof TrackerConfigSchema>
