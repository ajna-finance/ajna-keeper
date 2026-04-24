import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber, ethers } from 'ethers';
import { DEFAULT_FEE_TIER_BY_SOURCE, LiquiditySource } from '../../config';
import { logger } from '../../logging';
import { NonceTracker } from '../../nonce';
import { ExternalTakeQuoteEvaluation, TakeActionConfig, TakeLiquidationPlan } from '../types';
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
  getSlippageFloorQuoteRaw,
  getSushiSwapQuoteProvider,
  getSwapDeadline,
} from './shared';
import {
  resolveTakeWriteTransport,
  submitTakeTransaction,
} from '../write-transport';

export async function evaluateSushiSwapFactoryQuote({
  pool,
  auctionPriceWad,
  collateral,
  poolConfig,
  config,
  signer,
  runtimeCache,
  feeTier,
  routeContext,
}: {
  pool: FungiblePool;
  auctionPriceWad: BigNumber;
  collateral: BigNumber;
  poolConfig: TakeActionConfig;
  config: Pick<FactoryQuoteConfig, 'sushiswapRouterOverrides'>;
  signer: Signer;
  runtimeCache?: FactoryQuoteProviderRuntimeCache;
  feeTier?: number;
  routeContext?: FactoryRouteEvaluationContext;
}): Promise<ExternalTakeQuoteEvaluation> {
  if (!config.sushiswapRouterOverrides) {
    logger.debug(`Factory: No sushiswapRouterOverrides configured for pool ${pool.name}`);
    return {
      isTakeable: false,
      reason: 'missing sushiswapRouterOverrides',
    };
  }

  const sushiConfig = config.sushiswapRouterOverrides;

  if (
    !sushiConfig.swapRouterAddress ||
    !sushiConfig.factoryAddress ||
    !sushiConfig.wethAddress
  ) {
    logger.debug(`Factory: Missing required SushiSwap configuration for pool ${pool.name}`);
    return {
      isTakeable: false,
      reason: 'missing required SushiSwap configuration',
    };
  }

  try {
    const quoteProvider = await getSushiSwapQuoteProvider({
      signer,
      routerConfig: sushiConfig,
      runtimeCache,
    });
    if (!quoteProvider) {
      logger.debug(`Factory: SushiSwap quote provider not available for pool ${pool.name}`);
      return {
        isTakeable: false,
        reason: 'SushiSwap quote provider unavailable',
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

    const selectedFeeTier =
      feeTier ??
      sushiConfig.defaultFeeTier ??
      DEFAULT_FEE_TIER_BY_SOURCE[LiquiditySource.SUSHISWAP];
    logger.debug(
      formatFactoryQuoteRequestLog({
        source: LiquiditySource.SUSHISWAP,
        poolName: pool.name,
        collateralAmount: ethers.utils.formatUnits(
          context.collateralInTokenDecimals,
          context.collateralTokenDecimals
        ),
        feeTier: selectedFeeTier,
      })
    );

    const quoteResult = await quoteProvider.getQuote(
      context.collateralInTokenDecimals,
      pool.collateralAddress,
      pool.quoteAddress,
      selectedFeeTier,
      {
        inputDecimals: context.collateralTokenDecimals,
        outputDecimals: context.quoteTokenDecimals,
      }
    );

    if (!quoteResult.success || !quoteResult.dstAmount) {
      logger.debug(`Factory: Failed to get SushiSwap quote for pool ${pool.name}: ${quoteResult.error}`);
      return {
        isTakeable: false,
        reason: quoteResult.error ?? 'SushiSwap quote failed',
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
        reason: 'invalid SushiSwap quote amounts',
      };
    }

    const marketPriceFactor = poolConfig.take.marketPriceFactor;
    if (!marketPriceFactor) {
      logger.debug(`Factory: No marketPriceFactor configured for pool ${pool.name}`);
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
      selectedLiquiditySource: LiquiditySource.SUSHISWAP,
      selectedFeeTier,
      existingSlippageFloorQuoteRaw: getSlippageFloorQuoteRaw(
        quoteAmountRaw,
        sushiConfig.defaultSlippage
      ),
      routeContext: context,
      failureReason:
        'quoted output below required SushiSwap profitability floor',
    });

    logger.debug(
      formatFactoryPriceCheckLog({
        source: LiquiditySource.SUSHISWAP,
        poolName: pool.name,
        auctionPrice,
        marketPrice: evaluation.marketPrice,
        takeablePrice: evaluation.takeablePrice,
        feeTier: selectedFeeTier,
        profitable: evaluation.isTakeable,
      })
    );

    return evaluation;
  } catch (error) {
    logger.error(`Factory: Error getting SushiSwap quote for pool ${pool.name}: ${error}`);
    return {
      isTakeable: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function executeSushiSwapFactoryTake({
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
    'keeperTakerFactory' | 'sushiswapRouterOverrides' | 'takeWriteTransport'
  >;
}): Promise<void> {
  const takeWriteTransport = resolveTakeWriteTransport(signer, config);
  const factory = AjnaKeeperTakerFactory__factory.connect(
    config.keeperTakerFactory!,
    signer
  );

  if (!config.sushiswapRouterOverrides) {
    const message = 'Factory: sushiswapRouterOverrides required for SushiSwap takes';
    logger.error(message);
    throw new Error(message);
  }
  if (quoteEvaluation.selectedFeeTier === undefined) {
    const message = 'Factory: selectedFeeTier required for SushiSwap takes';
    logger.error(message);
    throw new Error(message);
  }

  const minimalAmountOut = await computeFactoryAmountOutMinimum({
    pool,
    liquidation,
    quoteEvaluation,
    marketPriceFactor: poolConfig.take.marketPriceFactor!,
  });
  const deadline = await getSwapDeadline(signer);

  logger.debug(
    formatFactoryExecutionLog({
      source: LiquiditySource.SUSHISWAP,
      poolName: pool.name,
      collateralWad: liquidation.collateral,
      auctionPriceWad: liquidation.auctionPrice,
      minimalAmountOut,
    })
  );

  const swapDetails = {
    swapRouter: config.sushiswapRouterOverrides.swapRouterAddress!,
    targetToken: pool.quoteAddress,
    feeTier: quoteEvaluation.selectedFeeTier,
    amountOutMinimum: minimalAmountOut,
    deadline,
  };

  const encodedSwapDetails = ethers.utils.defaultAbiCoder.encode(
    ['uint24', 'uint256', 'uint256'],
    [swapDetails.feeTier, swapDetails.amountOutMinimum, swapDetails.deadline]
  );

  try {
    logger.debug(
      formatFactoryTakeSubmissionLog({
        source: LiquiditySource.SUSHISWAP,
        poolAddress: pool.poolAddress,
        borrower: liquidation.borrower,
      })
    );

    await NonceTracker.queueTransaction(takeWriteTransport.signer, async (nonce: number) => {
      const fallbackGasLimit = ethers.BigNumber.from(1_500_000);
      const txArgs = [
        pool.poolAddress,
        liquidation.borrower,
        liquidation.auctionPrice,
        liquidation.collateral,
        Number(LiquiditySource.SUSHISWAP),
        swapDetails.swapRouter,
        encodedSwapDetails,
      ] as const;
      const gasLimit = await estimateGasWithBuffer(
        () => factory.estimateGas.takeWithAtomicSwap(...txArgs),
        fallbackGasLimit,
        `Factory Sushi take ${pool.name}/${liquidation.borrower}`
      );
      const txRequest = await factory.populateTransaction.takeWithAtomicSwap(...txArgs, {
        gasLimit,
        nonce: nonce.toString(),
      });
      return await submitTakeTransaction(takeWriteTransport, txRequest);
    });

    logger.info(
      `Factory SushiSwap Take successful - poolAddress: ${pool.poolAddress}, borrower: ${liquidation.borrower}`
    );
  } catch (error) {
    logger.error(
      `Factory: Failed to SushiSwap Take. pool: ${pool.name}, borrower: ${liquidation.borrower}`,
      error
    );
    throw error;
  }
}
