import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber } from 'ethers';
import { LiquiditySource } from '../../config';
import { getErrorMessage, weiToDecimaled } from '../../utils';
import {
  makeCalldataAggregatorProviderRejectionRecorder,
  prepareCalldataAggregatorExecution,
  takeLiquidationCalldataAggregatorProvider,
} from '../aggregator-calldata/execution';
import { ApprovedCalldataAggregatorQuote } from '../aggregator-calldata/types';
import { getExternalTakeExecutionPlanPrimaryEvaluation } from '../external-take/execution-plan';
import { TakeActionConfig, TakeLiquidationPlan } from '../types';
import { getOneInchAggregatorPathQuoteEvaluation } from './quote-evaluation';
import {
  getOneInchAggregatorQuoteFailureMetadata,
  getOneInchAggregatorTokenDecimals,
  requestValidatedOneInchAggregatorQuote,
  resolveOneInchAggregatorChainId,
} from './quote-service';
import { OneInchAggregatorExecutionConfig } from './types';

const ONEINCH_LABEL = '1inch';
const DEFAULT_ONEINCH_AGGREGATOR_MAX_QUOTE_AGE_MS = 30_000;

async function requestFreshOneInchAggregatorExecutionQuote(params: {
  pool: FungiblePool;
  signer: Signer;
  config: OneInchAggregatorExecutionConfig;
  takerAddress: string;
  chainId: number;
  collateralInTokenDecimals: BigNumber;
}): Promise<ApprovedCalldataAggregatorQuote> {
  try {
    return await requestValidatedOneInchAggregatorQuote({
      pool: params.pool,
      signer: params.signer,
      config: params.config,
      takerAddress: params.takerAddress,
      chainId: params.chainId,
      collateralInTokenDecimals: params.collateralInTokenDecimals,
    });
  } catch (error) {
    const failure = getOneInchAggregatorQuoteFailureMetadata(error);
    params.config.onOneInchAggregatorQuoteResult?.({
      success: false,
      retryable: failure.retryable,
      errorCode: failure.code,
      error: getErrorMessage(error),
    });
    throw error;
  }
}

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
    label: ONEINCH_LABEL,
    missingRouterReason:
      '1inch aggregator execution requires keeperTakerRouter',
    missingTakerReason:
      '1inch aggregator execution requires oneInchAggregatorTaker',
    collateralRoundsToZeroReason:
      '1inch collateral rounds to zero in token decimals',
    getQuoteEvaluation: async ({ executionCollateralWad }) =>
      getExternalTakeExecutionPlanPrimaryEvaluation(
        liquidation.externalTakeExecutionPlan
      ) ??
      (await getOneInchAggregatorPathQuoteEvaluation(
        pool,
        Number(weiToDecimaled(liquidation.auctionPrice)),
        executionCollateralWad,
        poolConfig,
        config,
        signer,
        liquidation.auctionPrice
      )),
    getTakerAddress: (config) => config.oneInchAggregatorTaker,
    resolveChainId: resolveOneInchAggregatorChainId,
    getCollateralTokenDecimals: ({ signer, tokenAddress, chainId, cache }) =>
      getOneInchAggregatorTokenDecimals({
        signer,
        tokenAddress,
        chainId,
        cache,
      }),
    requestFreshQuote: requestFreshOneInchAggregatorExecutionQuote,
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
    liquiditySource: LiquiditySource.ONEINCH,
    label: ONEINCH_LABEL,
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
