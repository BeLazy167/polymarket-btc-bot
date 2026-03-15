import { loadConfig } from './config/markets.ts'
import type { MarketConfig, ModelConfig, TickSize, Config } from './config/schema.ts'
import { getTimeframeBucket, getWindowMeta } from './config/markets.ts'
import { PriceStore } from './data/price-store.ts'
import { createBinanceWS } from './data/binance-ws.ts'
import { createPolymarketWS, type OrderbookState } from './data/polymarket-ws.ts'
import { fetchCurrentMarket, fetchOpenPrice, getWindowEpoch, type LiveMarket } from './data/market-discovery.ts'
import { classicFairValue } from './models/classic.ts'
import { fatTailsFairValue } from './models/fat-tails.ts'
import { ewmaVariance, garchVariance } from './models/math.ts'
import type { FairValueResult, StrategyContext, Signal } from './models/types.ts'
import { MomentumStrategy } from './strategies/momentum.ts'
import { LowVolRiderStrategy } from './strategies/low-vol-rider.ts'
import { MicrostructureStrategy } from './strategies/microstructure.ts'
import { FairValueArbStrategy } from './strategies/fair-value-arb.ts'
import { ValueStrategy } from './strategies/value.ts'
import type { Strategy } from './strategies/base.ts'
import { RiskManager } from './risk/manager.ts'
import { LiveExecutor, type Executor } from './execution/executor.ts'
import { PaperExecutor } from './execution/paper.ts'
import { redeemPositions } from './execution/redeem.ts'
import { createAlerts } from './monitoring/alerts.ts'
import { logger, stdout, color, banner, tag, progressBar, box } from './monitoring/logger.ts'

const CONFIG_PATH = process.argv[2] ?? 'config.yaml'
const MINUTES_PER_YEAR = 365.25 * 24 * 60

/** Max age of data before we consider it stale and skip trading */
const MAX_PRICE_STALE_MS = 5_000
const MAX_BOOK_STALE_MS = 10_000

async function main() {
  const config = await loadConfig(CONFIG_PATH)
  const WINDOW_SEC = config.windowDurationSec
  const { marketId: MARKET_ID, label: WINDOW_LABEL } = getWindowMeta(WINDOW_SEC)
  logger.level = config.logLevel
  banner([
    `${color.bold('POLYMARKET BTC BOT')}`,
    `${color.dim('mode')} ${color.cyan(config.mode)}  ${color.dim('size')} $${config.risk.positionSizeUsdc}  ${color.dim('max-loss')} $${config.risk.maxDailyLossUsdc}`,
  ], 'start')

  // --- Init components ---
  const priceStore = new PriceStore()
  const riskManager = new RiskManager(config.risk)
  let executor: Executor
  if (config.mode === 'live') {
    if (!config.polymarket.privateKey || !config.polymarket.apiKey) {
      throw new Error('Live mode requires polymarket credentials (privateKey + apiKey)')
    }
    executor = new LiveExecutor(config)
  } else {
    executor = new PaperExecutor()
  }

  const alerts = createAlerts({
    enabled: config.telegram.enabled,
    telegramBotToken: config.telegram.botToken,
    telegramChatId: config.telegram.chatId,
  })

  // --- Init strategies ---
  const strategies: Strategy[] = []
  const momentumStrategy = new MomentumStrategy(config.strategies.momentum)
  if (config.strategies.momentum.enabled) strategies.push(momentumStrategy)
  if (config.strategies.lowVolRider.enabled) strategies.push(new LowVolRiderStrategy(config.strategies.lowVolRider))
  if (config.strategies.microstructure.enabled) strategies.push(new MicrostructureStrategy(config.strategies.microstructure))
  if (config.strategies.fairValueArb.enabled) strategies.push(new FairValueArbStrategy(config.strategies.fairValueArb))
  if (config.strategies.value.enabled) strategies.push(new ValueStrategy(config.strategies.value))

  stdout(`${color.dim(box.arrow)} Strategies: ${color.bold(strategies.map(s => s.name).join(color.dim(' │ ')))}`)

  // --- Vol state (updated once per minute, not per tick) ---
  let ewmaVar = 0
  let garchVar = 0
  let prevReturn = 0
  let lastMinutePrice = 0
  let lastMinuteTimestamp = 0

  // --- Current price state (updated every tick) ---
  let lastPrice = 0
  let lastPriceTimestamp = 0

  // --- Dynamic market state ---
  let currentMarket: LiveMarket | null = null
  let currentEpoch = 0
  let referencePrice = 0 // BTC price at window start

  // --- Orderbook state ---
  const orderbookStates = new Map<string, OrderbookState>()

  // --- Trade tracking for P&L ---
  interface OpenTrade { side: 'YES' | 'NO'; entryPrice: number; sizeUsdc: number; refPrice: number; strategy: string; entryTime: number; sellFailures?: number; partialRevenue?: number; peakBid?: number; edge: number }
  const openTrades = new Map<string, OpenTrade>()
  const sellingInProgress = new Set<string>()
  const buyingInProgress = new Set<string>()
  const MAX_TRADES_PER_WINDOW = 2
  const windowTradeCount = new Map<string, number>()
  /** Track which half (1 or 2) the last trade entered in */
  const windowTradeHalf = new Map<string, number>()
  let tradeCount = 0
  let winCount = 0
  let lastTickLog = 0
  let refreshing = false
  const pendingRedemptions = new Map<string, number>() // conditionId → retry count

  // --- Data feeds ---
  const binanceWS = createBinanceWS({
    onPrice(price, timestamp) {
      lastPrice = price
      lastPriceTimestamp = Date.now()

      // Downsample: only update vol models + PriceStore once per minute
      const currentMinute = Math.floor(timestamp / 60_000)
      const lastMinute = Math.floor(lastMinuteTimestamp / 60_000)

      if (currentMinute > lastMinute && lastMinutePrice > 0) {
        const logReturn = Math.log(price / lastMinutePrice)
        ewmaVar = ewmaVariance(ewmaVar, logReturn, config.models.ewmaLambda)
        garchVar = garchVariance(garchVar, prevReturn, config.models.garchOmega, config.models.garchAlpha, config.models.garchBeta)
        prevReturn = logReturn
        priceStore.addPrice(price, timestamp)
      } else if (lastMinutePrice === 0) {
        priceStore.addPrice(price, timestamp)
      }

      if (currentMinute > lastMinute || lastMinutePrice === 0) {
        lastMinutePrice = price
        lastMinuteTimestamp = timestamp
      }

      // Track minute prices for momentum strategy
      if (currentMarket) {
        const windowKey = `${MARKET_ID}-${currentMarket.epoch}`
        momentumStrategy.recordMinutePrice(price, windowKey, Date.now())
      }
    },
    onConnect() { stdout(`${color.green(box.dot)} ${color.green('Binance')} connected`) },
    onDisconnect() {
      stdout(`${color.red(box.dot)} ${color.yellow('Binance')} disconnected`)
      setTimeout(() => { if (Date.now() - lastPriceTimestamp > 30_000) alerts.sendErrorAlert('Binance WS down >30s').catch(() => {}) }, 30_000)
    },
    onError(err) { logger.error({ err }, 'Binance WS error') },
  })

  const polymarketWS = createPolymarketWS({
    assetIds: [], // will be set dynamically
    onUpdate(tokenId, state) {
      orderbookStates.set(tokenId, state)
    },
    onConnect() { stdout(`${color.green(box.dot)} ${color.green('Polymarket')} connected`) },
    onDisconnect() {
      stdout(`${color.red(box.dot)} ${color.yellow('Polymarket')} disconnected`)
      setTimeout(() => {
        if (orderbookStates.size === 0) return // window rotation, WS reconnecting
        const maxAge = Math.max(...[...orderbookStates.values()].map(s => Date.now() - s.lastUpdate))
        if (maxAge > 30_000) alerts.sendErrorAlert('Polymarket WS down >30s').catch(() => {})
      }, 30_000)
    },
    onError(err) { logger.error({ err }, 'Polymarket WS error') },
  })

  // --- Connect ---
  binanceWS.connect()
  polymarketWS.connect()

  // Wait for Binance price
  stdout(`${color.dim('...')} Waiting for price data`)
  await Bun.sleep(3000)

  // --- Fetch initial market ---
  let lastFailedRefresh = 0
  await refreshMarket()
  async function refreshMarket() {
    if (refreshing) return
    if (Date.now() - lastFailedRefresh < 10_000) return // backoff 10s after failed fetch
    const newEpoch = getWindowEpoch(Date.now(), WINDOW_SEC)
    if (newEpoch === currentEpoch && currentMarket) return

    refreshing = true
    try {
      const market = await fetchCurrentMarket(WINDOW_SEC)
      if (!market) {
        logger.error('Failed to fetch market from Gamma API')
        lastFailedRefresh = Date.now()
        return
      }

      // Re-subscribe Polymarket WS early so orderbook populates while we fetch open price
      const newIds = [market.yesTokenId, market.noTokenId]
      polymarketWS.resubscribe(newIds)

      const refPrice = await fetchOpenPrice(market.epoch, WINDOW_SEC)

      if (!refPrice) {
        stdout(`${tag.warn} Ref price unavailable — skipping window`)
        lastFailedRefresh = Date.now()
        return
      }

      const cooldownSec = WINDOW_SEC >= 900 ? 30 : 5
      stdout(`${tag.market} ${color.cyan(market.slug)} ${color.dim('ref')} ${color.bold('$' + refPrice.toFixed(2))} ${color.dim('│')} cooldown ${color.yellow(cooldownSec + 's')}`)

      // Redeem any resolved positions during cooldown (winning tokens → USDC.e, gasless via relayer)
      if (config.mode === 'live' && pendingRedemptions.size > 0) {
        const batch = [...pendingRedemptions.entries()]
        pendingRedemptions.clear()
        for (const [cid, retries] of batch) {
          const result = await redeemPositions(config.polymarket, cid)
          if (result.success) {
            stdout(`${color.green(box.dot)} ${color.green('Redeemed')} ${color.dim(cid.slice(0, 10))}… tx ${color.cyan(result.txHash?.slice(0, 10) + '…')}`)
          } else if (result.error !== 'not-resolved' && retries < 3) {
            pendingRedemptions.set(cid, retries + 1)
          } else if (retries >= 3) {
            logger.warn({ conditionId: cid, retries }, 'Redemption abandoned after max retries')
          }
        }
      }

      await Bun.sleep(cooldownSec * 1_000)

      // Commit state AFTER sleep so tick loop won't trade during wait
      currentMarket = market
      currentEpoch = newEpoch
      referencePrice = refPrice
      stdout(`${color.dim('─'.repeat(50))}`)
    } finally {
      refreshing = false
    }
  }

  // --- Main loop (1s tick) ---
  const tickInterval = setInterval(async () => {
    try {
      if (riskManager.isHalted()) return

      const now = Date.now()

      // Time/day filter
      const nowDate = new Date(now)
      if (config.timeFilter.skipDays.includes(nowDate.getUTCDay())) return

      // Check Binance data freshness
      if (now - lastPriceTimestamp > MAX_PRICE_STALE_MS) {
        logger.debug({ staleMs: now - lastPriceTimestamp }, 'Binance price stale — skipping tick')
        return
      }

      const currentPrice = lastPrice
      if (!currentPrice) return

      // --- Window rotation ---
      const newEpoch = getWindowEpoch(now, WINDOW_SEC)
      if (newEpoch !== currentEpoch) {
        // Resolve any open trades from previous window — attempt real sell first
        if (currentMarket) {
          const prevKey = `${MARKET_ID}-${currentMarket.epoch}`
          const trade = !sellingInProgress.has(prevKey) ? openTrades.get(prevKey) : undefined
          if (trade) {
            sellingInProgress.add(prevKey)
            try {
            const tokenId = trade.side === 'YES' ? currentMarket.yesTokenId : currentMarket.noTokenId
            const shares = trade.sizeUsdc / trade.entryPrice
            const expiryBook = orderbookStates.get(tokenId)
            const expiryBid = expiryBook?.bestBid

            // Try real sell before falling back to paper settlement
            const sellResult = await executor.sell(tokenId, shares, currentMarket.tickSize as TickSize, currentMarket.negRisk, expiryBid)

            if (sellResult.success) {
              const exitBook = orderbookStates.get(tokenId)
              const exitBid = exitBook?.bestBid ?? 0
              const soldShares = sellResult.filledShares ?? shares
              const exitPrice = sellResult.fillPrice ?? exitBid
              const revenue = computeRevenue(sellResult.revenue, trade.partialRevenue ?? 0, soldShares, exitBid)
              const pnl = revenue - trade.sizeUsdc

              riskManager.recordTrade(MARKET_ID, pnl)
              riskManager.closePosition(MARKET_ID)
              if (pnl > 0) winCount++

              const holdSec = Math.round((Date.now() - trade.entryTime) / 1000)
              stdout(`${tag.sell} ${color.bold(trade.side)} window-expiry sell ${fmtPnl(pnl)} ${color.yellow('held ' + holdSec + 's')} ${color.cyan(soldShares.toFixed(1) + ' shares')}`)
              logger.info({ side: trade.side, entry: trade.entryPrice, exitPrice, soldShares, revenue: revenue.toFixed(2), pnl: pnl.toFixed(2) }, 'EXIT — window expiry sell')
              alerts.sendExitAlert({ strategy: trade.strategy, side: trade.side, entryPrice: trade.entryPrice, exitPrice, pnl, reason: 'window expiry', holdSec, soldShares, revenue }).catch(() => {})
            } else if (sellResult.remaining !== undefined && sellResult.remaining < 5) {
              // B3: sub-minimum stuck — don't paper-settle, shares will resolve on-chain
              const btcWentUp = currentPrice >= trade.refPrice
              const weWon = (trade.side === 'YES' && btcWentUp) || (trade.side === 'NO' && !btcWentUp)
              const estimatedPnl = weWon ? (sellResult.remaining * 0.98) - trade.sizeUsdc : -trade.sizeUsdc

              riskManager.closePosition(MARKET_ID)
              // Don't record PnL — shares still in wallet, will resolve at $1 or $0
              stdout(`${tag.sell} ${color.bold(trade.side)} ${color.yellow('pending resolution')} ${sellResult.remaining?.toFixed(1)} shares stuck (sub-min) — ${weWon ? 'likely win' : 'likely loss'} ~${fmtPnl(estimatedPnl)}`)
              logger.warn({ side: trade.side, entry: trade.entryPrice, remaining: sellResult.remaining, tokenId, weWon, estimatedPnl: estimatedPnl.toFixed(2) }, 'Pending on-chain resolution — no PnL recorded')
              alerts.sendErrorAlert(`⏳ ${trade.side} pending resolution — ${sellResult.remaining?.toFixed(1)} shares stuck, ${weWon ? 'likely win' : 'likely loss'}`).catch(() => {})
            } else {
              // Fall back to paper settlement (normal sell failure, >= 5 shares)
              const btcWentUp = currentPrice >= trade.refPrice
              const weWon = (trade.side === 'YES' && btcWentUp) || (trade.side === 'NO' && !btcWentUp)
              const partialRevenue = sellResult.revenue ?? 0
              const pnl = weWon ? (shares * 0.98) - trade.sizeUsdc : partialRevenue - trade.sizeUsdc

              riskManager.recordTrade(MARKET_ID, pnl)
              riskManager.closePosition(MARKET_ID)
              if (weWon) winCount++

              stdout(weWon
                ? `${tag.win} ${color.bold(trade.side)} settled ${fmtPnl(pnl)}`
                : `${tag.loss} ${color.bold(trade.side)} settled ${fmtPnl(pnl)}`)

              logger.info({
                side: trade.side,
                entry: trade.entryPrice,
                won: weWon,
                pnl: pnl.toFixed(2),
                refPrice: trade.refPrice,
                endPrice: currentPrice,
              }, weWon ? 'Trade WON' : 'Trade LOST')
              alerts.sendErrorAlert(`Window-expiry sell failed — paper settled ${trade.side} @ ${(trade.entryPrice * 100).toFixed(0)}¢`).catch(() => {})
            }

            openTrades.delete(prevKey)
            } finally {
              sellingInProgress.delete(prevKey)
            }
          }
        }

        // Queue previous market for CTF redemption (resolves winning tokens → USDC.e)
        if (currentMarket && !pendingRedemptions.has(currentMarket.conditionId)) pendingRedemptions.set(currentMarket.conditionId, 0)

        sellingInProgress.clear()
        buyingInProgress.clear()
        windowTradeCount.clear()
        windowTradeHalf.clear()
        orderbookStates.clear()
        lastTickLog = 0
        if (!refreshing) await refreshMarket()
        return // skip rest of tick — wait for refresh to commit new state
      }

      if (!currentMarket || !referencePrice) return

      // Get orderbook state
      const yesBook = orderbookStates.get(currentMarket.yesTokenId)
      const noBook = orderbookStates.get(currentMarket.noTokenId)
      if (!yesBook || !noBook) {
        logger.debug('No orderbook data yet — waiting')
        return
      }

      // Check orderbook data freshness
      const bookAge = Math.max(now - yesBook.lastUpdate, now - noBook.lastUpdate)
      if (bookAge > MAX_BOOK_STALE_MS) {
        logger.debug({ bookAgeMs: bookAge }, 'Orderbook stale — skipping')
        return
      }

      if (!yesBook.bestAsk || !noBook.bestAsk) return

      // Elapsed seconds in current window
      const elapsed = (now - currentMarket.windowStartMs) / 1000
      if (elapsed < 0 || elapsed > WINDOW_SEC) return

      // Get volatility + fair value
      const sigma = getSigma(config.models, priceStore, ewmaVar, garchVar, WINDOW_SEC)
      if (!Number.isFinite(sigma) || sigma <= 0) {
        logger.debug({ sigma }, 'No valid vol estimate yet')
        return
      }

      const timeRemaining = Math.max(WINDOW_SEC - elapsed, 1)
      const T = timeRemaining / (365.25 * 24 * 3600)

      // --- Adaptive model selection based on vol regime ---
      let fv: FairValueResult
      let modelTag: string
      if (sigma < config.models.lowVolThreshold) {
        fv = classicFairValue(currentPrice, referencePrice, T, sigma)
        modelTag = 'C'
      } else if (sigma > config.models.highVolThreshold) {
        fv = fatTailsFairValue(currentPrice, referencePrice, T, sigma, 4)
        modelTag = 'F4'
      } else {
        fv = fatTailsFairValue(currentPrice, referencePrice, T, sigma, config.models.studentTNu)
        modelTag = `F${config.models.studentTNu}`
      }

      // Build strategy context
      const windowKey = `${MARKET_ID}-${currentMarket.epoch}`
      const ctx: StrategyContext = {
        currentPrice,
        referencePrice,
        timeRemainingYears: T,
        sigma,
        fairValueUp: fv.fairValueUp,
        fairValueDown: fv.fairValueDown,
        marketYesPrice: yesBook.bestAsk,
        marketNoPrice: noBook.bestAsk,
        windowDurationSec: WINDOW_SEC,
        elapsedSec: elapsed,
        yesBidDepth: sumDepth(yesBook.bidLevels ?? []),
        yesAskDepth: sumDepth(yesBook.askLevels ?? []),
        noBidDepth: sumDepth(noBook.bidLevels ?? []),
        noAskDepth: sumDepth(noBook.askLevels ?? []),
        yesSpread: yesBook.bestAsk - yesBook.bestBid,
        noSpread: noBook.bestAsk - noBook.bestBid,
      }

      // Compact tick log every 1s
      if (now - lastTickLog >= 1_000) {
        lastTickLog = now
        const pBar = progressBar(elapsed, WINDOW_SEC, 15)
        const delta = currentPrice - referencePrice
        const deltaStr = delta >= 0 ? color.green(`+${delta.toFixed(0)}`) : color.red(`${delta.toFixed(0)}`)
        // Show PnL + distance to TP if we have a confirmed position (not still buying)
        const openTrade = openTrades.get(windowKey)
        let posStr = ''
        if (openTrade && !buyingInProgress.has(windowKey)) {
          const bid = (openTrade.side === 'YES' ? yesBook.bestBid : noBook.bestBid) ?? 0
          const unrealizedPnl = (bid - openTrade.entryPrice) * (openTrade.sizeUsdc / openTrade.entryPrice)
          const toTp = (openTrade.entryPrice + 0.10) - bid
          if (unrealizedPnl > 0) {
            posStr = ` ${color.green('PnL +$' + unrealizedPnl.toFixed(2))} ${color.dim('TP in')} ${color.yellow((toTp * 100).toFixed(0) + '¢')}`
          } else {
            posStr = ` ${color.red('PnL -$' + Math.abs(unrealizedPnl).toFixed(2))}`
          }
        }
        stdout(`${pBar} ${color.bold('$' + currentPrice.toFixed(0))} ${color.dim('ref')}$${referencePrice.toFixed(0)} ${color.dim('Δ')}${deltaStr} ${color.dim('│')} ${color.green('Y')} fv=${color.cyan(fv.fairValueUp.toFixed(2))} a=${yesBook.bestAsk.toFixed(2)} b=${(yesBook.bestBid ?? 0).toFixed(2)} ${color.dim('│')} ${color.red('N')} fv=${color.cyan(fv.fairValueDown.toFixed(2))} a=${noBook.bestAsk.toFixed(2)} b=${(noBook.bestBid ?? 0).toFixed(2)} ${color.dim('σ')}=${sigma.toFixed(2)} ${color.magenta('[' + modelTag + ']')}${posStr}`)
      }

      // --- Check exits for open positions ---
      const existingTrade = openTrades.get(windowKey)
      if (existingTrade) {
        const exitBid = (existingTrade.side === 'YES' ? yesBook.bestBid : noBook.bestBid) ?? 0
        const fairValue = existingTrade.side === 'YES' ? fv.fairValueUp : fv.fairValueDown
        const arbCfg = config.strategies.fairValueArb

        let shouldExit = false
        let exitReason = ''

        // Update peak bid for trailing stop (only after buy is confirmed)
        if (!buyingInProgress.has(windowKey) && exitBid > (existingTrade.peakBid ?? 0)) {
          existingTrade.peakBid = exitBid
        }

        // Exit at fair value
        if (arbCfg.exitAtFairValue && exitBid >= fairValue) {
          shouldExit = true
          exitReason = `bid ${(exitBid * 100).toFixed(0)}¢ >= FV ${(fairValue * 100).toFixed(0)}¢`
        }

        // Fixed take-profit at 10¢ (skip when FV > 85¢ confirms held side — UNLESS bid >= 93¢ where upside is capped)
        if (!shouldExit && exitBid >= existingTrade.entryPrice + 0.10 && (fairValue < 0.85 || exitBid >= 0.93)) {
          shouldExit = true
          exitReason = `TP 10¢: bid ${(exitBid * 100).toFixed(0)}¢, entry ${(existingTrade.entryPrice * 100).toFixed(0)}¢`
        }

        // Fixed stop-loss: exit when bid drops stopLossCents below entry
        if (!shouldExit && arbCfg.stopLossCents > 0 && exitBid > 0 && exitBid <= existingTrade.entryPrice - arbCfg.stopLossCents) {
          shouldExit = true
          exitReason = `SL ${(arbCfg.stopLossCents * 100).toFixed(0)}¢: bid ${(exitBid * 100).toFixed(0)}¢, entry ${(existingTrade.entryPrice * 100).toFixed(0)}¢`
        }

        // Low-vol-rider SL: bid down 10¢ AND FV down 5¢ from entry (dual confirm — ignore transient book gaps)
        if (!shouldExit && existingTrade.strategy.startsWith('low-vol-rider')
            && exitBid <= existingTrade.entryPrice - 0.10
            && Number.isFinite(fairValue) && fairValue < existingTrade.entryPrice - 0.05) {
          shouldExit = true
          exitReason = `rider SL: bid ${(exitBid * 100).toFixed(0)}¢, fv ${(fairValue * 100).toFixed(0)}¢, entry ${(existingTrade.entryPrice * 100).toFixed(0)}¢`
        }

        // Edge-relative trailing stop (not for low-vol-rider, skip when FV > 85¢ confirms held side — UNLESS bid >= 93¢)
        const fvConfirmsPosition = Number.isFinite(fairValue) && fairValue > 0.85 && exitBid < 0.93
        if (!shouldExit && existingTrade.peakBid && !existingTrade.strategy.startsWith('low-vol-rider') && !fvConfirmsPosition) {
          const stopWidth = existingTrade.edge * 0.60
          const profitFromEntry = existingTrade.peakBid - existingTrade.entryPrice
          if (profitFromEntry >= existingTrade.edge * 0.40 && exitBid > 0 && exitBid <= existingTrade.peakBid - stopWidth) {
            shouldExit = true
            exitReason = `trailing stop: peak ${(existingTrade.peakBid * 100).toFixed(0)}¢, bid ${(exitBid * 100).toFixed(0)}¢ (-${((existingTrade.peakBid - exitBid) * 100).toFixed(0)}¢, width ${(stopWidth * 100).toFixed(1)}¢)`
          }
        }

        // Pre-expiry emergency dump: sell last 10s at ANY positive bid
        if (!shouldExit && elapsed >= WINDOW_SEC - 10 && exitBid > 0) {
          shouldExit = true
          exitReason = `emergency dump at ${(exitBid * 100).toFixed(0)}¢ (last 10s)`
        }

        if (shouldExit && exitBid > 0) {
          if (buyingInProgress.has(windowKey) || sellingInProgress.has(windowKey)) return

          const tokenId = existingTrade.side === 'YES' ? currentMarket.yesTokenId : currentMarket.noTokenId
          const shares = existingTrade.sizeUsdc / existingTrade.entryPrice
          sellingInProgress.add(windowKey)
          try {
            const isUrgent = exitReason.startsWith('SL ') || exitReason.startsWith('trailing stop') || exitReason.startsWith('TP') || exitReason.startsWith('emergency') || exitReason.startsWith('rider SL')
            const sellResult = await executor.sell(tokenId, shares, currentMarket.tickSize as TickSize, currentMarket.negRisk, exitBid, isUrgent)

            if (!sellResult.success) {
              existingTrade.sellFailures = (existingTrade.sellFailures ?? 0) + 1
              if (sellResult.revenue && sellResult.revenue > 0) {
                existingTrade.partialRevenue = (existingTrade.partialRevenue ?? 0) + sellResult.revenue
              }
              logger.warn({ result: sellResult, exitReason, attempt: existingTrade.sellFailures, remaining: sellResult.remaining, partialRevenue: existingTrade.partialRevenue }, 'Sell failed — retrying next tick')
              if (existingTrade.sellFailures % 3 === 0) {
                alerts.sendSellFailureAlert({
                  side: existingTrade.side,
                  entryPrice: existingTrade.entryPrice,
                  strategy: existingTrade.strategy,
                  remaining: sellResult.remaining ?? shares,
                  attempts: existingTrade.sellFailures,
                  error: sellResult.error,
                }).catch(() => {})
              }
              return
            }

            const soldShares = sellResult.filledShares ?? shares
            const actualExitPrice = sellResult.fillPrice ?? exitBid
            const revenue = computeRevenue(sellResult.revenue, existingTrade.partialRevenue ?? 0, soldShares, exitBid)
            const pnl = revenue - existingTrade.sizeUsdc

            riskManager.recordTrade(MARKET_ID, pnl)
            riskManager.closePosition(MARKET_ID)
            if (pnl > 0) winCount++

            const holdSec = Math.round((Date.now() - existingTrade.entryTime) / 1000)
            stdout(`${tag.sell} ${color.bold(existingTrade.side)} ${(existingTrade.entryPrice * 100).toFixed(0)}¢${color.dim(box.arrow)}${(actualExitPrice * 100).toFixed(0)}¢ ${fmtPnl(pnl)} ${color.yellow('held ' + holdSec + 's')} ${color.cyan(soldShares.toFixed(1) + ' shares')} ${color.dim('$' + revenue.toFixed(2))} ${color.dim(exitReason)}`)

            logger.info({
              side: existingTrade.side,
              entry: existingTrade.entryPrice,
              exit: actualExitPrice,
              soldShares,
              remaining: sellResult.remaining,
              revenue: revenue.toFixed(2),
              pnl: pnl.toFixed(2),
              reason: exitReason,
            }, pnl > 0 ? 'EXIT — profit' : 'EXIT — loss')

            alerts.sendExitAlert({
              strategy: existingTrade.strategy,
              side: existingTrade.side,
              entryPrice: existingTrade.entryPrice,
              exitPrice: actualExitPrice,
              pnl,
              reason: exitReason,
              holdSec,
              soldShares,
              revenue,
            }).catch(() => {})

            openTrades.delete(windowKey)
            windowTradeCount.set(windowKey, (windowTradeCount.get(windowKey) ?? 0) + 1)
            tradeCount++
          } finally {
            sellingInProgress.delete(windowKey)
          }
        }

        return // already have a position (or just exited), skip new entries this tick
      }

      // Skip new entries on fat-tails models — only trade on [C]
      if (modelTag !== 'C') return

      // Skip new entries when paused via Telegram
      if (alerts.isPaused()) return

      // Skip new entries if max trades per window reached
      if ((windowTradeCount.get(windowKey) ?? 0) >= MAX_TRADES_PER_WINDOW) return

      // Enforce one trade per half: if already traded in this half, skip
      const currentHalf = elapsed < WINDOW_SEC / 2 ? 1 : 2
      const lastHalf = windowTradeHalf.get(windowKey)
      if (lastHalf === currentHalf) return

      // No new entries in last 15s — not enough time to fill + sell
      if (elapsed >= WINDOW_SEC - 15) {
        logger.debug({ elapsed, cutoff: WINDOW_SEC - 15 }, 'Skipping entry — 15s cutoff')
        return
      }

      // Evaluate all strategies
      for (const strategy of strategies) {
        const signal = strategy instanceof MomentumStrategy
          ? strategy.evaluate(ctx, windowKey)
          : strategy.evaluate(ctx)
        if (!signal) continue

        const approved = riskManager.approve(signal, MARKET_ID)
        if (!approved) continue

        const entryPrice = Math.round((signal.side === 'YES' ? ctx.marketYesPrice : ctx.marketNoPrice) * 100) / 100
        approved.price = entryPrice
        approved.sigma = sigma

        logger.info({
          strategy: signal.strategy,
          side: signal.side,
          edge: signal.edge.toFixed(4),
          fv: (signal.side === 'YES' ? fv.fairValueUp : fv.fairValueDown).toFixed(4),
          marketPrice: entryPrice,
          btcPrice: currentPrice,
          refPrice: referencePrice,
        }, 'Signal detected — executing')

        const marketConfig: MarketConfig = {
          id: MARKET_ID,
          name: `BTC ${WINDOW_LABEL} ${currentMarket.slug}`,
          yesTokenId: currentMarket.yesTokenId,
          noTokenId: currentMarket.noTokenId,
          conditionId: currentMarket.conditionId,
          referencePrice,
          windowDurationSec: WINDOW_SEC,
          tickSize: currentMarket.tickSize as TickSize,
          negRisk: currentMarket.negRisk,
          minOrderSize: currentMarket.minOrderSize,
        }

        // Reserve slot + guard BEFORE async call to prevent duplicate orders and sells
        openTrades.set(windowKey, {
          side: signal.side,
          entryPrice,
          sizeUsdc: entryPrice * (currentMarket.minOrderSize ?? 5),
          refPrice: referencePrice,
          strategy: signal.strategy,
          entryTime: Date.now(),
          edge: signal.edge,
        })
        buyingInProgress.add(windowKey)

        try {
          const result = await executor.execute(approved, marketConfig)

          if (result.success) {
            const actualShares = result.filledShares ?? (currentMarket.minOrderSize ?? 5)
            const actualPrice = result.fillPrice ?? entryPrice
            const trade = openTrades.get(windowKey)
            if (trade) {
              trade.entryPrice = actualPrice
              trade.sizeUsdc = actualShares * actualPrice
            }

            riskManager.openPosition(MARKET_ID)
            tradeCount++
            windowTradeHalf.set(windowKey, elapsed < WINDOW_SEC / 2 ? 1 : 2)

            stdout(`${tag.trade} ${color.bold(signal.side)} @ ${(actualPrice * 100).toFixed(0)}¢ ${color.yellow('t=' + Math.round(elapsed) + 's')} ${color.dim('│')} edge ${color.green((signal.edge * 100).toFixed(1) + '¢')} ${color.dim('│')} ${color.dim(signal.strategy)} ${color.dim('│')} BTC ${color.bold('$' + currentPrice.toFixed(0))} ${color.dim('│')} ${color.cyan(actualShares.toFixed(1) + ' shares')} ${color.dim('$' + (actualShares * actualPrice).toFixed(2))}`)

            alerts.sendEntryAlert({
              strategy: signal.strategy,
              side: signal.side,
              entryPrice: actualPrice,
              edge: signal.edge,
              btcPrice: currentPrice,
              signalPrice: entryPrice,
              fillPrice: actualPrice,
            }).catch(() => {})
          } else {
            // Order failed — release slot, allow retry next tick
            openTrades.delete(windowKey)
            stdout(`${color.bgRed(' FAIL ')} ${color.red(String(result.error ?? result.status))}`)
            logger.warn({ result }, 'Order failed')
            alerts.sendErrorAlert(`Order failed: ${result.error ?? result.status}\n${signal.side} @ ${(entryPrice * 100).toFixed(0)}¢ · ${signal.strategy}`).catch(() => {})
          }
        } finally {
          buyingInProgress.delete(windowKey)
        }

        break // one signal per tick
      }
    } catch (err) {
      logger.error({ err }, 'Main loop error')
      alerts.sendErrorAlert(`Main loop error: ${err instanceof Error ? err.message : String(err)}`).catch(() => {})
    }
  }, 1000)

  // --- Graceful shutdown ---
  const shutdown = async () => {
    logger.info('Shutting down...')
    clearInterval(tickInterval)
    alerts.stopPolling()
    binanceWS.close()
    polymarketWS.close()

    const pnl = riskManager.getDailyPnl()
    const winRate = tradeCount > 0 ? ((winCount / tradeCount) * 100).toFixed(0) + '%' : 'n/a'
    banner([
      `${color.bold('SESSION COMPLETE')}`,
      `${color.dim('P&L')} ${fmtPnl(pnl)}  ${color.dim('trades')} ${tradeCount}  ${color.dim('wins')} ${winCount}  ${color.dim('rate')} ${winRate}`,
    ], 'stop')

    await alerts.sendDailySummary(pnl, tradeCount, winCount)
    process.exit(0)
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  stdout(`${color.green(box.dot)} ${color.green('Ready')} ${color.dim('— Ctrl+C to stop')}`)
  alerts.sendStartAlert(config.mode, config.risk.positionSizeUsdc, config.risk.maxDailyLossUsdc)

  // Telegram command polling
  alerts.startPolling(
    () => stdout(`${tag.warn} Bot paused via Telegram`),
    () => stdout(`${color.green(box.dot)} Bot resumed via Telegram`),
  )
}

// --- Helpers ---

function sumDepth(levels: Array<{ size: number }>): number {
  return levels.reduce((s, l) => s + l.size, 0)
}

/** Compute sell revenue: prefer CLOB data + partial, fall back to estimated. */
function computeRevenue(sellRevenue: number | undefined, partialRevenue: number, soldShares: number, exitBid: number): number {
  if (sellRevenue !== undefined) return partialRevenue + sellRevenue
  return soldShares * Math.max(exitBid, 0.01) * 0.98
}

function fmtPnl(pnl: number): string {
  return pnl >= 0 ? color.green(`+$${pnl.toFixed(2)}`) : color.red(`-$${Math.abs(pnl).toFixed(2)}`)
}

/** Default BTC annualized vol ~60% — used as bootstrap before enough data */
const DEFAULT_SIGMA = 0.60
/** BTC annualized vol never below ~30% — prevents EWMA from collapsing on sparse data */
const MIN_SIGMA = 0.30

function getSigma(
  models: ModelConfig,
  store: PriceStore,
  ewmaVar: number,
  garchVar: number,
  windowSec: number,
): number {
  // Prefer GARCH if configured and warm, then EWMA, then rolling, then default
  const bucket = getTimeframeBucket(windowSec)
  const varianceToUse = (models[bucket] === 'garch' && garchVar > 0) ? garchVar
    : ewmaVar > 0 ? ewmaVar
    : 0

  if (varianceToUse > 0) {
    return Math.max(Math.sqrt(varianceToUse) * Math.sqrt(MINUTES_PER_YEAR), MIN_SIGMA)
  }

  const rolling = store.getRollingVol(60)
  return rolling > 0 ? Math.max(rolling, MIN_SIGMA) : DEFAULT_SIGMA
}

main().catch(err => {
  logger.error({ err }, 'Fatal startup error')
  process.exit(1)
})
