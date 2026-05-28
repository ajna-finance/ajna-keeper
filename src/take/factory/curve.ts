import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber, ethers } from 'ethers';
import { CurvePoolType, LiquiditySource } from '../../config';
import { logger } from '../../logging';
import { NonceTracker } from '../../nonce';
import {
  ApprovedCurveFactoryQuoteEvaluation,
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
import { AjnaKeeperTakerFactory__factory } from '../../../typechain-types';
import {
  FactoryExecutionConfig,
  FactoryQuoteConfig,
  FactoryQuoteProviderRuntimeCache,
  FactoryRouteEvaluationContext,
  buildFactoryRouteEvaluationContext,
  buildFactoryQuoteEvaluation,
  computeFactoryAmountOutMinimum,
  DEFAULT_FACTORY_ROUTE_RPC_TIMEOUT_MS,
  formatFactoryExecutionLog,
  formatFactoryPriceCheckLog,
  formatFactoryQuoteRequestLog,
  formatFactoryTakeSubmissionLog,
  getCurveQuoteProvider,
  getSlippageFloorQuoteRaw,
  getSwapDeadlineCached,
} from './shared';
import {
  resolveTakeWriteTransport,
  submitTakeTransaction,
} from '../write-transport';
import { logTakeExecutionTelemetry } from '../execution-telemetry';

export async function evaluateCurveFactoryQuote({
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
  config: Pick<FactoryQuoteConfig, 'curveRouterOverrides' | 'tokenAddresses'>;
  signer: Signer;
  runtimeCache?: FactoryQuoteProviderRuntimeCache;
  routeContext?: FactoryRouteEvaluationContext;
}): Promise<ExternalTakeQuoteEvaluation> {
  if (!config.curveRouterOverrides) {
    logger.debug(
      `Factory: No curveRouterOverrides configured for pool ${pool.name}`
    );
    return {
      isTakeable: false,
      reason: 'missing curveRouterOverrides',
    };
  }

  const curveConfig = config.curveRouterOverrides;

  if (!curveConfig.poolConfigs || !curveConfig.wethAddress) {
    logger.debug(
      `Factory: Missing required Curve configuration for pool ${pool.name}`
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
        `Factory: Curve quote provider not available for pool ${pool.name}`
      );
      return {
        isTakeable: false,
        reason: 'Curve quote provider unavailable',
      };
    }

    const context =
      routeContext ??
      (await buildFactoryRouteEvaluationContext({
        pool,
        signer,
        auctionPriceWad,
        collateral,
        marketPriceFactor: poolConfig.take.marketPriceFactor!,
        runtimeCache,
      }));

    logger.debug(
      formatFactoryQuoteRequestLog({
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
      DEFAULT_FACTORY_ROUTE_RPC_TIMEOUT_MS,
      'Curve quote'
    );

    if (!quoteResult.success || !quoteResult.dstAmount) {
      logger.debug(
        `Factory: Failed to get Curve quote for pool ${pool.name}: ${quoteResult.error}`
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
        `Factory: Invalid amounts - collateral: ${collateralAmount}, quote: ${quoteAmount} for pool ${pool.name}`
      );
      return {
        isTakeable: false,
        reason: 'invalid Curve quote amounts',
      };
    }

    const marketPriceFactor = poolConfig.take.marketPriceFactor;
    if (!marketPriceFactor) {
      logger.debug(
        `Factory: No marketPriceFactor configured for pool ${pool.name}`
      );
      return {
        isTakeable: false,
        reason: 'marketPriceFactor is not configured',
      };
    }

    const evaluation = await buildFactoryQuoteEvaluation({
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
      formatFactoryPriceCheckLog({
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
      `Factory: Error getting Curve quote for pool ${pool.name}: ${error}`
    );
    return {
      isTakeable: false,
      reason: getErrorMessage(error),
    };
  }
}

export async function executeCurveFactoryTake({
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
  quoteEvaluation: ApprovedCurveFactoryQuoteEvaluation;
  config: Pick<
    FactoryExecutionConfig,
    | 'keeperTakerFactory'
    | 'curveRouterOverrides'
    | 'tokenAddresses'
    | 'takeWriteTransport'
    | 'runtimeCache'
    | 'onFactoryExecutionFailure'
  >;
}): Promise<void> {
  let attemptedSubmission = false;
  try {
    const takeWriteTransport = resolveTakeWriteTransport(signer, config);
    const factory = AjnaKeeperTakerFactory__factory.connect(
      config.keeperTakerFactory!,
      signer
    );

    if (!config.curveRouterOverrides) {
      const message = 'Factory: curveRouterOverrides required for Curve takes';
      logger.error(message);
      throw new Error(message);
    }
    const resolvedCurvePool = quoteEvaluation.curvePool;

    logger.debug(
      `Factory: Found Curve pool tokens: ${pool.collateralAddress}@${resolvedCurvePool.tokenInIndex}, ${pool.quoteAddress}@${resolvedCurvePool.tokenOutIndex}`
    );

    const minimalAmountOut = await computeFactoryAmountOutMinimum({
      pool,
      liquidation,
      quoteEvaluation,
    });
    const deadline = await getSwapDeadlineCached({
      signer,
      runtimeCache: config.runtimeCache,
    });

    logger.debug(
      formatFactoryExecutionLog({
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
      formatFactoryTakeSubmissionLog({
        source: LiquiditySource.CURVE,
        poolAddress: pool.poolAddress,
        borrower: liquidation.borrower,
      })
    );

    const executionDelayMs = config.curveRouterOverrides.executionDelayMs ?? 0;
    if (executionDelayMs > 0) {
      logger.debug(
        `Adding ${executionDelayMs}ms Curve execution delay before factory take`
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
          () => factory.estimateGas.takeWithAtomicSwap(...txArgs),
          `Factory Curve take ${pool.name}/${liquidation.borrower}`,
          13000
        );
        const txRequest = await factory.populateTransaction.takeWithAtomicSwap(
          ...txArgs,
          {
            gasLimit,
            nonce: nonce.toString(),
          }
        );
        attemptedSubmission = true;
        return await submitTakeTransaction(takeWriteTransport, txRequest);
      }
    );
    logTakeExecutionTelemetry({
      path: 'factory',
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
      `Factory Curve Take successful - poolAddress: ${pool.poolAddress}, borrower: ${liquidation.borrower}`
    );
  } catch (error) {
    logger.error(
      `Factory: Failed to Curve Take. pool: ${pool.name}, borrower: ${liquidation.borrower}`,
      error
    );
    config.onFactoryExecutionFailure?.({
      preBroadcast: !attemptedSubmission,
      error: getErrorMessage(error),
    });
    throw error;
  }
}
