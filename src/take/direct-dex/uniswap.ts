import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber, ethers } from 'ethers';
import {
  DEFAULT_FEE_TIER_BY_SOURCE,
  LiquiditySource,
  resolveUniswapV3DirectDexRouteConfig,
} from '../../config';
import { logger } from '../../logging';
import { isNonceConsumedTransactionError, NonceTracker } from '../../nonce';
import {
  ApprovedUniswapV3DirectDexQuoteEvaluation,
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
  getSlippageFloorQuoteRaw,
  getUniswapV3QuoteProvider,
  getSwapDeadlineCached,
} from './route-selection';
import {
  resolveTakeWriteTransport,
  submitTakeTransaction,
} from '../write-transport';
import { logTakeExecutionTelemetry } from '../execution-telemetry';

export async function evaluateUniswapV3DirectDexQuote({
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
  config: Pick<DirectDexQuoteConfig, 'uniswapV3RouterOverrides'>;
  signer: Signer;
  runtimeCache?: DirectDexQuoteProviderRuntimeCache;
  feeTier?: number;
  routeContext?: DirectDexRouteEvaluationContext;
}): Promise<ExternalTakeQuoteEvaluation> {
  const routerConfig = resolveUniswapV3DirectDexRouteConfig(
    config.uniswapV3RouterOverrides
  );
  if (!routerConfig) {
    logger.debug(
      `Direct DEX: Incomplete uniswapV3RouterOverrides configured for pool ${pool.name}`
    );
    return {
      isTakeable: false,
      reason: 'missing required Uniswap V3 direct DEX route configuration',
    };
  }

  try {
    const quoteProvider = getUniswapV3QuoteProvider({
      signer,
      quoteConfig: routerConfig,
      runtimeCache,
    });
    if (!quoteProvider) {
      logger.debug(
        `Direct DEX: UniswapV3QuoteProvider not available for pool ${pool.name}`
      );
      return {
        isTakeable: false,
        reason: 'Uniswap V3 quote provider unavailable',
      };
    }

    const quoterAddress = quoteProvider.getQuoterAddress();
    logger.debug(
      `Direct DEX: Using QuoterV2 at ${quoterAddress} for pool ${pool.name}`
    );

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

    const selectedFeeTier =
      feeTier ??
      routerConfig.defaultFeeTier ??
      DEFAULT_FEE_TIER_BY_SOURCE[LiquiditySource.UNISWAPV3];
    logger.debug(
      formatDirectDexQuoteRequestLog({
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
      DEFAULT_DIRECT_DEX_ROUTE_RPC_TIMEOUT_MS,
      'Uniswap V3 quote'
    );

    if (!quoteResult.success || !quoteResult.dstAmount) {
      logger.debug(
        `Direct DEX: Failed to get official Uniswap V3 quote for pool ${pool.name}: ${quoteResult.error}`
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
        `Direct DEX: Invalid amounts - collateral: ${collateralAmount}, quote: ${quoteAmount} for pool ${pool.name}`
      );
      return {
        isTakeable: false,
        reason: 'invalid Uniswap V3 quote amounts',
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
      formatDirectDexPriceCheckLog({
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
      `Direct DEX: Error getting official Uniswap V3 quote for pool ${pool.name}: ${error}`
    );
    return {
      isTakeable: false,
      reason: getErrorMessage(error),
    };
  }
}

export async function executeUniswapV3DirectDexTake({
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
  quoteEvaluation: ApprovedUniswapV3DirectDexQuoteEvaluation;
  config: Pick<
    DirectDexExecutionConfig,
    | 'keeperTakerRouter'
    | 'uniswapV3RouterOverrides'
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

    const routerConfig = resolveUniswapV3DirectDexRouteConfig(
      config.uniswapV3RouterOverrides
    );
    if (!routerConfig) {
      const message =
        'Direct DEX: complete dex.uniswapV3.router configuration required for UniswapV3 takes';
      logger.error(message);
      throw new Error(message);
    }
    const swapRouterAddress = routerConfig.swapRouter02Address;
    const routerAmountOutMinimum = await computeDirectDexAmountOutMinimum({
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
      formatDirectDexTakeSubmissionLog({
        source: LiquiditySource.UNISWAPV3,
        poolAddress: pool.poolAddress,
        borrower: liquidation.borrower,
      })
    );

    const receipt = await NonceTracker.queueTransaction(
      takeWriteTransport.signer,
      async (nonce: number) => {
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
          () => router.estimateGas.takeWithAtomicSwap(...txArgs),
          `Direct DEX Uniswap take ${pool.name}/${liquidation.borrower}`,
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
      `Direct DEX Uniswap V3 Take successful - poolAddress: ${pool.poolAddress}, borrower: ${liquidation.borrower}`
    );
  } catch (error) {
    logger.error(
      `Direct DEX: Failed to Uniswap V3 Take. pool: ${pool.name}, borrower: ${liquidation.borrower}`,
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
