import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber } from 'ethers';
import { LiquiditySource } from '../../config';
import {
  ApprovedDirectDexQuoteEvaluation,
  ApprovedCurveDirectDexQuoteEvaluation,
  ApprovedUniswapV3DirectDexQuoteEvaluation,
  ExternalTakeQuoteEvaluation,
  TakeActionConfig,
  TakeLiquidationPlan,
} from '../types';
import {
  DirectDexExecutionConfig,
  DirectDexQuoteConfig,
  DirectDexRouteEvaluationContext,
} from './route-types';
import { DirectDexQuoteProviderRuntimeCache } from './runtime-cache';
import { evaluateCurveDirectDexQuote, executeCurveDirectDexTake } from './curve';
import {
  evaluateUniswapV3DirectDexQuote,
  executeUniswapV3DirectDexTake,
} from './uniswap';

export interface DirectDexProviderEvaluateArgs {
  pool: FungiblePool;
  auctionPriceWad: BigNumber;
  collateral: BigNumber;
  poolConfig: TakeActionConfig;
  config: DirectDexQuoteConfig;
  signer: Signer;
  runtimeCache?: DirectDexQuoteProviderRuntimeCache;
  feeTier?: number;
  routeContext?: DirectDexRouteEvaluationContext;
}

export interface DirectDexProviderExecuteArgs {
  pool: FungiblePool;
  poolConfig: TakeActionConfig;
  signer: Signer;
  liquidation: TakeLiquidationPlan;
  quoteEvaluation: ApprovedDirectDexQuoteEvaluation;
  config: DirectDexExecutionConfig;
}

export interface DirectDexProvider {
  liquiditySource: LiquiditySource;
  evaluate(
    args: DirectDexProviderEvaluateArgs
  ): Promise<ExternalTakeQuoteEvaluation>;
  execute(args: DirectDexProviderExecuteArgs): Promise<boolean>;
}

export const uniswapV3DirectDexProvider: DirectDexProvider = {
  liquiditySource: LiquiditySource.UNISWAPV3,
  evaluate: async ({
    pool,
    auctionPriceWad,
    collateral,
    poolConfig,
    config,
    signer,
    runtimeCache,
    feeTier,
    routeContext,
  }) =>
    await evaluateUniswapV3DirectDexQuote({
      pool,
      auctionPriceWad,
      collateral,
      poolConfig,
      config,
      signer,
      runtimeCache,
      feeTier,
      routeContext,
    }),
  execute: async ({
    pool,
    poolConfig,
    signer,
    liquidation,
    quoteEvaluation,
    config,
  }) => {
    await executeUniswapV3DirectDexTake({
      pool,
      poolConfig,
      signer,
      liquidation,
      quoteEvaluation:
        quoteEvaluation as ApprovedUniswapV3DirectDexQuoteEvaluation,
      config,
    });
    return true;
  },
};

export const curveDirectDexProvider: DirectDexProvider = {
  liquiditySource: LiquiditySource.CURVE,
  evaluate: async ({
    pool,
    auctionPriceWad,
    collateral,
    poolConfig,
    config,
    signer,
    runtimeCache,
    routeContext,
  }) =>
    await evaluateCurveDirectDexQuote({
      pool,
      auctionPriceWad,
      collateral,
      poolConfig,
      config,
      signer,
      runtimeCache,
      routeContext,
    }),
  execute: async ({
    pool,
    poolConfig,
    signer,
    liquidation,
    quoteEvaluation,
    config,
  }) => {
    await executeCurveDirectDexTake({
      pool,
      poolConfig,
      signer,
      liquidation,
      quoteEvaluation: quoteEvaluation as ApprovedCurveDirectDexQuoteEvaluation,
      config,
    });
    return true;
  },
};

export const directDexProvidersBySource: Partial<
  Record<LiquiditySource, DirectDexProvider>
> = {
  [LiquiditySource.UNISWAPV3]: uniswapV3DirectDexProvider,
  [LiquiditySource.CURVE]: curveDirectDexProvider,
};
