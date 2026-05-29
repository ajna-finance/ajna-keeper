import { Signer, FungiblePool } from '@ajna-finance/sdk';
import { BigNumber, ethers } from 'ethers';
import { AjnaKeeperTaker__factory } from '../../typechain-types';
import { LiquiditySource } from '../config';
import { DexRouter } from '../dex/router';
import {
  convertSwapApiResponseToDetails,
  encodeOneInchSwapDetailsBytes,
  validateOneInchSwapDetailsForAtomicTake,
} from '../dex/one-inch';
import {
  convertWadToTokenDecimals,
  convertWadToTokenDecimalsCeil,
} from '../erc20';
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
import { logTakeExecutionTelemetry } from './execution-telemetry';
import * as factoryShared from './factory/shared';
import { OneInchExecutionConfig, OneInchQuoteConfig } from './one-inch-types';
import {
  resolveTakeWriteTransport,
  submitTakeTransaction,
} from './write-transport';
import {
  ApprovedOneInchQuoteEvaluation,
  ExternalTakeQuoteEvaluation,
  TakeActionConfig,
  TakeLiquidationPlan,
} from './types';
import {
  EXTERNAL_TAKE_REJECTION_REASONS,
  applyExternalTakeRoutePolicy,
  mergeRoutePolicyIntoEvaluation,
} from './external-take-policy';

async function getOneInchTokenDecimals(params: {
  signer: Signer;
  tokenAddress: string;
  chainId?: number;
  cache?: Map<string, number>;
}): Promise<number> {
  return getCachedTokenDecimals(params);
}

async function resolveOneInchChainId(
  config: Partial<Pick<OneInchQuoteConfig, 'chainId'>>,
  signer: Signer
): Promise<number> {
  return resolveExternalTakeChainId(config, signer, '1inch');
}

function getQuoteAmountDueRawFromDecimals(params: {
  auctionPriceWad: BigNumber;
  collateralWad: BigNumber;
  quoteDecimals: number;
}): BigNumber {
  const quoteDueWad = params.collateralWad
    .mul(params.auctionPriceWad)
    .add(factoryShared.WAD.sub(1))
    .div(factoryShared.WAD);
  // Round repayment up so min-out never underfunds the Ajna take amount.
  return convertWadToTokenDecimalsCeil(quoteDueWad, params.quoteDecimals);
}

function getOneInchRequestOptions(config: Partial<OneInchQuoteConfig>): {
  timeoutMs?: number;
  signal?: AbortSignal;
} {
  return {
    timeoutMs: config.oneInchRequestTimeoutMs,
    ...(config.oneInchRequestAbortSignal
      ? { signal: config.oneInchRequestAbortSignal }
      : {}),
  };
}

export async function getOneInchTakeQuoteEvaluation(
  pool: FungiblePool,
  price: number,
  collateral: BigNumber,
  poolConfig: TakeActionConfig,
  config: Partial<OneInchQuoteConfig>,
  signer: Signer,
  oneInchRouters: { [chainId: number]: string } | undefined,
  connectorTokens: string[] | undefined,
  auctionPriceWad?: BigNumber
): Promise<ExternalTakeQuoteEvaluation> {
  if (
    poolConfig.take.liquiditySource !== LiquiditySource.ONEINCH ||
    !poolConfig.take.marketPriceFactor
  ) {
    return {
      isTakeable: false,
      reason: '1inch take settings are not configured',
    };
  }

  return getOneInchPathQuoteEvaluation(
    pool,
    price,
    collateral,
    poolConfig,
    config,
    signer,
    oneInchRouters,
    connectorTokens,
    auctionPriceWad
  );
}

export async function getOneInchPathQuoteEvaluation(
  pool: FungiblePool,
  price: number,
  collateral: BigNumber,
  poolConfig: TakeActionConfig,
  config: Partial<OneInchQuoteConfig>,
  signer: Signer,
  oneInchRouters: { [chainId: number]: string } | undefined,
  connectorTokens: string[] | undefined,
  auctionPriceWad?: BigNumber
): Promise<ExternalTakeQuoteEvaluation> {
  if (!poolConfig.take.marketPriceFactor) {
    return {
      isTakeable: false,
      reason: '1inch marketPriceFactor is not configured',
    };
  }

  if (!collateral.gt(0)) {
    logger.debug(
      `Invalid collateral amount: ${collateral.toString()} for pool ${pool.name}`
    );
    return {
      isTakeable: false,
      reason: 'collateral must be greater than zero',
    };
  }

  try {
    const chainId = await resolveOneInchChainId(config, signer);
    if (!oneInchRouters || !oneInchRouters[chainId]) {
      logger.debug(
        `No 1inch router configured for chainId ${chainId} in pool ${pool.name}`
      );
      return {
        isTakeable: false,
        reason: `missing 1inch router for chain ${chainId}`,
      };
    }

    const dexRouter = new DexRouter(signer, {
      oneInchRouters: oneInchRouters ?? {},
      connectorTokens: connectorTokens ?? [],
    });

    // 1inch expects collateral amounts in token-native decimals, not WAD.
    const collateralDecimals = await getOneInchTokenDecimals({
      signer,
      tokenAddress: pool.collateralAddress,
      chainId,
      cache: config.tokenDecimalsCache,
    });
    const collateralInTokenDecimals = convertWadToTokenDecimals(
      collateral,
      collateralDecimals
    );

    const quoteResult = await dexRouter.getQuoteFromOneInch(
      chainId,
      collateralInTokenDecimals,
      pool.collateralAddress,
      pool.quoteAddress,
      getOneInchRequestOptions(config)
    );

    if (!quoteResult.success) {
      logger.debug(
        `No valid quote data for collateral ${ethers.utils.formatUnits(collateralInTokenDecimals, collateralDecimals)} in pool ${pool.name}: ${quoteResult.error}`
      );
      return {
        isTakeable: false,
        reason: quoteResult.error ?? '1inch quote failed',
        quoteFailureRetryable: quoteResult.retryable,
        quoteFailureCode: quoteResult.errorCode,
      };
    }

    const amountOut = ethers.BigNumber.from(quoteResult.dstAmount);
    if (amountOut.isZero()) {
      logger.debug(
        `Zero amountOut for collateral ${ethers.utils.formatUnits(collateralInTokenDecimals, collateralDecimals)} in pool ${pool.name}`
      );
      return {
        isTakeable: false,
        reason: '1inch returned zero amountOut',
      };
    }

    const quoteDecimals = await getOneInchTokenDecimals({
      signer,
      tokenAddress: pool.quoteAddress,
      chainId,
      cache: config.tokenDecimalsCache,
    });

    const collateralAmount = Number(
      ethers.utils.formatUnits(collateralInTokenDecimals, collateralDecimals)
    );
    const quoteAmount = Number(
      ethers.utils.formatUnits(amountOut, quoteDecimals)
    );

    const marketPrice = quoteAmount / collateralAmount;
    const effectiveAuctionPriceWad = auctionPriceWad ?? decimaledToWei(price);
    const quoteAmountDueRaw = getQuoteAmountDueRawFromDecimals({
      auctionPriceWad: effectiveAuctionPriceWad,
      collateralWad: collateral,
      quoteDecimals,
    });
    const marketFactorFloorQuoteRaw = factoryShared.ceilDiv(
      quoteAmountDueRaw.mul(factoryShared.MARKET_FACTOR_SCALE),
      BigNumber.from(
        factoryShared.getMarketPriceFactorUnits(
          poolConfig.take.marketPriceFactor
        )
      )
    );
    const slippageFloor = factoryShared.getSlippageFloorQuoteRaw(
      amountOut,
      config.oneInchDefaultSlippage
    );
    const policy = applyExternalTakeRoutePolicy({
      configuredMarketPriceFactor: poolConfig.take.marketPriceFactor,
      allowSubsidy: poolConfig.take.allowSubsidy === true,
      quoteAmountRaw: amountOut,
      quoteDueRaw: quoteAmountDueRaw,
      marketFactorFloorQuoteRaw,
      routeMinOutRaw: slippageFloor,
    });
    const takeablePrice = marketPrice * policy.effectiveMarketPriceFactor;

    logger.info(
      `Take check for pool ${pool.name}: marketPrice=${marketPrice.toFixed(6)}, takeablePrice=${takeablePrice.toFixed(6)}, auctionPrice=${price.toFixed(6)}, collateral=${collateralAmount}, factor=${poolConfig.take.marketPriceFactor}, effectiveFactor=${policy.effectiveMarketPriceFactor.toFixed(6)}, subsidy=${policy.expectedSubsidyQuoteRaw.gt(0) ? policy.expectedSubsidyQuoteRaw.toString() : '0'} → ${policy.isEconomicallyExecutable ? 'TAKEABLE' : 'skip'}`
    );

    return mergeRoutePolicyIntoEvaluation({
      evaluation: {
        isTakeable: policy.isEconomicallyExecutable,
        externalTakePath: 'oneinch',
        marketPrice,
        takeablePrice,
        quoteAmount,
        quoteAmountRaw: amountOut,
        selectedLiquiditySource: LiquiditySource.ONEINCH,
        collateralAmount,
        quotedCollateralWad: collateral,
        quotedAuctionPriceWad: effectiveAuctionPriceWad,
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
    logger.error(`Failed to fetch quote data for pool ${pool.name}: ${error}`);
    return {
      isTakeable: false,
      reason: getErrorMessage(error),
    };
  }
}

async function computeOneInchAtomicMinReturnAmount(params: {
  pool: FungiblePool;
  liquidation: Pick<TakeLiquidationPlan, 'auctionPrice' | 'collateral'>;
  quoteEvaluation: ApprovedOneInchQuoteEvaluation;
}): Promise<BigNumber> {
  const quoteAmountDueRaw = await factoryShared.getQuoteAmountDueRaw(
    params.pool,
    params.liquidation.auctionPrice,
    params.liquidation.collateral
  );
  const approvedMinOutRaw = params.quoteEvaluation.approvedMinOutRaw;

  if (approvedMinOutRaw.lt(quoteAmountDueRaw)) {
    throw new Error('1inch approvedMinOutRaw below auction repayment floor');
  }

  return approvedMinOutRaw;
}

type OneInchQuoteApprovalResult =
  | { approved: true; quoteEvaluation: ApprovedOneInchQuoteEvaluation }
  | { approved: false; reason: string };

function approveOneInchQuoteForExecution(params: {
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  poolName: string;
  borrower: string;
}): OneInchQuoteApprovalResult {
  const { quoteEvaluation, poolName, borrower } = params;

  if (!quoteEvaluation.isTakeable) {
    return {
      approved: false,
      reason: `1inch atomic take quote no longer satisfies execution policy for ${poolName}/${borrower}: ${quoteEvaluation.reason ?? 'not takeable'}`,
    };
  }

  if (!quoteEvaluation.quoteAmountRaw) {
    return {
      approved: false,
      reason: `1inch atomic take is missing raw quote amount for ${poolName}/${borrower}; refusing to send an unbounded swap`,
    };
  }

  if (
    quoteEvaluation.externalTakePath !== undefined &&
    quoteEvaluation.externalTakePath !== 'oneinch'
  ) {
    return {
      approved: false,
      reason: `1inch atomic take received non-1inch approved path for ${poolName}/${borrower}`,
    };
  }

  if (
    quoteEvaluation.selectedLiquiditySource !== undefined &&
    quoteEvaluation.selectedLiquiditySource !== LiquiditySource.ONEINCH
  ) {
    return {
      approved: false,
      reason: `1inch atomic take received non-1inch approved source for ${poolName}/${borrower}`,
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
      reason: `1inch atomic take is missing approved min-out floor for ${poolName}/${borrower}; refusing to execute an unbound swap`,
    };
  }

  return {
    approved: true,
    quoteEvaluation: {
      ...quoteEvaluation,
      isTakeable: true,
      externalTakePath: 'oneinch',
      quoteAmountRaw: quoteEvaluation.quoteAmountRaw,
      selectedLiquiditySource: LiquiditySource.ONEINCH,
      approvedMinOutRaw,
    },
  };
}

interface TakeLiquidationParams {
  pool: FungiblePool;
  signer: Signer;
  poolConfig: TakeActionConfig;
  liquidation: TakeLiquidationPlan;
  config: OneInchExecutionConfig;
}

export async function takeLiquidation({
  pool,
  poolConfig,
  signer,
  liquidation,
  config,
}: TakeLiquidationParams): Promise<boolean> {
  const { borrower } = liquidation;
  const { dryRun } = config;

  const suppliedQuoteEvaluation = liquidation.externalTakeQuoteEvaluation;
  const usesOneInchExecutionPath =
    poolConfig.take.liquiditySource === LiquiditySource.ONEINCH ||
    suppliedQuoteEvaluation?.externalTakePath === 'oneinch' ||
    suppliedQuoteEvaluation?.selectedLiquiditySource ===
      LiquiditySource.ONEINCH;
  if (!usesOneInchExecutionPath) {
    logger.error(
      `Valid liquidity source not configured. Skipping liquidation of poolAddress: ${pool.poolAddress}, borrower: ${borrower}.`
    );
    return false;
  }

  let attemptedSubmission = false;
  try {
    const quoteEvaluation =
      suppliedQuoteEvaluation ??
      (await getOneInchTakeQuoteEvaluation(
        pool,
        Number(weiToDecimaled(liquidation.auctionPrice)),
        liquidation.collateral,
        poolConfig,
        {
          oneInchRequestTimeoutMs: config.oneInchRequestTimeoutMs,
          oneInchRequestAbortSignal: config.oneInchRequestAbortSignal,
          oneInchDefaultSlippage: config.oneInchDefaultSlippage,
          chainId: config.chainId,
          tokenDecimalsCache: config.tokenDecimalsCache,
        },
        signer,
        config.oneInchRouters,
        config.connectorTokens,
        liquidation.auctionPrice
      ));

    const approval = approveOneInchQuoteForExecution({
      quoteEvaluation,
      poolName: pool.name,
      borrower,
    });
    if (!approval.approved) {
      logger.error(approval.reason);
      return false;
    }
    const approvedQuoteEvaluation = approval.quoteEvaluation;

    if (dryRun) {
      logger.info(
        `DryRun - would Take - poolAddress: ${pool.poolAddress}, borrower: ${borrower} using ${approvedQuoteEvaluation.selectedLiquiditySource}, approvedMinOutRaw=${approvedQuoteEvaluation.approvedMinOutRaw.toString()}`
      );
      return true;
    }

    const takeWriteTransport = resolveTakeWriteTransport(signer, config);
    const keeperTaker = AjnaKeeperTaker__factory.connect(
      config.keeperTaker!,
      signer
    );

    const dexRouter = new DexRouter(signer, {
      oneInchRouters: config.oneInchRouters ?? {},
      connectorTokens: config.connectorTokens ?? [],
    });
    const chainId = await resolveOneInchChainId(config, signer);
    const configuredOneInchRouter = dexRouter.getRouter(chainId);
    if (!configuredOneInchRouter) {
      const error = `missing 1inch router for chain ${chainId}`;
      config.onOneInchSwapDataResult?.({
        success: false,
        retryable: false,
        error,
      });
      logger.error(
        `1inch atomic take cannot request swap data for ${pool.name}/${borrower}: ${error}`
      );
      return false;
    }

    const collateralDecimals = await getOneInchTokenDecimals({
      signer,
      tokenAddress: pool.collateralAddress,
      chainId,
      cache: config.tokenDecimalsCache,
    });
    const collateralInTokenDecimals = convertWadToTokenDecimals(
      liquidation.collateral,
      collateralDecimals
    );

    const swapData = await dexRouter.getSwapDataFromOneInch(
      chainId,
      collateralInTokenDecimals,
      pool.collateralAddress,
      pool.quoteAddress,
      config.oneInchDefaultSlippage ?? 1,
      keeperTaker.address,
      true,
      getOneInchRequestOptions(config)
    );
    if (!swapData.success || !swapData.data) {
      config.onOneInchSwapDataResult?.({
        success: false,
        retryable: swapData.retryable,
        errorCode: swapData.errorCode,
        error: swapData.error,
      });
      logger.error(
        `1inch atomic swap data request failed for ${pool.name}/${borrower}: ${swapData.error ?? 'unknown error'}`
      );
      return false;
    }
    const swapDetails = convertSwapApiResponseToDetails(swapData.data);
    const allowedAggregationExecutors =
      config.oneInchAggregationExecutorAllowlist?.[chainId];
    const swapDetailsValidationError = validateOneInchSwapDetailsForAtomicTake(
      swapDetails,
      {
        srcToken: pool.collateralAddress,
        dstToken: pool.quoteAddress,
        srcReceiver: configuredOneInchRouter,
        dstReceiver: keeperTaker.address,
        amount: collateralInTokenDecimals,
        aggregationExecutors: allowedAggregationExecutors,
      }
    );
    if (swapDetailsValidationError) {
      config.onOneInchSwapDataResult?.({
        success: false,
        retryable: false,
        error: swapDetailsValidationError,
      });
      logger.error(
        `1inch atomic swap data validation failed for ${pool.name}/${borrower}: ${swapDetailsValidationError}`
      );
      return false;
    }
    logger.info(
      `1inch atomic take swap validated - pool: ${pool.name}, borrower: ${borrower}, executor: ${swapDetails.aggregationExecutor}, srcReceiver: ${swapDetails.swapDescription.srcReceiver}, allowlist: ${allowedAggregationExecutors ? 'configured' : 'not_configured'}`
    );

    const requiredMinReturnAmount = await computeOneInchAtomicMinReturnAmount({
      pool,
      liquidation,
      quoteEvaluation: approvedQuoteEvaluation,
    });

    const routeMinReturnAmount = BigNumber.from(
      swapDetails.swapDescription.minReturnAmount
    );
    const executionMinReturnAmount = routeMinReturnAmount.lt(
      requiredMinReturnAmount
    )
      ? requiredMinReturnAmount
      : routeMinReturnAmount;
    if (swapData.dstAmount !== undefined) {
      const freshSwapDstAmount = BigNumber.from(swapData.dstAmount);
      if (freshSwapDstAmount.lt(executionMinReturnAmount)) {
        config.onOneInchSwapDataResult?.({
          success: false,
          retryable: false,
          error: '1inch swap data expected output below execution floor',
        });
        logger.warn(
          `1inch atomic swap data expected output ${freshSwapDstAmount.toString()} is below execution floor ${executionMinReturnAmount.toString()} for ${pool.name}/${borrower}; refusing to estimate or submit`
        );
        return false;
      }
    }
    config.onOneInchSwapDataResult?.({ success: true });
    if (routeMinReturnAmount.lt(executionMinReturnAmount)) {
      swapDetails.swapDescription = {
        ...swapDetails.swapDescription,
        minReturnAmount: executionMinReturnAmount,
      };
    }
    const swapDetailsBytes = encodeOneInchSwapDetailsBytes(swapDetails);

    logger.debug(
      `Preparing takeWithAtomicSwap transaction:\n` +
        `  Pool: ${pool.poolAddress}\n` +
        `  Borrower: ${liquidation.borrower}\n` +
        `  Auction Price (WAD): ${liquidation.auctionPrice.toString()}\n` +
        `  Collateral (WAD): ${liquidation.collateral.toString()}\n` +
        `  Collateral (Token Decimals): ${collateralInTokenDecimals.toString()}\n` +
        `  Liquidity Source: ${LiquiditySource.ONEINCH}\n` +
        `  1inch Router: ${configuredOneInchRouter}\n` +
        `  Required Min Return: ${executionMinReturnAmount.toString()}\n` +
        `  Swap Data Length: ${swapData.data.length} chars`
    );

    logger.debug(
      `Sending Take Tx - poolAddress: ${pool.poolAddress}, borrower: ${borrower}`
    );
    await NonceTracker.queueTransaction(
      takeWriteTransport.signer,
      async (nonce: number) => {
        const txArgs = [
          pool.poolAddress,
          liquidation.borrower,
          liquidation.auctionPrice,
          liquidation.collateral,
          Number(LiquiditySource.ONEINCH),
          configuredOneInchRouter,
          swapDetailsBytes,
        ] as const;
        const gasLimit = await estimateGasWithBuffer(
          () => keeperTaker.estimateGas.takeWithAtomicSwap(...txArgs),
          `Take ${pool.name}/${borrower}`,
          13000
        );
        const txRequest =
          await keeperTaker.populateTransaction.takeWithAtomicSwap(...txArgs, {
            gasLimit,
            nonce: nonce.toString(),
          });
        const receipt = await submitTakeTransaction(
          takeWriteTransport,
          txRequest,
          () => {
            attemptedSubmission = true;
          }
        );
        logTakeExecutionTelemetry({
          path: 'oneinch',
          source: LiquiditySource.ONEINCH,
          poolName: pool.name,
          poolAddress: pool.poolAddress,
          borrower,
          receipt,
          routeProfitability: approvedQuoteEvaluation.routeProfitability,
          approvedMinOutRaw: executionMinReturnAmount,
          takeWriteTransport,
        });
        logger.info(
          `Take successful - pool: ${pool.name}, borrower: ${borrower} | tx: ${receipt.transactionHash}`
        );
        return receipt;
      }
    );
    return true;
  } catch (error) {
    config.onOneInchExecutionFailure?.({
      preBroadcast:
        !attemptedSubmission && !isNonceConsumedTransactionError(error),
      error: getErrorMessage(error),
    });
    logger.error(
      `Failed to Take. pool: ${pool.name}, borrower: ${borrower}`,
      error
    );
    return false;
  }
}
