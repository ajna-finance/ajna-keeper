import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber, ethers } from 'ethers';
import { CurvePoolType, LiquiditySource } from '../../config';
import { logger } from '../../logging';
import {
  ApprovedCurveDirectDexQuoteEvaluation,
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
  DirectDexQuoteProviderRuntimeCache,
  DirectDexRouteEvaluationContext,
  buildDirectDexRouteEvaluationContext,
  computeDirectDexAmountOutMinimum,
  DEFAULT_DIRECT_DEX_ROUTE_RPC_TIMEOUT_MS,
  formatDirectDexExecutionLog,
  formatDirectDexQuoteRequestLog,
  getCurveQuoteProvider,
  getSwapDeadlineCached,
} from './route-selection';
import { resolveTakeWriteTransport } from '../write-transport';
import {
  finalizeDirectDexQuoteEvaluation,
  submitDirectDexTake,
} from './provider-engine';

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

    const evaluation = await finalizeDirectDexQuoteEvaluation({
      pool,
      auctionPriceWad,
      collateral,
      poolConfig,
      marketPriceFactor: poolConfig.take.marketPriceFactor,
      context,
      quoteAmountRaw,
      collateralAmount,
      source: LiquiditySource.CURVE,
      slippageSource: curveConfig.defaultSlippage,
      invalidAmountsReason: 'invalid Curve quote amounts',
      failureReason: 'quoted output below required Curve profitability floor',
    });

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
      const message =
        'Direct DEX: curveRouterOverrides required for Curve takes';
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

    await submitDirectDexTake({
      pool,
      signer,
      liquidation,
      router,
      takeWriteTransport,
      source: LiquiditySource.CURVE,
      swapTarget: resolvedCurvePool.address,
      encodedSwapDetails,
      estimateGasLabel: `Direct DEX Curve take ${pool.name}/${liquidation.borrower}`,
      telemetryExtra: { curvePoolAddress: resolvedCurvePool.address },
      routeProfitability: quoteEvaluation.routeProfitability,
      approvedMinOutRaw: quoteEvaluation.approvedMinOutRaw,
      successVerb: 'Curve',
      onAttempted: () => {
        attemptedSubmission = true;
      },
      executionDelayMs: config.curveRouterOverrides.executionDelayMs ?? 0,
    });
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
