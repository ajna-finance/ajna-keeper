import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber, ethers } from 'ethers';
import { AjnaKeeperTakerFactory__factory } from '../../../typechain-types/factories/contracts/factories';
import { LifiDexConfig, LiquiditySource } from '../../config';
import type { ExternalTakeTakerContractKey } from '../../config';
import { ApprovedLifiQuote, DEFAULT_LIFI_QUOTE_MAX_AGE_MS } from '../../dex/lifi';
import { convertWadToTokenDecimals } from '../../erc20';
import { logger } from '../../logging';
import { isNonceConsumedTransactionError, NonceTracker } from '../../nonce';
import {
  estimateGasWithBuffer,
  getErrorMessage,
  weiToDecimaled,
} from '../../utils';
import { approveLifiQuoteForExecution } from '../external-take/quote-approval';
import { getExternalTakeExecutionPlanPrimaryEvaluation } from '../external-take/execution-plan';
import { LifiExecutionConfig } from './types';
import { getLifiPathQuoteEvaluation as evaluateLifiPathQuote } from './quote-evaluation';
import {
  getLifiQuoteFailureMetadata,
  getLifiTokenDecimals,
  requestValidatedLifiQuote,
  requireProductionLifiConfig,
  resolveLifiChainId,
} from './quote-service';
import {
  ApprovedLifiQuoteEvaluation,
  ExternalTakeQuoteEvaluation,
  TakeActionConfig,
  TakeLiquidationPlan,
} from '../types';
import {
  TakeWriteTransport,
  resolveTakeWriteTransport,
  submitTakeTransaction,
} from '../write-transport';
import { logTakeExecutionTelemetry } from '../execution-telemetry';

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

function getLifiFreshQuoteAgeError(params: {
  quote: Pick<ApprovedLifiQuote, 'quotedAtMs'>;
  config: LifiDexConfig;
}): string | undefined {
  if (
    Date.now() - params.quote.quotedAtMs >
    (params.config.maxQuoteAgeMs ?? DEFAULT_LIFI_QUOTE_MAX_AGE_MS)
  ) {
    return 'LI.FI fresh quote exceeded maxQuoteAgeMs';
  }
  return undefined;
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

function getLifiQuoteContextMismatch(params: {
  quoteEvaluation: ApprovedLifiQuoteEvaluation;
  liquidation: Pick<TakeLiquidationPlan, 'auctionPrice' | 'collateral'>;
}): string | undefined {
  if (
    params.quoteEvaluation.quotedCollateralWad !== undefined &&
    !params.quoteEvaluation.quotedCollateralWad.eq(
      params.liquidation.collateral
    )
  ) {
    return 'LI.FI approved quote collateral does not match current liquidation collateral';
  }
  if (
    params.quoteEvaluation.quotedAuctionPriceWad !== undefined &&
    !params.quoteEvaluation.quotedAuctionPriceWad.eq(
      params.liquidation.auctionPrice
    )
  ) {
    return 'LI.FI approved quote auction price does not match current liquidation auction price';
  }
  return undefined;
}

function encodeLifiSwapDetails(params: {
  quote: ApprovedLifiQuote;
  amountOutMinimum: BigNumber;
}): string {
  return ethers.utils.defaultAbiCoder.encode(
    [
      'tuple(address approvalSpender,address srcToken,address dstToken,address dstReceiver,uint256 amountInTokenUnits,uint256 amountOutMinimum,bytes callData)',
    ],
    [
      {
        approvalSpender: params.quote.approvalSpender,
        srcToken: params.quote.srcToken,
        dstToken: params.quote.dstToken,
        dstReceiver: params.quote.dstReceiver,
        amountInTokenUnits: params.quote.amountInTokenUnits,
        amountOutMinimum: params.amountOutMinimum,
        callData: params.quote.transactionRequest.data,
      },
    ]
  );
}

type LifiTakerFactory = ReturnType<
  typeof AjnaKeeperTakerFactory__factory.connect
>;

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
      approvedQuoteEvaluation: ApprovedLifiQuoteEvaluation;
    }
  | {
      kind: 'ready';
      approvedQuoteEvaluation: ApprovedLifiQuoteEvaluation;
      freshQuote: ApprovedLifiQuote;
      swapDetails: string;
      takeWriteTransport: TakeWriteTransport;
      factory: LifiTakerFactory;
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
  config: LifiExecutionConfig;
}): Promise<
  | { approved: true; quoteEvaluation: ApprovedLifiQuoteEvaluation }
  | { approved: false; reason: string; logError?: boolean }
> {
  const { pool, signer, poolConfig, liquidation, config } = params;
  const quoteEvaluation =
    getExternalTakeExecutionPlanPrimaryEvaluation(
      liquidation.externalTakeExecutionPlan
    ) ??
    (await getLifiPathQuoteEvaluation(
      pool,
      Number(weiToDecimaled(liquidation.auctionPrice)),
      liquidation.collateral,
      poolConfig,
      config,
      signer,
      liquidation.auctionPrice
    ));
  const approval = approveLifiQuoteForExecution({
    quoteEvaluation,
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
  const contextMismatch = getLifiQuoteContextMismatch({
    quoteEvaluation: approval.quoteEvaluation,
    liquidation,
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
}): Promise<ApprovedLifiQuote> {
  try {
    return await requestValidatedLifiQuote({
      pool: params.pool,
      lifiConfig: params.lifiConfig,
      lifiTaker: params.lifiTaker,
      chainId: params.chainId,
      collateralInTokenDecimals: params.collateralInTokenDecimals,
      signal: params.config.lifiRequestAbortSignal,
    });
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

function getLifiFreshQuoteFloorError(params: {
  freshQuote: ApprovedLifiQuote;
  approvedMinOutRaw: BigNumber;
}): string | undefined {
  if (params.freshQuote.quoteAmountRaw.lt(params.approvedMinOutRaw)) {
    return 'LI.FI fresh quote expected output below execution floor';
  }
  if (params.freshQuote.routeMinOutRaw.lt(params.approvedMinOutRaw)) {
    return 'LI.FI fresh quote min output below execution floor';
  }
  return undefined;
}

function createLifiFreshQuoteCurrentGuard(params: {
  freshQuote: ApprovedLifiQuote;
  lifiConfig: LifiDexConfig;
  config: LifiExecutionConfig;
}): () => void {
  return () => {
    const error = getLifiFreshQuoteAgeError({
      quote: params.freshQuote,
      config: params.lifiConfig,
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
  const approved = await resolveApprovedLifiExecutionQuote({
    pool,
    signer,
    poolConfig,
    liquidation,
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

  if (!config.keeperTakerFactory) {
    throw new Error('LI.FI execution requires keeperTakerFactory');
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
    liquidation.collateral,
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
  const floorError = getLifiFreshQuoteFloorError({
    freshQuote,
    approvedMinOutRaw: approvedQuoteEvaluation.approvedMinOutRaw,
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
  const freshQuoteAgeError = getLifiFreshQuoteAgeError({
    quote: freshQuote,
    config: lifiConfig,
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
    swapDetails: encodeLifiSwapDetails({
      quote: freshQuote,
      amountOutMinimum: approvedQuoteEvaluation.approvedMinOutRaw,
    }),
    takeWriteTransport: resolveTakeWriteTransport(signer, config),
    factory: AjnaKeeperTakerFactory__factory.connect(
      config.keeperTakerFactory,
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
  const { borrower } = liquidation;
  await NonceTracker.queueTransaction(
    prepared.takeWriteTransport.signer,
    async (nonce: number) => {
      prepared.assertFreshQuoteStillCurrent();
      const txArgs = [
        pool.poolAddress,
        liquidation.borrower,
        liquidation.auctionPrice,
        liquidation.collateral,
        Number(LiquiditySource.LIFI),
        prepared.freshQuote.transactionTarget,
        prepared.swapDetails,
      ] as const;
      const gasLimit = await estimateGasWithBuffer(
        () => prepared.factory.estimateGas.takeWithAtomicSwap(...txArgs),
        `LI.FI Take ${pool.name}/${borrower}`,
        13000
      );
      prepared.assertFreshQuoteStillCurrent();
      const txRequest =
        await prepared.factory.populateTransaction.takeWithAtomicSwap(
          ...txArgs,
          {
            gasLimit,
            nonce: nonce.toString(),
          }
        );
      prepared.assertFreshQuoteStillCurrent();
      config.onLifiQuoteResult?.({ success: true });
      const receipt = await submitTakeTransaction(
        prepared.takeWriteTransport,
        txRequest,
        params.onSubmissionAccepted
      );
      logTakeExecutionTelemetry({
        path: 'lifi',
        source: LiquiditySource.LIFI,
        poolName: pool.name,
        poolAddress: pool.poolAddress,
        borrower,
        receipt,
        routeProfitability: prepared.approvedQuoteEvaluation.routeProfitability,
        approvedMinOutRaw: prepared.approvedQuoteEvaluation.approvedMinOutRaw,
        takeWriteTransport: prepared.takeWriteTransport,
      });
      logger.info(
        `LI.FI Take successful - pool: ${pool.name}, borrower: ${borrower} | tx: ${receipt.transactionHash}`
      );
      return receipt;
    }
  );
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
    suppliedQuoteEvaluation?.externalTakePath === 'lifi';
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
