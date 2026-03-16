import { Effect, Layer, Schedule } from 'effect'
import { TrackerConfigService, TrackerConfigLive } from './config/service.ts'
import { Db, DbLive } from './core/db.ts'
import { OpportunityQueue } from './core/opportunity-queue.ts'
import { RiskManager } from './core/risk-manager.ts'
import { PaperExecutor } from './core/executor.ts'
import { startPositionMonitor } from './core/position-monitor.ts'
import { startNinetyEightScanner } from './scanner/ninety-eight.ts'
import { startNearResolutionSniper } from './scanner/near-resolution.ts'
import { startInsiderDetector } from './smart-money/insider-detector.ts'
import { startSweepsMonitor } from './smart-money/sweeps.ts'
import { startWhaleTracker } from './smart-money/whale-tracker.ts'
import { startArbScanner } from './scanner/arb.ts'
import { alertOpportunity, alertError } from './core/alerts.ts'
import type { RawOpportunity } from './core/types.ts'

const CONFIG_PATH = process.argv[2] ?? 'config-tracker.yaml'

const program = Effect.gen(function* () {
  const { config } = yield* TrackerConfigService
  const db = yield* Db

  const queue = new OpportunityQueue(config, db)
  const risk = new RiskManager(config, db)
  const executor = new PaperExecutor(config, db)

  const onOpportunity = (opp: RawOpportunity) => {
    queue.push(opp)
  }

  // Process queue every 5s
  const processQueue = Effect.sync(() => {
    const ready = queue.drain()
    for (const opp of ready) {
      const result = risk.evaluate(opp)
      if (result.approved) {
        executor.execute(opp, result.size)
        Effect.runFork(alertOpportunity(opp, result.size).pipe(Effect.catchAll(() => Effect.void)))
      }
    }
    queue.expire()
  }).pipe(
    Effect.catchAll((e) => Effect.sync(() => console.error('[queue] error:', e))),
    Effect.repeat(Schedule.fixed('5 seconds')),
  )

  // Start all signal sources concurrently
  const signals = Effect.all([
    startNinetyEightScanner(config, onOpportunity),
    startNearResolutionSniper(config, onOpportunity),
    startInsiderDetector(config, db, onOpportunity),
    startSweepsMonitor(config, db, onOpportunity),
    startWhaleTracker(config, db, onOpportunity),
    startArbScanner(config, onOpportunity),
    startPositionMonitor(config, db, executor),
    processQueue,
  ], { concurrency: 'unbounded' })

  console.log(`[tracker] running in ${config.mode} mode`)
  console.log(`[tracker] 6 signal sources + position monitor active`)

  yield* signals
})

const ConfigLive = TrackerConfigLive(CONFIG_PATH)
const AppLive = Layer.provideMerge(DbLive('data/tracker.db'), ConfigLive)

const main = program.pipe(Effect.provide(AppLive))

Effect.runPromise(main).catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
