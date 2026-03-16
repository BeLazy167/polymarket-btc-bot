import { Effect, Layer, Ref, Schedule, Stream, Scope } from 'effect'
import { ConfigService, ConfigServiceLive } from './config/service.ts'
import { BinanceFeed, BinanceFeedLive } from './data/binance-feed.ts'
import { PolymarketFeed, PolymarketFeedLive } from './data/polymarket-feed.ts'
import { MarketDiscovery, MarketDiscoveryLive } from './data/market-discovery.ts'
import { Executor, ExecutorLive, ExecutorPaper } from './execution/service.ts'
import { Alerts, AlertsLive } from './monitoring/alerts.ts'
import { RiskManager, RiskManagerLive } from './risk/service.ts'
import { PriceStore } from './data/price-store.ts'
import { MomentumStrategy } from './strategies/momentum.ts'
import { LowVolRiderStrategy } from './strategies/low-vol-rider.ts'
import { MicrostructureStrategy } from './strategies/microstructure.ts'
import { FairValueArbStrategy } from './strategies/fair-value-arb.ts'
import { ValueStrategy } from './strategies/value.ts'
import type { Strategy } from './strategies/base.ts'
import { initialBotState } from './state.ts'
import { handlePriceTick } from './vol.ts'
import { tick } from './tick.ts'
import { refreshMarket } from './refresh.ts'
import { stdout, color, banner, box, tag } from './monitoring/logger.ts'

const CONFIG_PATH = process.argv[2] ?? 'config.yaml'

const program = Effect.gen(function* () {
  const { config } = yield* ConfigService
  const binanceFeed = yield* BinanceFeed
  const alerts = yield* Alerts

  banner([
    `${color.bold('POLYMARKET BTC BOT')}`,
    `${color.dim('mode')} ${color.cyan(config.mode)}  ${color.dim('size')} $${config.risk.positionSizeUsdc}  ${color.dim('max-loss')} $${config.risk.maxDailyLossUsdc}`,
  ], 'start')

  // --- Init ---
  const priceStore = new PriceStore()
  const stateRef = yield* Ref.make(initialBotState())

  // --- Init strategies ---
  const strategies: Strategy[] = []
  const momentumStrategy = new MomentumStrategy(config.strategies.momentum)
  if (config.strategies.momentum.enabled) strategies.push(momentumStrategy)
  if (config.strategies.lowVolRider.enabled) strategies.push(new LowVolRiderStrategy(config.strategies.lowVolRider))
  if (config.strategies.microstructure.enabled) strategies.push(new MicrostructureStrategy(config.strategies.microstructure))
  if (config.strategies.fairValueArb.enabled) strategies.push(new FairValueArbStrategy(config.strategies.fairValueArb))
  if (config.strategies.value.enabled) strategies.push(new ValueStrategy(config.strategies.value))

  stdout(`${color.dim(box.arrow)} Strategies: ${color.bold(strategies.map(s => s.name).join(color.dim(' │ ')))}`)

  // --- Fork price ingestion ---
  yield* Stream.runForEach(binanceFeed.prices, (t) =>
    handlePriceTick(stateRef, priceStore, config, t.price, t.timestamp),
  ).pipe(Effect.fork)

  stdout(`${color.dim('...')} Waiting for price data`)
  yield* Effect.sleep(3000)

  // --- Initial market fetch ---
  yield* refreshMarket(stateRef, config).pipe(Effect.catchAll(() => Effect.void))

  // --- Telegram polling ---
  const scope = yield* Scope.make()
  yield* alerts.startPolling(
    () => stdout(`${tag.warn} Bot paused via Telegram`),
    () => stdout(`${color.green(box.dot)} Bot resumed via Telegram`),
  ).pipe(Effect.provideService(Scope.Scope, scope))

  yield* alerts.sendStartAlert(config.mode, config.risk.positionSizeUsdc, config.risk.maxDailyLossUsdc).pipe(Effect.catchAll(() => Effect.void))

  stdout(`${color.green(box.dot)} ${color.green('Ready')} ${color.dim('— Ctrl+C to stop')}`)

  // --- Main tick loop (1s) ---
  const doRefresh = refreshMarket(stateRef, config).pipe(Effect.catchAll(() => Effect.void))
  const tickEffect = tick(stateRef, config, priceStore, strategies, momentumStrategy, doRefresh)

  yield* tickEffect.pipe(
    Effect.catchAll((e) => {
      stdout(`${color.bgRed(' ERROR ')} ${color.red(String(e))}`)
      return alerts.sendErrorAlert(`Main loop error: ${e}`).pipe(Effect.catchAll(() => Effect.void))
    }),
    Effect.repeat(Schedule.fixed(1000)),
  )
})

// --- Layer composition ---
const ConfigLive = ConfigServiceLive(CONFIG_PATH)

const BaseLive = Layer.mergeAll(
  BinanceFeedLive(),
  PolymarketFeedLive([]),
  MarketDiscoveryLive,
  AlertsLive,
  RiskManagerLive,
).pipe(
  Layer.provideMerge(ConfigLive),
)

// Resolve executor mode at startup, then run program
const main = Effect.gen(function* () {
  const { config } = yield* ConfigService
  const executorLayer = config.mode === 'live' ? ExecutorLive : ExecutorPaper
  const AppLive = Layer.provideMerge(BaseLive, executorLayer)
  yield* program.pipe(Effect.provide(AppLive), Effect.scoped)
}).pipe(Effect.provide(ConfigLive))

Effect.runPromise(main).catch((err) => {
  console.error('Fatal startup error:', err)
  process.exit(1)
})
