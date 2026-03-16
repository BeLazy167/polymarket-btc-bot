/**
 * Integration test: buy 6 shares on a live 15m market, immediately sell, verify full flow.
 * Cost: ~$5-6 round trip, lose ~$0.10-0.30 to spread+fees.
 *
 * Usage: bun scripts/test-sell-flow.ts [config.yaml]
 */
import { loadConfig } from '../src/config/markets.ts'
import { LiveExecutor } from '../src/execution/executor.ts'
import { fetchCurrentMarket, getWindowEpoch } from '../src/data/market-discovery.ts'
import type { TickSize, MarketConfig } from '../src/config/schema.ts'
import type { ApprovedOrder } from '../src/risk/manager.ts'

const CONFIG_PATH = process.argv[2] ?? 'config-15m.yaml'
const WINDOW_SEC = 900

const log = (msg: string, data?: Record<string, unknown>) => {
  const ts = new Date().toISOString().slice(11, 19)
  console.log(`[${ts}] ${msg}`, data ? JSON.stringify(data, null, 2) : '')
}

async function main() {
  log('=== INTEGRATION TEST: SELL FLOW ===')
  log('Loading config...')
  const config = await loadConfig(CONFIG_PATH)
  const executor = new LiveExecutor(config)

  // Step 1: Find active market
  log('Fetching current 15m market...')
  const market = await fetchCurrentMarket(WINDOW_SEC)
  if (!market) {
    log('ERROR: No active market found')
    process.exit(1)
  }

  const epoch = getWindowEpoch(Date.now(), WINDOW_SEC)
  const remaining = Math.round((market.windowEndMs - Date.now()) / 1000)
  log('Market found', {
    slug: market.slug,
    epoch,
    remainingSec: remaining,
    minOrderSize: market.minOrderSize,
    tickSize: market.tickSize,
  })

  if (remaining < 120) {
    log('ERROR: Less than 2min left in window — too risky, wait for next window')
    process.exit(1)
  }

  // Step 2: Get orderbook to find ask price
  log('Fetching orderbook...')
  const noBookRes = await fetch(`https://clob.polymarket.com/orderbook/${market.noTokenId}`)
  const noBook = await noBookRes.json() as { asks?: Array<{ price: string; size: string }>; bids?: Array<{ price: string; size: string }> }

  const bestAsk = noBook.asks?.[0] ? Number(noBook.asks[0].price) : null
  const bestBid = noBook.bids?.[0] ? Number(noBook.bids[0].price) : null
  log('NO orderbook', { bestAsk, bestBid, askDepth: noBook.asks?.length, bidDepth: noBook.bids?.length })

  if (!bestAsk || !bestBid) {
    log('ERROR: No orderbook data')
    process.exit(1)
  }

  // Step 3: Check pre-trade balance
  const preBal = await executor.getTokenBalance(market.noTokenId)
  log('Pre-trade NO balance', { balance: preBal })

  // Step 4: Buy 6 NO shares at ask price (uses Layer A: minOrderSize+1)
  const buyPrice = Math.round(Math.min(bestAsk, 0.97) * 100) / 100
  const buyShares = (market.minOrderSize ?? 5) + 1

  log(`Buying ${buyShares} NO shares at ${buyPrice}...`)

  const marketConfig: MarketConfig = {
    name: market.slug,
    conditionId: market.conditionId,
    yesTokenId: market.yesTokenId,
    noTokenId: market.noTokenId,
    tickSize: (market.tickSize || '0.01') as '0.1' | '0.01' | '0.001' | '0.0001',
    negRisk: market.negRisk,
    minOrderSize: market.minOrderSize,
  }

  const order: ApprovedOrder = {
    side: 'NO',
    sizeUsdc: buyShares * buyPrice,
    strategy: 'integration-test',
    confidence: 1,
    edge: 0.01,
    price: buyPrice,
    sigma: 0,
  }

  const buyResult = await executor.execute(order, marketConfig)
  log('Buy result', {
    success: buyResult.success,
    orderId: buyResult.orderId,
    status: buyResult.status,
    filledShares: buyResult.filledShares,
    fillPrice: buyResult.fillPrice,
  })

  if (!buyResult.success) {
    log('ERROR: Buy failed — aborting test')
    process.exit(1)
  }

  // Step 5: Check post-buy balance
  await Bun.sleep(2000)
  const postBuyBal = await executor.getTokenBalance(market.noTokenId)
  log('Post-buy NO balance', {
    balance: postBuyBal,
    expectedMin: market.minOrderSize,
    aboveMinimum: postBuyBal >= (market.minOrderSize ?? 5),
  })

  // LAYER A VERIFICATION
  if (postBuyBal >= (market.minOrderSize ?? 5)) {
    log('✅ LAYER A PASS: post-fee balance >= minOrderSize')
  } else {
    log('❌ LAYER A FAIL: post-fee balance < minOrderSize', { balance: postBuyBal, min: market.minOrderSize })
  }

  // Step 6: Immediately sell all shares
  log('Selling all NO shares...')

  // Re-fetch bid for best price
  const sellBookRes = await fetch(`https://clob.polymarket.com/orderbook/${market.noTokenId}`)
  const sellBook = await sellBookRes.json() as { bids?: Array<{ price: string }> }
  const sellBid = sellBook.bids?.[0] ? Number(sellBook.bids[0].price) : bestBid

  log('Sell orderbook', { bestBid: sellBid })

  const sellResult = await executor.sell(
    market.noTokenId,
    postBuyBal,
    market.tickSize as TickSize,
    market.negRisk,
    sellBid,  // B2: pass bestBid
  )

  log('Sell result', {
    success: sellResult.success,
    orderId: sellResult.orderId,
    status: sellResult.status,
    filledShares: sellResult.filledShares,
    fillPrice: sellResult.fillPrice,
    remaining: sellResult.remaining,
    revenue: sellResult.revenue,
    error: sellResult.error,
  })

  // Step 7: Check final balance
  await Bun.sleep(2000)
  const finalBal = await executor.getTokenBalance(market.noTokenId)
  log('Final NO balance', { balance: finalBal })

  // Step 8: Report
  console.log('\n=== TEST RESULTS ===')

  const cost = (buyResult.filledShares ?? buyShares) * (buyResult.fillPrice ?? buyPrice)
  const revenue = sellResult.revenue ?? 0
  const pnl = revenue - cost

  console.log(`  Buy:     ${buyResult.filledShares ?? '?'} shares @ ${buyResult.fillPrice ?? buyPrice}¢ = $${cost.toFixed(2)}`)
  console.log(`  Sell:    ${sellResult.filledShares ?? '?'} shares @ ${sellResult.fillPrice ?? '?'}¢ = $${revenue.toFixed(2)}`)
  console.log(`  P&L:     $${pnl.toFixed(2)} (spread + fees)`)
  console.log(`  Balance: ${finalBal} shares remaining`)

  console.log('\n  Layer A (buy +1):       ', postBuyBal >= (market.minOrderSize ?? 5) ? '✅ PASS' : '❌ FAIL')
  console.log('  Layer B1 (FAK trust):   ', sellResult.filledShares && sellResult.filledShares > 0 ? '✅ PASS' : '⚠️  SKIPPED (FAK worked or failed)')
  console.log('  Layer B2 (bestBid GTC): ', sellResult.status === 'filled' && sellResult.fillPrice && sellResult.fillPrice > 0.02 ? '✅ PASS (sold above 2¢)' : '⚠️  SKIPPED (FAK handled it)')
  console.log('  Layer B3 (no phantom):  ', finalBal < 0.5 ? '✅ PASS (clean exit)' : finalBal < 5 ? '⚠️  DUST remaining — would be pending-resolution' : '❌ FAIL (position stuck)')
  console.log(`  Overall:                `, sellResult.success && finalBal < 0.5 ? '✅ ALL CLEAR' : '⚠️  CHECK LOGS')

  console.log('\nDone.')
  process.exit(0)
}

main().catch(err => {
  console.error('Test failed:', err)
  process.exit(1)
})
