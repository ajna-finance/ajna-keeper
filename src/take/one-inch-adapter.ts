import { ExternalTakeAdapter } from './engine';
import {
  getOneInchTakeQuoteEvaluation,
  takeLiquidation,
} from './one-inch-execution';
import { OneInchExecutionConfig, OneInchQuoteConfig } from './one-inch-types';
import { TakeActionConfig } from './types';

export function createNoExternalTakeAdapter(): ExternalTakeAdapter<
  TakeActionConfig,
  OneInchExecutionConfig
> {
  return {
    kind: 'none',
  };
}

export function createOneInchTakeAdapter(
  quoteConfig: OneInchQuoteConfig
): ExternalTakeAdapter<TakeActionConfig, OneInchExecutionConfig> {
  return {
    kind: 'oneinch',
    evaluateExternalTake: async ({
      pool,
      signer,
      poolConfig,
      price,
      auctionPrice,
      collateral,
    }) =>
      getOneInchTakeQuoteEvaluation(
        pool,
        price,
        collateral,
        poolConfig,
        {
          delayBetweenActions: quoteConfig.delayBetweenActions,
          oneInchRequestTimeoutMs: quoteConfig.oneInchRequestTimeoutMs,
          skipOneInchRateLimitDelay: quoteConfig.skipOneInchRateLimitDelay,
        },
        signer,
        quoteConfig.oneInchRouters,
        quoteConfig.connectorTokens,
        auctionPrice
      ),
    executeExternalTake: async ({
      pool,
      signer,
      poolConfig,
      liquidation,
      config,
    }) =>
      takeLiquidation({
        pool,
        signer,
        poolConfig,
        liquidation,
        config,
      }),
  };
}
