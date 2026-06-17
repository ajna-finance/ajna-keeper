import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber, ethers } from 'ethers';
import { TakerRouter__factory } from '../../../typechain-types/factories/contracts/factories';
import {
  CalldataAggregatorProviderId,
  getAggregatorProviderIdentity,
} from '../../config';
import { convertWadToTokenDecimals } from '../../erc20';
import { logger } from '../../logging';
import { isNonceConsumedTransactionError, NonceTracker } from '../../nonce';
import {
  estimateGasWithBuffer,
  getErrorMessage,
  weiToDecimaled,
} from '../../utils';
import { logTakeExecutionTelemetry } from '../execution-telemetry';
import { getCachedTokenDecimals } from '../external-take/chain';
import { getDebtConstrainedTakeCollateralWad } from '../take-sizing';
import {
  ApprovedCalldataAggregatorQuoteEvaluation,
  ExternalTakeQuoteEvaluation,
  RouteProfitabilityBreakdown,
  TakeActionConfig,
  TakeLiquidationPlan,
} from '../types';
import { getExternalTakeExecutionPlanPrimaryEvaluation } from '../external-take/execution-plan';
import { resolveCalldataAggregatorQuoteIdentity } from '../external-take/route-binding';
import {
  TakeWriteTransport,
  TakeWriteTransportConfig,
  resolveTakeWriteTransport,
  submitTakeTransaction,
} from '../write-transport';
import { approveCalldataAggregatorQuoteForExecution } from './quote-approval';
import { ApprovedCalldataAggregatorQuote } from './types';

/**
 * Provider-neutral calldata-aggregator execution core (Packet 2B). These
 * helpers consume ONLY normalized provider output
 * (ApprovedCalldataAggregatorQuote); they never see raw provider responses.
 * Provider wrappers own API requests, parsing, normalization, and
 * provider-labeled callbacks, then delegate execution mechanics here.
 */

export type AggregatorTakerFactory = ReturnType<
  typeof TakerRouter__factory.connect
>;

export type CalldataAggregatorQuoteResultNotification = {
  success: boolean;
  retryable?: boolean;
  errorCode?: number | string;
  error?: string;
};

export type CalldataAggregatorPreBroadcastRejection = {
  kind: 'rejected';
  reason: string;
  logError?: boolean;
  quoteResult?: CalldataAggregatorQuoteResultNotification;
};

export type PreparedCalldataAggregatorExecution =
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
  | CalldataAggregatorPreBroadcastRejection;

export type CalldataAggregatorExecutionConfigBase = TakeWriteTransportConfig & {
  dryRun?: boolean;
  keeperTakerRouter?: string;
  tokenDecimalsCache?: Map<string, number>;
  // Provider-neutral discovery/execution notification hooks. Every
  // calldata-aggregator provider shares this single pair; the discovery layer
  // (calldata-aggregator-providers.ts) populates them and the shared execution
  // core invokes them directly — there are no per-provider callback names.
  onCalldataAggregatorQuoteResult?: (
    result: CalldataAggregatorQuoteResultNotification
  ) => void;
  onCalldataAggregatorExecutionFailure?: (result: {
    preBroadcast: boolean;
    error?: string;
  }) => void;
};

export type CalldataAggregatorProviderExecutionParams<
  TConfig extends CalldataAggregatorExecutionConfigBase,
> = {
  pool: FungiblePool;
  signer: Signer;
  poolConfig: TakeActionConfig;
  liquidation: TakeLiquidationPlan;
  config: TConfig;
};

/**
 * The 7-positional-arg path-quote evaluation contract every calldata-aggregator
 * provider implements (getLifiPathQuoteEvaluation et al.). Threading one named
 * type through the take adapter descriptor and the prepare-execution param
 * removes the positional-arg drift between those surfaces.
 */
export type CalldataAggregatorPathQuoteEvaluator<TConfig> = (
  pool: FungiblePool,
  price: number,
  collateralWad: BigNumber,
  poolConfig: TakeActionConfig,
  quoteConfig: TConfig,
  signer: Signer,
  auctionPrice?: BigNumber
) => Promise<ExternalTakeQuoteEvaluation>;

export function recordCalldataAggregatorPreBroadcastRejection<
  TConfig extends CalldataAggregatorExecutionConfigBase,
>(params: {
  config: TConfig;
  rejection: CalldataAggregatorPreBroadcastRejection;
}): void {
  if (params.rejection.logError) {
    logger.error(params.rejection.reason);
  }
  if (params.rejection.quoteResult) {
    params.config.onCalldataAggregatorQuoteResult?.(
      params.rejection.quoteResult
    );
  }
  params.config.onCalldataAggregatorExecutionFailure?.({
    preBroadcast: true,
    error: params.rejection.reason,
  });
}

/**
 * Encodes the shared on-chain AggregatorSwapDetails tuple consumed by
 * BaseAggregatorCalldataTaker. The amountOutMinimum is the keeper's approved
 * execution floor, not the provider's route minimum.
 */
/**
 * Canonical on-chain AggregatorSwapDetails tuple ABI — the single source of
 * truth every calldata-aggregator taker decodes. Encoders and decode-side test
 * assertions must reference this instead of re-typing the literal.
 */
export const AGGREGATOR_SWAP_DETAILS_TUPLE_ABI =
  'tuple(address approvalSpender,address srcToken,address dstToken,address dstReceiver,uint256 amountInTokenUnits,uint256 amountOutMinimum,bytes callData)';

export function encodeAggregatorSwapDetails(params: {
  quote: Pick<
    ApprovedCalldataAggregatorQuote,
    | 'approvalSpender'
    | 'srcToken'
    | 'dstToken'
    | 'dstReceiver'
    | 'amountInTokenUnits'
    | 'callData'
  >;
  amountOutMinimum: BigNumber;
}): string {
  return ethers.utils.defaultAbiCoder.encode(
    [AGGREGATOR_SWAP_DETAILS_TUPLE_ABI],
    [
      {
        approvalSpender: params.quote.approvalSpender,
        srcToken: params.quote.srcToken,
        dstToken: params.quote.dstToken,
        dstReceiver: params.quote.dstReceiver,
        amountInTokenUnits: params.quote.amountInTokenUnits,
        amountOutMinimum: params.amountOutMinimum,
        callData: params.quote.callData,
      },
    ]
  );
}

/** Execution-quote freshness check against the provider's quote timestamp. */
export function getAggregatorQuoteAgeError(params: {
  quote: Pick<ApprovedCalldataAggregatorQuote, 'quotedAtMs'>;
  maxQuoteAgeMs: number;
  label: string;
}): string | undefined {
  if (Date.now() - params.quote.quotedAtMs > params.maxQuoteAgeMs) {
    return `${params.label} fresh quote exceeded maxQuoteAgeMs`;
  }
  return undefined;
}

/**
 * Revalidates the approved quote context against the current liquidation:
 * the quoted collateral and auction price must match what execution is about
 * to take, or the quote must be re-derived.
 */
export function getAggregatorQuoteContextMismatch(params: {
  quoteEvaluation: ApprovedCalldataAggregatorQuoteEvaluation;
  liquidation: Pick<TakeLiquidationPlan, 'auctionPrice'>;
  executionCollateralWad: BigNumber;
  label: string;
}): string | undefined {
  if (
    params.quoteEvaluation.quotedCollateralWad !== undefined &&
    !params.quoteEvaluation.quotedCollateralWad.eq(
      params.executionCollateralWad
    )
  ) {
    return `${params.label} approved quote collateral does not match current liquidation collateral`;
  }
  if (
    params.quoteEvaluation.quotedAuctionPriceWad !== undefined &&
    !params.quoteEvaluation.quotedAuctionPriceWad.eq(
      params.liquidation.auctionPrice
    )
  ) {
    return `${params.label} approved quote auction price does not match current liquidation auction price`;
  }
  return undefined;
}

/**
 * Final min-out floor comparison for a freshly re-fetched execution quote:
 * both the expected output and the route minimum must clear the approved
 * execution floor (which already prices the ceil-rounded Ajna quote due).
 */
export function getAggregatorFreshQuoteFloorError(params: {
  freshQuote: Pick<
    ApprovedCalldataAggregatorQuote,
    'quoteAmountRaw' | 'routeMinOutRaw'
  >;
  approvedMinOutRaw: BigNumber;
  label: string;
}): string | undefined {
  if (params.freshQuote.quoteAmountRaw.lt(params.approvedMinOutRaw)) {
    return `${params.label} fresh quote expected output below execution floor`;
  }
  if (params.freshQuote.routeMinOutRaw.lt(params.approvedMinOutRaw)) {
    return `${params.label} fresh quote min output below execution floor`;
  }
  return undefined;
}

export function isCalldataAggregatorExecutionPathSelected(params: {
  poolConfig: Pick<TakeActionConfig, 'take'>;
  liquidation: Pick<TakeLiquidationPlan, 'externalTakeExecutionPlan'>;
  providerId: CalldataAggregatorProviderId;
}): boolean {
  const identity = getAggregatorProviderIdentity(params.providerId);
  const suppliedQuoteEvaluation = getExternalTakeExecutionPlanPrimaryEvaluation(
    params.liquidation.externalTakeExecutionPlan
  );
  if (suppliedQuoteEvaluation === undefined) {
    return params.poolConfig.take.liquiditySource === identity.source;
  }

  const suppliedQuoteIdentity = resolveCalldataAggregatorQuoteIdentity(
    suppliedQuoteEvaluation
  );
  return (
    suppliedQuoteIdentity.mismatch === undefined &&
    suppliedQuoteIdentity.providerId === params.providerId
  );
}

export async function prepareCalldataAggregatorExecution<
  TConfig extends CalldataAggregatorExecutionConfigBase,
>(params: {
  pool: FungiblePool;
  signer: Signer;
  poolConfig: TakeActionConfig;
  liquidation: TakeLiquidationPlan;
  config: TConfig;
  providerId: CalldataAggregatorProviderId;
  missingRouterReason: string;
  missingTakerReason: string;
  collateralRoundsToZeroReason: string;
  getPathQuoteEvaluation: CalldataAggregatorPathQuoteEvaluator<TConfig>;
  getTakerAddress: (config: TConfig) => string | undefined;
  resolveChainId: (config: TConfig, signer: Signer) => Promise<number>;
  requestValidatedQuote: (params: {
    pool: FungiblePool;
    signer: Signer;
    config: TConfig;
    takerAddress: string;
    chainId: number;
    collateralInTokenDecimals: BigNumber;
  }) => Promise<ApprovedCalldataAggregatorQuote>;
  getFailureMetadata: (error: unknown) => {
    retryable?: boolean;
    code?: number | string;
  };
  getMaxQuoteAgeMs: (config: TConfig) => number;
}): Promise<PreparedCalldataAggregatorExecution> {
  const { pool, signer, poolConfig, liquidation, config } = params;
  const { label } = getAggregatorProviderIdentity(params.providerId);
  const executionCollateralWad = getDebtConstrainedTakeCollateralWad({
    collateral: liquidation.collateral,
    auctionPrice: liquidation.auctionPrice,
    debtToCover: liquidation.debtToCover,
  });
  const quoteEvaluation =
    getExternalTakeExecutionPlanPrimaryEvaluation(
      liquidation.externalTakeExecutionPlan
    ) ??
    (await params.getPathQuoteEvaluation(
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
    providerId: params.providerId,
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
    label,
  });
  if (contextMismatch) {
    return { kind: 'rejected', reason: contextMismatch };
  }

  const approvedQuoteEvaluation = approval.quoteEvaluation;
  if (config.dryRun) {
    return { kind: 'dry_run', approvedQuoteEvaluation };
  }

  if (!config.keeperTakerRouter) {
    throw new Error(params.missingRouterReason);
  }
  const takerAddress = params.getTakerAddress(config);
  if (!takerAddress) {
    throw new Error(params.missingTakerReason);
  }

  const chainId = await params.resolveChainId(config, signer);
  const collateralDecimals = await getCachedTokenDecimals({
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
      reason: params.collateralRoundsToZeroReason,
    };
  }

  let freshQuote: ApprovedCalldataAggregatorQuote;
  try {
    freshQuote = await params.requestValidatedQuote({
      pool,
      signer,
      config,
      takerAddress,
      chainId,
      collateralInTokenDecimals,
    });
  } catch (error) {
    const failure = params.getFailureMetadata(error);
    config.onCalldataAggregatorQuoteResult?.({
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
    label,
  });
  if (floorError) {
    return {
      kind: 'rejected',
      reason: floorError,
      quoteResult: { success: false, retryable: false, error: floorError },
    };
  }

  const maxQuoteAgeMs = params.getMaxQuoteAgeMs(config);
  const ageError = getAggregatorQuoteAgeError({
    quote: freshQuote,
    maxQuoteAgeMs,
    label,
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
    factory: TakerRouter__factory.connect(config.keeperTakerRouter, signer),
    assertFreshQuoteStillCurrent: () => {
      const error = getAggregatorQuoteAgeError({
        quote: freshQuote,
        maxQuoteAgeMs,
        label,
      });
      if (error) {
        config.onCalldataAggregatorQuoteResult?.({
          success: false,
          retryable: false,
          error,
        });
        throw new Error(error);
      }
    },
  };
}

/**
 * Submits a calldata-aggregator take through the configured take write
 * transport: nonce queueing, buffered gas estimation, transaction
 * population, freshness re-assertion before every irreversible step, and
 * provider-id-aware execution telemetry.
 */
export async function submitCalldataAggregatorTake(params: {
  factory: AggregatorTakerFactory;
  takeWriteTransport: TakeWriteTransport;
  poolName: string;
  poolAddress: string;
  borrower: string;
  auctionPrice: BigNumber;
  executionCollateralWad: BigNumber;
  providerId: CalldataAggregatorProviderId;
  transactionTarget: string;
  swapDetails: string;
  routeProfitability?: RouteProfitabilityBreakdown;
  approvedMinOutRaw: BigNumber;
  assertFreshQuoteStillCurrent: () => void;
  onQuoteConsumed?: () => void;
  onSubmissionAccepted: () => void;
}): Promise<void> {
  const { source: liquiditySource, label } = getAggregatorProviderIdentity(
    params.providerId
  );
  await NonceTracker.queueTransaction(
    params.takeWriteTransport.signer,
    async (nonce: number) => {
      params.assertFreshQuoteStillCurrent();
      const txArgs = [
        params.poolAddress,
        params.borrower,
        params.auctionPrice,
        params.executionCollateralWad,
        Number(liquiditySource),
        params.transactionTarget,
        params.swapDetails,
      ] as const;
      const gasLimit = await estimateGasWithBuffer(
        () => params.factory.estimateGas.takeWithAtomicSwap(...txArgs),
        `${label} Take ${params.poolName}/${params.borrower}`,
        13000
      );
      params.assertFreshQuoteStillCurrent();
      const txRequest =
        await params.factory.populateTransaction.takeWithAtomicSwap(...txArgs, {
          gasLimit,
          nonce: nonce.toString(),
        });
      params.assertFreshQuoteStillCurrent();
      params.onQuoteConsumed?.();
      const receipt = await submitTakeTransaction(
        params.takeWriteTransport,
        txRequest,
        params.onSubmissionAccepted
      );
      logTakeExecutionTelemetry({
        path: 'calldata_aggregator',
        providerId: params.providerId,
        source: liquiditySource,
        poolName: params.poolName,
        poolAddress: params.poolAddress,
        borrower: params.borrower,
        receipt,
        routeProfitability: params.routeProfitability,
        approvedMinOutRaw: params.approvedMinOutRaw,
        takeWriteTransport: params.takeWriteTransport,
      });
      logger.info(
        `${label} Take successful - pool: ${params.poolName}, borrower: ${params.borrower} | tx: ${receipt.transactionHash}`
      );
      return receipt;
    }
  );
}

export async function submitPreparedCalldataAggregatorExecution(params: {
  pool: FungiblePool;
  liquidation: TakeLiquidationPlan;
  prepared: Extract<PreparedCalldataAggregatorExecution, { kind: 'ready' }>;
  providerId: CalldataAggregatorProviderId;
  onQuoteConsumed?: () => void;
  onSubmissionAccepted: () => void;
}): Promise<void> {
  const { pool, liquidation, prepared } = params;
  await submitCalldataAggregatorTake({
    factory: prepared.factory,
    takeWriteTransport: prepared.takeWriteTransport,
    poolName: pool.name,
    poolAddress: pool.poolAddress,
    borrower: liquidation.borrower,
    auctionPrice: liquidation.auctionPrice,
    executionCollateralWad: prepared.executionCollateralWad,
    providerId: params.providerId,
    transactionTarget: prepared.freshQuote.transactionTarget,
    swapDetails: prepared.swapDetails,
    routeProfitability: prepared.approvedQuoteEvaluation.routeProfitability,
    approvedMinOutRaw: prepared.approvedQuoteEvaluation.approvedMinOutRaw,
    assertFreshQuoteStillCurrent: prepared.assertFreshQuoteStillCurrent,
    onQuoteConsumed: params.onQuoteConsumed,
    onSubmissionAccepted: params.onSubmissionAccepted,
  });
}

export async function takeLiquidationCalldataAggregatorProvider<
  TConfig extends CalldataAggregatorExecutionConfigBase,
>(
  params: CalldataAggregatorProviderExecutionParams<TConfig> & {
    providerId: CalldataAggregatorProviderId;
    prepareExecution: (
      params: CalldataAggregatorProviderExecutionParams<TConfig>
    ) => Promise<PreparedCalldataAggregatorExecution>;
  }
): Promise<boolean> {
  const { pool, liquidation, config } = params;
  const { label } = getAggregatorProviderIdentity(params.providerId);
  const { borrower } = liquidation;
  if (
    !isCalldataAggregatorExecutionPathSelected({
      poolConfig: params.poolConfig,
      liquidation,
      providerId: params.providerId,
    })
  ) {
    logger.error(
      `${label} liquidity source not selected. Skipping liquidation of poolAddress: ${pool.poolAddress}, borrower: ${borrower}.`
    );
    return false;
  }

  let attemptedSubmission = false;
  try {
    const prepared = await params.prepareExecution(params);
    if (prepared.kind === 'rejected') {
      recordCalldataAggregatorPreBroadcastRejection({
        config,
        rejection: prepared,
      });
      return false;
    }
    if (prepared.kind === 'dry_run') {
      logger.info(
        `DryRun - would ${label} Take - poolAddress: ${pool.poolAddress}, borrower: ${borrower}, approvedMinOutRaw=${prepared.approvedQuoteEvaluation.approvedMinOutRaw.toString()}`
      );
      return true;
    }

    await submitPreparedCalldataAggregatorExecution({
      pool,
      liquidation,
      prepared,
      providerId: params.providerId,
      onQuoteConsumed: () =>
        config.onCalldataAggregatorQuoteResult?.({ success: true }),
      onSubmissionAccepted: () => {
        attemptedSubmission = true;
      },
    });
    return true;
  } catch (error) {
    config.onCalldataAggregatorExecutionFailure?.({
      preBroadcast:
        !attemptedSubmission && !isNonceConsumedTransactionError(error),
      error: getErrorMessage(error),
    });
    logger.error(
      `Failed ${label} Take. pool: ${pool.name}, borrower: ${borrower}`,
      error
    );
    return false;
  }
}
