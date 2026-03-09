import { ClobClient, Chain, OrderType, Side as PolySide } from '@polymarket/clob-client'
import { Wallet } from '@ethersproject/wallet'
import type { Config, MarketConfig } from '../config/schema.ts'
import type { ApprovedOrder } from '../risk/manager.ts'
import { logger } from '../monitoring/logger.ts'

export interface ExecutionResult {
  success: boolean
  orderId?: string
  status?: string
  error?: string
}

export interface Executor {
  execute(order: ApprovedOrder, market: MarketConfig): Promise<ExecutionResult>
}

export class LiveExecutor implements Executor {
  private client: ClobClient

  constructor(config: Config) {
    const wallet = new Wallet(config.polymarket.privateKey)
    this.client = new ClobClient(
      'https://clob.polymarket.com',
      Chain.POLYGON,
      wallet,
      {
        key: config.polymarket.apiKey,
        secret: config.polymarket.apiSecret,
        passphrase: config.polymarket.apiPassphrase,
      },
      config.polymarket.signatureType,
      config.polymarket.funderAddress || undefined,
    )
  }

  async execute(order: ApprovedOrder, market: MarketConfig): Promise<ExecutionResult> {
    const tokenId = order.side === 'YES' ? market.yesTokenId : market.noTokenId

    logger.info({
      strategy: order.strategy,
      side: order.side,
      size: order.sizeUsdc,
      edge: order.edge,
      market: market.name,
    }, 'Executing live order')

    try {
      const response = await this.client.createAndPostMarketOrder(
        {
          tokenID: tokenId,
          amount: order.sizeUsdc,
          side: PolySide.BUY,
        },
        { tickSize: market.tickSize as "0.1" | "0.01" | "0.001" | "0.0001" },
        OrderType.FOK,
      )

      const result: ExecutionResult = {
        success: response.success ?? false,
        orderId: response.orderID,
        status: response.status,
      }

      logger.info({ result, market: market.name }, 'Order result')
      return result
    } catch (err) {
      logger.error({ err, market: market.name }, 'Order execution threw')
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}
