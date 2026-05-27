import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber, ethers } from 'ethers';
import { DEFAULT_FEE_TIER_BY_SOURCE, LiquiditySource } from '../../config';
import { logger } from '../../logging';
import { NonceTracker } from '../../nonce';
import {
  ApprovedUniswapV3FactoryQuoteEvaluation,
  ExternalTakeQuoteEvaluation,
  TakeActionConfig,
  TakeLiquidationPlan,
} from '../types';
import {
  estimateGasWithBuffer,
  getErrorMessage,
  TAKE_WRITE_GAS_ESTIMATE_OPTIONS,
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
  getSlippageFloorQuoteRaw,
  getUniswapV3QuoteProvider,
  getSwapDeadlineCached,
  requireConfiguredUniswapSwapRouterAddress,
} from './shared';
import {
  resolveTakeWriteTransport,
  submitTakeTransaction,
} from '../write-transport';
import { logTakeExecutionTelemetry } from '../execution-telemetry';

export async function evaluateUniswapV3FactoryQuote({
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
  config: Pick<FactoryQuoteConfig, 'uniswapV3RouterOverrides'>;
  signer: Signer;
  runtimeCache?: FactoryQuoteProviderRuntimeCache;
  feeTier?: number;
  routeContext?: FactoryRouteEvaluationContext;
}): Promise<ExternalTakeQuoteEvaluation> {
  if (!config.uniswapV3RouterOverrides) {
    logger.debug(
      `Factory: No uniswapV3RouterOverrides configured for pool ${pool.name}`
    );
    return {
      isTakeable: false,
      reason: 'missing uniswapV3RouterOverrides',
    };
  }

  const routerConfig = config.uniswapV3RouterOverrides;

  if (
    !routerConfig.poolFactoryAddress ||
    !routerConfig.wethAddress
  ) {
    logger.debug(
      `Factory: Missing required router configuration for pool ${pool.name}`
    );
    return {
      isTakeable: false,
      reason: 'missing required Uniswap router configuration',
    };
  }

  try {
    const quoteProvider = getUniswapV3QuoteProvider({
      signer,
      routerConfig,
      runtimeCache,
    });
    if (!quoteProvider) {
      logger.debug(
        `Factory: UniswapV3QuoteProvider not available for pool ${pool.name}`
      );
      return {
        isTakeable: false,
        reason: 'Uniswap V3 quote provider unavailable',
      };
    }

    const quoterAddress = quoteProvider.getQuoterAddress();
    logger.debug(
      `Factory: Using QuoterV2 at ${quoterAddress} for pool ${pool.name}`
    );

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
      routerConfig.defaultFeeTier ??
      DEFAULT_FEE_TIER_BY_SOURCE[LiquiditySource.UNISWAPV3];
    logger.debug(
      formatFactoryQuoteRequestLog({
        source: LiquiditySource.UNISWAPV3,
        poolName: pool.name,
        collateralAmount: ethers.utils.formatUnits(
          context.collateralInTokenDecimals,
          context.collateralTokenDecimals
        ),
        feeTier: selectedFeeTier,
      })
    );

    const quoteResult = await withTimeout(
      quoteProvider.getQuote(
        context.collateralInTokenDecimals,
        pool.collateralAddress,
        pool.quoteAddress,
        selectedFeeTier,
        {
          inputDecimals: context.collateralTokenDecimals,
          outputDecimals: context.quoteTokenDecimals,
        }
      ),
      DEFAULT_FACTORY_ROUTE_RPC_TIMEOUT_MS,
      'Uniswap V3 quote'
    );

    if (!quoteResult.success || !quoteResult.dstAmount) {
      logger.debug(
        `Factory: Failed to get official Uniswap V3 quote for pool ${pool.name}: ${quoteResult.error}`
      );
      return {
        isTakeable: false,
        reason: quoteResult.error ?? 'Uniswap V3 quote failed',
      };
    }

    const quoteAmountRaw = BigNumber.from(quoteResult.dstAmount);
    const collateralAmount = context.collateralAmount;
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
        reason: 'invalid Uniswap V3 quote amounts',
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
      selectedLiquiditySource: LiquiditySource.UNISWAPV3,
      selectedFeeTier,
      existingSlippageFloorQuoteRaw: getSlippageFloorQuoteRaw(
        quoteAmountRaw,
        routerConfig.defaultSlippage
      ),
      allowSubsidy: poolConfig.take.allowSubsidy === true,
      routeContext: context,
      failureReason:
        'quoted output below required Uniswap V3 profitability floor',
    });

    logger.debug(
      formatFactoryPriceCheckLog({
        source: LiquiditySource.UNISWAPV3,
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
    logger.error(
      `Factory: Error getting official Uniswap V3 quote for pool ${pool.name}: ${error}`
    );
    return {
      isTakeable: false,
      reason: getErrorMessage(error),
    };
  }
}

export async function executeUniswapV3FactoryTake({
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
  quoteEvaluation: ApprovedUniswapV3FactoryQuoteEvaluation;
  config: Pick<
    FactoryExecutionConfig,
    | 'keeperTakerFactory'
    | 'uniswapV3RouterOverrides'
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

    if (!config.uniswapV3RouterOverrides) {
      const message =
        'Factory: uniswapV3RouterOverrides required for UniswapV3 takes';
      logger.error(message);
      throw new Error(message);
    }
    const swapRouterAddress = requireConfiguredUniswapSwapRouterAddress(
      config.uniswapV3RouterOverrides,
      pool.name
    );
    const routerAmountOutMinimum = await computeFactoryAmountOutMinimum({
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
        source: LiquiditySource.UNISWAPV3,
        poolName: pool.name,
        collateralWad: liquidation.collateral,
        auctionPriceWad: liquidation.auctionPrice,
        minimalAmountOut: routerAmountOutMinimum,
      })
    );

    const swapDetails = {
      swapRouter: swapRouterAddress,
      targetToken: pool.quoteAddress,
      feeTier: quoteEvaluation.selectedFeeTier,
      amountOutMinimum: routerAmountOutMinimum,
      deadline,
    };

    const encodedSwapDetails = ethers.utils.defaultAbiCoder.encode(
      ['(address,address,uint24,uint256,uint256)'],
      [
        [
          swapDetails.swapRouter,
          swapDetails.targetToken,
          swapDetails.feeTier,
          swapDetails.amountOutMinimum,
          swapDetails.deadline,
        ],
      ]
    );

    logger.debug(
      formatFactoryTakeSubmissionLog({
        source: LiquiditySource.UNISWAPV3,
        poolAddress: pool.poolAddress,
        borrower: liquidation.borrower,
      })
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
          Number(LiquiditySource.UNISWAPV3),
          swapDetails.swapRouter,
          encodedSwapDetails,
        ] as const;
        const gasLimit = await estimateGasWithBuffer(
          () => factory.estimateGas.takeWithAtomicSwap(...txArgs),
          fallbackGasLimit,
          `Factory Uniswap take ${pool.name}/${liquidation.borrower}`,
          13000,
          TAKE_WRITE_GAS_ESTIMATE_OPTIONS
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
      source: LiquiditySource.UNISWAPV3,
      poolName: pool.name,
      poolAddress: pool.poolAddress,
      borrower: liquidation.borrower,
      receipt,
      routeProfitability: quoteEvaluation.routeProfitability,
      approvedMinOutRaw: quoteEvaluation.approvedMinOutRaw,
      selectedFeeTier: quoteEvaluation.selectedFeeTier,
      takeWriteTransport,
    });

    logger.info(
      `Factory Uniswap V3 Take successful - poolAddress: ${pool.poolAddress}, borrower: ${liquidation.borrower}`
    );
  } catch (error) {
    logger.error(
      `Factory: Failed to Uniswap V3 Take. pool: ${pool.name}, borrower: ${liquidation.borrower}`,
      error
    );
    config.onFactoryExecutionFailure?.({
      preBroadcast: !attemptedSubmission,
      error: getErrorMessage(error),
    });
    throw error;
  }
}
