import { Effect, Context, Layer, Ref } from 'effect'
import type { Signal } from '../models/types.ts'
import { ConfigService } from '../config/service.ts'

export interface ApprovedOrder {
  side: 'YES' | 'NO'
  sizeUsdc: number
  strategy: string
  confidence: number
  edge: number
  price: number
  sigma: number
}

interface RiskState {
  dailyPnl: number
  activePositions: Map<string, number>
  halted: boolean
  lastResetDate: string
}

export class RiskManager extends Context.Tag('RiskManager')<
  RiskManager,
  {
    readonly approve: (signal: Signal, marketId: string) => Effect.Effect<ApprovedOrder | null>
    readonly recordTrade: (marketId: string, pnl: number) => Effect.Effect<void>
    readonly openPosition: (marketId: string) => Effect.Effect<void>
    readonly closePosition: (marketId: string) => Effect.Effect<void>
    readonly isHalted: () => Effect.Effect<boolean>
    readonly getDailyPnl: () => Effect.Effect<number>
  }
>() {}

const makeInitialState = (): RiskState => ({
  dailyPnl: 0,
  activePositions: new Map(),
  halted: false,
  lastResetDate: '',
})

const maybeResetDaily = (state: RiskState): RiskState => {
  const today = new Date().toISOString().slice(0, 10)
  if (today !== state.lastResetDate) {
    return { ...state, dailyPnl: 0, halted: false, lastResetDate: today }
  }
  return state
}

export const RiskManagerLive = Layer.effect(
  RiskManager,
  Effect.gen(function* () {
    const { config } = yield* ConfigService
    const risk = config.risk!
    const ref = yield* Ref.make(makeInitialState())

    return {
      approve: (signal: Signal, marketId: string) =>
        Effect.gen(function* () {
          const prev = yield* Ref.get(ref)
          yield* Ref.update(ref, maybeResetDaily)
          const state = yield* Ref.get(ref)
          if (state.lastResetDate !== prev.lastResetDate) {
            yield* Effect.log('Daily P&L reset')
          }

          if (state.halted) {
            yield* Effect.logWarning('Trading halted — daily loss limit reached')
            return null
          }

          const positions = state.activePositions.get(marketId) ?? 0
          if (positions >= risk.maxConcurrentPositions) {
            yield* Effect.logDebug(`Max concurrent positions reached`, { marketId, positions })
            return null
          }

          return {
            side: signal.side,
            sizeUsdc: risk.positionSizeUsdc,
            strategy: signal.strategy,
            confidence: signal.confidence,
            edge: signal.edge,
            price: 0,
            sigma: 0,
          } satisfies ApprovedOrder
        }),

      recordTrade: (marketId: string, pnl: number) =>
        Ref.updateAndGet(ref, (s) => {
          const newPnl = s.dailyPnl + pnl
          const halted = newPnl <= -risk.maxDailyLossUsdc ? true : s.halted
          return { ...s, dailyPnl: newPnl, halted }
        }).pipe(
          Effect.tap((s) =>
            s.halted
              ? Effect.logError(`Daily loss limit hit — halting`, { dailyPnl: s.dailyPnl })
              : Effect.void,
          ),
          Effect.asVoid,
        ),

      openPosition: (marketId: string) =>
        Ref.update(ref, (s) => {
          const next = new Map(s.activePositions)
          next.set(marketId, (next.get(marketId) ?? 0) + 1)
          return { ...s, activePositions: next }
        }),

      closePosition: (marketId: string) =>
        Ref.update(ref, (s) => {
          const next = new Map(s.activePositions)
          next.set(marketId, Math.max(0, (next.get(marketId) ?? 0) - 1))
          return { ...s, activePositions: next }
        }),

      isHalted: () => Ref.get(ref).pipe(Effect.map((s) => s.halted)),

      getDailyPnl: () => Ref.get(ref).pipe(Effect.map((s) => s.dailyPnl)),
    }
  }),
)
