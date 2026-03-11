import { loadConfig } from './config/markets.ts'
import type { MarketConfig, ModelConfig, TickSize } from './config/schema.ts'
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
import { FairValueArbStrategy } from './strategies/fair-value-arb.ts'
import { ValueStrategy } from './strategies/value.ts'
import type { Strategy } from './strategies/base.ts'
import { RiskManager } from './risk/manager.ts'
import { LiveExecutor, type Executor } from './execution/executor.ts'
import { PaperExecutor } from './execution/paper.ts'
import { createAlerts } from './monitoring/alerts.ts'
import { logger, stdout, color, banner, tag, progressBar, box } from './monitoring/logger.ts'

const CONFIG_PATH = process.argv[2] ?? 'config.yaml'
const MINUTES_PER_YEAR = 365.25 * 24 * 60
const WINDOW_SEC = 300
const MARKET_ID = 'btc-5m'

/** Max age of data before we consider it stale and skip trading */
const MAX_PRICE_STALE_MS = 5_000
const MAX_BOOK_STALE_MS = 10_000

async function main() {
  const config = await loadConfig(CONFIG_PATH)
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
  interface OpenTrade { side: 'YES' | 'NO'; entryPrice: number; sizeUsdc: number; refPrice: number; strategy: string; entryTime: number; sellFailures?: number; peakBid?: number; edge: number }
  const openTrades = new Map<string, OpenTrade>()
  const sellingInProgress = new Set<string>()
  const buyingInProgress = new Set<string>()
  const windowCooldowns = new Set<string>()
  let tradeCount = 0
  let winCount = 0
  let lastTickLog = 0
  let refreshing = false

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
        const windowKey = `btc-5m-${currentMarket.epoch}`
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
    const newEpoch = getWindowEpoch(Date.now())
    if (newEpoch === currentEpoch && currentMarket) return

    refreshing = true
    try {
      const market = await fetchCurrentMarket()
      if (!market) {
        logger.error('Failed to fetch market from Gamma API')
        lastFailedRefresh = Date.now()
        return
      }

      // Re-subscribe Polymarket WS early so orderbook populates while we fetch open price
      const newIds = [market.yesTokenId, market.noTokenId]
      polymarketWS.resubscribe(newIds)

      const openPrice = await fetchOpenPrice(market.epoch)
      if (!openPrice) {
        stdout(`${tag.warn} Open price unavailable — skipping window`)
        lastFailedRefresh = Date.now()
        return // don't update currentMarket/currentEpoch so we retry next tick
      }

      stdout(`${tag.market} ${color.cyan(market.slug)} ${color.dim('ref')} ${color.bold('$' + openPrice.toFixed(2))} ${color.dim('│')} cooldown ${color.yellow('15s')}`)
      await Bun.sleep(15_000)

      // Commit state AFTER sleep so tick loop won't trade during wait
      currentMarket = market
      currentEpoch = newEpoch
      referencePrice = openPrice
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

      // --- Window rotation: check if we've entered a new 5-min window ---
      const newEpoch = getWindowEpoch(now)
      if (newEpoch !== currentEpoch) {
        // Resolve any open trades from previous window — attempt real sell first
        if (currentMarket) {
          const prevKey = `btc-5m-${currentMarket.epoch}`
          const trade = !sellingInProgress.has(prevKey) ? openTrades.get(prevKey) : undefined
          if (trade) {
            const tokenId = trade.side === 'YES' ? currentMarket.yesTokenId : currentMarket.noTokenId
            const shares = trade.sizeUsdc / trade.entryPrice

            // Try real sell before falling back to paper settlement
            const sellResult = await executor.sell(tokenId, shares, currentMarket.tickSize as TickSize, currentMarket.negRisk)

            if (sellResult.success) {
              const exitBook = orderbookStates.get(tokenId)
              const exitBid = exitBook?.bestBid ?? 0
              const revenue = shares * Math.max(exitBid, 0.01) * 0.98
              const pnl = revenue - trade.sizeUsdc

              riskManager.recordTrade(MARKET_ID, pnl)
              riskManager.closePosition(MARKET_ID)
              if (pnl > 0) winCount++

              const holdSec = Math.round((Date.now() - trade.entryTime) / 1000)
              stdout(`${tag.sell} ${color.bold(trade.side)} window-expiry sell ${fmtPnl(pnl)} ${color.yellow('held ' + holdSec + 's')}`)
              logger.info({ side: trade.side, entry: trade.entryPrice, pnl: pnl.toFixed(2) }, 'EXIT — window expiry sell')
              alerts.sendExitAlert({ strategy: trade.strategy, side: trade.side, entryPrice: trade.entryPrice, exitPrice: exitBid, pnl, reason: 'window expiry', holdSec }).catch(() => {})
            } else {
              // Fall back to paper settlement
              const btcWentUp = currentPrice >= trade.refPrice
              const weWon = (trade.side === 'YES' && btcWentUp) || (trade.side === 'NO' && !btcWentUp)
              const pnl = weWon ? (shares * 0.98) - trade.sizeUsdc : -trade.sizeUsdc

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
          }
        }

        sellingInProgress.clear()
        buyingInProgress.clear()
        windowCooldowns.clear()
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
      const sigma = getSigma(config.models, priceStore, ewmaVar, garchVar)
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
      const windowKey = `btc-5m-${currentMarket.epoch}`
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
      }

      // Compact tick log every 5s
      if (now - lastTickLog >= 5_000) {
        lastTickLog = now
        const pBar = progressBar(elapsed, WINDOW_SEC, 15)
        const delta = currentPrice - referencePrice
        const deltaStr = delta >= 0 ? color.green(`+${delta.toFixed(0)}`) : color.red(`${delta.toFixed(0)}`)
        stdout(`${pBar} ${color.bold('$' + currentPrice.toFixed(0))} ${color.dim('ref')}$${referencePrice.toFixed(0)} ${color.dim('Δ')}${deltaStr} ${color.dim('│')} ${color.green('Y')} fv=${color.cyan(fv.fairValueUp.toFixed(2))} a=${yesBook.bestAsk.toFixed(2)} b=${(yesBook.bestBid ?? 0).toFixed(2)} ${color.dim('│')} ${color.red('N')} fv=${color.cyan(fv.fairValueDown.toFixed(2))} a=${noBook.bestAsk.toFixed(2)} b=${(noBook.bestBid ?? 0).toFixed(2)} ${color.dim('σ')}=${sigma.toFixed(2)} ${color.magenta('[' + modelTag + ']')}`)
      }

      // --- Check exits for open positions ---
      const existingTrade = openTrades.get(windowKey)
      if (existingTrade) {
        const exitBid = (existingTrade.side === 'YES' ? yesBook.bestBid : noBook.bestBid) ?? 0
        const fairValue = existingTrade.side === 'YES' ? fv.fairValueUp : fv.fairValueDown
        const arbCfg = config.strategies.fairValueArb

        let shouldExit = false
        let exitReason = ''

        // Update peak bid for trailing stop
        if (exitBid > (existingTrade.peakBid ?? 0)) {
          existingTrade.peakBid = exitBid
        }

        // Exit at fair value
        if (arbCfg.exitAtFairValue && exitBid >= fairValue) {
          shouldExit = true
          exitReason = `bid ${(exitBid * 100).toFixed(0)}¢ >= FV ${(fairValue * 100).toFixed(0)}¢`
        }

        // Edge-relative trailing stop: activation at 40% of edge, stop width at 25% of edge
        if (!shouldExit && existingTrade.peakBid) {
          const stopWidth = existingTrade.edge * 0.25
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
            const sellResult = await executor.sell(tokenId, shares, currentMarket.tickSize as TickSize, currentMarket.negRisk)

            if (!sellResult.success) {
              existingTrade.sellFailures = (existingTrade.sellFailures ?? 0) + 1
              logger.warn({ result: sellResult, exitReason, attempt: existingTrade.sellFailures }, 'Sell order failed — retrying next tick')
              if (existingTrade.sellFailures % 5 === 0) {
                alerts.sendErrorAlert(`Sell failed ${existingTrade.sellFailures}x — still retrying\n${existingTrade.side} @ ${(existingTrade.entryPrice * 100).toFixed(0)}¢ · ${existingTrade.strategy}`).catch(() => {})
              }
              return
            }

            const revenue = shares * exitBid * 0.98 // 2% fee on exit
            const pnl = revenue - existingTrade.sizeUsdc

            riskManager.recordTrade(MARKET_ID, pnl)
            riskManager.closePosition(MARKET_ID)
            if (pnl > 0) winCount++

            const holdSec = Math.round((Date.now() - existingTrade.entryTime) / 1000)
            stdout(`${tag.sell} ${color.bold(existingTrade.side)} ${(existingTrade.entryPrice * 100).toFixed(0)}¢${color.dim(box.arrow)}${(exitBid * 100).toFixed(0)}¢ ${fmtPnl(pnl)} ${color.yellow('held ' + holdSec + 's')} ${color.dim(exitReason)}`)

            logger.info({
              side: existingTrade.side,
              entry: existingTrade.entryPrice,
              exit: exitBid,
              pnl: pnl.toFixed(2),
              reason: exitReason,
            }, pnl > 0 ? 'EXIT — profit' : 'EXIT — loss')

            alerts.sendExitAlert({
              strategy: existingTrade.strategy,
              side: existingTrade.side,
              entryPrice: existingTrade.entryPrice,
              exitPrice: exitBid,
              pnl,
              reason: exitReason,
              holdSec,
            }).catch(() => {})

            openTrades.delete(windowKey)
            windowCooldowns.add(windowKey)
            tradeCount++
          } finally {
            sellingInProgress.delete(windowKey)
          }
        }

        return // already have a position (or just exited), skip new entries this tick
      }

      // Skip new entries when paused via Telegram
      if (alerts.isPaused()) return

      // Skip new entries in windows where we already exited
      if (windowCooldowns.has(windowKey)) return

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
          name: `BTC 5m ${currentMarket.slug}`,
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

            stdout(`${tag.trade} ${color.bold(signal.side)} @ ${(actualPrice * 100).toFixed(0)}¢ ${color.yellow('t=' + Math.round(elapsed) + 's')} ${color.dim('│')} edge ${color.green((signal.edge * 100).toFixed(1) + '¢')} ${color.dim('│')} ${color.dim(signal.strategy)} ${color.dim('│')} BTC ${color.bold('$' + currentPrice.toFixed(0))} ${color.dim('│')} ${color.cyan(actualShares.toFixed(1) + ' shares')} ${color.dim('$' + (actualShares * actualPrice).toFixed(2))}`)

            alerts.sendEntryAlert({
              strategy: signal.strategy,
              side: signal.side,
              entryPrice,
              edge: signal.edge,
              btcPrice: currentPrice,
            }).catch(() => {})
          } else {
            // Order failed — release slot and cooldown this window
            openTrades.delete(windowKey)
            windowCooldowns.add(windowKey)
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
): number {
  // Prefer GARCH if configured and warm, then EWMA, then rolling, then default
  const varianceToUse = (models.fiveMin === 'garch' && garchVar > 0) ? garchVar
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
