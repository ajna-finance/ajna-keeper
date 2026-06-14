import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber } from 'ethers';
import { AjnaKeeperTakerFactory__factory } from '../../../typechain-types/factories/contracts/factories';
import { LiquiditySource } from '../../config';
import {
  DEFAULT_SUSHI_AGGREGATOR_MAX_QUOTE_AGE_MS,
} from '../../config/sushi-aggregator-policy';
import { convertWadToTokenDecimals } from '../../erc20';
import { logger } from '../../logging';
import { isNonceConsumedTransactionError } from '../../nonce';
import { getErrorMessage, weiToDecimaled } from '../../utils';
import { approveCalldataAggregatorQuoteForExecution } from '../aggregator-calldata/quote-approval';
import {
  AggregatorTakerFactory,
  encodeAggregatorSwapDetails,
  getAggregatorFreshQuoteFloorError,
  getAggregatorQuoteAgeError,
  getAggregatorQuoteContextMismatch,
  submitCalldataAggregatorTake,
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
import {
  ApprovedCalldataAggregatorQuoteEvaluation,
  TakeActionConfig,
  TakeLiquidationPlan,
} from '../types';
import {
  TakeWriteTransport,
  resolveTakeWriteTransport,
} from '../write-transport';
import { getDebtConstrainedTakeCollateralWad } from '../take-sizing';

const SUSHI_LABEL = 'Sushi Aggregator';

function recordSushiPreBroadcastFailure(
  config: SushiAggregatorExecutionConfig,
  error: string
): void {
  config.onSushiAggregatorExecutionFailure?.({ preBroadcast: true, error });
}

function getSushiMaxQuoteAgeMs(
  config: SushiAggregatorExecutionConfig
): number {
  return (
    config.sushiAggregator?.maxQuoteAgeMs ??
    DEFAULT_SUSHI_AGGREGATOR_MAX_QUOTE_AGE_MS
  );
}

type SushiPreBroadcastRejection = {
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

type PreparedSushiExecution =
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
  | SushiPreBroadcastRejection;

function recordPreparedSushiRejection(
  config: SushiAggregatorExecutionConfig,
  rejection: SushiPreBroadcastRejection
): void {
  if (rejection.logError) {
    logger.error(rejection.reason);
  }
  if (rejection.quoteResult) {
    config.onSushiAggregatorQuoteResult?.(rejection.quoteResult);
  }
  recordSushiPreBroadcastFailure(config, rejection.reason);
}

async function prepareSushiAggregatorExecution(params: {
  pool: FungiblePool;
  signer: Signer;
  poolConfig: TakeActionConfig;
  liquidation: TakeLiquidationPlan;
  config: SushiAggregatorExecutionConfig;
}): Promise<PreparedSushiExecution> {
  const { pool, signer, poolConfig, liquidation, config } = params;
  // Sushi calldata cannot be re-sized on-chain: quote and take exactly the
  // debt-clamped size so the strict on-chain balance check passes.
  const executionCollateralWad = getDebtConstrainedTakeCollateralWad({
    collateral: liquidation.collateral,
    auctionPrice: liquidation.auctionPrice,
    debtToCover: liquidation.debtToCover,
  });
  const quoteEvaluation =
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
    ));
  const approval = approveCalldataAggregatorQuoteForExecution({
    quoteEvaluation,
    providerId: 'sushi_aggregator',
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
    label: SUSHI_LABEL,
  });
  if (contextMismatch) {
    return { kind: 'rejected', reason: contextMismatch };
  }
  const approvedQuoteEvaluation = approval.quoteEvaluation;
  if (config.dryRun) {
    return { kind: 'dry_run', approvedQuoteEvaluation };
  }

  if (!config.keeperTakerFactory) {
    throw new Error('Sushi aggregator execution requires keeperTakerFactory');
  }
  const sushiConfig = requireSushiAggregatorConfig(config.sushiAggregator);
  const sushiTaker = config.sushiAggregatorTaker;
  if (!sushiTaker) {
    throw new Error('Sushi aggregator execution requires sushiAggregatorTaker');
  }
  const chainId = await resolveSushiAggregatorChainId(config, signer);
  const collateralDecimals = await getSushiAggregatorTokenDecimals({
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
      reason: 'Sushi aggregator collateral rounds to zero in token decimals',
    };
  }

  let freshQuote: ApprovedCalldataAggregatorQuote;
  try {
    freshQuote = await requestValidatedSushiAggregatorQuote({
      pool,
      sushiConfig,
      takerAddress: sushiTaker,
      chainId,
      collateralInTokenDecimals,
      signal: config.sushiAggregatorRequestAbortSignal,
    });
  } catch (error) {
    const failure = getSushiAggregatorQuoteFailureMetadata(error);
    config.onSushiAggregatorQuoteResult?.({
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
    label: SUSHI_LABEL,
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
    maxQuoteAgeMs: getSushiMaxQuoteAgeMs(config),
    label: SUSHI_LABEL,
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
    factory: AjnaKeeperTakerFactory__factory.connect(
      config.keeperTakerFactory,
      signer
    ),
    assertFreshQuoteStillCurrent: () => {
      const error = getAggregatorQuoteAgeError({
        quote: freshQuote,
        maxQuoteAgeMs: getSushiMaxQuoteAgeMs(config),
        label: SUSHI_LABEL,
      });
      if (error) {
        // Local nonce-queue latency, not a provider health signal.
        config.onSushiAggregatorQuoteResult?.({
          success: false,
          retryable: false,
          error,
        });
        throw new Error(error);
      }
    },
  };
}

export async function takeLiquidationSushiAggregator(params: {
  pool: FungiblePool;
  signer: Signer;
  poolConfig: TakeActionConfig;
  liquidation: TakeLiquidationPlan;
  config: SushiAggregatorExecutionConfig;
}): Promise<boolean> {
  const { pool, signer, poolConfig, liquidation, config } = params;
  const { borrower } = liquidation;
  const suppliedQuoteEvaluation = getExternalTakeExecutionPlanPrimaryEvaluation(
    liquidation.externalTakeExecutionPlan
  );
  const usesSushiExecutionPath =
    poolConfig.take.liquiditySource === LiquiditySource.SUSHI_AGGREGATOR ||
    suppliedQuoteEvaluation?.calldataQuote?.providerId === 'sushi_aggregator';
  if (!usesSushiExecutionPath) {
    logger.error(
      `Sushi aggregator liquidity source not configured. Skipping liquidation of poolAddress: ${pool.poolAddress}, borrower: ${borrower}.`
    );
    return false;
  }

  let attemptedSubmission = false;
  try {
    const prepared = await prepareSushiAggregatorExecution({
      pool,
      signer,
      poolConfig,
      liquidation,
      config,
    });
    if (prepared.kind === 'rejected') {
      recordPreparedSushiRejection(config, prepared);
      return false;
    }
    if (prepared.kind === 'dry_run') {
      logger.info(
        `DryRun - would Sushi Aggregator Take - poolAddress: ${pool.poolAddress}, borrower: ${borrower}, approvedMinOutRaw=${prepared.approvedQuoteEvaluation.approvedMinOutRaw.toString()}`
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
      liquiditySource: LiquiditySource.SUSHI_AGGREGATOR,
      providerId: 'sushi_aggregator',
      label: SUSHI_LABEL,
      transactionTarget: prepared.freshQuote.transactionTarget,
      swapDetails: prepared.swapDetails,
      routeProfitability: prepared.approvedQuoteEvaluation.routeProfitability,
      approvedMinOutRaw: prepared.approvedQuoteEvaluation.approvedMinOutRaw,
      assertFreshQuoteStillCurrent: prepared.assertFreshQuoteStillCurrent,
      onQuoteConsumed: () =>
        config.onSushiAggregatorQuoteResult?.({ success: true }),
      onSubmissionAccepted: () => {
        attemptedSubmission = true;
      },
    });
    return true;
  } catch (error) {
    config.onSushiAggregatorExecutionFailure?.({
      preBroadcast:
        !attemptedSubmission && !isNonceConsumedTransactionError(error),
      error: getErrorMessage(error),
    });
    logger.error(
      `Failed Sushi Aggregator Take. pool: ${pool.name}, borrower: ${borrower}`,
      error
    );
    return false;
  }
}
