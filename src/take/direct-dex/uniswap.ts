import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber, ethers } from 'ethers';
import {
  DEFAULT_FEE_TIER_BY_SOURCE,
  LiquiditySource,
  resolveUniswapV3DirectDexRouteConfig,
} from '../../config';
import { logger } from '../../logging';
import {
  ApprovedUniswapV3DirectDexQuoteEvaluation,
  ExternalTakeQuoteEvaluation,
  TakeActionConfig,
  TakeLiquidationPlan,
} from '../types';
import { getErrorMessage, withTimeout } from '../../utils';
import { isNonceConsumedTransactionError } from '../../nonce';
import { TakerRouter__factory } from '../../../typechain-types';
import {
  DirectDexExecutionConfig,
  DirectDexQuoteConfig,
  DirectDexRouteEvaluationContext,
} from './route-types';
import { DirectDexQuoteProviderRuntimeCache } from './runtime-cache';
import {
  computeDirectDexAmountOutMinimum,
  DEFAULT_DIRECT_DEX_ROUTE_RPC_TIMEOUT_MS,
  getSwapDeadlineCached,
} from './route-amounts';
import {
  formatDirectDexExecutionLog,
  formatDirectDexQuoteRequestLog,
} from './logs';
import { getUniswapV3QuoteProvider } from './providers';
import { resolveTakeWriteTransport } from '../write-transport';
import {
  finalizeDirectDexQuoteEvaluation,
  submitDirectDexTake,
} from './provider-engine';

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
  routeContext: DirectDexRouteEvaluationContext;
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

    const context = routeContext;

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

    const evaluation = await finalizeDirectDexQuoteEvaluation({
      pool,
      auctionPriceWad,
      collateral,
      poolConfig,
      marketPriceFactor: poolConfig.take.marketPriceFactor,
      context,
      quoteAmountRaw,
      collateralAmount,
      source: LiquiditySource.UNISWAPV3,
      slippageSource: routerConfig.defaultSlippage,
      invalidAmountsReason: 'invalid Uniswap V3 quote amounts',
      failureReason: 'quoted output below required Uniswap V3 profitability floor',
      selectedFeeTier,
    });

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

    await submitDirectDexTake({
      pool,
      signer,
      liquidation,
      router,
      takeWriteTransport,
      source: LiquiditySource.UNISWAPV3,
      swapTarget: swapDetails.swapRouter,
      encodedSwapDetails,
      estimateGasLabel: `Direct DEX Uniswap take ${pool.name}/${liquidation.borrower}`,
      telemetryExtra: { selectedFeeTier: quoteEvaluation.selectedFeeTier },
      routeProfitability: quoteEvaluation.routeProfitability,
      approvedMinOutRaw: quoteEvaluation.approvedMinOutRaw,
      successVerb: 'Uniswap V3',
      onAttempted: () => {
        attemptedSubmission = true;
      },
    });
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
