import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber } from 'ethers';
import { LiquiditySource } from '../../config';
import { logger } from '../../logging';
import { isNonceConsumedTransactionError } from '../../nonce';
import { getErrorMessage, weiToDecimaled } from '../../utils';
import {
  CalldataAggregatorPreBroadcastRejection,
  prepareCalldataAggregatorExecution,
  recordCalldataAggregatorPreBroadcastRejection,
  submitPreparedCalldataAggregatorExecution,
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

function recordPreparedOneInchAggregatorRejection(
  config: OneInchAggregatorExecutionConfig,
  rejection: CalldataAggregatorPreBroadcastRejection
): void {
  recordCalldataAggregatorPreBroadcastRejection({
    config,
    rejection,
    onQuoteResult: (config, result) =>
      config.onOneInchAggregatorQuoteResult?.(result),
    onExecutionFailure: (config, result) =>
      config.onOneInchAggregatorExecutionFailure?.(result),
  });
}

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
    missingRouterReason: '1inch aggregator execution requires keeperTakerRouter',
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
    getCollateralTokenDecimals: ({
      signer,
      tokenAddress,
      chainId,
      cache,
    }) =>
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
  const { pool, signer, poolConfig, liquidation, config } = params;
  const { borrower } = liquidation;
  const suppliedQuoteEvaluation = getExternalTakeExecutionPlanPrimaryEvaluation(
    liquidation.externalTakeExecutionPlan
  );
  const usesOneInchAggregatorPath =
    poolConfig.take.liquiditySource === LiquiditySource.ONEINCH ||
    suppliedQuoteEvaluation?.providerId === 'oneinch' ||
    suppliedQuoteEvaluation?.calldataQuote?.providerId === 'oneinch';
  if (!usesOneInchAggregatorPath) {
    logger.error(
      `1inch aggregator liquidity source not configured. Skipping liquidation of poolAddress: ${pool.poolAddress}, borrower: ${borrower}.`
    );
    return false;
  }

  let attemptedSubmission = false;
  try {
    const prepared = await prepareOneInchAggregatorExecution({
      pool,
      signer,
      poolConfig,
      liquidation,
      config,
    });
    if (prepared.kind === 'rejected') {
      recordPreparedOneInchAggregatorRejection(config, prepared);
      return false;
    }
    if (prepared.kind === 'dry_run') {
      logger.info(
        `DryRun - would 1inch Aggregator Take - poolAddress: ${pool.poolAddress}, borrower: ${borrower}, approvedMinOutRaw=${prepared.approvedQuoteEvaluation.approvedMinOutRaw.toString()}`
      );
      return true;
    }

    await submitPreparedCalldataAggregatorExecution({
      pool,
      liquidation,
      prepared,
      liquiditySource: LiquiditySource.ONEINCH,
      providerId: 'oneinch',
      label: ONEINCH_LABEL,
      onQuoteConsumed: () =>
        config.onOneInchAggregatorQuoteResult?.({ success: true }),
      onSubmissionAccepted: () => {
        attemptedSubmission = true;
      },
    });
    return true;
  } catch (error) {
    config.onOneInchAggregatorExecutionFailure?.({
      preBroadcast:
        !attemptedSubmission && !isNonceConsumedTransactionError(error),
      error: getErrorMessage(error),
    });
    logger.error(
      `Failed 1inch Aggregator Take. pool: ${pool.name}, borrower: ${borrower}`,
      error
    );
    return false;
  }
}
