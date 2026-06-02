import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber, ethers } from 'ethers';
import { AjnaKeeperTakerFactory__factory } from '../../typechain-types/factories/contracts/factories';
import { LifiDexConfig, LiquiditySource } from '../config';
import { normalizeLifiProductionChainPolicy } from '../config/lifi-policy';
import {
  ApprovedLifiQuote,
  DEFAULT_LIFI_QUOTE_MAX_AGE_MS,
  fetchLifiQuote,
  validateLifiQuote,
} from '../dex/lifi';
import { convertWadToTokenDecimals } from '../erc20';
import {
  getCachedTokenDecimals,
  resolveExternalTakeChainId,
} from './external-take-chain';
import { logger } from '../logging';
import { isNonceConsumedTransactionError, NonceTracker } from '../nonce';
import {
  decimaledToWei,
  estimateGasWithBuffer,
  getErrorMessage,
  weiToDecimaled,
} from '../utils';
import {
  EXTERNAL_TAKE_REJECTION_REASONS,
  applyExternalTakeRoutePolicy,
  mergeRoutePolicyIntoEvaluation,
} from './external-take-policy';
import * as factoryShared from './factory/shared';
import { LifiExecutionConfig, LifiQuoteConfig } from './lifi-types';
import {
  ApprovedLifiQuoteEvaluation,
  ExternalTakeQuoteEvaluation,
  TakeActionConfig,
  TakeLiquidationPlan,
} from './types';
import {
  resolveTakeWriteTransport,
  submitTakeTransaction,
} from './write-transport';
import { logTakeExecutionTelemetry } from './execution-telemetry';

function getLifiApiKey(config: LifiDexConfig | undefined): string | undefined {
  return config?.apiKeyEnvVar ? process.env[config.apiKeyEnvVar] : undefined;
}

function getLifiTakerAddress(
  takerContracts: { [source: string]: string } | undefined
): string | undefined {
  return takerContracts?.Lifi;
}

function getLifiQuoteFailureMetadata(error: unknown): {
  retryable?: boolean;
  code: number | string;
} {
  const typed = error as { retryable?: boolean; status?: number };
  return {
    retryable: typed.retryable ?? false,
    code: typed.status ?? 'exception',
  };
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

async function getLifiTokenDecimals(params: {
  signer: Signer;
  tokenAddress: string;
  chainId?: number;
  cache?: Map<string, number>;
}): Promise<number> {
  return getCachedTokenDecimals(params);
}

async function resolveLifiChainId(
  config: Partial<Pick<LifiQuoteConfig, 'chainId'>>,
  signer: Signer
): Promise<number> {
  return resolveExternalTakeChainId(config, signer, 'LI.FI');
}

function requireProductionLifiConfig(
  config: LifiDexConfig | undefined
): LifiDexConfig & { mode: 'production' } {
  if (!config || config.mode !== 'production') {
    throw new Error('LI.FI production config is required for live quotes');
  }
  return config;
}

function getLifiTopLevelQuoteType(quote: ApprovedLifiQuote): string {
  return typeof quote.raw.type === 'string' && quote.raw.type.trim().length > 0
    ? quote.raw.type.trim().toLowerCase()
    : 'n/a';
}

function getLifiTopLevelQuoteTool(quote: ApprovedLifiQuote): string {
  if (quote.topLevelTool) {
    return quote.topLevelTool;
  }
  return typeof quote.raw.tool === 'string' && quote.raw.tool.trim().length > 0
    ? quote.raw.tool.trim().toLowerCase()
    : 'n/a';
}

async function requestValidatedLifiQuote(params: {
  pool: FungiblePool;
  lifiConfig: LifiDexConfig;
  lifiTaker: string;
  chainId: number;
  collateralInTokenDecimals: BigNumber;
  signal?: AbortSignal;
}): Promise<ApprovedLifiQuote> {
  const productionConfig = requireProductionLifiConfig(params.lifiConfig);
  const chainPolicy = normalizeLifiProductionChainPolicy({
    config: productionConfig,
    fieldName: 'LI.FI',
    chainId: params.chainId,
  });
  const result = await fetchLifiQuote({
    config: productionConfig,
    apiKey: getLifiApiKey(productionConfig),
    signal: params.signal,
    request: {
      chainId: params.chainId,
      fromToken: params.pool.collateralAddress,
      toToken: params.pool.quoteAddress,
      fromAmount: params.collateralInTokenDecimals.toString(),
      fromAddress: params.lifiTaker,
      toAddress: params.lifiTaker,
      slippage: productionConfig.defaultSlippage,
      maxPriceImpact: productionConfig.maxPriceImpact,
    },
  });

  return validateLifiQuote({
    quote: result.data,
    chainId: params.chainId,
    fromToken: params.pool.collateralAddress,
    toToken: params.pool.quoteAddress,
    fromAmount: params.collateralInTokenDecimals,
    takerAddress: params.lifiTaker,
    allowedExchangeTools: productionConfig.allowExchanges,
    callTargetAllowlist: chainPolicy.callTargets,
    approvalSpenderAllowlist: chainPolicy.approvalSpenders,
    selectorAllowlist: chainPolicy.selectorAllowlist,
    feeCostPolicy: productionConfig.feeCostPolicy,
  });
}

export async function getLifiPathQuoteEvaluation(
  pool: FungiblePool,
  price: number,
  collateral: BigNumber,
  poolConfig: TakeActionConfig,
  config: Partial<LifiQuoteConfig>,
  signer: Signer,
  auctionPriceWad?: BigNumber
): Promise<ExternalTakeQuoteEvaluation> {
  if (!poolConfig.take.marketPriceFactor) {
    return {
      isTakeable: false,
      externalTakePath: 'lifi',
      selectedLiquiditySource: LiquiditySource.LIFI,
      reason: 'LI.FI marketPriceFactor is not configured',
    };
  }
  if (!collateral.gt(0)) {
    return {
      isTakeable: false,
      externalTakePath: 'lifi',
      selectedLiquiditySource: LiquiditySource.LIFI,
      reason: 'collateral must be greater than zero',
    };
  }

  try {
    const lifiConfig = requireProductionLifiConfig(config.lifi);
    if (!config.lifiTaker) {
      return {
        isTakeable: false,
        externalTakePath: 'lifi',
        selectedLiquiditySource: LiquiditySource.LIFI,
        reason: 'LI.FI taker is not configured',
      };
    }
    const chainId = await resolveLifiChainId(config, signer);
    const collateralDecimals = await getLifiTokenDecimals({
      signer,
      tokenAddress: pool.collateralAddress,
      chainId,
      cache: config.tokenDecimalsCache,
    });
    const collateralInTokenDecimals = convertWadToTokenDecimals(
      collateral,
      collateralDecimals
    );
    if (collateralInTokenDecimals.isZero()) {
      return {
        isTakeable: false,
        externalTakePath: 'lifi',
        selectedLiquiditySource: LiquiditySource.LIFI,
        reason: 'LI.FI collateral rounds to zero in token decimals',
      };
    }
    const approvedQuote = await requestValidatedLifiQuote({
      pool,
      lifiConfig,
      lifiTaker: config.lifiTaker,
      chainId,
      collateralInTokenDecimals,
      signal: config.lifiRequestAbortSignal,
    });

    const quoteDecimals = await getLifiTokenDecimals({
      signer,
      tokenAddress: pool.quoteAddress,
      chainId,
      cache: config.tokenDecimalsCache,
    });
    // LI.FI calldata is opaque and cannot be patched with a higher provider
    // min-out. Use the provider's post-fee floor as the economic quote.
    const executableQuoteAmountRaw = approvedQuote.routeMinOutRaw;
    const collateralAmount = Number(
      ethers.utils.formatUnits(collateralInTokenDecimals, collateralDecimals)
    );
    const quoteAmount = Number(
      ethers.utils.formatUnits(executableQuoteAmountRaw, quoteDecimals)
    );
    const marketPrice = quoteAmount / collateralAmount;
    const effectiveAuctionPriceWad = auctionPriceWad ?? decimaledToWei(price);
    const quoteAmountDueRaw = await factoryShared.getQuoteAmountDueRaw(
      pool,
      effectiveAuctionPriceWad,
      collateral
    );
    const marketFactorFloorQuoteRaw = factoryShared.ceilDiv(
      quoteAmountDueRaw.mul(factoryShared.MARKET_FACTOR_SCALE),
      BigNumber.from(
        factoryShared.getMarketPriceFactorUnits(
          poolConfig.take.marketPriceFactor
        )
      )
    );
    const policy = applyExternalTakeRoutePolicy({
      configuredMarketPriceFactor: poolConfig.take.marketPriceFactor,
      allowSubsidy: poolConfig.take.allowSubsidy === true,
      quoteAmountRaw: executableQuoteAmountRaw,
      quoteDueRaw: quoteAmountDueRaw,
      marketFactorFloorQuoteRaw,
      routeMinOutRaw: approvedQuote.routeMinOutRaw,
    });
    const takeablePrice = marketPrice * policy.effectiveMarketPriceFactor;

    logger.info(
      `LI.FI take check for pool ${pool.name}: marketPrice=${marketPrice.toFixed(6)}, takeablePrice=${takeablePrice.toFixed(6)}, auctionPrice=${price.toFixed(6)}, collateral=${collateralAmount}, factor=${poolConfig.take.marketPriceFactor}, lifiMode=${lifiConfig.mode}, topLevelType=${getLifiTopLevelQuoteType(approvedQuote)}, topLevelTool=${getLifiTopLevelQuoteTool(approvedQuote)}, effectiveTool=${approvedQuote.tool}, expectedOutputRaw=${approvedQuote.quoteAmountRaw.toString()}, routeMinOutRaw=${approvedQuote.routeMinOutRaw.toString()}, approvedMinOutRaw=${policy.approvedMinOutRaw.toString()}, target=${approvedQuote.transactionTarget}, transactionTarget=${approvedQuote.transactionRequest.to}, approvalSpender=${approvedQuote.approvalSpender}, selector=${approvedQuote.selector}, rejectionReason=${policy.rejectionReason ?? 'none'} -> ${policy.isEconomicallyExecutable ? 'TAKEABLE' : 'skip'}`
    );

    return mergeRoutePolicyIntoEvaluation({
      evaluation: {
        isTakeable: policy.isEconomicallyExecutable,
        externalTakePath: 'lifi',
        marketPrice,
        takeablePrice,
        quoteAmount,
        quoteAmountRaw: executableQuoteAmountRaw,
        selectedLiquiditySource: LiquiditySource.LIFI,
        collateralAmount,
        quotedCollateralWad: collateral,
        quotedAuctionPriceWad: effectiveAuctionPriceWad,
        lifiQuote: approvedQuote,
        reason: policy.isEconomicallyExecutable
          ? undefined
          : (policy.rejectionReason ??
            EXTERNAL_TAKE_REJECTION_REASONS.auctionPriceAboveThreshold),
      },
      policy,
      auctionRepayRequirementQuoteRaw: quoteAmountDueRaw,
      configuredMarketPriceFactor: poolConfig.take.marketPriceFactor,
      marketFactorFloorQuoteRaw,
    });
  } catch (error) {
    const failure = getLifiQuoteFailureMetadata(error);
    return {
      isTakeable: false,
      externalTakePath: 'lifi',
      selectedLiquiditySource: LiquiditySource.LIFI,
      quoteFailureRetryable: failure.retryable ?? true,
      quoteFailureCode: failure.code,
      reason: getErrorMessage(error),
    };
  }
}

function approveLifiQuoteForExecution(params: {
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  poolName: string;
  borrower: string;
}):
  | { approved: true; quoteEvaluation: ApprovedLifiQuoteEvaluation }
  | { approved: false; reason: string } {
  const { quoteEvaluation, poolName, borrower } = params;
  if (!quoteEvaluation.isTakeable) {
    return {
      approved: false,
      reason: `LI.FI quote no longer satisfies execution policy for ${poolName}/${borrower}: ${quoteEvaluation.reason ?? 'not takeable'}`,
    };
  }
  if (!quoteEvaluation.quoteAmountRaw) {
    return {
      approved: false,
      reason: `LI.FI quote is missing raw quote amount for ${poolName}/${borrower}`,
    };
  }
  if (quoteEvaluation.externalTakePath !== 'lifi') {
    return {
      approved: false,
      reason: `LI.FI execution received non-LI.FI approved path for ${poolName}/${borrower}`,
    };
  }
  if (quoteEvaluation.selectedLiquiditySource !== LiquiditySource.LIFI) {
    return {
      approved: false,
      reason: `LI.FI execution received non-LI.FI approved source for ${poolName}/${borrower}`,
    };
  }
  if (!quoteEvaluation.lifiQuote) {
    return {
      approved: false,
      reason: `LI.FI execution is missing validated route details for ${poolName}/${borrower}`,
    };
  }
  const approvedMinOutRaw = factoryShared.deriveApprovedMinOutRaw({
    routeMinOutRaw: quoteEvaluation.routeMinOutRaw,
    profitMinOutRaw: quoteEvaluation.profitMinOutRaw,
    fallbackMinOutRaw: quoteEvaluation.approvedMinOutRaw,
  });
  if (!approvedMinOutRaw) {
    return {
      approved: false,
      reason: `LI.FI execution is missing approved min-out floor for ${poolName}/${borrower}`,
    };
  }
  return {
    approved: true,
    quoteEvaluation: {
      ...quoteEvaluation,
      isTakeable: true,
      externalTakePath: 'lifi',
      quoteAmountRaw: quoteEvaluation.quoteAmountRaw,
      selectedLiquiditySource: LiquiditySource.LIFI,
      approvedMinOutRaw,
      lifiQuote: quoteEvaluation.lifiQuote,
    },
  };
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

export async function takeLiquidationLifi(params: {
  pool: FungiblePool;
  signer: Signer;
  poolConfig: TakeActionConfig;
  liquidation: TakeLiquidationPlan;
  config: LifiExecutionConfig;
}): Promise<boolean> {
  const { pool, signer, poolConfig, liquidation, config } = params;
  const { borrower } = liquidation;
  const suppliedQuoteEvaluation = liquidation.externalTakeQuoteEvaluation;
  const usesLifiExecutionPath =
    poolConfig.take.liquiditySource === LiquiditySource.LIFI ||
    suppliedQuoteEvaluation?.externalTakePath === 'lifi' ||
    suppliedQuoteEvaluation?.selectedLiquiditySource === LiquiditySource.LIFI;
  if (!usesLifiExecutionPath) {
    logger.error(
      `LI.FI liquidity source not configured. Skipping liquidation of poolAddress: ${pool.poolAddress}, borrower: ${borrower}.`
    );
    return false;
  }

  let attemptedSubmission = false;
  try {
    const quoteEvaluation =
      suppliedQuoteEvaluation ??
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
      borrower,
    });
    if (!approval.approved) {
      logger.error(approval.reason);
      recordLifiPreBroadcastFailure(config, approval.reason);
      return false;
    }
    const approvedQuoteEvaluation = approval.quoteEvaluation;
    const contextMismatch = getLifiQuoteContextMismatch({
      quoteEvaluation: approvedQuoteEvaluation,
      liquidation,
    });
    if (contextMismatch) {
      recordLifiPreBroadcastFailure(config, contextMismatch);
      return false;
    }
    if (config.dryRun) {
      logger.info(
        `DryRun - would LI.FI Take - poolAddress: ${pool.poolAddress}, borrower: ${borrower}, approvedMinOutRaw=${approvedQuoteEvaluation.approvedMinOutRaw.toString()}`
      );
      return true;
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
      recordLifiPreBroadcastFailure(config, error);
      return false;
    }
    let freshQuote: ApprovedLifiQuote;
    try {
      freshQuote = await requestValidatedLifiQuote({
        pool,
        lifiConfig,
        lifiTaker,
        chainId,
        collateralInTokenDecimals,
        signal: config.lifiRequestAbortSignal,
      });
    } catch (error) {
      const failure = getLifiQuoteFailureMetadata(error);
      config.onLifiQuoteResult?.({
        success: false,
        retryable: failure.retryable,
        errorCode: failure.code,
        error: getErrorMessage(error),
      });
      throw error;
    }
    if (
      freshQuote.quoteAmountRaw.lt(approvedQuoteEvaluation.approvedMinOutRaw)
    ) {
      const error = 'LI.FI fresh quote expected output below execution floor';
      config.onLifiQuoteResult?.({
        success: false,
        retryable: false,
        error,
      });
      recordLifiPreBroadcastFailure(config, error);
      return false;
    }
    if (
      freshQuote.routeMinOutRaw.lt(approvedQuoteEvaluation.approvedMinOutRaw)
    ) {
      const error = 'LI.FI fresh quote min output below execution floor';
      config.onLifiQuoteResult?.({
        success: false,
        retryable: false,
        error,
      });
      recordLifiPreBroadcastFailure(config, error);
      return false;
    }
    const freshQuoteAgeError = getLifiFreshQuoteAgeError({
      quote: freshQuote,
      config: lifiConfig,
    });
    if (freshQuoteAgeError) {
      recordLifiStaleFreshQuote(config, freshQuoteAgeError, true);
      recordLifiPreBroadcastFailure(config, freshQuoteAgeError);
      return false;
    }
    const assertFreshQuoteStillCurrent = (): void => {
      const error = getLifiFreshQuoteAgeError({
        quote: freshQuote,
        config: lifiConfig,
      });
      if (error) {
        recordLifiStaleFreshQuote(config, error, false);
        throw new Error(error);
      }
    };

    const swapDetails = encodeLifiSwapDetails({
      quote: freshQuote,
      amountOutMinimum: approvedQuoteEvaluation.approvedMinOutRaw,
    });
    const takeWriteTransport = resolveTakeWriteTransport(signer, config);
    const factory = AjnaKeeperTakerFactory__factory.connect(
      config.keeperTakerFactory,
      signer
    );
    await NonceTracker.queueTransaction(
      takeWriteTransport.signer,
      async (nonce: number) => {
        assertFreshQuoteStillCurrent();
        const txArgs = [
          pool.poolAddress,
          liquidation.borrower,
          liquidation.auctionPrice,
          liquidation.collateral,
          Number(LiquiditySource.LIFI),
          freshQuote.transactionTarget,
          swapDetails,
        ] as const;
        const gasLimit = await estimateGasWithBuffer(
          () => factory.estimateGas.takeWithAtomicSwap(...txArgs),
          `LI.FI Take ${pool.name}/${borrower}`,
          13000
        );
        assertFreshQuoteStillCurrent();
        const txRequest = await factory.populateTransaction.takeWithAtomicSwap(
          ...txArgs,
          {
            gasLimit,
            nonce: nonce.toString(),
          }
        );
        assertFreshQuoteStillCurrent();
        config.onLifiQuoteResult?.({ success: true });
        const receipt = await submitTakeTransaction(
          takeWriteTransport,
          txRequest,
          () => {
            attemptedSubmission = true;
          }
        );
        logTakeExecutionTelemetry({
          path: 'lifi',
          source: LiquiditySource.LIFI,
          poolName: pool.name,
          poolAddress: pool.poolAddress,
          borrower,
          receipt,
          routeProfitability: approvedQuoteEvaluation.routeProfitability,
          approvedMinOutRaw: approvedQuoteEvaluation.approvedMinOutRaw,
          takeWriteTransport,
        });
        logger.info(
          `LI.FI Take successful - pool: ${pool.name}, borrower: ${borrower} | tx: ${receipt.transactionHash}`
        );
        return receipt;
      }
    );
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

export { getLifiTakerAddress };
