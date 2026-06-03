import {
  CurveRouterOverrides,
  LifiDexConfig,
  LiquiditySource,
  PoolConfig,
  SushiswapRouterOverrides,
  UniswapV3RouterOverrides,
} from '../config';
import { RequireFields } from '../utils';
import { ArbTakeStrategy, createArbTakeStrategy } from './arb-strategy';
import {
  createFactoryQuoteProviderRuntimeCache,
  createFactoryTakeAdapter,
  FactoryExecutionConfig,
} from './factory';
import { ExternalTakeAdapter } from './engine';
import {
  createNoExternalTakeAdapter,
  createOneInchTakeAdapter,
} from './one-inch-adapter';
import { OneInchExecutionConfig } from './one-inch-types';
import { createLifiTakeAdapter } from './lifi-adapter';
import { getLifiTakerAddress } from './lifi-execution';
import { LifiExecutionConfig } from './lifi-types';
import { TakeWriteTransportConfig } from './write-transport';
import { TakeActionConfig } from './types';

interface ManualTakeCommonContextConfig {
  dryRun?: boolean;
}

export interface ManualOneInchContextConfig
  extends ManualTakeCommonContextConfig {
  connectorTokens?: Array<string>;
  oneInchDefaultSlippage?: number;
  oneInchRouters?: { [chainId: number]: string };
  oneInchAggregationExecutorAllowlist?: { [chainId: number]: string[] };
  keeperTaker?: string;
}

export interface ManualFactoryContextConfig
  extends ManualTakeCommonContextConfig {
  keeperTakerFactory?: string;
  uniswapV3RouterOverrides?: UniswapV3RouterOverrides;
  sushiswapRouterOverrides?: SushiswapRouterOverrides;
  curveRouterOverrides?: CurveRouterOverrides;
  tokenAddresses?: { [tokenSymbol: string]: string };
}

export interface ManualLifiContextConfig extends ManualTakeCommonContextConfig {
  keeperTakerFactory?: string;
  lifi?: LifiDexConfig;
  lifiTaker?: string;
  takerContracts?: { [source: string]: string };
}

export interface ManualTakeContext<TExecutionConfig> {
  externalTakeAdapter: ExternalTakeAdapter<TakeActionConfig, TExecutionConfig>;
  externalExecutionConfig: TExecutionConfig;
  arbTakeStrategy: ArbTakeStrategy<TakeActionConfig>;
  logPrefix?: string;
  foundLogLevel: 'debug' | 'info';
}

export function stripExternalTakeSettings(
  poolConfig: RequireFields<PoolConfig, 'take'>
): RequireFields<PoolConfig, 'take'> {
  return {
    ...poolConfig,
    take: {
      ...poolConfig.take,
      liquiditySource: undefined,
      marketPriceFactor: undefined,
    },
  };
}

export function isFactoryExternalTakeSource(
  liquiditySource: LiquiditySource | undefined
): boolean {
  return (
    liquiditySource === LiquiditySource.UNISWAPV3 ||
    liquiditySource === LiquiditySource.SUSHISWAP ||
    liquiditySource === LiquiditySource.CURVE
  );
}

export function isLifiExternalTakeSource(
  liquiditySource: LiquiditySource | undefined
): liquiditySource is LiquiditySource.LIFI {
  return liquiditySource === LiquiditySource.LIFI;
}

export function createManualOneInchTakeContext(params: {
  poolConfig: TakeActionConfig;
  config: ManualOneInchContextConfig;
  takeWriteTransport?: TakeWriteTransportConfig['takeWriteTransport'];
}): ManualTakeContext<OneInchExecutionConfig> {
  return {
    externalTakeAdapter:
      params.poolConfig.take.liquiditySource === LiquiditySource.ONEINCH
        ? createOneInchTakeAdapter({
            oneInchDefaultSlippage: params.config.oneInchDefaultSlippage,
            oneInchRouters: params.config.oneInchRouters,
            connectorTokens: params.config.connectorTokens,
          })
        : createNoExternalTakeAdapter(),
    arbTakeStrategy: createArbTakeStrategy(),
    externalExecutionConfig: {
      dryRun: params.config.dryRun,
      connectorTokens: params.config.connectorTokens,
      oneInchDefaultSlippage: params.config.oneInchDefaultSlippage,
      oneInchRouters: params.config.oneInchRouters,
      oneInchAggregationExecutorAllowlist:
        params.config.oneInchAggregationExecutorAllowlist,
      keeperTaker: params.config.keeperTaker,
      takeWriteTransport: params.takeWriteTransport,
    },
    foundLogLevel: 'info',
  };
}

export function createManualFactoryTakeContext(params: {
  config: ManualFactoryContextConfig;
  takeWriteTransport?: TakeWriteTransportConfig['takeWriteTransport'];
}): ManualTakeContext<FactoryExecutionConfig> {
  const quoteProviderCache = createFactoryQuoteProviderRuntimeCache();
  return {
    externalTakeAdapter: createFactoryTakeAdapter({
      quoteConfig: {
        uniswapV3RouterOverrides: params.config.uniswapV3RouterOverrides,
        sushiswapRouterOverrides: params.config.sushiswapRouterOverrides,
        curveRouterOverrides: params.config.curveRouterOverrides,
        tokenAddresses: params.config.tokenAddresses,
      },
      runtimeCache: quoteProviderCache,
    }),
    arbTakeStrategy: createArbTakeStrategy({
      actionLabel: 'Factory ArbTake',
      logPrefix: 'Factory: ',
    }),
    externalExecutionConfig: {
      dryRun: params.config.dryRun,
      keeperTakerFactory: params.config.keeperTakerFactory,
      uniswapV3RouterOverrides: params.config.uniswapV3RouterOverrides,
      sushiswapRouterOverrides: params.config.sushiswapRouterOverrides,
      curveRouterOverrides: params.config.curveRouterOverrides,
      tokenAddresses: params.config.tokenAddresses,
      takeWriteTransport: params.takeWriteTransport,
      runtimeCache: quoteProviderCache,
    },
    logPrefix: 'Factory: ',
    foundLogLevel: 'debug',
  };
}

export function createManualLifiTakeContext(params: {
  config: ManualLifiContextConfig;
  takeWriteTransport?: TakeWriteTransportConfig['takeWriteTransport'];
}): ManualTakeContext<LifiExecutionConfig> {
  const tokenDecimalsCache = new Map<string, number>();
  const lifiTaker =
    params.config.lifiTaker ??
    getLifiTakerAddress(params.config.takerContracts);
  return {
    externalTakeAdapter: createLifiTakeAdapter({
      lifi: params.config.lifi,
      lifiTaker,
      tokenDecimalsCache,
    }),
    arbTakeStrategy: createArbTakeStrategy({
      actionLabel: 'LI.FI ArbTake',
      logPrefix: 'LI.FI: ',
    }),
    externalExecutionConfig: {
      dryRun: params.config.dryRun,
      keeperTakerFactory: params.config.keeperTakerFactory,
      lifi: params.config.lifi,
      lifiTaker,
      takeWriteTransport: params.takeWriteTransport,
      tokenDecimalsCache,
    },
    logPrefix: 'LI.FI: ',
    foundLogLevel: 'info',
  };
}
