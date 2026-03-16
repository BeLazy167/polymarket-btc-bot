import { Effect } from 'effect'
import { Wallet } from '@ethersproject/wallet'
import { Interface } from '@ethersproject/abi'
import { RelayClient, RelayerTxType } from '@polymarket/builder-relayer-client'
import { BuilderConfig } from '@polymarket/builder-signing-sdk'
import { RedemptionError } from '../errors.ts'

const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045'
const USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'
const PARENT_COLLECTION_ID = '0x0000000000000000000000000000000000000000000000000000000000000000'
const RELAYER_URL = 'https://relayer-v2.polymarket.com'
const POLYGON_CHAIN_ID = 137

const ctfIface = new Interface([
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
])

interface RedeemCreds {
  privateKey: string
  apiKey: string
  apiSecret: string
  apiPassphrase: string
  signatureType: number
}

/**
 * Redeems winning conditional tokens for USDC.e via Polymarket's gasless relayer.
 * Calls CTF redeemPositions with indexSets [1, 2] to cover both YES/NO outcomes.
 * Uses PROXY relay for signatureType=1 (magic/email), SAFE for signatureType=0.
 */
export const redeemPositions = (cfg: RedeemCreds, conditionId: string): Effect.Effect<{ success: boolean; txHash?: string; error?: string }, RedemptionError> =>
  Effect.gen(function* () {
    const wallet = new Wallet(cfg.privateKey)
    const builderConfig = new BuilderConfig({
      localBuilderCreds: { key: cfg.apiKey, secret: cfg.apiSecret, passphrase: cfg.apiPassphrase },
    })
    const relayType = cfg.signatureType === 1 ? RelayerTxType.PROXY : RelayerTxType.SAFE
    // BuilderConfig from builder-signing-sdk vs clob-client's nested copy — same shape, different declarations
    const relay = new RelayClient(RELAYER_URL, POLYGON_CHAIN_ID, wallet, builderConfig as never, relayType)

    const data = ctfIface.encodeFunctionData('redeemPositions', [
      USDC_E,
      PARENT_COLLECTION_ID,
      conditionId,
      [1, 2],
    ])

    yield* Effect.log('Attempting gasless CTF redemption', { conditionId, wallet: wallet.address, relayType })

    const resp = yield* Effect.tryPromise({
      try: () => relay.execute([{ to: CTF_ADDRESS, data, value: '0' }], `Redeem ${conditionId.slice(0, 10)}`),
      catch: (e) => new RedemptionError({ message: e instanceof Error ? e.message : String(e), conditionId }),
    })

    const result = yield* Effect.tryPromise({
      try: () => resp.wait(),
      catch: (e) => new RedemptionError({ message: `wait() failed: ${e}`, conditionId }),
    })

    const successStates = new Set(['STATE_CONFIRMED', 'STATE_MINED', 'STATE_EXECUTED'])
    if (result && successStates.has(result.state)) {
      yield* Effect.log('CTF redemption succeeded', { txHash: result.transactionHash, conditionId, state: result.state })
      return { success: true, txHash: result.transactionHash }
    }

    const state = result?.state ?? 'no-result'
    yield* Effect.logWarning('CTF redemption did not confirm', { conditionId, state, txId: resp.transactionID })
    return { success: false, error: state }
  }).pipe(
    Effect.catchTag('RedemptionError', (e) => {
      const msg = e.message
      if (msg.includes('revert') || msg.includes('no tokens') || msg.includes('not resolved')) {
        return Effect.gen(function* () {
          yield* Effect.logDebug('CTF redemption skipped — market not resolved or no tokens', { conditionId, err: msg })
          return { success: false, error: 'not-resolved' }
        })
      }
      return Effect.gen(function* () {
        yield* Effect.logWarning('CTF redemption failed', { conditionId, err: msg })
        return { success: false, error: msg }
      })
    }),
  )
