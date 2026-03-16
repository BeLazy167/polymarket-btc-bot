import { Effect, Ref } from 'effect'
import type { BotState } from './state.ts'
import type { PriceStore } from './data/price-store.ts'
import { ewmaVariance, garchVariance } from './models/math.ts'
import type { Config } from './config/schema.ts'

/**
 * Handles a price tick: updates lastPrice, downsamples to 1-min vol updates,
 * records in PriceStore, and tracks momentum minute prices.
 */
export const handlePriceTick = (
  stateRef: Ref.Ref<BotState>,
  priceStore: PriceStore,
  config: Config,
  price: number,
  timestamp: number,
) =>
  Ref.update(stateRef, (s) => {
    const next = { ...s, lastPrice: price, lastPriceTimestamp: Date.now() }

    // Downsample: only update vol models + PriceStore once per minute
    const currentMinute = Math.floor(timestamp / 60_000)
    const lastMinute = Math.floor(s.vol.lastMinuteTimestamp / 60_000)

    if (currentMinute > lastMinute && s.vol.lastMinutePrice > 0) {
      const logReturn = Math.log(price / s.vol.lastMinutePrice)
      next.vol = {
        ewmaVar: ewmaVariance(s.vol.ewmaVar, logReturn, config.models.ewmaLambda),
        garchVar: garchVariance(s.vol.garchVar, s.vol.prevReturn, config.models.garchOmega, config.models.garchAlpha, config.models.garchBeta),
        prevReturn: logReturn,
        lastMinutePrice: price,
        lastMinuteTimestamp: timestamp,
      }
      priceStore.addPrice(price, timestamp)
    } else if (s.vol.lastMinutePrice === 0) {
      next.vol = { ...s.vol, lastMinutePrice: price, lastMinuteTimestamp: timestamp }
      priceStore.addPrice(price, timestamp)
    } else if (currentMinute > lastMinute) {
      next.vol = { ...s.vol, lastMinutePrice: price, lastMinuteTimestamp: timestamp }
    }

    // Track minute prices for momentum strategy
    if (s.currentMarket) {
      const windowKey = `${config.windowDurationSec <= 300 ? 'btc-5m' : config.windowDurationSec <= 900 ? 'btc-15m' : config.windowDurationSec <= 3600 ? 'btc-1h' : 'btc-1d'}-${s.currentMarket.epoch}`
      const cm = Math.floor(Date.now() / 60_000)
      const lm = s.momentumLastMinute.get(windowKey)

      if (lm !== cm) {
        const newPrices = new Map(s.momentumPrices)
        const existing = newPrices.get(windowKey) ?? []
        newPrices.set(windowKey, [...existing, price])

        // Cleanup old windows (keep max 3)
        if (newPrices.size > 3) {
          const oldest = newPrices.keys().next().value!
          newPrices.delete(oldest)
        }

        const newLastMinute = new Map(s.momentumLastMinute)
        newLastMinute.set(windowKey, cm)
        if (newLastMinute.size > 3) {
          const oldest = newLastMinute.keys().next().value!
          newLastMinute.delete(oldest)
        }

        next.momentumPrices = newPrices
        next.momentumLastMinute = newLastMinute
      }
    }

    return next
  })
