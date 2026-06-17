import { FungiblePool, Signer } from '@ajna-finance/sdk';
import {
  makeCalldataAggregatorProviderRejectionRecorder,
  prepareCalldataAggregatorExecution,
  takeLiquidationCalldataAggregatorProvider,
} from '../aggregator-calldata/execution';
import { TakeActionConfig, TakeLiquidationPlan } from '../types';
import { getOneInchAggregatorPathQuoteEvaluation } from './quote-evaluation';
import {
  getOneInchAggregatorQuoteFailureMetadata,
  requestValidatedOneInchAggregatorQuote,
  resolveOneInchAggregatorChainId,
} from './quote-service';
import { OneInchAggregatorExecutionConfig } from './types';

const DEFAULT_ONEINCH_AGGREGATOR_MAX_QUOTE_AGE_MS = 30_000;

async function prepareOneInchAggregatorExecution(params: {
  pool: FungiblePool;
  signer: Signer;
  poolConfig: TakeActionConfig;
  liquidation: TakeLiquidationPlan;
  config: OneInchAggregatorExecutionConfig;
}) {
  const { pool, signer, poolConfig, liquidation, config } = params;
  return prepareCalldataAggregatorExecution({
    pool,
    signer,
    poolConfig,
    liquidation,
    config,
    providerId: 'oneinch',
    missingRouterReason:
      '1inch aggregator execution requires keeperTakerRouter',
    missingTakerReason:
      '1inch aggregator execution requires oneInchAggregatorTaker',
    collateralRoundsToZeroReason:
      '1inch collateral rounds to zero in token decimals',
    getPathQuoteEvaluation: getOneInchAggregatorPathQuoteEvaluation,
    getTakerAddress: (config) => config.oneInchAggregatorTaker,
    resolveChainId: resolveOneInchAggregatorChainId,
    requestValidatedQuote: async ({
      pool,
      signer,
      config,
      takerAddress,
      chainId,
      collateralInTokenDecimals,
    }) =>
      await requestValidatedOneInchAggregatorQuote({
        pool,
        signer,
        config,
        takerAddress,
        chainId,
        collateralInTokenDecimals,
      }),
    getFailureMetadata: getOneInchAggregatorQuoteFailureMetadata,
    getMaxQuoteAgeMs: () => DEFAULT_ONEINCH_AGGREGATOR_MAX_QUOTE_AGE_MS,
    onQuoteResult: (config, result) =>
      config.onOneInchAggregatorQuoteResult?.(result),
  });
}

export async function takeLiquidationOneInchAggregator(params: {
  pool: FungiblePool;
  signer: Signer;
  poolConfig: TakeActionConfig;
  liquidation: TakeLiquidationPlan;
  config: OneInchAggregatorExecutionConfig;
}): Promise<boolean> {
  return await takeLiquidationCalldataAggregatorProvider({
    ...params,
    providerId: 'oneinch',
    prepareExecution: prepareOneInchAggregatorExecution,
    recordPreparedRejection:
      makeCalldataAggregatorProviderRejectionRecorder<OneInchAggregatorExecutionConfig>(
        {
          onQuoteResult: (c, r) => c.onOneInchAggregatorQuoteResult?.(r),
          onExecutionFailure: (c, r) =>
            c.onOneInchAggregatorExecutionFailure?.(r),
        }
      ),
    onQuoteConsumed: (config) =>
      config.onOneInchAggregatorQuoteResult?.({ success: true }),
    onExecutionFailure: (config, result) =>
      config.onOneInchAggregatorExecutionFailure?.(result),
  });
}
