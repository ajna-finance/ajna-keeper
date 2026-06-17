import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber } from 'ethers';
import {
  CurveRouterOverrides,
  LiquiditySource,
  LiquiditySourceMap,
  PoolConfig,
  UniswapV3RouterOverrides,
} from '../../config';
import type { ExternalTakeTakerContractKey } from '../../config';
import { SubgraphConfigInput, WithSubgraph } from '../../read-transports';
import { AsyncOperationLimiter, RequireFields } from '../../utils';
import {
  GasPolicyRejectCode,
  GasQuoteAttempt,
} from '../types';
import { TakeWriteTransport } from '../write-transport';
import { DirectDexQuoteProviderRuntimeCache } from './runtime-cache';

export interface DirectDexRouteCandidate {
  liquiditySource: LiquiditySource;
  feeTier?: number;
}

export interface DirectDexRouteEvaluationContext {
  quoteTokenAddress: string;
  collateralTokenAddress: string;
  quoteTokenDecimals: number;
  collateralTokenDecimals: number;
  collateralInTokenDecimals: BigNumber;
  collateralAmount: number;
  auctionPriceWad: BigNumber;
  collateralWad: BigNumber;
  auctionRepayRequirementQuoteRaw: BigNumber;
  marketPriceFactor: number;
}

export interface DirectDexRouteSelectionOptions {
  allowedLiquiditySources?: LiquiditySource[];
  routeQuoteBudgetPerCandidate?: number;
  routeProbeLimiter?: AsyncOperationLimiter;
  routeProbeAbortSignal?: AbortSignal;
  routeProfitabilityContext?: DirectDexRouteProfitabilityContext;
  routeProfitabilityContextBuilder?: (
    sources: LiquiditySource[]
  ) => Promise<DirectDexRouteProfitabilityContext | undefined>;
}

export interface DirectDexRouteProfitabilityContext {
  routeExecutionCostQuoteRawBySource?: LiquiditySourceMap<BigNumber>;
  routeGasLimitBySource?: LiquiditySourceMap<BigNumber>;
  nativeProfitFloorQuoteRawBySource?: LiquiditySourceMap<BigNumber>;
  configuredProfitFloorQuoteRaw?: BigNumber;
  slippageRiskBufferQuoteRaw?: BigNumber;
  allowSubsidy?: boolean;
  routeRejectionReasonsBySource?: LiquiditySourceMap<string>;
  gasPolicyRejectCodeBySource?: LiquiditySourceMap<GasPolicyRejectCode>;
  gasQuoteAttemptsBySource?: LiquiditySourceMap<GasQuoteAttempt[]>;
  gasPriceWei?: BigNumber;
  gasPriceGwei?: number;
  gasPriceAgeMs?: number;
  gasPriceFreshnessTtlMs?: number;
  l2GasCostBufferBasisPoints?: number;
  gasPolicyEvaluatedAt?: number;
}

export interface DirectDexTakeConfigBase {
  dryRun?: boolean;
  keeperTakerRouter?: string;
  takerContracts?: Partial<Record<ExternalTakeTakerContractKey, string>>;
  uniswapV3RouterOverrides?: UniswapV3RouterOverrides;
  curveRouterOverrides?: CurveRouterOverrides;
  tokenAddresses?: { [tokenSymbol: string]: string };
}

export type DirectDexTakeConfig = WithSubgraph<DirectDexTakeConfigBase>;
export type DirectDexTakeConfigInput =
  SubgraphConfigInput<DirectDexTakeConfigBase>;

export interface DirectDexTakeParams {
  signer: Signer;
  takeWriteTransport?: TakeWriteTransport;
  pool: FungiblePool;
  poolConfig: RequireFields<PoolConfig, 'take'>;
  config: DirectDexTakeConfigInput;
}

export type DirectDexExecutionConfig = Pick<
  DirectDexTakeConfig,
  | 'dryRun'
  | 'keeperTakerRouter'
  | 'uniswapV3RouterOverrides'
  | 'curveRouterOverrides'
  | 'tokenAddresses'
> & {
  takeWriteTransport?: TakeWriteTransport;
  runtimeCache?: DirectDexQuoteProviderRuntimeCache;
  onDirectDexExecutionFailure?: (result: {
    preBroadcast: boolean;
    error?: string;
  }) => void;
};

export type DirectDexQuoteConfig = Pick<
  DirectDexTakeConfig,
  'uniswapV3RouterOverrides' | 'curveRouterOverrides' | 'tokenAddresses'
>;
