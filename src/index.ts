import { loadConfig } from './config/markets.ts'
import type { Config, MarketConfig, ModelConfig } from './config/schema.ts'
import { PriceStore } from './data/price-store.ts'
import { createBinanceWS } from './data/binance-ws.ts'
import { createPolymarketWS, type OrderbookState } from './data/polymarket-ws.ts'
import { fetchCurrentMarket, fetchPriceToBeat, getWindowEpoch, type LiveMarket } from './data/market-discovery.ts'
import { readChainlinkBtcPrice } from './data/chainlink.ts'
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
import { LiveExecutor } from './execution/executor.ts'
import { PaperExecutor } from './execution/paper.ts'
import type { Executor } from './execution/executor.ts'
import { createAlerts } from './monitoring/alerts.ts'
import { logger } from './monitoring/logger.ts'

const CONFIG_PATH = process.argv[2] ?? 'config.yaml'
const MINUTES_PER_YEAR = 365.25 * 24 * 60
const WINDOW_SEC = 300

/** Max age of data before we consider it stale and skip trading */
const MAX_PRICE_STALE_MS = 5_000
const MAX_BOOK_STALE_MS = 10_000

async function main() {
  const config = await loadConfig(CONFIG_PATH)
  logger.level = config.logLevel
  logger.info({ mode: config.mode }, 'Bot starting')

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

  logger.info({ strategies: strategies.map(s => s.name) }, 'Strategies loaded')

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
  interface OpenTrade { side: 'YES' | 'NO'; entryPrice: number; sizeUsdc: number; refPrice: number; strategy: string }
  const openTrades = new Map<string, OpenTrade>()
  let tradeCount = 0
  let winCount = 0

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
    onConnect() { logger.info('Binance WS connected') },
    onDisconnect() {
      logger.warn('Binance WS disconnected')
      alerts.sendErrorAlert('Binance WS disconnected — reconnecting')
    },
    onError(err) { logger.error({ err }, 'Binance WS error') },
  })

  const polymarketWS = createPolymarketWS({
    assetIds: [], // will be set dynamically
    onUpdate(tokenId, state) {
      orderbookStates.set(tokenId, state)
    },
    onConnect() { logger.info('Polymarket WS connected') },
    onDisconnect() {
      logger.warn('Polymarket WS disconnected')
      alerts.sendErrorAlert('Polymarket WS disconnected — reconnecting')
    },
    onError(err) { logger.error({ err }, 'Polymarket WS error') },
  })

  // --- Connect ---
  binanceWS.connect()
  polymarketWS.connect()

  // Wait for Binance price
  logger.info('Waiting for initial price data...')
  await Bun.sleep(3000)

  // --- Fetch initial market ---
  await refreshMarket()

  async function refreshMarket() {
    const newEpoch = getWindowEpoch(Date.now())
    if (newEpoch === currentEpoch && currentMarket) return

    const market = await fetchCurrentMarket()
    if (!market) {
      logger.error('Failed to fetch market from Gamma API')
      return
    }

    currentMarket = market
    currentEpoch = newEpoch

    // Chainlink on-chain feed as real-time ref price, fallback to Binance
    const chainlinkPrice = await readChainlinkBtcPrice()
    referencePrice = chainlinkPrice ?? lastPrice ?? 0

    // Re-subscribe Polymarket WS to new token IDs
    const newIds = [market.yesTokenId, market.noTokenId]
    polymarketWS.resubscribe(newIds)

    logger.info({
      epoch: market.epoch,
      slug: market.slug,
      yesToken: market.yesTokenId.substring(0, 12) + '...',
      noToken: market.noTokenId.substring(0, 12) + '...',
      refPrice: referencePrice,
      refSource: chainlinkPrice ? 'chainlink' : 'binance',
    }, 'Market refreshed')
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
        // Resolve any open trades from previous window using priceToBeat for accuracy
        if (currentMarket) {
          const prevKey = `btc-5m-${currentMarket.epoch}`
          const trade = openTrades.get(prevKey)
          if (trade) {
            // Fetch exact priceToBeat for the ended window (Gamma publishes it after close)
            const ptb = await fetchPriceToBeat(currentMarket.epoch)
            const settleRef = ptb ?? trade.refPrice
            if (ptb) {
              logger.info({ chainlinkRef: trade.refPrice, priceToBeat: ptb, delta: (ptb - trade.refPrice).toFixed(2) }, 'Using Gamma priceToBeat for settlement')
            }

            const btcWentUp = currentPrice >= settleRef
            const weWon = (trade.side === 'YES' && btcWentUp) || (trade.side === 'NO' && !btcWentUp)
            const shares = trade.sizeUsdc / trade.entryPrice
            const pnl = weWon ? (shares * 0.98) - trade.sizeUsdc : -trade.sizeUsdc

            riskManager.recordTrade('btc-5m', pnl)
            riskManager.closePosition('btc-5m')
            if (weWon) winCount++

            logger.info({
              side: trade.side,
              entry: trade.entryPrice,
              won: weWon,
              pnl: pnl.toFixed(2),
              refPrice: settleRef,
              endPrice: currentPrice,
            }, weWon ? 'Trade WON' : 'Trade LOST')

            openTrades.delete(prevKey)
          }
        }

        // Capture reference price for new window
        referencePrice = currentPrice
        await refreshMarket()
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

      // --- Ensemble: run 3 models, use consensus ---
      const fvClassic = classicFairValue(currentPrice, referencePrice, T, sigma)
      const fvFat7 = fatTailsFairValue(currentPrice, referencePrice, T, sigma, 7)
      const fvFat4 = fatTailsFairValue(currentPrice, referencePrice, T, sigma, 4)

      // Consensus: use min of the 3 for the favored side (conservative)
      const allUp = [fvClassic.fairValueUp, fvFat7.fairValueUp, fvFat4.fairValueUp]
      const allDown = [fvClassic.fairValueDown, fvFat7.fairValueDown, fvFat4.fairValueDown]

      // Check direction agreement: all 3 must agree which side > 0.5
      const upVotes = allUp.filter(v => v > 0.5).length
      const downVotes = allDown.filter(v => v > 0.5).length
      const consensus = upVotes === 3 ? 'UP' : downVotes === 3 ? 'DOWN' : 'SPLIT'

      // Conservative FV = min of 3 models for the favored side
      const fv: FairValueResult = {
        fairValueUp: Math.min(...allUp),
        fairValueDown: Math.min(...allDown),
        sigma,
        model: 'ensemble',
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

      logger.debug({
        btc: currentPrice,
        ref: referencePrice,
        classic: fvClassic.fairValueUp.toFixed(3),
        fat7: fvFat7.fairValueUp.toFixed(3),
        fat4: fvFat4.fairValueUp.toFixed(3),
        fvUp: fv.fairValueUp.toFixed(3),
        consensus,
        mktYes: yesBook.bestAsk,
        mktNo: noBook.bestAsk,
        bidYes: yesBook.bestBid,
        bidNo: noBook.bestBid,
        elapsed: elapsed.toFixed(0),
        sigma: sigma.toFixed(4),
      }, 'Tick')

      // --- Check exits for open positions ---
      const existingTrade = openTrades.get(windowKey)
      if (existingTrade) {
        const exitBid = existingTrade.side === 'YES' ? yesBook.bestBid : noBook.bestBid
        const fairValue = existingTrade.side === 'YES' ? fv.fairValueUp : fv.fairValueDown
        const arbCfg = config.strategies.fairValueArb

        let shouldExit = false
        let exitReason = ''

        // Exit at fair value
        if (arbCfg.exitAtFairValue && exitBid >= fairValue) {
          shouldExit = true
          exitReason = `bid ${(exitBid * 100).toFixed(0)}¢ >= FV ${(fairValue * 100).toFixed(0)}¢`
        }

        // Take profit
        if (!shouldExit && arbCfg.takeProfitCents > 0 && exitBid >= existingTrade.entryPrice + arbCfg.takeProfitCents) {
          shouldExit = true
          exitReason = `+${((exitBid - existingTrade.entryPrice) * 100).toFixed(0)}¢ profit`
        }

        if (shouldExit && exitBid > 0) {
          const shares = existingTrade.sizeUsdc / existingTrade.entryPrice
          const revenue = shares * exitBid * 0.98 // 2% fee on exit
          const pnl = revenue - existingTrade.sizeUsdc

          riskManager.recordTrade('btc-5m', pnl)
          riskManager.closePosition('btc-5m')
          if (pnl > 0) winCount++

          logger.info({
            side: existingTrade.side,
            entry: existingTrade.entryPrice,
            exit: exitBid,
            pnl: pnl.toFixed(2),
            reason: exitReason,
          }, pnl > 0 ? 'EXIT — profit' : 'EXIT — loss')

          alerts.sendTradeAlert(
            `EXIT ${existingTrade.strategy} | ${existingTrade.side} | ${(existingTrade.entryPrice * 100).toFixed(0)}¢→${(exitBid * 100).toFixed(0)}¢ | P&L=$${pnl.toFixed(2)} | ${exitReason}`
          )

          openTrades.delete(windowKey)
          tradeCount++
        }

        return // already have a position (or just exited), skip new entries this tick
      }

      // Skip new entries when models disagree on direction
      if (consensus === 'SPLIT') return

      // Evaluate all strategies
      for (const strategy of strategies) {
        const signal = strategy instanceof MomentumStrategy
          ? strategy.evaluate(ctx, windowKey)
          : strategy.evaluate(ctx)
        if (!signal) continue

        const approved = riskManager.approve(signal, 'btc-5m')
        if (!approved) continue

        logger.info({
          strategy: signal.strategy,
          side: signal.side,
          edge: signal.edge.toFixed(4),
          fv: fv.fairValueUp.toFixed(4),
          marketPrice: signal.side === 'YES' ? ctx.marketYesPrice : ctx.marketNoPrice,
          btcPrice: currentPrice,
        }, 'Signal detected — executing')

        // Build MarketConfig-compatible object for executor
        const marketConfig: MarketConfig = {
          id: 'btc-5m',
          name: `BTC 5m ${currentMarket.slug}`,
          yesTokenId: currentMarket.yesTokenId,
          noTokenId: currentMarket.noTokenId,
          conditionId: currentMarket.conditionId,
          referencePrice,
          windowDurationSec: WINDOW_SEC,
          tickSize: currentMarket.tickSize as '0.01',
          negRisk: currentMarket.negRisk,
        }

        const result = await executor.execute(approved, marketConfig)

        if (result.success) {
          riskManager.openPosition('btc-5m')
          const entryPrice = signal.side === 'YES' ? ctx.marketYesPrice : ctx.marketNoPrice

          openTrades.set(windowKey, {
            side: signal.side,
            entryPrice,
            sizeUsdc: approved.sizeUsdc,
            refPrice: referencePrice,
            strategy: signal.strategy,
          })
          tradeCount++

          alerts.sendTradeAlert(
            `${signal.strategy} | ${signal.side} | entry=${(entryPrice * 100).toFixed(0)}¢ | edge=${(signal.edge * 100).toFixed(1)}¢ | BTC=$${currentPrice.toFixed(0)}`
          )
        } else {
          logger.warn({ result }, 'Order failed')
          alerts.sendErrorAlert(`Order failed: ${result.error ?? result.status}`)
        }

        break // one signal per tick
      }
    } catch (err) {
      logger.error({ err }, 'Main loop error')
      alerts.sendErrorAlert(`Main loop error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, 1000)

  // --- Graceful shutdown ---
  const shutdown = async () => {
    logger.info('Shutting down...')
    clearInterval(tickInterval)
    binanceWS.close()
    polymarketWS.close()

    const pnl = riskManager.getDailyPnl()
    logger.info({ dailyPnl: pnl, trades: tradeCount, wins: winCount }, 'Bot stopped')

    await alerts.sendDailySummary(pnl, tradeCount, winCount)
    process.exit(0)
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  logger.info('Bot running — press Ctrl+C to stop')
}

// --- Helpers ---

/** Default BTC annualized vol ~60% — used as bootstrap before enough data */
const DEFAULT_SIGMA = 0.60

function getSigma(
  models: ModelConfig,
  store: PriceStore,
  ewmaVar: number,
  garchVar: number,
): number {
  const model = models.fiveMin

  if (model === 'garch' && garchVar > 0) {
    return Math.sqrt(garchVar) * Math.sqrt(MINUTES_PER_YEAR)
  }

  if (ewmaVar > 0) {
    return Math.sqrt(ewmaVar) * Math.sqrt(MINUTES_PER_YEAR)
  }

  const rolling = store.getRollingVol(60)
  return rolling > 0 ? rolling : DEFAULT_SIGMA
}


main().catch(err => {
  logger.error({ err }, 'Fatal startup error')
  process.exit(1)
})
