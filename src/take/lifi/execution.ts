import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber } from 'ethers';
import { TakerRouter__factory } from '../../../typechain-types/factories/contracts/factories';
import { LifiDexConfig, LiquiditySource } from '../../config';
import type { ExternalTakeTakerContractKey } from '../../config';
import { DEFAULT_LIFI_QUOTE_MAX_AGE_MS } from '../../dex/lifi';
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
import { LifiExecutionConfig } from './types';
import { getLifiPathQuoteEvaluation as evaluateLifiPathQuote } from './quote-evaluation';
import {
  getLifiQuoteFailureMetadata,
  getLifiTokenDecimals,
  normalizeApprovedLifiQuote,
  requestValidatedLifiQuote,
  requireProductionLifiConfig,
  resolveLifiChainId,
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

const LIFI_LABEL = 'LI.FI';

export const getLifiPathQuoteEvaluation = evaluateLifiPathQuote;

function getLifiTakerAddress(
  takerContracts:
    | Partial<Record<ExternalTakeTakerContractKey, string>>
    | undefined
): string | undefined {
  return takerContracts?.Lifi;
}

function resolveLifiTakerAddress(params: {
  lifiTaker?: string;
  takerContracts?: Partial<Record<ExternalTakeTakerContractKey, string>>;
}): string | undefined {
  const canonicalTaker = getLifiTakerAddress(params.takerContracts);
  if (
    canonicalTaker &&
    params.lifiTaker &&
    canonicalTaker.toLowerCase() !== params.lifiTaker.toLowerCase()
  ) {
    throw new Error(
      'LI.FI runtime lifiTaker override must match takers.contracts.Lifi'
    );
  }
  return canonicalTaker ?? params.lifiTaker;
}

function recordLifiPreBroadcastFailure(
  config: LifiExecutionConfig,
  error: string
): void {
  config.onLifiExecutionFailure?.({
    preBroadcast: true,
    error,
  });
}

function getLifiMaxQuoteAgeMs(config: LifiDexConfig): number {
  return config.maxQuoteAgeMs ?? DEFAULT_LIFI_QUOTE_MAX_AGE_MS;
}

function recordLifiStaleFreshQuote(
  config: LifiExecutionConfig,
  error: string,
  retryable: boolean
): void {
  // `retryable` here drives the LI.FI execution_refresh circuit (retryable
  // failures count toward opening it). Staleness detected after the quote has
  // waited in the keeper's own nonce queue / gas-estimation path is a local
  // latency condition, not a LI.FI health signal, so it is recorded as
  // non-retryable (neutral) to avoid opening the circuit while the provider is
  // healthy. Genuine provider failures still flow through the fetch catch path.
  config.onLifiQuoteResult?.({
    success: false,
    retryable,
    error,
  });
}

type LifiQuoteResultNotification = Parameters<
  NonNullable<LifiExecutionConfig['onLifiQuoteResult']>
>[0];

type LifiPreBroadcastRejection = {
  kind: 'rejected';
  reason: string;
  logError?: boolean;
  quoteResult?: LifiQuoteResultNotification;
};

type PreparedLifiExecution =
  | {
      kind: 'dry_run';
      approvedQuoteEvaluation: ApprovedCalldataAggregatorQuoteEvaluation;
    }
  | {
      kind: 'ready';
      approvedQuoteEvaluation: ApprovedCalldataAggregatorQuoteEvaluation;
      freshQuote: ApprovedCalldataAggregatorQuote;
      swapDetails: string;
      // maxAmount for pool.take; the debt-clamped size the LI.FI calldata was
      // requested for, so the take fills exactly and the strict on-chain
      // balance check (UnexpectedSourceBalance) passes.
      executionCollateralWad: BigNumber;
      takeWriteTransport: TakeWriteTransport;
      factory: AggregatorTakerFactory;
      assertFreshQuoteStillCurrent: () => void;
    }
  | LifiPreBroadcastRejection;

function recordPreparedLifiRejection(
  config: LifiExecutionConfig,
  rejection: LifiPreBroadcastRejection
): void {
  if (rejection.logError) {
    logger.error(rejection.reason);
  }
  if (rejection.quoteResult) {
    config.onLifiQuoteResult?.(rejection.quoteResult);
  }
  recordLifiPreBroadcastFailure(config, rejection.reason);
}

async function resolveApprovedLifiExecutionQuote(params: {
  pool: FungiblePool;
  signer: Signer;
  poolConfig: TakeActionConfig;
  liquidation: TakeLiquidationPlan;
  executionCollateralWad: BigNumber;
  config: LifiExecutionConfig;
}): Promise<
  | {
      approved: true;
      quoteEvaluation: ApprovedCalldataAggregatorQuoteEvaluation;
    }
  | { approved: false; reason: string; logError?: boolean }
> {
  const {
    pool,
    signer,
    poolConfig,
    liquidation,
    executionCollateralWad,
    config,
  } = params;
  const quoteEvaluation =
    getExternalTakeExecutionPlanPrimaryEvaluation(
      liquidation.externalTakeExecutionPlan
    ) ??
    (await getLifiPathQuoteEvaluation(
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
    providerId: 'lifi',
    poolName: pool.name,
    borrower: liquidation.borrower,
  });
  if (!approval.approved) {
    return {
      approved: false,
      reason: approval.reason,
      logError: true,
    };
  }
  const contextMismatch = getAggregatorQuoteContextMismatch({
    quoteEvaluation: approval.quoteEvaluation,
    liquidation,
    executionCollateralWad,
    label: LIFI_LABEL,
  });
  if (contextMismatch) {
    return {
      approved: false,
      reason: contextMismatch,
    };
  }
  return {
    approved: true,
    quoteEvaluation: approval.quoteEvaluation,
  };
}

async function requestFreshLifiExecutionQuote(params: {
  pool: FungiblePool;
  config: LifiExecutionConfig;
  lifiConfig: LifiDexConfig;
  lifiTaker: string;
  chainId: number;
  collateralInTokenDecimals: BigNumber;
}): Promise<ApprovedCalldataAggregatorQuote> {
  try {
    const validated = await requestValidatedLifiQuote({
      pool: params.pool,
      lifiConfig: params.lifiConfig,
      lifiTaker: params.lifiTaker,
      chainId: params.chainId,
      collateralInTokenDecimals: params.collateralInTokenDecimals,
      signal: params.config.lifiRequestAbortSignal,
    });
    return normalizeApprovedLifiQuote(validated, params.chainId);
  } catch (error) {
    const failure = getLifiQuoteFailureMetadata(error);
    params.config.onLifiQuoteResult?.({
      success: false,
      retryable: failure.retryable,
      errorCode: failure.code,
      error: getErrorMessage(error),
    });
    throw error;
  }
}

function createLifiFreshQuoteCurrentGuard(params: {
  freshQuote: ApprovedCalldataAggregatorQuote;
  lifiConfig: LifiDexConfig;
  config: LifiExecutionConfig;
}): () => void {
  return () => {
    const error = getAggregatorQuoteAgeError({
      quote: params.freshQuote,
      maxQuoteAgeMs: getLifiMaxQuoteAgeMs(params.lifiConfig),
      label: LIFI_LABEL,
    });
    if (error) {
      recordLifiStaleFreshQuote(params.config, error, false);
      throw new Error(error);
    }
  };
}

async function prepareLifiExecution(params: {
  pool: FungiblePool;
  signer: Signer;
  poolConfig: TakeActionConfig;
  liquidation: TakeLiquidationPlan;
  config: LifiExecutionConfig;
}): Promise<PreparedLifiExecution> {
  const { pool, signer, poolConfig, liquidation, config } = params;
  // LI.FI calldata cannot be re-sized on-chain, so quote and take exactly the
  // debt-clamped size: price decay only increases what Ajna can fill, making
  // maxAmount == quoted size an exact fill.
  const executionCollateralWad = getDebtConstrainedTakeCollateralWad({
    collateral: liquidation.collateral,
    auctionPrice: liquidation.auctionPrice,
    debtToCover: liquidation.debtToCover,
  });
  const approved = await resolveApprovedLifiExecutionQuote({
    pool,
    signer,
    poolConfig,
    liquidation,
    executionCollateralWad,
    config,
  });
  if (!approved.approved) {
    return {
      kind: 'rejected',
      reason: approved.reason,
      logError: approved.logError,
    };
  }

  const approvedQuoteEvaluation = approved.quoteEvaluation;
  if (config.dryRun) {
    return {
      kind: 'dry_run',
      approvedQuoteEvaluation,
    };
  }

  if (!config.keeperTakerRouter) {
    throw new Error('LI.FI execution requires keeperTakerRouter');
  }
  const lifiConfig = requireProductionLifiConfig(config.lifi);
  const lifiTaker = config.lifiTaker;
  if (!lifiTaker) {
    throw new Error('LI.FI execution requires lifiTaker');
  }
  const chainId = await resolveLifiChainId(config, signer);
  const collateralDecimals = await getLifiTokenDecimals({
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
    const error = 'LI.FI collateral rounds to zero in token decimals';
    return { kind: 'rejected', reason: error };
  }

  const freshQuote = await requestFreshLifiExecutionQuote({
    pool,
    config,
    lifiConfig,
    lifiTaker,
    chainId,
    collateralInTokenDecimals,
  });
  const floorError = getAggregatorFreshQuoteFloorError({
    freshQuote,
    approvedMinOutRaw: approvedQuoteEvaluation.approvedMinOutRaw,
    label: LIFI_LABEL,
  });
  if (floorError) {
    return {
      kind: 'rejected',
      reason: floorError,
      quoteResult: {
        success: false,
        retryable: false,
        error: floorError,
      },
    };
  }
  const freshQuoteAgeError = getAggregatorQuoteAgeError({
    quote: freshQuote,
    maxQuoteAgeMs: getLifiMaxQuoteAgeMs(lifiConfig),
    label: LIFI_LABEL,
  });
  if (freshQuoteAgeError) {
    return {
      kind: 'rejected',
      reason: freshQuoteAgeError,
      quoteResult: {
        success: false,
        retryable: true,
        error: freshQuoteAgeError,
      },
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
    assertFreshQuoteStillCurrent: createLifiFreshQuoteCurrentGuard({
      freshQuote,
      lifiConfig,
      config,
    }),
  };
}

async function submitPreparedLifiExecution(params: {
  pool: FungiblePool;
  liquidation: TakeLiquidationPlan;
  config: LifiExecutionConfig;
  prepared: Extract<PreparedLifiExecution, { kind: 'ready' }>;
  onSubmissionAccepted: () => void;
}): Promise<void> {
  const { pool, liquidation, config, prepared } = params;
  await submitCalldataAggregatorTake({
    factory: prepared.factory,
    takeWriteTransport: prepared.takeWriteTransport,
    poolName: pool.name,
    poolAddress: pool.poolAddress,
    borrower: liquidation.borrower,
    auctionPrice: liquidation.auctionPrice,
    executionCollateralWad: prepared.executionCollateralWad,
    liquiditySource: LiquiditySource.LIFI,
    providerId: 'lifi',
    label: LIFI_LABEL,
    transactionTarget: prepared.freshQuote.transactionTarget,
    swapDetails: prepared.swapDetails,
    routeProfitability: prepared.approvedQuoteEvaluation.routeProfitability,
    approvedMinOutRaw: prepared.approvedQuoteEvaluation.approvedMinOutRaw,
    assertFreshQuoteStillCurrent: prepared.assertFreshQuoteStillCurrent,
    onQuoteConsumed: () => config.onLifiQuoteResult?.({ success: true }),
    onSubmissionAccepted: params.onSubmissionAccepted,
  });
}

export async function takeLiquidationLifi(params: {
  pool: FungiblePool;
  signer: Signer;
  poolConfig: TakeActionConfig;
  liquidation: TakeLiquidationPlan;
  config: LifiExecutionConfig;
}): Promise<boolean> {
  const { pool, signer, poolConfig, liquidation, config } = params;
  const { borrower } = liquidation;
  const suppliedQuoteEvaluation = getExternalTakeExecutionPlanPrimaryEvaluation(
    liquidation.externalTakeExecutionPlan
  );
  const usesLifiExecutionPath =
    poolConfig.take.liquiditySource === LiquiditySource.LIFI ||
    suppliedQuoteEvaluation?.providerId === 'lifi' ||
    suppliedQuoteEvaluation?.calldataQuote?.providerId === 'lifi';
  if (!usesLifiExecutionPath) {
    logger.error(
      `LI.FI liquidity source not configured. Skipping liquidation of poolAddress: ${pool.poolAddress}, borrower: ${borrower}.`
    );
    return false;
  }

  let attemptedSubmission = false;
  try {
    const prepared = await prepareLifiExecution({
      pool,
      signer,
      poolConfig,
      liquidation,
      config,
    });
    if (prepared.kind === 'rejected') {
      recordPreparedLifiRejection(config, prepared);
      return false;
    }
    if (prepared.kind === 'dry_run') {
      logger.info(
        `DryRun - would LI.FI Take - poolAddress: ${pool.poolAddress}, borrower: ${borrower}, approvedMinOutRaw=${prepared.approvedQuoteEvaluation.approvedMinOutRaw.toString()}`
      );
      return true;
    }

    await submitPreparedLifiExecution({
      pool,
      liquidation,
      config,
      prepared,
      onSubmissionAccepted: () => {
        attemptedSubmission = true;
      },
    });
    return true;
  } catch (error) {
    config.onLifiExecutionFailure?.({
      preBroadcast:
        !attemptedSubmission && !isNonceConsumedTransactionError(error),
      error: getErrorMessage(error),
    });
    logger.error(
      `Failed LI.FI Take. pool: ${pool.name}, borrower: ${borrower}`,
      error
    );
    return false;
  }
}

export { getLifiTakerAddress, resolveLifiTakerAddress };
