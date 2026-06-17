import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { DEFAULT_SUSHI_AGGREGATOR_MAX_QUOTE_AGE_MS } from '../../config/sushi-aggregator-policy';
import {
  prepareCalldataAggregatorExecution,
  takeLiquidationCalldataAggregatorProvider,
} from '../aggregator-calldata/execution';
import { SushiAggregatorExecutionConfig } from './types';
import { getSushiAggregatorPathQuoteEvaluation } from './quote-evaluation';
import {
  getSushiAggregatorQuoteFailureMetadata,
  requestValidatedSushiAggregatorQuote,
  requireSushiAggregatorConfig,
  resolveSushiAggregatorChainId,
} from './quote-service';
import { TakeActionConfig, TakeLiquidationPlan } from '../types';

function getSushiMaxQuoteAgeMs(config: SushiAggregatorExecutionConfig): number {
  return (
    config.sushiAggregator?.maxQuoteAgeMs ??
    DEFAULT_SUSHI_AGGREGATOR_MAX_QUOTE_AGE_MS
  );
}

async function prepareSushiAggregatorExecution(params: {
  pool: FungiblePool;
  signer: Signer;
  poolConfig: TakeActionConfig;
  liquidation: TakeLiquidationPlan;
  config: SushiAggregatorExecutionConfig;
}) {
  const { pool, signer, poolConfig, liquidation, config } = params;
  return prepareCalldataAggregatorExecution({
    pool,
    signer,
    poolConfig,
    liquidation,
    config,
    providerId: 'sushi_aggregator',
    missingRouterReason:
      'Sushi aggregator execution requires keeperTakerRouter',
    missingTakerReason:
      'Sushi aggregator execution requires sushiAggregatorTaker',
    collateralRoundsToZeroReason:
      'Sushi aggregator collateral rounds to zero in token decimals',
    getPathQuoteEvaluation: getSushiAggregatorPathQuoteEvaluation,
    getTakerAddress: (config) => config.sushiAggregatorTaker,
    resolveChainId: resolveSushiAggregatorChainId,
    requestValidatedQuote: async ({
      pool,
      config,
      takerAddress,
      chainId,
      collateralInTokenDecimals,
    }) => {
      const sushiConfig = requireSushiAggregatorConfig(config.sushiAggregator);
      return await requestValidatedSushiAggregatorQuote({
        pool,
        sushiConfig,
        takerAddress,
        chainId,
        collateralInTokenDecimals,
        signal: config.sushiAggregatorRequestAbortSignal,
      });
    },
    getFailureMetadata: getSushiAggregatorQuoteFailureMetadata,
    getMaxQuoteAgeMs: getSushiMaxQuoteAgeMs,
  });
}

export async function takeLiquidationSushiAggregator(params: {
  pool: FungiblePool;
  signer: Signer;
  poolConfig: TakeActionConfig;
  liquidation: TakeLiquidationPlan;
  config: SushiAggregatorExecutionConfig;
}): Promise<boolean> {
  return await takeLiquidationCalldataAggregatorProvider({
    ...params,
    providerId: 'sushi_aggregator',
    prepareExecution: prepareSushiAggregatorExecution,
  });
}
