import { Wallet } from '@ethersproject/wallet'
import { JsonRpcProvider } from '@ethersproject/providers'

const POLYGON_RPC = process.env.POLYGON_RPC_URL ?? 'https://polygon-bor-rpc.publicnode.com'
import { Interface } from '@ethersproject/abi'
import { RelayClient, RelayerTxType } from '@polymarket/builder-relayer-client'
import { BuilderConfig } from '@polymarket/builder-signing-sdk'
import { logger } from '../monitoring/logger.ts'

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
export async function redeemPositions(cfg: RedeemCreds, conditionId: string): Promise<{ success: boolean; txHash?: string; error?: string }> {
  try {
    const provider = new JsonRpcProvider(POLYGON_RPC)
    const wallet = new Wallet(cfg.privateKey, provider)
    const builderConfig = new BuilderConfig({
      localBuilderCreds: { key: cfg.apiKey, secret: cfg.apiSecret, passphrase: cfg.apiPassphrase },
    })
    const relayType = cfg.signatureType === 1 ? RelayerTxType.PROXY : RelayerTxType.SAFE
    const relay = new RelayClient(RELAYER_URL, POLYGON_CHAIN_ID, wallet, builderConfig as never, relayType)

    const data = ctfIface.encodeFunctionData('redeemPositions', [
      USDC_E,
      PARENT_COLLECTION_ID,
      conditionId,
      [1, 2],
    ])

    logger.info({ conditionId, wallet: wallet.address, relayType }, 'Attempting gasless CTF redemption')

    const resp = await relay.execute([{ to: CTF_ADDRESS, data, value: '0' }], `Redeem ${conditionId.slice(0, 10)}`)
    const result = await resp.wait()

    const successStates = new Set(['STATE_CONFIRMED', 'STATE_MINED', 'STATE_EXECUTED'])
    if (result && successStates.has(result.state)) {
      logger.info({ txHash: result.transactionHash, conditionId, state: result.state }, 'CTF redemption succeeded')
      return { success: true, txHash: result.transactionHash }
    }

    const state = result?.state ?? 'no-result'
    logger.warn({ conditionId, state, txId: resp.transactionID }, 'CTF redemption did not confirm')
    return { success: false, error: state }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('revert') || msg.includes('no tokens') || msg.includes('not resolved')) {
      logger.debug({ conditionId, err: msg }, 'CTF redemption skipped — market not resolved or no tokens')
      return { success: false, error: 'not-resolved' }
    }
    logger.warn({ conditionId, err }, 'CTF redemption failed')
    return { success: false, error: msg }
  }
}
