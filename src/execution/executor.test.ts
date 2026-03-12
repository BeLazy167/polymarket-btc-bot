import { test, expect, describe, mock } from 'bun:test'
import { LiveExecutor } from './executor.ts'

/**
 * Tests for sell() scenarios — validates all 4 defense layers:
 * A: buy minOrderSize+1 (tested indirectly via execute)
 * B1: trust FAK makingAmount over stale balance
 * B2: GTC at bestBid instead of 1¢
 * B3: sub-minimum stuck returns failure (caller handles no-paper-settle)
 */

// Mock the CLOB client responses for different sell scenarios
function makeMockClient(opts: {
  balance: number
  balanceAfterSell?: number
  fakResponse?: any
  fakThrows?: boolean
  gtcResponse?: any
}) {
  const balanceAfter = opts.balanceAfterSell ?? opts.balance
  let callCount = 0
  return {
    getBalanceAllowance: mock(() => {
      callCount++
      const bal = callCount === 1 ? opts.balance : balanceAfter
      return Promise.resolve({ balance: String(bal * 1e6) })
    }),
    createAndPostMarketOrder: opts.fakThrows
      ? mock(() => Promise.reject(new Error('FAK threw')))
      : mock(() => Promise.resolve(opts.fakResponse ?? { success: true, status: 'matched' })),
    createAndPostOrder: mock(() => Promise.resolve(opts.gtcResponse ?? { success: true })),
    cancelAll: mock(() => Promise.resolve()),
  }
}

// Helper: create a LiveExecutor with mocked client
function makeExecutor(client: any) {
  const executor = Object.create(LiveExecutor.prototype)
  executor.client = client
  return executor
}

describe('sell() — B1: trust FAK response over balance diff', () => {
  test('FAK matched but balance stale → uses makingAmount for sold', async () => {
    const client = makeMockClient({
      balance: 5.96,
      balanceAfterSell: 5.96, // balance never updates (stale)
      fakResponse: {
        success: true,
        orderID: 'test-123',
        status: 'matched',
        makingAmount: '5.96',
        takingAmount: '5.30',
      },
    })
    // Override: after the extra 3s wait, balance finally updates
    let getBalanceCalls = 0
    client.getBalanceAllowance = mock(() => {
      getBalanceCalls++
      // 1st = initial (5.96), 2nd = still stale (5.96), 3rd = finally updated (0)
      const bal = getBalanceCalls <= 2 ? 5.96 : 0
      return Promise.resolve({ balance: String(bal * 1e6) })
    })

    const executor = makeExecutor(client)
    const result = await executor.sell('token-1', 6, '0.01', false, 0.89)

    expect(result.success).toBe(true)
    expect(result.filledShares).toBeGreaterThan(0)
  }, 15_000)

  test('FAK no match, balance unchanged → returns failure', async () => {
    const client = makeMockClient({
      balance: 4.96,
      balanceAfterSell: 4.96, // nothing sold
      fakThrows: true, // FAK threw error
    })

    const executor = makeExecutor(client)
    const result = await executor.sell('token-1', 5, '0.01', false, 0.89)

    expect(result.success).toBe(false)
    expect(result.status).toBe('no-fill')
    expect(result.remaining).toBe(4.96)
  })
})

describe('sell() — B2: GTC at bestBid', () => {
  test('GTC fallback uses bestBid-1¢ instead of 1¢', async () => {
    const client = makeMockClient({
      balance: 6.0,
      balanceAfterSell: 6.0, // FAK fails, GTC needed
      fakResponse: { success: false, errorMsg: 'no match' },
      gtcResponse: { success: true, orderID: 'gtc-1', status: 'matched', takingAmount: '5.28' },
    })
    // After GTC, balance drops
    let calls = 0
    client.getBalanceAllowance = mock(() => {
      calls++
      const bal = calls <= 2 ? 6.0 : 0
      return Promise.resolve({ balance: String(bal * 1e6) })
    })

    const executor = makeExecutor(client)
    await executor.sell('token-1', 6, '0.01', false, 0.89)

    // Verify GTC was called with bestBid-1¢ = 0.88, not 0.01
    const gtcCall = client.createAndPostOrder.mock.calls[0]
    expect(gtcCall[0].price).toBe(0.88)
  })

  test('GTC fallback at 1¢ when no bestBid provided', async () => {
    const client = makeMockClient({
      balance: 6.0,
      balanceAfterSell: 6.0,
      fakResponse: { success: false, errorMsg: 'no match' },
    })

    const executor = makeExecutor(client)
    await executor.sell('token-1', 6, '0.01', false) // no bestBid

    expect(client.createAndPostOrder.mock.calls.length).toBeGreaterThan(0)
    const gtcCall = client.createAndPostOrder.mock.calls[0]
    expect(gtcCall[0].price).toBe(0.01)
  })
})

describe('sell() — B3: sub-minimum positions', () => {
  test('sub-5 remaining with 0 sold → returns failure (not dust-remaining)', async () => {
    const client = makeMockClient({
      balance: 4.96,
      balanceAfterSell: 4.96,
      fakResponse: { success: false, errorMsg: 'no orders found to match' },
    })

    const executor = makeExecutor(client)
    const result = await executor.sell('token-1', 5, '0.01', false)

    expect(result.success).toBe(false)
    expect(result.status).toBe('no-fill')
    // NOT dust-remaining — caller should retry or handle as pending-resolution
  })

  test('sub-5 remaining with partial sold → returns dust-remaining', async () => {
    const client = makeMockClient({
      balance: 6.0,
      balanceAfterSell: 1.5, // sold 4.5, 1.5 remains (sub-min)
      fakResponse: { success: true, status: 'matched', makingAmount: '4.5', takingAmount: '4.0' },
    })

    const executor = makeExecutor(client)
    const result = await executor.sell('token-1', 6, '0.01', false)

    expect(result.success).toBe(true)
    expect(result.status).toBe('dust-remaining')
    expect(result.filledShares).toBe(4.5)
    expect(result.remaining).toBe(1.5)
  })
})

describe('execute() — Layer A: buy minOrderSize+1', () => {
  test('buys 6 shares when minOrderSize is 5', async () => {
    let balCalls = 0
    const client = {
      postHeartbeat: mock(() => Promise.resolve({ heartbeat_id: 'hb-1' })),
      createAndPostOrder: mock(() => Promise.resolve({
        success: true, orderID: 'buy-1', status: 'matched',
        takingAmount: '6', makingAmount: '4.74',
      })),
      // 1st call = pre-fill baseline (0), subsequent = post-fill (6 shares)
      getBalanceAllowance: mock(() => {
        balCalls++
        const bal = balCalls === 1 ? 0 : 6_000_000
        return Promise.resolve({ balance: String(bal) })
      }),
    }

    const executor = makeExecutor(client)
    await executor.execute(
      { side: 'YES', sizeUsdc: 5, strategy: 'test', confidence: 0.8, edge: 0.1, price: 0.79, sigma: 0.3 },
      { name: 'test', yesTokenId: 'yes-1', noTokenId: 'no-1', tickSize: '0.01', minOrderSize: 5, negRisk: false, slug: '', conditionId: '', epoch: 0 },
    )

    // Verify size=6 was sent (minOrderSize 5 + 1)
    const buyCall = client.createAndPostOrder.mock.calls[0]
    expect(buyCall[0].size).toBe(6)
  })
})
