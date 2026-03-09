export type BinanceStreamType = 'aggTrade' | 'kline' | 'bookTicker'

export interface BinanceWSOptions {
  onPrice: (price: number, timestamp: number) => void
  onError?: (error: Error) => void
  onConnect?: () => void
  onDisconnect?: () => void
  /** Which stream to use. aggTrade = fastest (sub-second), kline = 1/sec, bookTicker = best bid/ask */
  stream?: BinanceStreamType
}

/** Aggregate trade event — fires on every individual trade, sub-second */
interface AggTradeEvent {
  e: 'aggTrade'
  E: number   // event time
  s: string   // symbol
  p: string   // price
  q: string   // quantity
  T: number   // trade time
}

/** Kline/candlestick event — fires every ~1 second */
interface KlineEvent {
  e: 'kline'
  E: number
  s: string
  k: {
    t: number   // kline start time
    T: number   // kline close time
    s: string
    i: string   // interval
    o: string   // open
    c: string   // close
    h: string   // high
    l: string   // low
    v: string   // volume
    n: number   // number of trades
    x: boolean  // is this kline closed?
  }
}

/** Book ticker event — fires on every best bid/ask change */
interface BookTickerEvent {
  e: 'bookTicker'
  E: number
  s: string
  b: string  // best bid price
  B: string  // best bid qty
  a: string  // best ask price
  A: string  // best ask qty
}

type BinanceEvent = AggTradeEvent | KlineEvent | BookTickerEvent

const STREAM_URLS: Record<BinanceStreamType, string> = {
  aggTrade: 'wss://data-stream.binance.vision/ws/btcusdt@aggTrade',
  kline: 'wss://data-stream.binance.vision/ws/btcusdt@kline_1m',
  bookTicker: 'wss://data-stream.binance.vision/ws/btcusdt@bookTicker',
}

const MAX_BACKOFF_MS = 30_000

export function createBinanceWS(options: BinanceWSOptions): { connect: () => void; close: () => void } {
  const streamType = options.stream ?? 'aggTrade'
  const url = STREAM_URLS[streamType]

  let ws: WebSocket | null = null
  let shouldReconnect = true
  let backoffMs = 1000
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  function parsePrice(data: BinanceEvent): { price: number; timestamp: number } | null {
    switch (data.e) {
      case 'aggTrade':
        return { price: parseFloat(data.p), timestamp: data.T }
      case 'kline':
        return { price: parseFloat(data.k.c), timestamp: data.E }
      case 'bookTicker':
        // Use midpoint of best bid/ask as price
        return {
          price: (parseFloat(data.b) + parseFloat(data.a)) / 2,
          timestamp: data.E,
        }
      default:
        return null
    }
  }

  function connect() {
    shouldReconnect = true
    ws = new WebSocket(url)

    ws.onopen = () => {
      backoffMs = 1000
      options.onConnect?.()
    }

    ws.onmessage = (event: MessageEvent) => {
      let data: BinanceEvent
      try {
        data = JSON.parse(event.data as string) as BinanceEvent
      } catch {
        return // skip malformed messages (e.g. Binance maintenance HTML)
      }
      const result = parsePrice(data)
      if (result && Number.isFinite(result.price)) {
        options.onPrice(result.price, result.timestamp)
      }
    }

    ws.onerror = (event: Event) => {
      options.onError?.(new Error(`Binance WS error: ${(event as ErrorEvent).message ?? 'unknown'}`))
    }

    ws.onclose = () => {
      options.onDisconnect?.()
      if (!shouldReconnect) return
      reconnectTimer = setTimeout(() => {
        connect()
      }, backoffMs)
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
    }
  }

  function close() {
    shouldReconnect = false
    if (reconnectTimer) clearTimeout(reconnectTimer)
    ws?.close()
    ws = null
  }

  return { connect, close }
}
