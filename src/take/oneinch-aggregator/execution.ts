import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber } from 'ethers';
import { TakerRouter__factory } from '../../../typechain-types/factories/contracts/factories';
import { LiquiditySource } from '../../config';
import { convertWadToTokenDecimals } from '../../erc20';
import { logger } from '../../logging';
import { isNonceConsumedTransactionError } from '../../nonce';
import { getErrorMessage, weiToDecimaled } from '../../utils';
import {
  AggregatorTakerFactory,
  encodeAggregatorSwapDetails,
  getAggregatorFreshQuoteFloorError,
  getAggregatorQuoteAgeError,
  getAggregatorQuoteContextMismatch,
  submitCalldataAggregatorTake,
} from '../aggregator-calldata/execution';
import { approveCalldataAggregatorQuoteForExecution } from '../aggregator-calldata/quote-approval';
import { ApprovedCalldataAggregatorQuote } from '../aggregator-calldata/types';
import { getExternalTakeExecutionPlanPrimaryEvaluation } from '../external-take/execution-plan';
import { getDebtConstrainedTakeCollateralWad } from '../take-sizing';
import {
  ApprovedCalldataAggregatorQuoteEvaluation,
  TakeActionConfig,
  TakeLiquidationPlan,
} from '../types';
import {
  TakeWriteTransport,
  resolveTakeWriteTransport,
} from '../write-transport';
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

function recordOneInchAggregatorPreBroadcastFailure(
  config: OneInchAggregatorExecutionConfig,
  error: string
): void {
  config.onOneInchAggregatorExecutionFailure?.({ preBroadcast: true, error });
}

type OneInchAggregatorPreBroadcastRejection = {
  kind: 'rejected';
  reason: string;
  logError?: boolean;
  quoteResult?: {
    success: boolean;
    retryable?: boolean;
    errorCode?: number | string;
    error?: string;
  };
};

type PreparedOneInchAggregatorExecution =
  | {
      kind: 'dry_run';
      approvedQuoteEvaluation: ApprovedCalldataAggregatorQuoteEvaluation;
    }
  | {
      kind: 'ready';
      approvedQuoteEvaluation: ApprovedCalldataAggregatorQuoteEvaluation;
      freshQuote: ApprovedCalldataAggregatorQuote;
      swapDetails: string;
      executionCollateralWad: BigNumber;
      takeWriteTransport: TakeWriteTransport;
      factory: AggregatorTakerFactory;
      assertFreshQuoteStillCurrent: () => void;
    }
  | OneInchAggregatorPreBroadcastRejection;

function recordPreparedOneInchAggregatorRejection(
  config: OneInchAggregatorExecutionConfig,
  rejection: OneInchAggregatorPreBroadcastRejection
): void {
  if (rejection.logError) {
    logger.error(rejection.reason);
  }
  if (rejection.quoteResult) {
    config.onOneInchAggregatorQuoteResult?.(rejection.quoteResult);
  }
  recordOneInchAggregatorPreBroadcastFailure(config, rejection.reason);
}

async function prepareOneInchAggregatorExecution(params: {
  pool: FungiblePool;
  signer: Signer;
  poolConfig: TakeActionConfig;
  liquidation: TakeLiquidationPlan;
  config: OneInchAggregatorExecutionConfig;
}): Promise<PreparedOneInchAggregatorExecution> {
  const { pool, signer, poolConfig, liquidation, config } = params;
  const executionCollateralWad = getDebtConstrainedTakeCollateralWad({
    collateral: liquidation.collateral,
    auctionPrice: liquidation.auctionPrice,
    debtToCover: liquidation.debtToCover,
  });
  const quoteEvaluation =
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
    ));
  const approval = approveCalldataAggregatorQuoteForExecution({
    quoteEvaluation,
    providerId: 'oneinch',
    poolName: pool.name,
    borrower: liquidation.borrower,
  });
  if (!approval.approved) {
    return { kind: 'rejected', reason: approval.reason, logError: true };
  }
  const contextMismatch = getAggregatorQuoteContextMismatch({
    quoteEvaluation: approval.quoteEvaluation,
    liquidation,
    executionCollateralWad,
    label: ONEINCH_LABEL,
  });
  if (contextMismatch) {
    return { kind: 'rejected', reason: contextMismatch };
  }
  const approvedQuoteEvaluation = approval.quoteEvaluation;
  if (config.dryRun) {
    return { kind: 'dry_run', approvedQuoteEvaluation };
  }

  if (!config.keeperTakerRouter) {
    throw new Error('1inch aggregator execution requires keeperTakerRouter');
  }
  const oneInchAggregatorTaker = config.oneInchAggregatorTaker;
  if (!oneInchAggregatorTaker) {
    throw new Error(
      '1inch aggregator execution requires oneInchAggregatorTaker'
    );
  }
  const chainId = await resolveOneInchAggregatorChainId(config, signer);
  const collateralDecimals = await getOneInchAggregatorTokenDecimals({
    signer,
    tokenAddress: pool.collateralAddress,
    chainId,
    cache: config.tokenDecimalsCache,
  });
  const collateralInTokenDecimals = convertWadToTokenDecimals(
    executionCollateralWad,
    collateralDecimals
  );
  if (collateralInTokenDecimals.isZero()) {
    return {
      kind: 'rejected',
      reason: '1inch collateral rounds to zero in token decimals',
    };
  }

  let freshQuote: ApprovedCalldataAggregatorQuote;
  try {
    freshQuote = await requestValidatedOneInchAggregatorQuote({
      pool,
      signer,
      config,
      takerAddress: oneInchAggregatorTaker,
      chainId,
      collateralInTokenDecimals,
    });
  } catch (error) {
    const failure = getOneInchAggregatorQuoteFailureMetadata(error);
    config.onOneInchAggregatorQuoteResult?.({
      success: false,
      retryable: failure.retryable,
      errorCode: failure.code,
      error: getErrorMessage(error),
    });
    throw error;
  }
  const floorError = getAggregatorFreshQuoteFloorError({
    freshQuote,
    approvedMinOutRaw: approvedQuoteEvaluation.approvedMinOutRaw,
    label: ONEINCH_LABEL,
  });
  if (floorError) {
    return {
      kind: 'rejected',
      reason: floorError,
      quoteResult: { success: false, retryable: false, error: floorError },
    };
  }
  const ageError = getAggregatorQuoteAgeError({
    quote: freshQuote,
    maxQuoteAgeMs: DEFAULT_ONEINCH_AGGREGATOR_MAX_QUOTE_AGE_MS,
    label: ONEINCH_LABEL,
  });
  if (ageError) {
    return {
      kind: 'rejected',
      reason: ageError,
      quoteResult: { success: false, retryable: true, error: ageError },
    };
  }

  return {
    kind: 'ready',
    approvedQuoteEvaluation,
    freshQuote,
    swapDetails: encodeAggregatorSwapDetails({
      quote: freshQuote,
      amountOutMinimum: approvedQuoteEvaluation.approvedMinOutRaw,
    }),
    executionCollateralWad,
    takeWriteTransport: resolveTakeWriteTransport(signer, config),
    factory: TakerRouter__factory.connect(
      config.keeperTakerRouter,
      signer
    ),
    assertFreshQuoteStillCurrent: () => {
      const error = getAggregatorQuoteAgeError({
        quote: freshQuote,
        maxQuoteAgeMs: DEFAULT_ONEINCH_AGGREGATOR_MAX_QUOTE_AGE_MS,
        label: ONEINCH_LABEL,
      });
      if (error) {
        config.onOneInchAggregatorQuoteResult?.({
          success: false,
          retryable: false,
          error,
        });
        throw new Error(error);
      }
    },
  };
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

    await submitCalldataAggregatorTake({
      factory: prepared.factory,
      takeWriteTransport: prepared.takeWriteTransport,
      poolName: pool.name,
      poolAddress: pool.poolAddress,
      borrower,
      auctionPrice: liquidation.auctionPrice,
      executionCollateralWad: prepared.executionCollateralWad,
      liquiditySource: LiquiditySource.ONEINCH,
      providerId: 'oneinch',
      label: ONEINCH_LABEL,
      transactionTarget: prepared.freshQuote.transactionTarget,
      swapDetails: prepared.swapDetails,
      routeProfitability: prepared.approvedQuoteEvaluation.routeProfitability,
      approvedMinOutRaw: prepared.approvedQuoteEvaluation.approvedMinOutRaw,
      assertFreshQuoteStillCurrent: prepared.assertFreshQuoteStillCurrent,
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
