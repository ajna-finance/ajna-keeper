import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber, ethers } from 'ethers';
import { CurvePoolType, LiquiditySource } from '../../config';
import { logger } from '../../logging';
import { NonceTracker } from '../../nonce';
import {
  ExternalTakeQuoteEvaluation,
  TakeActionConfig,
  TakeLiquidationPlan,
} from '../types';
import { estimateGasWithBuffer, weiToDecimaled } from '../../utils';
import { AjnaKeeperTakerFactory__factory } from '../../../typechain-types';
import {
  FactoryExecutionConfig,
  FactoryQuoteConfig,
  FactoryQuoteProviderRuntimeCache,
  FactoryRouteEvaluationContext,
  buildFactoryRouteEvaluationContext,
  buildFactoryQuoteEvaluation,
  computeFactoryAmountOutMinimum,
  formatFactoryExecutionLog,
  formatFactoryPriceCheckLog,
  formatFactoryQuoteRequestLog,
  formatFactoryTakeSubmissionLog,
  getCurveQuoteProvider,
  getSlippageFloorQuoteRaw,
  getSwapDeadline,
} from './shared';
import {
  resolveTakeWriteTransport,
  submitTakeTransaction,
} from '../write-transport';
import { logTakeExecutionTelemetry } from '../execution-telemetry';

const CURVE_L2_PROPAGATION_DELAY_MS = 2_000;

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

    const quoteResult = await quoteProvider.getQuote(
      context.collateralInTokenDecimals,
      pool.collateralAddress,
      pool.quoteAddress,
      {
        inputDecimals: context.collateralTokenDecimals,
        outputDecimals: context.quoteTokenDecimals,
      }
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
      reason: error instanceof Error ? error.message : String(error),
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
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  config: Pick<
    FactoryExecutionConfig,
    | 'keeperTakerFactory'
    | 'curveRouterOverrides'
    | 'tokenAddresses'
    | 'takeWriteTransport'
  >;
}): Promise<void> {
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
  if (!quoteEvaluation.curvePool) {
    const message = `Factory: selected Curve pool required for ${pool.collateralAddress}/${pool.quoteAddress}`;
    logger.error(message);
    throw new Error(message);
  }

  try {
    const resolvedCurvePool = quoteEvaluation.curvePool;

    logger.debug(
      `Factory: Found Curve pool tokens: ${pool.collateralAddress}@${resolvedCurvePool.tokenInIndex}, ${pool.quoteAddress}@${resolvedCurvePool.tokenOutIndex}`
    );

    const minimalAmountOut = await computeFactoryAmountOutMinimum({
      pool,
      liquidation,
      quoteEvaluation,
      marketPriceFactor: poolConfig.take.marketPriceFactor!,
    });
    const deadline = await getSwapDeadline(signer);

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

    logger.debug(
      `Adding ${CURVE_L2_PROPAGATION_DELAY_MS}ms state propagation delay before factory take (L2 sequencer protection)`
    );
    await new Promise((resolve) =>
      setTimeout(resolve, CURVE_L2_PROPAGATION_DELAY_MS)
    );

    const receipt = await NonceTracker.queueTransaction(
      takeWriteTransport.signer,
      async (nonce: number) => {
        const fallbackGasLimit = ethers.BigNumber.from(1_500_000);
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
          fallbackGasLimit,
          `Factory Curve take ${pool.name}/${liquidation.borrower}`
        );
        const txRequest = await factory.populateTransaction.takeWithAtomicSwap(
          ...txArgs,
          {
            gasLimit,
            nonce: nonce.toString(),
          }
        );
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
    throw error;
  }
}
