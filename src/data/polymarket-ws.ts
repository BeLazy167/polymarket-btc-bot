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

export interface PolymarketWSOptions {
  assetIds: string[]
  onUpdate: (tokenId: string, state: OrderbookState) => void
  onError?: (error: Error) => void
  onConnect?: () => void
  onDisconnect?: () => void
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

export function createPolymarketWS(options: PolymarketWSOptions): {
  connect: () => void
  close: () => void
  resubscribe: (newAssetIds: string[]) => void
} {
  let ws: WebSocket | null = null
  let shouldReconnect = true
  let backoffMs = 1000
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let pingTimer: ReturnType<typeof setInterval> | null = null
  const books = new Map<string, OrderbookState>()

  function subscribe() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    for (const assetId of options.assetIds) {
      ws.send(JSON.stringify({ type: 'market', assets_ids: [assetId] }))
    }
  }

  function startPing() {
    stopPing()
    pingTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send('PING')
      }
    }, PING_INTERVAL_MS)
  }

  function stopPing() {
    if (pingTimer) {
      clearInterval(pingTimer)
      pingTimer = null
    }
  }

  /** Process initial snapshot — extract best bid/ask + top 5 depth from full order book */
  function processSnapshot(msg: SnapshotMessage) {
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
    const state: OrderbookState = { bestBid, bestAsk, bidLevels, askLevels, lastUpdate: ts }
    books.set(msg.asset_id, state)
    options.onUpdate(msg.asset_id, state)
  }

  /** Process price_changes update — use best_bid/best_ask directly, preserve depth from last snapshot */
  function processPriceChange(change: PriceChange) {
    const prev = books.get(change.asset_id)
    const bestBid = parseFloat(change.best_bid)
    const bestAsk = parseFloat(change.best_ask)

    const state: OrderbookState = {
      bestBid: Number.isFinite(bestBid) ? bestBid : (prev?.bestBid ?? 0),
      bestAsk: Number.isFinite(bestAsk) ? bestAsk : (prev?.bestAsk ?? 0),
      bidLevels: prev?.bidLevels ?? [],
      askLevels: prev?.askLevels ?? [],
      lastUpdate: Date.now(),
    }
    books.set(change.asset_id, state)
    options.onUpdate(change.asset_id, state)
  }

  function connect() {
    shouldReconnect = true
    ws = new WebSocket(WS_URL)

    ws.onopen = () => {
      backoffMs = 1000
      subscribe()
      startPing()
      options.onConnect?.()
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
        for (const msg of parsed as SnapshotMessage[]) {
          if (msg.asset_id && (msg.bids || msg.asks)) {
            processSnapshot(msg)
          }
        }
        return
      }

      // Format 2: Price update — single object with price_changes array
      const obj = parsed as PriceChangeMessage
      if (obj.price_changes && Array.isArray(obj.price_changes)) {
        for (const change of obj.price_changes) {
          if (change.asset_id) {
            processPriceChange(change)
          }
        }
      }
    }

    ws.onerror = (event: Event) => {
      options.onError?.(new Error(`Polymarket WS error: ${(event as ErrorEvent).message ?? 'unknown'}`))
    }

    ws.onclose = () => {
      stopPing()
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
    stopPing()
    if (reconnectTimer) clearTimeout(reconnectTimer)
    ws?.close()
    ws = null
  }

  /** Close, update asset IDs, and reconnect to get fresh subscriptions */
  function resubscribe(newAssetIds: string[]) {
    options.assetIds = newAssetIds
    books.clear()
    // Close without triggering auto-reconnect, then reconnect manually
    shouldReconnect = false
    stopPing()
    if (reconnectTimer) clearTimeout(reconnectTimer)
    ws?.close()
    ws = null
    // Reconnect with new asset IDs
    connect()
  }

  return { connect, close, resubscribe }
}
