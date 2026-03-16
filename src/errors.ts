import { Data } from 'effect'

export class ConfigError extends Data.TaggedError('ConfigError')<{
  readonly message: string
  readonly issues?: unknown
}> {}

export class WebSocketError extends Data.TaggedError('WebSocketError')<{
  readonly message: string
  readonly source: 'binance' | 'polymarket'
}> {}

export class ExecutionError extends Data.TaggedError('ExecutionError')<{
  readonly message: string
  readonly orderId?: string
  readonly status?: string
}> {}

export class MarketDiscoveryError extends Data.TaggedError('MarketDiscoveryError')<{
  readonly message: string
  readonly slug?: string
  readonly status?: number
}> {}

export class AlertError extends Data.TaggedError('AlertError')<{
  readonly message: string
  readonly status?: number
}> {}

export class RedemptionError extends Data.TaggedError('RedemptionError')<{
  readonly message: string
  readonly conditionId: string
}> {}
