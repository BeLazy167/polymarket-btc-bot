import { Effect, Context, Layer, Ref } from 'effect'
import { WebSocketError } from '../errors.ts'

export interface PriceLevel { price: number; size: number }

export interface OrderbookState {
  bestBid: number
  bestAsk: number
  /** Top 5 bid levels (highest first) */
  bidLevels: PriceLevel[]
  /** Top 5 ask levels (lowest first) */
  askLevels: PriceLevel[]
  lastUpdate: number
}

/** Initial snapshot message — array element with bids/asks, no event_type */
interface SnapshotMessage {
  asset_id: string
  market: string
  bids: Array<{ price: string; size: string }>
  asks: Array<{ price: string; size: string }>
  timestamp: string
}

/** Price change entry inside a PriceChangeMessage */
interface PriceChange {
  asset_id: string
  price: string
  size: string
  side: string
  best_bid: string
  best_ask: string
}

/** Subsequent update — single object with price_changes array */
interface PriceChangeMessage {
  market: string
  price_changes: PriceChange[]
}

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market'
const PING_INTERVAL_MS = 50_000
const MAX_BACKOFF_MS = 30_000

export class PolymarketFeed extends Context.Tag('PolymarketFeed')<
  PolymarketFeed,
  {
    readonly getOrderbook: (tokenId: string) => Effect.Effect<OrderbookState | undefined>
    readonly allOrderbooks: Effect.Effect<Map<string, OrderbookState>>
    readonly resubscribe: (assetIds: string[]) => Effect.Effect<void>
  }
>() {}

/** Process initial snapshot — extract best bid/ask + top 5 depth from full order book */
function processSnapshot(
  books: Map<string, OrderbookState>,
  msg: SnapshotMessage,
): OrderbookState {
  const prev = books.get(msg.asset_id)

  const bidLevels: PriceLevel[] = msg.bids
    .map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
    .filter(l => Number.isFinite(l.price) && Number.isFinite(l.size))
    .sort((a, b) => b.price - a.price)
    .slice(0, 5)

  const askLevels: PriceLevel[] = msg.asks
    .map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
    .filter(l => Number.isFinite(l.price) && Number.isFinite(l.size))
    .sort((a, b) => a.price - b.price)
    .slice(0, 5)

  const bestBid = bidLevels[0]?.price ?? prev?.bestBid ?? 0
  const bestAsk = askLevels[0]?.price ?? prev?.bestAsk ?? 0
  const ts = parseInt(msg.timestamp, 10) || Date.now()

  return { bestBid, bestAsk, bidLevels, askLevels, lastUpdate: ts }
}

/** Process price_changes update — use best_bid/best_ask directly, preserve depth from last snapshot */
function processPriceChange(
  books: Map<string, OrderbookState>,
  change: PriceChange,
): OrderbookState {
  const prev = books.get(change.asset_id)
  const bestBid = parseFloat(change.best_bid)
  const bestAsk = parseFloat(change.best_ask)

  return {
    bestBid: Number.isFinite(bestBid) ? bestBid : (prev?.bestBid ?? 0),
    bestAsk: Number.isFinite(bestAsk) ? bestAsk : (prev?.bestAsk ?? 0),
    bidLevels: prev?.bidLevels ?? [],
    askLevels: prev?.askLevels ?? [],
    lastUpdate: Date.now(),
  }
}

export const PolymarketFeedLive = (initialAssetIds: string[]) =>
  Layer.effect(
    PolymarketFeed,
    Effect.gen(function* () {
      const booksRef = yield* Ref.make(new Map<string, OrderbookState>())
      const assetIdsRef = yield* Ref.make<string[]>(initialAssetIds)

      // Mutable WS state managed imperatively (WS is callback-based)
      let ws: WebSocket | null = null
      let shouldReconnect = true
      let backoffMs = 1000
      let reconnectTimer: ReturnType<typeof setTimeout> | null = null
      let pingTimer: ReturnType<typeof setInterval> | null = null

      function subscribe(assetIds: string[]) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return
        for (const assetId of assetIds) {
          ws.send(JSON.stringify({ type: 'market', assets_ids: [assetId] }))
        }
      }

      function startPing() {
        stopPing()
        pingTimer = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) ws.send('PING')
        }, PING_INTERVAL_MS)
      }

      function stopPing() {
        if (pingTimer) {
          clearInterval(pingTimer)
          pingTimer = null
        }
      }

      function connect() {
        shouldReconnect = true
        const currentIds = Effect.runSync(Ref.get(assetIdsRef))
        ws = new WebSocket(WS_URL)

        ws.onopen = () => {
          backoffMs = 1000
          subscribe(currentIds)
          startPing()
          Effect.runFork(Effect.log('Polymarket WS connected'))
        }

        ws.onmessage = (event: MessageEvent) => {
          const raw = event.data as string
          if (raw === 'PONG') return
          let parsed: unknown
          try {
            parsed = JSON.parse(raw)
          } catch {
            return
          }

          // Format 1: Initial snapshot — array of objects with bids/asks
          if (Array.isArray(parsed)) {
            Effect.runFork(
              Ref.update(booksRef, (books) => {
                const next = new Map(books)
                for (const msg of parsed as SnapshotMessage[]) {
                  if (msg.asset_id && (msg.bids || msg.asks)) {
                    next.set(msg.asset_id, processSnapshot(books, msg))
                  }
                }
                return next
              }),
            )
            return
          }

          // Format 2: Price update — single object with price_changes array
          const obj = parsed as PriceChangeMessage
          if (obj.price_changes && Array.isArray(obj.price_changes)) {
            Effect.runFork(
              Ref.update(booksRef, (books) => {
                const next = new Map(books)
                for (const change of obj.price_changes) {
                  if (change.asset_id) {
                    next.set(change.asset_id, processPriceChange(books, change))
                  }
                }
                return next
              }),
            )
          }
        }

        ws.onerror = (event: Event) => {
          Effect.runFork(
            Effect.log(`Polymarket WS error: ${(event as ErrorEvent).message ?? 'unknown'}`),
          )
        }

        ws.onclose = () => {
          stopPing()
          Effect.runFork(Effect.log('Polymarket WS disconnected'))
          if (!shouldReconnect) return
          reconnectTimer = setTimeout(() => connect(), backoffMs)
          backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
        }
      }

      function close() {
        shouldReconnect = false
        stopPing()
        if (reconnectTimer) clearTimeout(reconnectTimer)
        ws?.close()
        ws = null
      }

      // Start initial connection
      connect()

      // Register finalizer to clean up WS on scope close
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          close()
          Effect.runFork(Effect.log('Polymarket WS finalizer: closed'))
        }),
      )

      return {
        getOrderbook: (tokenId: string) =>
          Ref.get(booksRef).pipe(Effect.map((books) => books.get(tokenId))),

        allOrderbooks: Ref.get(booksRef),

        resubscribe: (newAssetIds: string[]) =>
          Effect.gen(function* () {
            yield* Ref.set(assetIdsRef, newAssetIds)
            yield* Ref.set(booksRef, new Map())
            // Close without auto-reconnect, then reconnect with new IDs
            shouldReconnect = false
            stopPing()
            if (reconnectTimer) clearTimeout(reconnectTimer)
            ws?.close()
            ws = null
            connect()
          }),
      }
    }),
  )
