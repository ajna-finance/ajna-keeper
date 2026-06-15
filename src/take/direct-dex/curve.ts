import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber, ethers } from 'ethers';
import { CurvePoolType, LiquiditySource } from '../../config';
import { logger } from '../../logging';
import { isNonceConsumedTransactionError, NonceTracker } from '../../nonce';
import {
  ApprovedCurveDirectDexQuoteEvaluation,
  ExternalTakeQuoteEvaluation,
  TakeActionConfig,
  TakeLiquidationPlan,
} from '../types';
import {
  estimateGasWithBuffer,
  getErrorMessage,
  weiToDecimaled,
  withTimeout,
} from '../../utils';
import { TakerRouter__factory } from '../../../typechain-types';
import {
  DirectDexExecutionConfig,
  DirectDexQuoteConfig,
  DirectDexQuoteProviderRuntimeCache,
  DirectDexRouteEvaluationContext,
  buildDirectDexRouteEvaluationContext,
  buildDirectDexQuoteEvaluation,
  computeDirectDexAmountOutMinimum,
  DEFAULT_DIRECT_DEX_ROUTE_RPC_TIMEOUT_MS,
  formatDirectDexExecutionLog,
  formatDirectDexPriceCheckLog,
  formatDirectDexQuoteRequestLog,
  formatDirectDexTakeSubmissionLog,
  getCurveQuoteProvider,
  getSlippageFloorQuoteRaw,
  getSwapDeadlineCached,
} from './route-selection';
import {
  resolveTakeWriteTransport,
  submitTakeTransaction,
} from '../write-transport';
import { logTakeExecutionTelemetry } from '../execution-telemetry';

export async function evaluateCurveDirectDexQuote({
  pool,
  auctionPriceWad,
  collateral,
  poolConfig,
  config,
  signer,
  runtimeCache,
  routeContext,
}: {
  pool: FungiblePool;
  auctionPriceWad: BigNumber;
  collateral: BigNumber;
  poolConfig: TakeActionConfig;
  config: Pick<DirectDexQuoteConfig, 'curveRouterOverrides' | 'tokenAddresses'>;
  signer: Signer;
  runtimeCache?: DirectDexQuoteProviderRuntimeCache;
  routeContext?: DirectDexRouteEvaluationContext;
}): Promise<ExternalTakeQuoteEvaluation> {
  if (!config.curveRouterOverrides) {
    logger.debug(
      `Direct DEX: No curveRouterOverrides configured for pool ${pool.name}`
    );
    return {
      isTakeable: false,
      reason: 'missing curveRouterOverrides',
    };
  }

  const curveConfig = config.curveRouterOverrides;

  if (!curveConfig.poolConfigs || !curveConfig.wethAddress) {
    logger.debug(
      `Direct DEX: Missing required Curve configuration for pool ${pool.name}`
    );
    return {
      isTakeable: false,
      reason: 'missing required Curve configuration',
    };
  }

  try {
    const quoteProvider = await getCurveQuoteProvider({
      signer,
      routerConfig: curveConfig,
      tokenAddresses: config.tokenAddresses,
      runtimeCache,
    });
    if (!quoteProvider) {
      logger.debug(
        `Direct DEX: Curve quote provider not available for pool ${pool.name}`
      );
      return {
        isTakeable: false,
        reason: 'Curve quote provider unavailable',
      };
    }

    const context =
      routeContext ??
      (await buildDirectDexRouteEvaluationContext({
        pool,
        signer,
        auctionPriceWad,
        collateral,
        marketPriceFactor: poolConfig.take.marketPriceFactor!,
        runtimeCache,
      }));

    logger.debug(
      formatDirectDexQuoteRequestLog({
        source: LiquiditySource.CURVE,
        poolName: pool.name,
        collateralAmount: ethers.utils.formatUnits(
          context.collateralInTokenDecimals,
          context.collateralTokenDecimals
        ),
      })
    );

    const quoteResult = await withTimeout(
      quoteProvider.getQuote(
        context.collateralInTokenDecimals,
        pool.collateralAddress,
        pool.quoteAddress,
        {
          inputDecimals: context.collateralTokenDecimals,
          outputDecimals: context.quoteTokenDecimals,
        }
      ),
      DEFAULT_DIRECT_DEX_ROUTE_RPC_TIMEOUT_MS,
      'Curve quote'
    );

    if (!quoteResult.success || !quoteResult.dstAmount) {
      logger.debug(
        `Direct DEX: Failed to get Curve quote for pool ${pool.name}: ${quoteResult.error}`
      );
      return {
        isTakeable: false,
        reason: quoteResult.error ?? 'Curve quote failed',
      };
    }

    const collateralAmount = context.collateralAmount;
    const quoteAmountRaw = quoteResult.dstAmount;
    const quoteAmount = Number(
      ethers.utils.formatUnits(quoteAmountRaw, context.quoteTokenDecimals)
    );
    const auctionPrice = Number(weiToDecimaled(auctionPriceWad));

    if (collateralAmount <= 0 || quoteAmount <= 0) {
      logger.debug(
        `Direct DEX: Invalid amounts - collateral: ${collateralAmount}, quote: ${quoteAmount} for pool ${pool.name}`
      );
      return {
        isTakeable: false,
        reason: 'invalid Curve quote amounts',
      };
    }

    const marketPriceFactor = poolConfig.take.marketPriceFactor;
    if (!marketPriceFactor) {
      logger.debug(
        `Direct DEX: No marketPriceFactor configured for pool ${pool.name}`
      );
      return {
        isTakeable: false,
        reason: 'marketPriceFactor is not configured',
      };
    }

    const evaluation = await buildDirectDexQuoteEvaluation({
      pool,
      auctionPriceWad,
      collateral,
      marketPriceFactor,
      quoteAmountRaw,
      quoteAmount,
      collateralAmount,
      selectedLiquiditySource: LiquiditySource.CURVE,
      existingSlippageFloorQuoteRaw: getSlippageFloorQuoteRaw(
        quoteAmountRaw,
        curveConfig.defaultSlippage
      ),
      allowSubsidy: poolConfig.take.allowSubsidy === true,
      routeContext: context,
      failureReason: 'quoted output below required Curve profitability floor',
    });

    logger.debug(
      formatDirectDexPriceCheckLog({
        source: LiquiditySource.CURVE,
        poolName: pool.name,
        auctionPrice,
        marketPrice: evaluation.marketPrice,
        takeablePrice: evaluation.takeablePrice,
        profitable: evaluation.isTakeable,
      })
    );

    return {
      ...evaluation,
      curvePool: quoteResult.selectedPool,
    };
  } catch (error) {
    logger.error(
      `Direct DEX: Error getting Curve quote for pool ${pool.name}: ${error}`
    );
    return {
      isTakeable: false,
      reason: getErrorMessage(error),
    };
  }
}

export async function executeCurveDirectDexTake({
  pool,
  poolConfig,
  signer,
  liquidation,
  quoteEvaluation,
  config,
}: {
  pool: FungiblePool;
  poolConfig: TakeActionConfig;
  signer: Signer;
  liquidation: TakeLiquidationPlan;
  quoteEvaluation: ApprovedCurveDirectDexQuoteEvaluation;
  config: Pick<
    DirectDexExecutionConfig,
    | 'keeperTakerRouter'
    | 'curveRouterOverrides'
    | 'tokenAddresses'
    | 'takeWriteTransport'
    | 'runtimeCache'
    | 'onDirectDexExecutionFailure'
  >;
}): Promise<void> {
  let attemptedSubmission = false;
  try {
    const takeWriteTransport = resolveTakeWriteTransport(signer, config);
    const router = TakerRouter__factory.connect(
      config.keeperTakerRouter!,
      signer
    );

    if (!config.curveRouterOverrides) {
      const message = 'Direct DEX: curveRouterOverrides required for Curve takes';
      logger.error(message);
      throw new Error(message);
    }
    const resolvedCurvePool = quoteEvaluation.curvePool;

    logger.debug(
      `Direct DEX: Found Curve pool tokens: ${pool.collateralAddress}@${resolvedCurvePool.tokenInIndex}, ${pool.quoteAddress}@${resolvedCurvePool.tokenOutIndex}`
    );

    const minimalAmountOut = await computeDirectDexAmountOutMinimum({
      pool,
      liquidation,
      quoteEvaluation,
    });
    const deadline = await getSwapDeadlineCached({
      signer,
      runtimeCache: config.runtimeCache,
    });

    logger.debug(
      formatDirectDexExecutionLog({
        source: LiquiditySource.CURVE,
        poolName: pool.name,
        collateralWad: liquidation.collateral,
        auctionPriceWad: liquidation.auctionPrice,
        minimalAmountOut,
        extraLines: [
          `Pool Address: ${resolvedCurvePool.address}`,
          `Pool Type: ${resolvedCurvePool.poolType}`,
          `Token Indices: ${resolvedCurvePool.tokenInIndex} -> ${resolvedCurvePool.tokenOutIndex}`,
        ],
      })
    );

    const encodedSwapDetails = ethers.utils.defaultAbiCoder.encode(
      ['address', 'uint8', 'uint8', 'uint8', 'uint256', 'uint256'],
      [
        resolvedCurvePool.address,
        resolvedCurvePool.poolType === CurvePoolType.STABLE ? 0 : 1,
        resolvedCurvePool.tokenInIndex,
        resolvedCurvePool.tokenOutIndex,
        minimalAmountOut,
        deadline,
      ]
    );

    logger.debug(
      formatDirectDexTakeSubmissionLog({
        source: LiquiditySource.CURVE,
        poolAddress: pool.poolAddress,
        borrower: liquidation.borrower,
      })
    );

    const executionDelayMs = config.curveRouterOverrides.executionDelayMs ?? 0;
    if (executionDelayMs > 0) {
      logger.debug(
        `Adding ${executionDelayMs}ms Curve execution delay before direct DEX take`
      );
      await new Promise((resolve) => setTimeout(resolve, executionDelayMs));
    }

    const receipt = await NonceTracker.queueTransaction(
      takeWriteTransport.signer,
      async (nonce: number) => {
        const txArgs = [
          pool.poolAddress,
          liquidation.borrower,
          liquidation.auctionPrice,
          liquidation.collateral,
          Number(LiquiditySource.CURVE),
          resolvedCurvePool.address,
          encodedSwapDetails,
        ] as const;
        const gasLimit = await estimateGasWithBuffer(
          () => router.estimateGas.takeWithAtomicSwap(...txArgs),
          `Direct DEX Curve take ${pool.name}/${liquidation.borrower}`,
          13000
        );
        const txRequest = await router.populateTransaction.takeWithAtomicSwap(
          ...txArgs,
          {
            gasLimit,
            nonce: nonce.toString(),
          }
        );
        return await submitTakeTransaction(
          takeWriteTransport,
          txRequest,
          () => {
            attemptedSubmission = true;
          }
        );
      }
    );
    logTakeExecutionTelemetry({
      path: 'direct_dex',
      source: LiquiditySource.CURVE,
      poolName: pool.name,
      poolAddress: pool.poolAddress,
      borrower: liquidation.borrower,
      receipt,
      routeProfitability: quoteEvaluation.routeProfitability,
      approvedMinOutRaw: quoteEvaluation.approvedMinOutRaw,
      curvePoolAddress: resolvedCurvePool.address,
      takeWriteTransport,
    });

    logger.info(
      `Direct DEX Curve Take successful - poolAddress: ${pool.poolAddress}, borrower: ${liquidation.borrower}`
    );
  } catch (error) {
    logger.error(
      `Direct DEX: Failed to Curve Take. pool: ${pool.name}, borrower: ${liquidation.borrower}`,
      error
    );
    config.onDirectDexExecutionFailure?.({
      preBroadcast:
        !attemptedSubmission && !isNonceConsumedTransactionError(error),
      error: getErrorMessage(error),
    });
    throw error;
  }
}
