import {
  ActiveExternalTakeDeploymentType,
  CalldataAggregatorProviderId,
  CurveRouterOverrides,
  ExternalTakeDeploymentResolution,
  ExternalTakeDeploymentRuntimeConfig,
  LifiDexConfig,
  PoolConfig,
  SushiAggregatorDexConfig,
  UniswapV3RouterOverrides,
  formatLiquiditySource,
  resolveExternalTakeDeployment,
  resolveExternalTakePathFromSource,
} from '../config';
import { RequireFields } from '../utils';
import { ArbTakeStrategy, createArbTakeStrategy } from './arb-strategy';
import {
  createDirectDexQuoteProviderRuntimeCache,
  createDirectDexTakeAdapter,
  DirectDexExecutionConfig,
} from './direct-dex';
import { ExternalTakeAdapter } from './engine';
import { createNoExternalTakeAdapter } from './no-external-take-adapter';
import { createLifiTakeAdapter } from './lifi/adapter';
import { LifiExecutionConfig } from './lifi/types';
import { createOneInchAggregatorTakeAdapter } from './oneinch-aggregator/adapter';
import { OneInchAggregatorExecutionConfig } from './oneinch-aggregator/types';
import { createSushiAggregatorTakeAdapter } from './sushi-aggregator/adapter';
import { SushiAggregatorExecutionConfig } from './sushi-aggregator/types';
import { TakeActionConfig } from './types';
import { TakeWriteTransportConfig } from './write-transport';

interface ManualTakeCommonContextConfig {
  dryRun?: boolean;
}

interface ManualCalldataAggregatorCommonContextConfig
  extends ManualTakeCommonContextConfig {
  keeperTakerRouter?: string;
  chainId?: number;
}

export interface ManualOneInchContextConfig
  extends ManualCalldataAggregatorCommonContextConfig {
  connectorTokens?: Array<string>;
  oneInchAggregatorTaker?: string;
  oneInchDefaultSlippage?: number;
  oneInchRouters?: { [chainId: number]: string };
  oneInchAggregationExecutorAllowlist?: { [chainId: number]: string[] };
  oneInchRequestAbortSignal?: AbortSignal;
  oneInchRequestTimeoutMs?: number;
}

export interface ManualDirectDexContextConfig
  extends ManualTakeCommonContextConfig {
  keeperTakerRouter?: string;
  uniswapV3RouterOverrides?: UniswapV3RouterOverrides;
  curveRouterOverrides?: CurveRouterOverrides;
  tokenAddresses?: { [tokenSymbol: string]: string };
}

export interface ManualLifiContextConfig
  extends ManualCalldataAggregatorCommonContextConfig {
  lifi?: LifiDexConfig;
  lifiTaker?: string;
  lifiRequestAbortSignal?: AbortSignal;
}

export interface ManualSushiAggregatorContextConfig
  extends ManualCalldataAggregatorCommonContextConfig {
  sushiAggregator?: SushiAggregatorDexConfig;
  sushiAggregatorTaker?: string;
  sushiAggregatorRequestAbortSignal?: AbortSignal;
}

export interface ManualTakeRuntimeConfig
  extends ExternalTakeDeploymentRuntimeConfig,
    ManualOneInchContextConfig,
    ManualDirectDexContextConfig,
    ManualLifiContextConfig,
    ManualSushiAggregatorContextConfig {}

export interface ManualTakeContext<TExecutionConfig> {
  externalTakeAdapter: ExternalTakeAdapter<TakeActionConfig, TExecutionConfig>;
  externalExecutionConfig: TExecutionConfig;
  arbTakeStrategy: ArbTakeStrategy<TakeActionConfig>;
  logPrefix?: string;
  foundLogLevel: 'debug' | 'info';
}

export type ResolvedManualTakeContext =
  | ManualTakeContext<unknown>
  | ManualTakeContext<DirectDexExecutionConfig>
  | ManualTakeContext<LifiExecutionConfig>
  | ManualTakeContext<OneInchAggregatorExecutionConfig>
  | ManualTakeContext<SushiAggregatorExecutionConfig>;

type ManualCalldataAggregatorTakeContext = Extract<
  ResolvedManualTakeContext,
  | ManualTakeContext<LifiExecutionConfig>
  | ManualTakeContext<OneInchAggregatorExecutionConfig>
  | ManualTakeContext<SushiAggregatorExecutionConfig>
>;

type ManualCalldataAggregatorContextFactory = (params: {
  config: ManualTakeRuntimeConfig;
  takerAddress: string;
  takeWriteTransport?: TakeWriteTransportConfig['takeWriteTransport'];
}) => ManualCalldataAggregatorTakeContext;

export type ManualTakeDeploymentResolution =
  ExternalTakeDeploymentResolution & {
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
    case 'direct_dex':
      return `Using direct_dex external take strategy for pool: ${params.poolName}`;
    case 'calldata_aggregator':
      return `Using manual calldata_aggregator external take strategy for pool: ${params.poolName}`;
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
    case 'direct_dex':
      return `Manual direct_dex external take context starting for pool: ${params.poolName}`;
    case 'calldata_aggregator':
      return `Manual calldata_aggregator external take context starting for pool: ${params.poolName}`;
    default:
      return `Manual arbTake context starting for pool: ${params.poolName}`;
  }
}

function createManualArbOnlyTakeContext(params: {
  config: ManualOneInchContextConfig;
  takeWriteTransport?: TakeWriteTransportConfig['takeWriteTransport'];
}): ManualTakeContext<unknown> {
  return {
    externalTakeAdapter: createNoExternalTakeAdapter(),
    arbTakeStrategy: createArbTakeStrategy(),
    externalExecutionConfig: {
      dryRun: params.config.dryRun,
      takeWriteTransport: params.takeWriteTransport,
    },
    foundLogLevel: 'info',
  };
}

function createManualDirectDexTakeContext(params: {
  config: ManualDirectDexContextConfig;
  takeWriteTransport?: TakeWriteTransportConfig['takeWriteTransport'];
}): ManualTakeContext<DirectDexExecutionConfig> {
  const quoteProviderCache = createDirectDexQuoteProviderRuntimeCache();
  return {
    externalTakeAdapter: createDirectDexTakeAdapter({
      quoteConfig: {
        uniswapV3RouterOverrides: params.config.uniswapV3RouterOverrides,
        curveRouterOverrides: params.config.curveRouterOverrides,
        tokenAddresses: params.config.tokenAddresses,
      },
      runtimeCache: quoteProviderCache,
    }),
    arbTakeStrategy: createArbTakeStrategy({
      actionLabel: 'Direct DEX ArbTake',
      logPrefix: 'Direct DEX: ',
    }),
    externalExecutionConfig: {
      dryRun: params.config.dryRun,
      keeperTakerRouter: params.config.keeperTakerRouter,
      uniswapV3RouterOverrides: params.config.uniswapV3RouterOverrides,
      curveRouterOverrides: params.config.curveRouterOverrides,
      tokenAddresses: params.config.tokenAddresses,
      takeWriteTransport: params.takeWriteTransport,
      runtimeCache: quoteProviderCache,
    },
    logPrefix: 'Direct DEX: ',
    foundLogLevel: 'debug',
  };
}

function createManualCalldataAggregatorContextBase(params: {
  config: ManualCalldataAggregatorCommonContextConfig;
  takeWriteTransport?: TakeWriteTransportConfig['takeWriteTransport'];
  actionLabel: string;
  logPrefix: string;
}): {
  tokenDecimalsCache: Map<string, number>;
  arbTakeStrategy: ArbTakeStrategy<TakeActionConfig>;
  externalExecutionConfigBase: {
    dryRun?: boolean;
    keeperTakerRouter?: string;
    chainId?: number;
    takeWriteTransport?: TakeWriteTransportConfig['takeWriteTransport'];
    tokenDecimalsCache: Map<string, number>;
  };
  logPrefix: string;
  foundLogLevel: 'info';
} {
  const tokenDecimalsCache = new Map<string, number>();
  return {
    tokenDecimalsCache,
    arbTakeStrategy: createArbTakeStrategy({
      actionLabel: params.actionLabel,
      logPrefix: params.logPrefix,
    }),
    externalExecutionConfigBase: {
      dryRun: params.config.dryRun,
      keeperTakerRouter: params.config.keeperTakerRouter,
      chainId: params.config.chainId,
      takeWriteTransport: params.takeWriteTransport,
      tokenDecimalsCache,
    },
    logPrefix: params.logPrefix,
    foundLogLevel: 'info',
  };
}

function createManualLifiTakeContext(params: {
  config: ManualLifiContextConfig;
  takeWriteTransport?: TakeWriteTransportConfig['takeWriteTransport'];
}): ManualTakeContext<LifiExecutionConfig> {
  const shared = createManualCalldataAggregatorContextBase({
    config: params.config,
    takeWriteTransport: params.takeWriteTransport,
    actionLabel: 'LI.FI ArbTake',
    logPrefix: 'LI.FI: ',
  });
  const lifiTaker = params.config.lifiTaker;
  return {
    externalTakeAdapter: createLifiTakeAdapter({
      lifi: params.config.lifi,
      lifiTaker,
      lifiRequestAbortSignal: params.config.lifiRequestAbortSignal,
      chainId: params.config.chainId,
      tokenDecimalsCache: shared.tokenDecimalsCache,
    }),
    arbTakeStrategy: shared.arbTakeStrategy,
    externalExecutionConfig: {
      ...shared.externalExecutionConfigBase,
      lifi: params.config.lifi,
      lifiTaker,
      lifiRequestAbortSignal: params.config.lifiRequestAbortSignal,
    },
    logPrefix: shared.logPrefix,
    foundLogLevel: shared.foundLogLevel,
  };
}

function createManualOneInchAggregatorTakeContext(params: {
  config: ManualOneInchContextConfig;
  takeWriteTransport?: TakeWriteTransportConfig['takeWriteTransport'];
}): ManualTakeContext<OneInchAggregatorExecutionConfig> {
  const shared = createManualCalldataAggregatorContextBase({
    config: params.config,
    takeWriteTransport: params.takeWriteTransport,
    actionLabel: '1inch Aggregator ArbTake',
    logPrefix: '1inch: ',
  });
  const oneInchAggregatorTaker = params.config.oneInchAggregatorTaker;
  return {
    externalTakeAdapter: createOneInchAggregatorTakeAdapter({
      connectorTokens: params.config.connectorTokens,
      oneInchAggregatorTaker,
      oneInchAggregationExecutorAllowlist:
        params.config.oneInchAggregationExecutorAllowlist,
      oneInchDefaultSlippage: params.config.oneInchDefaultSlippage,
      oneInchRouters: params.config.oneInchRouters,
      oneInchRequestAbortSignal: params.config.oneInchRequestAbortSignal,
      oneInchRequestTimeoutMs: params.config.oneInchRequestTimeoutMs,
      chainId: params.config.chainId,
      tokenDecimalsCache: shared.tokenDecimalsCache,
    }),
    arbTakeStrategy: shared.arbTakeStrategy,
    externalExecutionConfig: {
      ...shared.externalExecutionConfigBase,
      connectorTokens: params.config.connectorTokens,
      oneInchAggregatorTaker,
      oneInchAggregationExecutorAllowlist:
        params.config.oneInchAggregationExecutorAllowlist,
      oneInchDefaultSlippage: params.config.oneInchDefaultSlippage,
      oneInchRouters: params.config.oneInchRouters,
      oneInchRequestAbortSignal: params.config.oneInchRequestAbortSignal,
      oneInchRequestTimeoutMs: params.config.oneInchRequestTimeoutMs,
    },
    logPrefix: shared.logPrefix,
    foundLogLevel: shared.foundLogLevel,
  };
}

function createManualSushiAggregatorTakeContext(params: {
  config: ManualSushiAggregatorContextConfig;
  takeWriteTransport?: TakeWriteTransportConfig['takeWriteTransport'];
}): ManualTakeContext<SushiAggregatorExecutionConfig> {
  const shared = createManualCalldataAggregatorContextBase({
    config: params.config,
    takeWriteTransport: params.takeWriteTransport,
    actionLabel: 'Sushi Aggregator ArbTake',
    logPrefix: 'Sushi Aggregator: ',
  });
  const sushiAggregatorTaker = params.config.sushiAggregatorTaker;
  return {
    externalTakeAdapter: createSushiAggregatorTakeAdapter({
      sushiAggregator: params.config.sushiAggregator,
      sushiAggregatorTaker,
      sushiAggregatorRequestAbortSignal:
        params.config.sushiAggregatorRequestAbortSignal,
      chainId: params.config.chainId,
      tokenDecimalsCache: shared.tokenDecimalsCache,
    }),
    arbTakeStrategy: shared.arbTakeStrategy,
    externalExecutionConfig: {
      ...shared.externalExecutionConfigBase,
      sushiAggregator: params.config.sushiAggregator,
      sushiAggregatorTaker,
      sushiAggregatorRequestAbortSignal:
        params.config.sushiAggregatorRequestAbortSignal,
    },
    logPrefix: shared.logPrefix,
    foundLogLevel: shared.foundLogLevel,
  };
}

function createManualCalldataAggregatorTakeContext(params: {
  config: ManualTakeRuntimeConfig;
  deploymentResolution: Extract<
    ManualTakeDeploymentResolution,
    { deploymentType: 'calldata_aggregator' }
  >;
  takeWriteTransport?: TakeWriteTransportConfig['takeWriteTransport'];
}): ManualCalldataAggregatorTakeContext {
  const createContext =
    MANUAL_CALLDATA_AGGREGATOR_CONTEXT_FACTORIES[
      params.deploymentResolution.providerId
    ];
  return createContext({
    config: params.config,
    takerAddress: params.deploymentResolution.resolvedTakerAddress,
    takeWriteTransport: params.takeWriteTransport,
  });
}

const MANUAL_CALLDATA_AGGREGATOR_CONTEXT_FACTORIES = {
  lifi: ({ config, takerAddress, takeWriteTransport }) =>
    createManualLifiTakeContext({
      config: {
        ...config,
        lifiTaker: takerAddress,
      },
      takeWriteTransport,
    }),
  oneinch: ({ config, takerAddress, takeWriteTransport }) =>
    createManualOneInchAggregatorTakeContext({
      config: {
        ...config,
        oneInchAggregatorTaker: takerAddress,
      },
      takeWriteTransport,
    }),
  sushi_aggregator: ({ config, takerAddress, takeWriteTransport }) =>
    createManualSushiAggregatorTakeContext({
      config: {
        ...config,
        sushiAggregatorTaker: takerAddress,
      },
      takeWriteTransport,
    }),
} satisfies Record<
  CalldataAggregatorProviderId,
  ManualCalldataAggregatorContextFactory
>;

function createManualTakeContext(params: {
  config: ManualTakeRuntimeConfig;
  deploymentResolution: ManualTakeDeploymentResolution;
  takeWriteTransport?: TakeWriteTransportConfig['takeWriteTransport'];
}): ResolvedManualTakeContext {
  switch (params.deploymentResolution.deploymentType) {
    case 'direct_dex':
      return createManualDirectDexTakeContext({
        config: params.config,
        takeWriteTransport: params.takeWriteTransport,
      });
    case 'calldata_aggregator':
      return createManualCalldataAggregatorTakeContext({
        config: params.config,
        deploymentResolution: params.deploymentResolution,
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
