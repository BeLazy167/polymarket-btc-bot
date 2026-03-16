import { Effect, Context, Layer, Stream } from 'effect'
import { WebSocketError } from '../errors.ts'

export type BinanceStreamType = 'aggTrade' | 'kline' | 'bookTicker'

interface AggTradeEvent {
  e: 'aggTrade'
  E: number
  s: string
  p: string
  q: string
  T: number
}

interface KlineEvent {
  e: 'kline'
  E: number
  s: string
  k: {
    t: number
    T: number
    s: string
    i: string
    o: string
    c: string
    h: string
    l: string
    v: string
    n: number
    x: boolean
  }
}

interface BookTickerEvent {
  e: 'bookTicker'
  E: number
  s: string
  b: string
  B: string
  a: string
  A: string
}

type BinanceEvent = AggTradeEvent | KlineEvent | BookTickerEvent

const STREAM_URLS: Record<BinanceStreamType, string> = {
  aggTrade: 'wss://data-stream.binance.vision/ws/btcusdt@aggTrade',
  kline: 'wss://data-stream.binance.vision/ws/btcusdt@kline_1m',
  bookTicker: 'wss://data-stream.binance.vision/ws/btcusdt@bookTicker',
}

const MAX_BACKOFF_MS = 30_000
const HEARTBEAT_INTERVAL_MS = 5_000
const HEARTBEAT_TIMEOUT_MS = 15_000

export interface PriceTick {
  price: number
  timestamp: number
}

function parsePrice(data: BinanceEvent): PriceTick | null {
  switch (data.e) {
    case 'aggTrade':
      return { price: parseFloat(data.p), timestamp: data.T }
    case 'kline':
      return { price: parseFloat(data.k.c), timestamp: data.E }
    case 'bookTicker':
      return {
        price: (parseFloat(data.b) + parseFloat(data.a)) / 2,
        timestamp: data.E,
      }
    default:
      return null
  }
}

/**
 * Single WS connection as a Stream. Emits PriceTick on each message.
 * Fails with WebSocketError on disconnect/heartbeat timeout.
 */
function connectOnce(url: string): Stream.Stream<PriceTick, WebSocketError> {
  return Stream.async<PriceTick, WebSocketError>((emit) => {
    let ws: WebSocket | null = null
    let lastMessageAt = Date.now()
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null

    function stopHeartbeat() {
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }

    function startHeartbeat() {
      stopHeartbeat()
      lastMessageAt = Date.now()
      heartbeatTimer = setInterval(() => {
        if (Date.now() - lastMessageAt > HEARTBEAT_TIMEOUT_MS) {
          stopHeartbeat()
          ws?.close()
        }
      }, HEARTBEAT_INTERVAL_MS)
    }

    ws = new WebSocket(url)

    ws.onopen = () => {
      startHeartbeat()
    }

    ws.onmessage = (event: MessageEvent) => {
      lastMessageAt = Date.now()
      let data: BinanceEvent
      try {
        data = JSON.parse(event.data as string) as BinanceEvent
      } catch {
        return // skip malformed messages
      }
      const result = parsePrice(data)
      if (result && Number.isFinite(result.price)) {
        emit.single(result)
      }
    }

    ws.onerror = () => {
      // onclose always follows, let it handle signaling
    }

    ws.onclose = () => {
      stopHeartbeat()
      emit.fail(
        new WebSocketError({
          message: 'Binance WS disconnected',
          source: 'binance',
        }),
      )
    }
  })
}

/**
 * Reconnecting price stream with exponential backoff (1s -> 30s).
 * On disconnect: log, wait, reconnect. Consumer just reads the stream.
 */
function makeReconnectingStream(streamType: BinanceStreamType): Stream.Stream<PriceTick, never> {
  const url = STREAM_URLS[streamType]

  function withReconnect(backoffMs: number): Stream.Stream<PriceTick, never> {
    const nextBackoff = Math.min(backoffMs * 2, MAX_BACKOFF_MS)

    return connectOnce(url).pipe(
      Stream.catchAll((_err: WebSocketError) =>
        Stream.concat(
          Stream.fromEffect(
            Effect.gen(function* () {
              yield* Effect.log(`Binance WS disconnected, reconnecting in ${backoffMs}ms`)
              yield* Effect.sleep(`${backoffMs} millis`)
            }),
          ).pipe(Stream.drain),
          withReconnect(nextBackoff),
        ),
      ),
    )
  }

  return withReconnect(1000)
}

export class BinanceFeed extends Context.Tag('BinanceFeed')<
  BinanceFeed,
  {
    readonly prices: Stream.Stream<PriceTick, never>
  }
>() {}

export const BinanceFeedLive = (streamType: BinanceStreamType = 'aggTrade') =>
  Layer.succeed(BinanceFeed, {
    prices: makeReconnectingStream(streamType),
  })
