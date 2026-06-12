import {
  ActiveExternalTakeDeploymentType,
  CurveRouterOverrides,
  ExternalTakeDeploymentResolution,
  ExternalTakeDeploymentRuntimeConfig,
  LifiDexConfig,
  PoolConfig,
  UniswapV3RouterOverrides,
  formatLiquiditySource,
  resolveExternalTakeDeployment,
  resolveExternalTakePathFromSource,
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
import { createLifiTakeAdapter } from './lifi/adapter';
import { LifiExecutionConfig } from './lifi/types';
import { TakeActionConfig } from './types';
import { TakeWriteTransportConfig } from './write-transport';

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
  curveRouterOverrides?: CurveRouterOverrides;
  tokenAddresses?: { [tokenSymbol: string]: string };
}

export interface ManualLifiContextConfig extends ManualTakeCommonContextConfig {
  keeperTakerFactory?: string;
  lifi?: LifiDexConfig;
  lifiTaker?: string;
}

export interface ManualTakeRuntimeConfig
  extends ExternalTakeDeploymentRuntimeConfig,
    ManualOneInchContextConfig,
    ManualFactoryContextConfig,
    ManualLifiContextConfig {}

export interface ManualTakeContext<TExecutionConfig> {
  externalTakeAdapter: ExternalTakeAdapter<TakeActionConfig, TExecutionConfig>;
  externalExecutionConfig: TExecutionConfig;
  arbTakeStrategy: ArbTakeStrategy<TakeActionConfig>;
  logPrefix?: string;
  foundLogLevel: 'debug' | 'info';
}

export type ResolvedManualTakeContext =
  | ManualTakeContext<OneInchExecutionConfig>
  | ManualTakeContext<FactoryExecutionConfig>
  | ManualTakeContext<LifiExecutionConfig>;

export type ManualTakeDeploymentResolution = ExternalTakeDeploymentResolution & {
  requestedLiquiditySourceLabel: string;
};

export interface ManualTakeDeploymentResolutionLog {
  level: 'debug' | 'warn';
  message: string;
}

export interface ResolvedManualTakeRuntimeContext {
  deploymentResolution: ManualTakeDeploymentResolution;
  effectivePoolConfig: RequireFields<PoolConfig, 'take'>;
  context: ResolvedManualTakeContext;
}

function stripExternalTakeSettings(
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

export function resolveManualTakeDeployment(params: {
  poolConfig: Pick<PoolConfig, 'take'>;
  config: ExternalTakeDeploymentRuntimeConfig;
}): ManualTakeDeploymentResolution {
  const requestedLiquiditySource = params.poolConfig.take?.liquiditySource;
  const resolution = resolveExternalTakeDeployment({
    liquiditySource: requestedLiquiditySource,
    config: params.config,
  });
  return {
    ...resolution,
    requestedLiquiditySourceLabel:
      requestedLiquiditySource !== undefined
        ? formatLiquiditySource(requestedLiquiditySource)
        : 'arb-only',
  };
}

export function formatManualExternalTakeDeployment(params: {
  deploymentType: ActiveExternalTakeDeploymentType;
  poolName: string;
}): string {
  switch (params.deploymentType) {
    case 'oneinch':
      return `Using manual 1inch external take strategy for pool: ${params.poolName}`;
    case 'factory':
      return `Using factory external take strategy for pool: ${params.poolName}`;
    case 'calldata_aggregator':
      return `Using manual LI.FI external take strategy for pool: ${params.poolName}`;
  }
}

export function formatManualTakeDeploymentResolutionLog(params: {
  resolution: ManualTakeDeploymentResolution;
  poolName: string;
}): ManualTakeDeploymentResolutionLog {
  if (params.resolution.deploymentType !== 'none') {
    return {
      level: 'debug',
      message: `Smart Detection: ${formatManualExternalTakeDeployment({
        deploymentType: params.resolution.deploymentType,
        poolName: params.poolName,
      })}`,
    };
  }
  if (params.resolution.unavailableReason) {
    return {
      level: 'warn',
      message: `Smart Detection: external liquidity source ${params.resolution.requestedLiquiditySourceLabel} requested for pool ${params.poolName} but ${params.resolution.unavailableReason}`,
    };
  }

  return {
    level: 'debug',
    message: `Smart Detection: No external liquidity source configured for pool ${params.poolName}`,
  };
}

export function formatManualTakeDeploymentFallback(params: {
  resolution: ManualTakeDeploymentResolution;
  poolName: string;
}): string {
  return params.resolution.requestedLiquiditySource !== undefined
    ? `External liquidity source ${params.resolution.requestedLiquiditySourceLabel} unavailable for pool ${params.poolName} - checking arbTake only`
    : `No external liquidity source configured for pool ${params.poolName} - checking arbTake only`;
}

export function formatManualTakeContextStart(params: {
  poolConfig: TakeActionConfig;
  poolName: string;
}): string {
  const path = resolveExternalTakePathFromSource(
    params.poolConfig.take.liquiditySource
  );
  switch (path) {
    case 'factory':
      return `Manual factory external take context starting for pool: ${params.poolName}`;
    case 'calldata_aggregator':
      return `Manual LI.FI external take context starting for pool: ${params.poolName}`;
    case 'oneinch':
      return `Manual 1inch take context starting for pool: ${params.poolName}`;
    default:
      return `Manual arbTake context starting for pool: ${params.poolName}`;
  }
}

function createManualOneInchTakeContext(params: {
  config: ManualOneInchContextConfig;
  takeWriteTransport?: TakeWriteTransportConfig['takeWriteTransport'];
}): ManualTakeContext<OneInchExecutionConfig> {
  return {
    externalTakeAdapter: createOneInchTakeAdapter({
      oneInchDefaultSlippage: params.config.oneInchDefaultSlippage,
      oneInchRouters: params.config.oneInchRouters,
      connectorTokens: params.config.connectorTokens,
    }),
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

function createManualArbOnlyTakeContext(params: {
  config: ManualOneInchContextConfig;
  takeWriteTransport?: TakeWriteTransportConfig['takeWriteTransport'];
}): ManualTakeContext<OneInchExecutionConfig> {
  return {
    externalTakeAdapter: createNoExternalTakeAdapter(),
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

function createManualFactoryTakeContext(params: {
  config: ManualFactoryContextConfig;
  takeWriteTransport?: TakeWriteTransportConfig['takeWriteTransport'];
}): ManualTakeContext<FactoryExecutionConfig> {
  const quoteProviderCache = createFactoryQuoteProviderRuntimeCache();
  return {
    externalTakeAdapter: createFactoryTakeAdapter({
      quoteConfig: {
        uniswapV3RouterOverrides: params.config.uniswapV3RouterOverrides,
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
      curveRouterOverrides: params.config.curveRouterOverrides,
      tokenAddresses: params.config.tokenAddresses,
      takeWriteTransport: params.takeWriteTransport,
      runtimeCache: quoteProviderCache,
    },
    logPrefix: 'Factory: ',
    foundLogLevel: 'debug',
  };
}

function createManualLifiTakeContext(params: {
  config: ManualLifiContextConfig;
  takeWriteTransport?: TakeWriteTransportConfig['takeWriteTransport'];
}): ManualTakeContext<LifiExecutionConfig> {
  const tokenDecimalsCache = new Map<string, number>();
  const lifiTaker = params.config.lifiTaker;
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

function createManualTakeContext(params: {
  config: ManualTakeRuntimeConfig;
  deploymentResolution: ManualTakeDeploymentResolution;
  takeWriteTransport?: TakeWriteTransportConfig['takeWriteTransport'];
}): ResolvedManualTakeContext {
  switch (params.deploymentResolution.deploymentType) {
    case 'factory':
      return createManualFactoryTakeContext({
        config: params.config,
        takeWriteTransport: params.takeWriteTransport,
      });
    case 'calldata_aggregator':
      return createManualLifiTakeContext({
        config: {
          ...params.config,
          lifiTaker: params.deploymentResolution.resolvedTakerAddress,
        },
        takeWriteTransport: params.takeWriteTransport,
      });
    case 'oneinch':
      return createManualOneInchTakeContext({
        config: params.config,
        takeWriteTransport: params.takeWriteTransport,
      });
    default:
      return createManualArbOnlyTakeContext({
        config: params.config,
        takeWriteTransport: params.takeWriteTransport,
      });
  }
}

export function resolveManualTakeContext(params: {
  poolConfig: RequireFields<PoolConfig, 'take'>;
  config: ManualTakeRuntimeConfig;
  takeWriteTransport?: TakeWriteTransportConfig['takeWriteTransport'];
}): ResolvedManualTakeRuntimeContext {
  const deploymentResolution = resolveManualTakeDeployment({
    poolConfig: params.poolConfig,
    config: params.config,
  });
  const effectivePoolConfig =
    deploymentResolution.deploymentType === 'none'
      ? stripExternalTakeSettings(params.poolConfig)
      : params.poolConfig;

  return {
    deploymentResolution,
    effectivePoolConfig,
    context: createManualTakeContext({
      config: params.config,
      deploymentResolution,
      takeWriteTransport: params.takeWriteTransport,
    }),
  };
}
