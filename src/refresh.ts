import { Effect, Ref } from 'effect'
import type { BotState } from './state.ts'
import type { Config, TickSize } from './config/schema.ts'
import { getWindowEpoch } from './data/market-discovery.ts'
import { MarketDiscovery } from './data/market-discovery.ts'
import { PolymarketFeed } from './data/polymarket-feed.ts'
import { Executor } from './execution/service.ts'
import { redeemPositions } from './execution/redeem.ts'
import { stdout, color, tag, box } from './monitoring/logger.ts'

export const refreshMarket = (
  stateRef: Ref.Ref<BotState>,
  config: Config,
) =>
  Effect.gen(function* () {
    const s = yield* Ref.get(stateRef)
    if (s.refreshing) return
    if (Date.now() - s.lastFailedRefresh < 10_000) return

    const WINDOW_SEC = config.windowDurationSec
    const newEpoch = getWindowEpoch(Date.now(), WINDOW_SEC)
    if (newEpoch === s.currentEpoch && s.currentMarket) return

    yield* Ref.update(stateRef, st => ({ ...st, refreshing: true }))

    const discovery = yield* MarketDiscovery
    const polyFeed = yield* PolymarketFeed

    const market = yield* discovery.fetchCurrentMarket
    if (!market) {
      yield* Effect.logError('Failed to fetch market from Gamma API')
      yield* Ref.update(stateRef, st => ({ ...st, refreshing: false, lastFailedRefresh: Date.now() }))
      return
    }

    // Re-subscribe Polymarket WS early so orderbook populates during cooldown
    const newIds = [market.yesTokenId, market.noTokenId]
    yield* polyFeed.resubscribe(newIds)

    const cooldownSec = WINDOW_SEC >= 900 ? 30 : 5
    stdout(`${tag.market} ${color.cyan(market.slug)} ${color.dim('│')} cooldown ${color.yellow(cooldownSec + 's')}`)

    // Redeem any resolved positions during cooldown
    if (config.mode === 'live' && s.pendingRedemptions.size > 0) {
      const batch = [...s.pendingRedemptions.entries()]
      yield* Ref.update(stateRef, st => ({ ...st, pendingRedemptions: new Map() }))

      for (const [cid, retries] of batch) {
        const result = yield* redeemPositions(config.polymarket, cid)
        if (result.success) {
          stdout(`${color.green(box.dot)} ${color.green('Redeemed')} ${color.dim(cid.slice(0, 10))}… tx ${color.cyan(result.txHash?.slice(0, 10) + '…')}`)
        } else if (result.error !== 'not-resolved' && retries < 3) {
          yield* Ref.update(stateRef, st => {
            const pr = new Map(st.pendingRedemptions)
            pr.set(cid, retries + 1)
            return { ...st, pendingRedemptions: pr }
          })
        } else if (retries >= 3) {
          yield* Effect.logWarning('Redemption abandoned after max retries', { conditionId: cid, retries })
        }
      }
    }

    yield* Effect.sleep(cooldownSec * 1_000)

    // Fetch ref price AFTER cooldown so API has settled
    const refPrice = yield* discovery.fetchOpenPrice(market.epoch)

    if (!refPrice) {
      stdout(`${tag.warn} Ref price unavailable — skipping window`)
      yield* Ref.update(stateRef, st => ({ ...st, refreshing: false, lastFailedRefresh: Date.now() }))
      return
    }

    stdout(`${tag.market} ${color.cyan(market.slug)} ${color.dim('ref')} ${color.bold('$' + refPrice.toFixed(2))}`)

    // Commit state AFTER sleep so tick loop won't trade during wait
    yield* Ref.update(stateRef, st => ({
      ...st,
      currentMarket: market,
      currentEpoch: newEpoch,
      referencePrice: refPrice,
      refreshing: false,
    }))
    stdout(`${color.dim('─'.repeat(50))}`)
  }).pipe(
    Effect.ensuring(
      Ref.update(stateRef, st => ({ ...st, refreshing: false })),
    ),
  )
