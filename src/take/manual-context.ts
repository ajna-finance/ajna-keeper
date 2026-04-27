import { LiquiditySource, KeeperConfig, PoolConfig } from '../config';
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
import { TakeWriteTransportConfig } from './write-transport';
import { TakeActionConfig } from './types';

type ManualTakeCommonContextConfig = Pick<
  KeeperConfig,
  'dryRun' | 'delayBetweenActions'
>;

export type ManualOneInchContextConfig = ManualTakeCommonContextConfig &
  Pick<
    KeeperConfig,
    | 'connectorTokens'
    | 'oneInchDefaultSlippage'
    | 'oneInchRouters'
    | 'oneInchAggregationExecutorAllowlist'
    | 'keeperTaker'
  >;

export type ManualFactoryContextConfig = ManualTakeCommonContextConfig &
  Pick<
    KeeperConfig,
    | 'keeperTakerFactory'
    | 'universalRouterOverrides'
    | 'sushiswapRouterOverrides'
    | 'curveRouterOverrides'
    | 'tokenAddresses'
  >;

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

export function createManualOneInchTakeContext(params: {
  poolConfig: TakeActionConfig;
  config: ManualOneInchContextConfig;
  takeWriteTransport?: TakeWriteTransportConfig['takeWriteTransport'];
}): ManualTakeContext<OneInchExecutionConfig> {
  return {
    externalTakeAdapter:
      params.poolConfig.take.liquiditySource === LiquiditySource.ONEINCH
        ? createOneInchTakeAdapter({
            delayBetweenActions: params.config.delayBetweenActions ?? 0,
            oneInchDefaultSlippage: params.config.oneInchDefaultSlippage,
            oneInchRouters: params.config.oneInchRouters,
            connectorTokens: params.config.connectorTokens,
          })
        : createNoExternalTakeAdapter(),
    arbTakeStrategy: createArbTakeStrategy(),
    externalExecutionConfig: {
      dryRun: params.config.dryRun,
      delayBetweenActions: params.config.delayBetweenActions ?? 0,
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
        universalRouterOverrides: params.config.universalRouterOverrides,
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
      universalRouterOverrides: params.config.universalRouterOverrides,
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
