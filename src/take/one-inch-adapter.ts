import { ExternalTakeAdapter } from './engine';
import { bindExternalTakeQuoteToExecutionResult } from './external-take/execution-plan';
import {
  getOneInchTakeQuoteEvaluation,
  takeLiquidation,
} from './one-inch-execution';
import { OneInchExecutionConfig, OneInchQuoteConfig } from './one-inch-types';
import { TakeActionConfig } from './types';

export function createNoExternalTakeAdapter<
  TApprovalContext = unknown,
>(): ExternalTakeAdapter<
  TakeActionConfig,
  OneInchExecutionConfig,
  TApprovalContext
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
      candidate,
      price,
      auctionPrice,
      collateral,
    }) => {
      const quoteEvaluation = await getOneInchTakeQuoteEvaluation(
        pool,
        price,
        collateral,
        poolConfig,
        {
          oneInchRequestTimeoutMs: quoteConfig.oneInchRequestTimeoutMs,
          oneInchRequestAbortSignal: quoteConfig.oneInchRequestAbortSignal,
          oneInchDefaultSlippage: quoteConfig.oneInchDefaultSlippage,
        },
        signer,
        quoteConfig.oneInchRouters,
        quoteConfig.connectorTokens,
        auctionPrice
      );
      return bindExternalTakeQuoteToExecutionResult({
        quoteEvaluation,
        configuredLiquiditySource: poolConfig.take.liquiditySource,
        poolName: pool.name,
        borrower: candidate.borrower,
      });
    },
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
