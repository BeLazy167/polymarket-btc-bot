import type { Signal, StrategyContext } from '../models/types.ts'

export interface Strategy {
  readonly name: string
  evaluate(ctx: StrategyContext, windowId?: string): Signal | null
}
