import { Effect, Ref } from 'effect'
import type { BotState, OpenTrade } from './state.ts'
import type { Config, MarketConfig, TickSize } from './config/schema.ts'
import type { FairValueResult, StrategyContext, Signal } from './models/types.ts'
import type { Strategy } from './strategies/base.ts'
import type { MomentumStrategy } from './strategies/momentum.ts'
import type { PriceStore } from './data/price-store.ts'
import type { OrderbookState } from './data/polymarket-feed.ts'
import { getWindowEpoch } from './data/market-discovery.ts'
import { classicFairValue } from './models/classic.ts'
import { fatTailsFairValue } from './models/fat-tails.ts'
import { getSigma } from './sigma.ts'
import { RiskManager } from './risk/service.ts'
import { Executor, type ExecutionResult } from './execution/service.ts'
import { Alerts } from './monitoring/alerts.ts'
import { PolymarketFeed } from './data/polymarket-feed.ts'
import { stdout, color, tag, progressBar, box } from './monitoring/logger.ts'

const MAX_PRICE_STALE_MS = 5_000
const MAX_BOOK_STALE_MS = 10_000
const MAX_TRADES_PER_WINDOW = 2

// ── Helpers ──

function sumDepth(levels: Array<{ size: number }>): number {
  return levels.reduce((s, l) => s + l.size, 0)
}

function computeRevenue(sellRevenue: number | undefined, partialRevenue: number, soldShares: number, exitBid: number): number {
  if (sellRevenue !== undefined) return partialRevenue + sellRevenue
  return soldShares * Math.max(exitBid, 0.01) * 0.98
}

function fmtPnl(pnl: number): string {
  return pnl >= 0 ? color.green(`+$${pnl.toFixed(2)}`) : color.red(`-$${Math.abs(pnl).toFixed(2)}`)
}

// ── Main tick ──

export const tick = <R>(
  stateRef: Ref.Ref<BotState>,
  config: Config,
  priceStore: PriceStore,
  strategies: Strategy[],
  momentumStrategy: MomentumStrategy,
  refreshMarket: Effect.Effect<void, never, R>,
) =>
  Effect.gen(function* () {
    const risk = yield* RiskManager
    const executor = yield* Executor
    const alerts = yield* Alerts
    const polyFeed = yield* PolymarketFeed

    const halted = yield* risk.isHalted()
    if (halted) return

    const now = Date.now()
    const s = yield* Ref.get(stateRef)

    const WINDOW_SEC = config.windowDurationSec
    const MARKET_ID = config.windowDurationSec <= 300 ? 'btc-5m'
      : config.windowDurationSec <= 900 ? 'btc-15m'
      : config.windowDurationSec <= 3600 ? 'btc-1h'
      : 'btc-1d'

    // Time/day filter
    const nowDate = new Date(now)
    if (config.timeFilter.skipDays.includes(nowDate.getUTCDay())) return

    // Check Binance data freshness
    if (now - s.lastPriceTimestamp > MAX_PRICE_STALE_MS) return

    const currentPrice = s.lastPrice
    if (!currentPrice) return

    // --- Window rotation ---
    const newEpoch = getWindowEpoch(now, WINDOW_SEC)
    if (newEpoch !== s.currentEpoch) {
      // Resolve any open trades from previous window
      if (s.currentMarket) {
        const prevKey = `${MARKET_ID}-${s.currentMarket.epoch}`
        const trade = !s.sellingInProgress.has(prevKey) ? s.openTrades.get(prevKey) : undefined
        if (trade) {
          yield* Ref.update(stateRef, st => {
            const next = new Set(st.sellingInProgress)
            next.add(prevKey)
            return { ...st, sellingInProgress: next }
          })

          const tokenId = trade.side === 'YES' ? s.currentMarket.yesTokenId : s.currentMarket.noTokenId
          const shares = trade.sizeUsdc / trade.entryPrice
          const expiryBook = yield* polyFeed.getOrderbook(tokenId)
          const expiryBid = expiryBook?.bestBid

          const sellResult = yield* executor.sell(tokenId, shares, s.currentMarket.tickSize as TickSize, s.currentMarket.negRisk, expiryBid)

          if (sellResult.success) {
            const exitBid = expiryBook?.bestBid ?? 0
            const soldShares = sellResult.filledShares ?? shares
            const exitPrice = sellResult.fillPrice ?? exitBid
            const revenue = computeRevenue(sellResult.revenue, trade.partialRevenue ?? 0, soldShares, exitBid)
            const pnl = revenue - trade.sizeUsdc

            yield* risk.recordTrade(MARKET_ID, pnl)
            yield* risk.closePosition(MARKET_ID)

            const holdSec = Math.round((Date.now() - trade.entryTime) / 1000)
            stdout(`${tag.sell} ${color.bold(trade.side)} window-expiry sell ${fmtPnl(pnl)} ${color.yellow('held ' + holdSec + 's')} ${color.cyan(soldShares.toFixed(1) + ' shares')}`)
            yield* alerts.sendExitAlert({ strategy: trade.strategy, side: trade.side, entryPrice: trade.entryPrice, exitPrice, pnl, reason: 'window expiry', holdSec, soldShares, revenue }).pipe(Effect.catchAll(() => Effect.void))

            yield* Ref.update(stateRef, st => {
              const openTrades = new Map(st.openTrades)
              openTrades.delete(prevKey)
              return { ...st, openTrades, winCount: pnl > 0 ? st.winCount + 1 : st.winCount }
            })
          } else if (sellResult.remaining !== undefined && sellResult.remaining < 5) {
            // Sub-minimum stuck — shares will resolve on-chain
            const btcWentUp = currentPrice >= trade.refPrice
            const weWon = (trade.side === 'YES' && btcWentUp) || (trade.side === 'NO' && !btcWentUp)
            const estimatedPnl = weWon ? (sellResult.remaining * 0.98) - trade.sizeUsdc : -trade.sizeUsdc
            yield* risk.closePosition(MARKET_ID)
            stdout(`${tag.sell} ${color.bold(trade.side)} ${color.yellow('pending resolution')} ${sellResult.remaining?.toFixed(1)} shares stuck (sub-min) — ${weWon ? 'likely win' : 'likely loss'} ~${fmtPnl(estimatedPnl)}`)
            yield* alerts.sendErrorAlert(`⏳ ${trade.side} pending resolution — ${sellResult.remaining?.toFixed(1)} shares stuck, ${weWon ? 'likely win' : 'likely loss'}`).pipe(Effect.catchAll(() => Effect.void))

            yield* Ref.update(stateRef, st => {
              const openTrades = new Map(st.openTrades)
              openTrades.delete(prevKey)
              return { ...st, openTrades }
            })
          } else {
            // Paper settlement fallback
            const btcWentUp = currentPrice >= trade.refPrice
            const weWon = (trade.side === 'YES' && btcWentUp) || (trade.side === 'NO' && !btcWentUp)
            const partialRevenue = sellResult.revenue ?? 0
            const pnl = weWon ? (shares * 0.98) - trade.sizeUsdc : partialRevenue - trade.sizeUsdc
            yield* risk.recordTrade(MARKET_ID, pnl)
            yield* risk.closePosition(MARKET_ID)

            stdout(weWon
              ? `${tag.win} ${color.bold(trade.side)} settled ${fmtPnl(pnl)}`
              : `${tag.loss} ${color.bold(trade.side)} settled ${fmtPnl(pnl)}`)
            yield* alerts.sendErrorAlert(`Window-expiry sell failed — paper settled ${trade.side} @ ${(trade.entryPrice * 100).toFixed(0)}¢`).pipe(Effect.catchAll(() => Effect.void))

            yield* Ref.update(stateRef, st => {
              const openTrades = new Map(st.openTrades)
              openTrades.delete(prevKey)
              return { ...st, openTrades, winCount: weWon ? st.winCount + 1 : st.winCount }
            })
          }

          yield* Ref.update(stateRef, st => {
            const next = new Set(st.sellingInProgress)
            next.delete(prevKey)
            return { ...st, sellingInProgress: next }
          })
        }
      }

      // Queue previous market for CTF redemption
      if (s.currentMarket && !s.pendingRedemptions.has(s.currentMarket.conditionId)) {
        yield* Ref.update(stateRef, st => {
          const pr = new Map(st.pendingRedemptions)
          pr.set(st.currentMarket!.conditionId, 0)
          return { ...st, pendingRedemptions: pr }
        })
      }

      // Clear window state
      yield* Ref.update(stateRef, st => ({
        ...st,
        sellingInProgress: new Set<string>(),
        buyingInProgress: new Set<string>(),
        windowTradeCount: new Map(),
        windowTradeHalf: new Map(),
        lastTickLog: 0,
      }))

      if (!s.refreshing) yield* refreshMarket
      return // skip rest of tick — wait for refresh to commit new state
    }

    if (!s.currentMarket || !s.referencePrice) return

    // Get orderbook state
    const yesBook = yield* polyFeed.getOrderbook(s.currentMarket.yesTokenId)
    const noBook = yield* polyFeed.getOrderbook(s.currentMarket.noTokenId)
    if (!yesBook || !noBook) return
    const bookAge = Math.max(now - yesBook.lastUpdate, now - noBook.lastUpdate)
    if (bookAge > MAX_BOOK_STALE_MS) return
    if (!yesBook.bestAsk || !noBook.bestAsk) return

    // --- Arb check (independent of model) ---
    if (config.arbEnabled && s.currentMarket) {
      const arbKey = `arb-${MARKET_ID}-${s.currentMarket.epoch}`
      const total = yesBook.bestAsk + noBook.bestAsk
      if (total < 1.0 && !s.openTrades.has(arbKey) && !s.buyingInProgress.has(arbKey)) {
        const gap = 1.0 - total
        const yesSize = Math.min(sumDepth(yesBook.askLevels ?? []), 50)
        const noSize = Math.min(sumDepth(noBook.askLevels ?? []), 50)
        const depth = Math.min(yesSize, noSize)
        if (depth >= (s.currentMarket.minOrderSize ?? 5)) {
          stdout(`${color.bgGreen(' ARB ')} YES ${yesBook.bestAsk.toFixed(2)} + NO ${noBook.bestAsk.toFixed(2)} = ${total.toFixed(3)} gap=${(gap * 100).toFixed(1)}¢ depth=${depth.toFixed(0)}`)

          const marketConfig: MarketConfig = {
            id: MARKET_ID,
            name: `ARB ${s.currentMarket.slug}`,
            yesTokenId: s.currentMarket.yesTokenId,
            noTokenId: s.currentMarket.noTokenId,
            conditionId: s.currentMarket.conditionId,
            referencePrice: s.referencePrice,
            windowDurationSec: WINDOW_SEC,
            tickSize: s.currentMarket.tickSize as TickSize,
            negRisk: s.currentMarket.negRisk,
            minOrderSize: s.currentMarket.minOrderSize,
          }

          const shares = s.currentMarket.minOrderSize + 1
          yield* Ref.update(stateRef, st => {
            const bi = new Set(st.buyingInProgress)
            bi.add(arbKey)
            return { ...st, buyingInProgress: bi }
          })

          // Buy YES side
          const yesResult = yield* executor.execute(
            { side: 'YES', sizeUsdc: shares * yesBook.bestAsk, strategy: 'arb', confidence: 1, edge: gap, price: yesBook.bestAsk, sigma: 0 },
            marketConfig,
          )
          // Buy NO side
          const noResult = yield* executor.execute(
            { side: 'NO', sizeUsdc: shares * noBook.bestAsk, strategy: 'arb', confidence: 1, edge: gap, price: noBook.bestAsk, sigma: 0 },
            marketConfig,
          )

          yield* Ref.update(stateRef, st => {
            const openTrades = new Map(st.openTrades)
            openTrades.set(arbKey, {
              side: 'YES', // placeholder — both sides held
              entryPrice: total,
              sizeUsdc: shares * total,
              refPrice: s.referencePrice,
              strategy: 'arb',
              entryTime: Date.now(),
              edge: gap,
            })
            const bi = new Set(st.buyingInProgress)
            bi.delete(arbKey)
            return { ...st, openTrades, buyingInProgress: bi }
          })

          yield* alerts.sendEntryAlert({
            strategy: 'arb',
            side: 'YES',
            entryPrice: total,
            edge: gap,
            btcPrice: currentPrice,
          }).pipe(Effect.catchAll(() => Effect.void))

          stdout(`${color.bgGreen(' ARB ')} bought ${shares} shares both sides @ ${total.toFixed(3)} — guaranteed ${(gap * 100).toFixed(1)}¢ profit`)
        }
      }
    }

    // Elapsed seconds in current window
    const elapsed = (now - s.currentMarket.windowStartMs) / 1000
    if (elapsed < 0 || elapsed > WINDOW_SEC) return

    // Get volatility + fair value
    const sigma = getSigma(config.models, priceStore, s.vol.ewmaVar, s.vol.garchVar, WINDOW_SEC)
    if (!Number.isFinite(sigma) || sigma <= 0) return

    const timeRemaining = Math.max(WINDOW_SEC - elapsed, 1)
    const T = timeRemaining / (365.25 * 24 * 3600)

    // Adaptive model selection
    let fv: FairValueResult
    let modelTag: string
    if (sigma < config.models.lowVolThreshold) {
      fv = classicFairValue(currentPrice, s.referencePrice, T, sigma)
      modelTag = 'C'
    } else if (sigma > config.models.highVolThreshold) {
      fv = fatTailsFairValue(currentPrice, s.referencePrice, T, sigma, 4)
      modelTag = 'F4'
    } else {
      fv = fatTailsFairValue(currentPrice, s.referencePrice, T, sigma, config.models.studentTNu)
      modelTag = `F${config.models.studentTNu}`
    }

    // Build strategy context
    const windowKey = `${MARKET_ID}-${s.currentMarket.epoch}`
    const ctx: StrategyContext = {
      currentPrice,
      referencePrice: s.referencePrice,
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
    if (now - s.lastTickLog >= 1_000) {
      yield* Ref.update(stateRef, st => ({ ...st, lastTickLog: now }))
      const pBar = progressBar(elapsed, WINDOW_SEC, 15)
      const delta = currentPrice - s.referencePrice
      const deltaStr = delta >= 0 ? color.green(`+${delta.toFixed(0)}`) : color.red(`${delta.toFixed(0)}`)
      const openTrade = s.openTrades.get(windowKey)
      let posStr = ''
      if (openTrade && !s.buyingInProgress.has(windowKey)) {
        const bid = (openTrade.side === 'YES' ? yesBook.bestBid : noBook.bestBid) ?? 0
        const unrealizedPnl = (bid - openTrade.entryPrice) * (openTrade.sizeUsdc / openTrade.entryPrice)
        const toTp = (openTrade.entryPrice + 0.10) - bid
        if (unrealizedPnl > 0) {
          posStr = ` ${color.green('PnL +$' + unrealizedPnl.toFixed(2))} ${color.dim('TP in')} ${color.yellow((toTp * 100).toFixed(0) + '¢')}`
        } else {
          posStr = ` ${color.red('PnL -$' + Math.abs(unrealizedPnl).toFixed(2))}`
        }
      }
      stdout(`${pBar} ${color.bold('$' + currentPrice.toFixed(0))} ${color.dim('ref')}$${s.referencePrice.toFixed(0)} ${color.dim('Δ')}${deltaStr} ${color.dim('│')} ${color.green('Y')} fv=${color.cyan(fv.fairValueUp.toFixed(2))} a=${yesBook.bestAsk.toFixed(2)} b=${(yesBook.bestBid ?? 0).toFixed(2)} ${color.dim('│')} ${color.red('N')} fv=${color.cyan(fv.fairValueDown.toFixed(2))} a=${noBook.bestAsk.toFixed(2)} b=${(noBook.bestBid ?? 0).toFixed(2)} ${color.dim('σ')}=${sigma.toFixed(2)} ${color.magenta('[' + modelTag + ']')}${posStr}`)
    }

    // --- Check exits for open positions ---
    const existingTrade = s.openTrades.get(windowKey)
    if (existingTrade) {
      const exitBid = (existingTrade.side === 'YES' ? yesBook.bestBid : noBook.bestBid) ?? 0
      const fairValue = existingTrade.side === 'YES' ? fv.fairValueUp : fv.fairValueDown
      const arbCfg = config.strategies.fairValueArb

      let shouldExit = false
      let exitReason = ''

      // Update peak bid for trailing stop
      if (!s.buyingInProgress.has(windowKey) && exitBid > (existingTrade.peakBid ?? 0)) {
        yield* Ref.update(stateRef, st => {
          const openTrades = new Map(st.openTrades)
          const t = openTrades.get(windowKey)
          if (t) openTrades.set(windowKey, { ...t, peakBid: exitBid })
          return { ...st, openTrades }
        })
      }

      // Exit at fair value
      if (arbCfg.exitAtFairValue && exitBid >= fairValue) {
        shouldExit = true
        exitReason = `bid ${(exitBid * 100).toFixed(0)}¢ >= FV ${(fairValue * 100).toFixed(0)}¢`
      }

      // Fixed take-profit at 10¢
      if (!shouldExit && exitBid >= existingTrade.entryPrice + 0.10) {
        shouldExit = true
        exitReason = `TP 10¢: bid ${(exitBid * 100).toFixed(0)}¢, entry ${(existingTrade.entryPrice * 100).toFixed(0)}¢`
      }

      // Fixed stop-loss
      if (!shouldExit && arbCfg.stopLossCents > 0 && exitBid > 0 && exitBid <= existingTrade.entryPrice - arbCfg.stopLossCents) {
        shouldExit = true
        exitReason = `SL ${(arbCfg.stopLossCents * 100).toFixed(0)}¢: bid ${(exitBid * 100).toFixed(0)}¢, entry ${(existingTrade.entryPrice * 100).toFixed(0)}¢`
      }

      // Low-vol-rider SL
      if (!shouldExit && existingTrade.strategy.startsWith('low-vol-rider')
          && exitBid <= existingTrade.entryPrice - 0.10
          && Number.isFinite(fairValue) && fairValue < existingTrade.entryPrice - 0.05) {
        shouldExit = true
        exitReason = `rider SL: bid ${(exitBid * 100).toFixed(0)}¢, fv ${(fairValue * 100).toFixed(0)}¢, entry ${(existingTrade.entryPrice * 100).toFixed(0)}¢`
      }

      // Edge-relative trailing stop
      if (!shouldExit && existingTrade.peakBid && !existingTrade.strategy.startsWith('low-vol-rider')) {
        const stopWidth = existingTrade.edge * 0.60
        const profitFromEntry = existingTrade.peakBid - existingTrade.entryPrice
        if (profitFromEntry >= existingTrade.edge * 0.40 && exitBid > 0 && exitBid <= existingTrade.peakBid - stopWidth) {
          shouldExit = true
          exitReason = `trailing stop: peak ${(existingTrade.peakBid * 100).toFixed(0)}¢, bid ${(exitBid * 100).toFixed(0)}¢ (-${((existingTrade.peakBid - exitBid) * 100).toFixed(0)}¢, width ${(stopWidth * 100).toFixed(1)}¢)`
        }
      }

      // Pre-expiry emergency dump
      if (!shouldExit && elapsed >= WINDOW_SEC - 10 && exitBid > 0) {
        shouldExit = true
        exitReason = `emergency dump at ${(exitBid * 100).toFixed(0)}¢ (last 10s)`
      }

      if (shouldExit && exitBid > 0) {
        if (s.buyingInProgress.has(windowKey) || s.sellingInProgress.has(windowKey)) return

        const tokenId = existingTrade.side === 'YES' ? s.currentMarket.yesTokenId : s.currentMarket.noTokenId
        const shares = existingTrade.sizeUsdc / existingTrade.entryPrice
        yield* Ref.update(stateRef, st => {
          const next = new Set(st.sellingInProgress)
          next.add(windowKey)
          return { ...st, sellingInProgress: next }
        })

        const isUrgent = exitReason.startsWith('SL ') || exitReason.startsWith('trailing stop') || exitReason.startsWith('TP') || exitReason.startsWith('emergency') || exitReason.startsWith('rider SL')
        const sellResult = yield* executor.sell(tokenId, shares, s.currentMarket.tickSize as TickSize, s.currentMarket.negRisk, exitBid, isUrgent)

        if (!sellResult.success) {
          yield* Ref.update(stateRef, st => {
            const openTrades = new Map(st.openTrades)
            const t = openTrades.get(windowKey)
            if (t) {
              const failures = (t.sellFailures ?? 0) + 1
              const partialRev = sellResult.revenue && sellResult.revenue > 0
                ? (t.partialRevenue ?? 0) + sellResult.revenue
                : t.partialRevenue
              openTrades.set(windowKey, { ...t, sellFailures: failures, partialRevenue: partialRev })
            }
            return { ...st, openTrades }
          })

          const updatedTrade = (yield* Ref.get(stateRef)).openTrades.get(windowKey)
          if (updatedTrade && (updatedTrade.sellFailures ?? 0) % 3 === 0) {
            yield* alerts.sendSellFailureAlert({
              side: existingTrade.side,
              entryPrice: existingTrade.entryPrice,
              strategy: existingTrade.strategy,
              remaining: sellResult.remaining ?? shares,
              attempts: updatedTrade.sellFailures ?? 0,
              error: sellResult.error,
            }).pipe(Effect.catchAll(() => Effect.void))
          }

          yield* Ref.update(stateRef, st => {
            const next = new Set(st.sellingInProgress)
            next.delete(windowKey)
            return { ...st, sellingInProgress: next }
          })
          return
        }

        const soldShares = sellResult.filledShares ?? shares
        const actualExitPrice = sellResult.fillPrice ?? exitBid
        const revenue = computeRevenue(sellResult.revenue, existingTrade.partialRevenue ?? 0, soldShares, exitBid)
        const pnl = revenue - existingTrade.sizeUsdc

        yield* risk.recordTrade(MARKET_ID, pnl)
        yield* risk.closePosition(MARKET_ID)

        const holdSec = Math.round((Date.now() - existingTrade.entryTime) / 1000)
        stdout(`${tag.sell} ${color.bold(existingTrade.side)} ${(existingTrade.entryPrice * 100).toFixed(0)}¢${color.dim(box.arrow)}${(actualExitPrice * 100).toFixed(0)}¢ ${fmtPnl(pnl)} ${color.yellow('held ' + holdSec + 's')} ${color.cyan(soldShares.toFixed(1) + ' shares')} ${color.dim('$' + revenue.toFixed(2))} ${color.dim(exitReason)}`)
        yield* alerts.sendExitAlert({
          strategy: existingTrade.strategy,
          side: existingTrade.side,
          entryPrice: existingTrade.entryPrice,
          exitPrice: actualExitPrice,
          pnl,
          reason: exitReason,
          holdSec,
          soldShares,
          revenue,
        }).pipe(Effect.catchAll(() => Effect.void))

        yield* Ref.update(stateRef, st => {
          const openTrades = new Map(st.openTrades)
          openTrades.delete(windowKey)
          const wc = new Map(st.windowTradeCount)
          wc.set(windowKey, (wc.get(windowKey) ?? 0) + 1)
          const next = new Set(st.sellingInProgress)
          next.delete(windowKey)
          return {
            ...st,
            openTrades,
            windowTradeCount: wc,
            sellingInProgress: next,
            tradeCount: st.tradeCount + 1,
            winCount: pnl > 0 ? st.winCount + 1 : st.winCount,
          }
        })
      }

      return // already have a position (or just exited), skip new entries
    }

    // Skip new entries on fat-tails models — only trade on [C]
    if (modelTag !== 'C') return

    // Skip when paused via Telegram
    const paused = yield* alerts.isPaused
    if (paused) return

    // Skip if max trades per window
    if ((s.windowTradeCount.get(windowKey) ?? 0) >= MAX_TRADES_PER_WINDOW) return

    // Enforce one trade per half
    const currentHalf = elapsed < WINDOW_SEC / 2 ? 1 : 2
    const lastHalf = s.windowTradeHalf.get(windowKey)
    if (lastHalf === currentHalf) return

    // No new entries in last 15s
    if (elapsed >= WINDOW_SEC - 15) return

    // Evaluate all strategies
    for (const strategy of strategies) {
      const signal = strategy === momentumStrategy
        ? momentumStrategy.evaluate(ctx, windowKey)
        : strategy.evaluate(ctx)
      if (!signal) continue

      const approved = yield* risk.approve(signal, MARKET_ID)
      if (!approved) continue

      const entryPrice = Math.round((signal.side === 'YES' ? ctx.marketYesPrice : ctx.marketNoPrice) * 100) / 100
      approved.price = entryPrice
      approved.sigma = sigma

      yield* Effect.log('Signal detected — executing', {
        strategy: signal.strategy, side: signal.side, edge: signal.edge.toFixed(4),
        fv: (signal.side === 'YES' ? fv.fairValueUp : fv.fairValueDown).toFixed(4),
        marketPrice: entryPrice, btcPrice: currentPrice, refPrice: s.referencePrice,
      })

      const marketConfig: MarketConfig = {
        id: MARKET_ID,
        name: `BTC ${config.windowDurationSec <= 300 ? '5m' : config.windowDurationSec <= 900 ? '15m' : config.windowDurationSec <= 3600 ? '1h' : '1d'} ${s.currentMarket.slug}`,
        yesTokenId: s.currentMarket.yesTokenId,
        noTokenId: s.currentMarket.noTokenId,
        conditionId: s.currentMarket.conditionId,
        referencePrice: s.referencePrice,
        windowDurationSec: WINDOW_SEC,
        tickSize: s.currentMarket.tickSize as TickSize,
        negRisk: s.currentMarket.negRisk,
        minOrderSize: s.currentMarket.minOrderSize,
      }

      // Reserve slot + guard BEFORE async call
      yield* Ref.update(stateRef, st => {
        const openTrades = new Map(st.openTrades)
        openTrades.set(windowKey, {
          side: signal.side,
          entryPrice,
          sizeUsdc: entryPrice * (s.currentMarket!.minOrderSize ?? 5),
          refPrice: s.referencePrice,
          strategy: signal.strategy,
          entryTime: Date.now(),
          edge: signal.edge,
        })
        const buying = new Set(st.buyingInProgress)
        buying.add(windowKey)
        return { ...st, openTrades, buyingInProgress: buying }
      })

      const result = yield* executor.execute(approved, marketConfig)

      if (result.success) {
        const actualShares = result.filledShares ?? (s.currentMarket.minOrderSize ?? 5)
        const actualPrice = result.fillPrice ?? entryPrice

        yield* Ref.update(stateRef, st => {
          const openTrades = new Map(st.openTrades)
          const t = openTrades.get(windowKey)
          if (t) openTrades.set(windowKey, { ...t, entryPrice: actualPrice, sizeUsdc: actualShares * actualPrice })
          const buying = new Set(st.buyingInProgress)
          buying.delete(windowKey)
          const wh = new Map(st.windowTradeHalf)
          wh.set(windowKey, elapsed < WINDOW_SEC / 2 ? 1 : 2)
          return { ...st, openTrades, buyingInProgress: buying, windowTradeHalf: wh, tradeCount: st.tradeCount + 1 }
        })
        yield* risk.openPosition(MARKET_ID)

        stdout(`${tag.trade} ${color.bold(signal.side)} @ ${(actualPrice * 100).toFixed(0)}¢ ${color.yellow('t=' + Math.round(elapsed) + 's')} ${color.dim('│')} edge ${color.green((signal.edge * 100).toFixed(1) + '¢')} ${color.dim('│')} ${color.dim(signal.strategy)} ${color.dim('│')} BTC ${color.bold('$' + currentPrice.toFixed(0))} ${color.dim('│')} ${color.cyan(actualShares.toFixed(1) + ' shares')} ${color.dim('$' + (actualShares * actualPrice).toFixed(2))}`)
        yield* alerts.sendEntryAlert({
          strategy: signal.strategy, side: signal.side, entryPrice: actualPrice,
          edge: signal.edge, btcPrice: currentPrice, signalPrice: entryPrice, fillPrice: actualPrice,
        }).pipe(Effect.catchAll(() => Effect.void))
      } else {
        // Order failed — release slot
        yield* Ref.update(stateRef, st => {
          const openTrades = new Map(st.openTrades)
          openTrades.delete(windowKey)
          const buying = new Set(st.buyingInProgress)
          buying.delete(windowKey)
          return { ...st, openTrades, buyingInProgress: buying }
        })
        stdout(`${color.bgRed(' FAIL ')} ${color.red(String(result.error ?? result.status))}`)
        yield* alerts.sendErrorAlert(`Order failed: ${result.error ?? result.status}\n${signal.side} @ ${(entryPrice * 100).toFixed(0)}¢ · ${signal.strategy}`).pipe(Effect.catchAll(() => Effect.void))
      }

      break // one signal per tick
    }
  })
