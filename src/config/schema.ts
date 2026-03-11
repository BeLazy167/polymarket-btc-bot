import * as v from 'valibot'

const MarketSchema = v.object({
  id: v.string(),
  name: v.string(),
  yesTokenId: v.string(),
  noTokenId: v.string(),
  conditionId: v.string(),
  referencePrice: v.pipe(v.number(), v.minValue(0)),
  windowDurationSec: v.pipe(v.number(), v.minValue(1)),
  /** Window start times as cron-like schedule or ISO timestamps */
  schedule: v.optional(v.string()),
  tickSize: v.optional(v.picklist(['0.1', '0.01', '0.001', '0.0001']), '0.01'),
  negRisk: v.optional(v.boolean(), false),
  minOrderSize: v.optional(v.pipe(v.number(), v.minValue(0)), 5),
})

const ModelConfigSchema = v.object({
  /** Default model per timeframe bucket */
  fiveMin: v.optional(v.picklist(['classic', 'garch', 'fat-tails']), 'fat-tails'),
  fifteenMin: v.optional(v.picklist(['classic', 'garch', 'fat-tails']), 'fat-tails'),
  oneHour: v.optional(v.picklist(['classic', 'garch', 'fat-tails']), 'classic'),
  oneDay: v.optional(v.picklist(['classic', 'garch', 'fat-tails']), 'garch'),
  /** Switch 1h to adaptive if rolling vol > volSwitchMultiplier * avg */
  volSwitchMultiplier: v.optional(v.pipe(v.number(), v.minValue(1)), 2),
  /** GARCH params */
  garchOmega: v.optional(v.pipe(v.number(), v.minValue(0)), 1e-6),
  garchAlpha: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1)), 0.1),
  garchBeta: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1)), 0.85),
  /** Student-t degrees of freedom */
  studentTNu: v.optional(v.pipe(v.number(), v.minValue(2)), 7),
  /** EWMA lambda */
  ewmaLambda: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1)), 0.94),
  /** σ below this → classic model (aggressive) */
  lowVolThreshold: v.optional(v.pipe(v.number(), v.minValue(0)), 0.40),
  /** σ above this → fat-tails ν=4 (defensive) */
  highVolThreshold: v.optional(v.pipe(v.number(), v.minValue(0)), 0.65),
})

const MomentumStrategySchema = v.object({
  enabled: v.optional(v.boolean(), true),
  /** Enter after this % of window elapsed (0-1) */
  entryThreshold: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1)), 0.8),
  /** Minimum edge (FV - market price) to enter */
  minEdge: v.optional(v.pipe(v.number(), v.minValue(0)), 0.05),
  /** Min consecutive same-direction minutes to trigger (3 = 80%, 4 = 96%) */
  minConsecutiveMinutes: v.optional(v.pipe(v.number(), v.minValue(1)), 3),
  /** Early momentum: min $ move in first 2 min to trigger early entry */
  earlyMomentumThreshold: v.optional(v.pipe(v.number(), v.minValue(0)), 100),
})

const TimeFilterSchema = v.object({
  /** Skip trading on these days (0=Sun, 6=Sat) */
  skipDays: v.optional(v.array(v.pipe(v.number(), v.minValue(0), v.maxValue(6))), [0, 6]),
  /** Preferred trading hours UTC (empty = all hours) */
  preferredHoursUtc: v.optional(v.array(v.pipe(v.number(), v.minValue(0), v.maxValue(23))), []),
  /** Only trade preferred hours (if false, still trade off-hours but with reduced size) */
  strictHourFilter: v.optional(v.boolean(), false),
})

const LowVolRiderSchema = v.object({
  enabled: v.optional(v.boolean(), true),
  /** Activate in last N seconds of window */
  activateLastSec: v.optional(v.pipe(v.number(), v.minValue(1)), 60),
  /** Min sigma gap for "reversal impossible" */
  minSigmaGap: v.optional(v.pipe(v.number(), v.minValue(1)), 3),
  /** Min fair value to enter (e.g., 0.90) */
  minFairValue: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1)), 0.90),
  /** Max entry price on Polymarket */
  maxEntryPrice: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1)), 0.85),
})

const FairValueArbSchema = v.object({
  enabled: v.optional(v.boolean(), true),
  /** Min gap between FV and market price to trigger (0.10 = 10¢) */
  minGap: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1)), 0.10),
  /** Min fair value confidence to consider */
  minFairValue: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1)), 0.70),
  /** Min entry price — skip illiquid cheap tokens */
  minEntryPrice: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1)), 0.15),
  /** Max entry price (dynamically raised based on gap size) */
  maxEntryPrice: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1)), 0.75),
  /** Exit when bid >= fair value (sell at FV) */
  exitAtFairValue: v.optional(v.boolean(), true),
  /** Exit when bid >= entry + this amount (e.g., 0.10 = 10¢ profit). 0 = disabled */
  takeProfitCents: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1)), 0.10),
  /** Trailing stop: exit when bid drops this far below peak (e.g., 0.03 = 3¢). 0 = disabled */
  trailingStopCents: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1)), 0.05),
  /** Trailing stop activates after bid is this far above entry (e.g., 0.07 = 7¢) */
  trailingActivationCents: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1)), 0.07),
})

const ValueStrategySchema = v.object({
  enabled: v.optional(v.boolean(), true),
  /** Min fair value to consider buying (skip longshots) */
  minFairValue: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1)), 0.30),
  /** Buy when market price < FV * (1 - discountThreshold) */
  discountThreshold: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1)), 0.20),
  /** Sell when market price >= FV * (1 - exitThreshold) */
  exitThreshold: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1)), 0.05),
  /** Never buy above this price */
  maxEntryPrice: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1)), 0.10),
  /** Target profit multiplier (e.g., 2 = sell at 2x entry) */
  minProfitTarget: v.optional(v.pipe(v.number(), v.minValue(1)), 2),
})

const RiskSchema = v.object({
  /** Fixed USDC per trade */
  positionSizeUsdc: v.optional(v.pipe(v.number(), v.minValue(0.01)), 2.5),
  /** Max daily loss in USDC before halting */
  maxDailyLossUsdc: v.optional(v.pipe(v.number(), v.minValue(1)), 25),
  /** Max concurrent positions per market */
  maxConcurrentPositions: v.optional(v.pipe(v.number(), v.minValue(1)), 2),
  /** Don't enter momentum trades above this price */
  maxMomentumEntryPrice: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1)), 0.75),
  /** Don't enter low-vol-rider trades above this price */
  maxRiderEntryPrice: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1)), 0.85),
})

const TelegramSchema = v.object({
  enabled: v.optional(v.boolean(), false),
  botToken: v.optional(v.string(), ''),
  chatId: v.optional(v.string(), ''),
})

const PolymarketAuthSchema = v.object({
  privateKey: v.optional(v.string(), ''),
  apiKey: v.optional(v.string(), ''),
  apiSecret: v.optional(v.string(), ''),
  apiPassphrase: v.optional(v.string(), ''),
  /** 0 = browser wallet, 1 = magic/email */
  signatureType: v.optional(v.picklist([0, 1]), 1),
  funderAddress: v.optional(v.string(), ''),
})

export const ConfigSchema = v.object({
  mode: v.optional(v.picklist(['live', 'paper']), 'paper'),
  markets: v.optional(v.array(MarketSchema), []),
  models: v.optional(ModelConfigSchema, {}),
  strategies: v.optional(v.object({
    momentum: v.optional(MomentumStrategySchema, {}),
    lowVolRider: v.optional(LowVolRiderSchema, {}),
    fairValueArb: v.optional(FairValueArbSchema, {}),
    value: v.optional(ValueStrategySchema, {}),
  }), {}),
  timeFilter: v.optional(TimeFilterSchema, {}),
  risk: v.optional(RiskSchema, {}),
  telegram: v.optional(TelegramSchema, {}),
  polymarket: PolymarketAuthSchema,
  /** Log level */
  logLevel: v.optional(v.picklist(['debug', 'info', 'warn', 'error']), 'info'),
})

export type Config = v.InferOutput<typeof ConfigSchema>
export type MarketConfig = v.InferOutput<typeof MarketSchema>
export type ModelConfig = v.InferOutput<typeof ModelConfigSchema>
export type MomentumConfig = v.InferOutput<typeof MomentumStrategySchema>
export type LowVolRiderConfig = v.InferOutput<typeof LowVolRiderSchema>
export type FairValueArbConfig = v.InferOutput<typeof FairValueArbSchema>
export type ValueConfig = v.InferOutput<typeof ValueStrategySchema>
export type RiskConfig = v.InferOutput<typeof RiskSchema>
export type TickSize = '0.1' | '0.01' | '0.001' | '0.0001'
