import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber } from 'ethers';
import { LiquiditySource } from '../../config';
import { DEFAULT_SUSHI_AGGREGATOR_MAX_QUOTE_AGE_MS } from '../../config/sushi-aggregator-policy';
import { getErrorMessage, weiToDecimaled } from '../../utils';
import {
  CalldataAggregatorPreBroadcastRejection,
  prepareCalldataAggregatorExecution,
  recordCalldataAggregatorPreBroadcastRejection,
  takeLiquidationCalldataAggregatorProvider,
} from '../aggregator-calldata/execution';
import { ApprovedCalldataAggregatorQuote } from '../aggregator-calldata/types';
import { getExternalTakeExecutionPlanPrimaryEvaluation } from '../external-take/execution-plan';
import { SushiAggregatorExecutionConfig } from './types';
import { getSushiAggregatorPathQuoteEvaluation } from './quote-evaluation';
import {
  getSushiAggregatorQuoteFailureMetadata,
  getSushiAggregatorTokenDecimals,
  requestValidatedSushiAggregatorQuote,
  requireSushiAggregatorConfig,
  resolveSushiAggregatorChainId,
} from './quote-service';
import { TakeActionConfig, TakeLiquidationPlan } from '../types';

const SUSHI_LABEL = 'Sushi Aggregator';

function getSushiMaxQuoteAgeMs(config: SushiAggregatorExecutionConfig): number {
  return (
    config.sushiAggregator?.maxQuoteAgeMs ??
    DEFAULT_SUSHI_AGGREGATOR_MAX_QUOTE_AGE_MS
  );
}

function recordPreparedSushiRejection(
  config: SushiAggregatorExecutionConfig,
  rejection: CalldataAggregatorPreBroadcastRejection
): void {
  recordCalldataAggregatorPreBroadcastRejection({
    config,
    rejection,
    onQuoteResult: (config, result) =>
      config.onSushiAggregatorQuoteResult?.(result),
    onExecutionFailure: (config, result) =>
      config.onSushiAggregatorExecutionFailure?.(result),
  });
}

async function requestFreshSushiAggregatorExecutionQuote(params: {
  pool: FungiblePool;
  config: SushiAggregatorExecutionConfig;
  takerAddress: string;
  chainId: number;
  collateralInTokenDecimals: BigNumber;
}): Promise<ApprovedCalldataAggregatorQuote> {
  try {
    const sushiConfig = requireSushiAggregatorConfig(
      params.config.sushiAggregator
    );
    return await requestValidatedSushiAggregatorQuote({
      pool: params.pool,
      sushiConfig,
      takerAddress: params.takerAddress,
      chainId: params.chainId,
      collateralInTokenDecimals: params.collateralInTokenDecimals,
      signal: params.config.sushiAggregatorRequestAbortSignal,
    });
  } catch (error) {
    const failure = getSushiAggregatorQuoteFailureMetadata(error);
    params.config.onSushiAggregatorQuoteResult?.({
      success: false,
      retryable: failure.retryable,
      errorCode: failure.code,
      error: getErrorMessage(error),
    });
    throw error;
  }
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
    label: SUSHI_LABEL,
    missingRouterReason:
      'Sushi aggregator execution requires keeperTakerRouter',
    missingTakerReason:
      'Sushi aggregator execution requires sushiAggregatorTaker',
    collateralRoundsToZeroReason:
      'Sushi aggregator collateral rounds to zero in token decimals',
    getQuoteEvaluation: async ({ executionCollateralWad }) =>
      getExternalTakeExecutionPlanPrimaryEvaluation(
        liquidation.externalTakeExecutionPlan
      ) ??
      (await getSushiAggregatorPathQuoteEvaluation(
        pool,
        Number(weiToDecimaled(liquidation.auctionPrice)),
        executionCollateralWad,
        poolConfig,
        config,
        signer,
        liquidation.auctionPrice
      )),
    getTakerAddress: (config) => config.sushiAggregatorTaker,
    resolveChainId: resolveSushiAggregatorChainId,
    getCollateralTokenDecimals: ({ signer, tokenAddress, chainId, cache }) =>
      getSushiAggregatorTokenDecimals({
        signer,
        tokenAddress,
        chainId,
        cache,
      }),
    requestFreshQuote: requestFreshSushiAggregatorExecutionQuote,
    getMaxQuoteAgeMs: getSushiMaxQuoteAgeMs,
    onQuoteResult: (config, result) =>
      config.onSushiAggregatorQuoteResult?.(result),
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
    liquiditySource: LiquiditySource.SUSHI_AGGREGATOR,
    label: SUSHI_LABEL,
    prepareExecution: prepareSushiAggregatorExecution,
    recordPreparedRejection: recordPreparedSushiRejection,
    onQuoteConsumed: (config) =>
      config.onSushiAggregatorQuoteResult?.({ success: true }),
    onExecutionFailure: (config, result) =>
      config.onSushiAggregatorExecutionFailure?.(result),
  });
}
