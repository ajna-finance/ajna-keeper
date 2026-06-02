import { FungiblePool, Signer } from '@ajna-finance/sdk';
import {
  ExternalTakePathKind,
  LiquiditySource,
  normalizeExternalTakeRouteSelectionMode,
  resolveDefaultFactoryLiquiditySource,
  resolveExternalTakePaths,
} from '../config';
import { logger } from '../logging';
import * as lifiExecutionModule from '../take/lifi-execution';
import { ExternalTakeAdapter } from '../take/engine';
import { TakeWriteTransport } from '../take/write-transport';
import { AsyncOperationLimiter } from '../utils';
import { DiscoveryReadTransports } from '../read-transports';
import { DiscoveryExternalExecutionConfig } from './external-take-provider';
import {
  DiscoveryExternalTakeApprovalContext,
  DiscoveryExternalTakeApprover,
  resolveDiscoveryExternalTakeApprovalMode,
} from './external-take-approval';
import { createExternalTakeAdapterForDiscovery } from './external-take-discovery-adapter';
import { createDiscoveryExternalTakeProviderRegistry } from './external-take-providers';
import {
  AutoDiscoverTakePolicyRuntime,
  DiscoveryFactoryQuoteConfig,
  DiscoveryFactoryRouteProfitabilityContextBuilder,
  FactoryPathQuoteFn,
  LifiCircuitOutcome,
  LifiPathQuoteFn,
  OneInchCircuitOutcome,
  OneInchPathQuoteFn,
  quoteFactoryPathForDiscovery,
  quoteKeeperTakerOneInchTakeForDiscovery,
  quoteLifiPathForDiscovery,
  quoteOneInchPathForDiscovery,
  recordLifiCircuitOutcomeForDiscovery,
  recordOneInchCircuitOutcomeForDiscovery,
} from './external-take-quotes';
import {
  DiscoveredTakeTargetStats,
  recordExternalTakePathFailureStats,
} from './external-take-stats';
import { getOneInchQuoteTimeoutMs } from './one-inch-circuit';
import {
  DiscoveryExecutionConfig,
  DiscoveryRpcCache,
  LifiCircuitPurpose,
  OneInchQuoteCircuitPurpose,
} from './types';
import { ResolvedTakeTarget } from './targets';
import { approveExternalTakeForDiscovery } from './external-take-approval-policy';

function getDiscoveryTokenDecimalsCache(
  rpcCache?: DiscoveryRpcCache
): Map<string, number> | undefined {
  if (!rpcCache?.factoryQuoteProviders) {
    return undefined;
  }
  rpcCache.factoryQuoteProviders.tokenDecimals ??= new Map();
  return rpcCache.factoryQuoteProviders.tokenDecimals;
}

export interface DiscoveredTakeTargetRuntime {
  externalTakePaths: ExternalTakePathKind[];
  defaultFactoryLiquiditySource: LiquiditySource | undefined;
  factoryQuoteConfig: DiscoveryFactoryQuoteConfig;
  externalTakeProbeTimeoutMs: number;
  externalTakeAdapter: ExternalTakeAdapter<
    ResolvedTakeTarget,
    DiscoveryExternalExecutionConfig,
    DiscoveryExternalTakeApprovalContext
  >;
  externalExecutionConfig: DiscoveryExternalExecutionConfig;
  approveExternalTake: DiscoveryExternalTakeApprover;
  resetExternalTakeAttemptSubmission: () => void;
  didExternalTakeAttemptSubmission: () => boolean;
}

export function createDiscoveredTakeTargetRuntime(params: {
  pool: FungiblePool;
  signer: Signer;
  config: DiscoveryExecutionConfig;
  target: ResolvedTakeTarget;
  transports: DiscoveryReadTransports;
  rpcCache?: DiscoveryRpcCache;
  takePolicy: AutoDiscoverTakePolicyRuntime;
  takeWriteTransport?: TakeWriteTransport;
  stats: DiscoveredTakeTargetStats;
  routeProbeLimiter?: AsyncOperationLimiter;
  externalTakeProbeTimeoutMs: number;
  buildFactoryRouteProfitabilityContext: DiscoveryFactoryRouteProfitabilityContextBuilder;
}): DiscoveredTakeTargetRuntime {
  const externalTakePaths = resolveExternalTakePaths({
    defaultLiquiditySource: params.target.take.liquiditySource,
    allowedExternalTakePaths: params.takePolicy?.allowedExternalTakePaths,
  });
  const defaultFactoryLiquiditySource = resolveDefaultFactoryLiquiditySource({
    defaultLiquiditySource: params.target.take.liquiditySource,
    configuredDefaultFactoryLiquiditySource:
      params.takePolicy?.defaultFactoryLiquiditySource,
  });
  const factoryQuoteConfig = {
    uniswapV3RouterOverrides: params.config.uniswapV3RouterOverrides,
    sushiswapRouterOverrides: params.config.sushiswapRouterOverrides,
    curveRouterOverrides: params.config.curveRouterOverrides,
    tokenAddresses: params.config.tokenAddresses,
  };
  const approveExternalTake: DiscoveryExternalTakeApprover = async ({
    price,
    auctionPrice,
    collateral,
    quoteEvaluation,
    externalTakeApprovalContext,
    approvalMode,
    countStats = true,
    forceGasRefresh = false,
  }) =>
    approveExternalTakeForDiscovery({
      pool: params.pool,
      signer: params.signer,
      config: params.config,
      transports: params.transports,
      target: params.target,
      rpcCache: params.rpcCache,
      takePolicy: params.takePolicy,
      takeWriteTransport: params.takeWriteTransport,
      stats: params.stats,
      price,
      auctionPrice,
      collateral,
      quoteEvaluation,
      approvalMode: resolveDiscoveryExternalTakeApprovalMode({
        approvalMode,
        externalTakeApprovalContext,
      }),
      countStats,
      forceGasRefresh,
    });
  const quoteFactoryPath: FactoryPathQuoteFn = (quoteParams) =>
    quoteFactoryPathForDiscovery({
      ...quoteParams,
      config: params.config,
      transports: params.transports,
      rpcCache: params.rpcCache,
      takePolicy: params.takePolicy,
      defaultFactoryLiquiditySource,
      routeProbeLimiter: params.routeProbeLimiter,
      factoryQuoteConfig,
      buildFactoryRouteProfitabilityContext:
        params.buildFactoryRouteProfitabilityContext,
    });
  const quoteOneInchPath: OneInchPathQuoteFn = (quoteParams) =>
    quoteOneInchPathForDiscovery({
      ...quoteParams,
      config: params.config,
      rpcCache: params.rpcCache,
      takePolicy: params.takePolicy,
      recordCircuitOutcome: quoteParams.recordCircuitOutcome,
      routeProbeLimiter: params.routeProbeLimiter,
      probeTimeoutMs: params.externalTakeProbeTimeoutMs,
      getTokenDecimalsCache: getDiscoveryTokenDecimalsCache,
    });
  const quoteKeeperTakerOneInchTake: OneInchPathQuoteFn = (quoteParams) =>
    quoteKeeperTakerOneInchTakeForDiscovery({
      ...quoteParams,
      config: params.config,
      rpcCache: params.rpcCache,
      takePolicy: params.takePolicy,
      routeProbeLimiter: params.routeProbeLimiter,
      probeTimeoutMs: params.externalTakeProbeTimeoutMs,
      getTokenDecimalsCache: getDiscoveryTokenDecimalsCache,
    });
  const quoteLifiPath: LifiPathQuoteFn = (quoteParams) =>
    quoteLifiPathForDiscovery({
      ...quoteParams,
      config: params.config,
      rpcCache: params.rpcCache,
      takePolicy: params.takePolicy,
      recordCircuitOutcome: quoteParams.recordCircuitOutcome,
      routeProbeLimiter: params.routeProbeLimiter,
      probeTimeoutMs: params.externalTakeProbeTimeoutMs,
      getTokenDecimalsCache: getDiscoveryTokenDecimalsCache,
    });
  const recordOneInchCircuitOutcome = (
    outcome: OneInchCircuitOutcome,
    purpose?: OneInchQuoteCircuitPurpose
  ): void => {
    recordOneInchCircuitOutcomeForDiscovery({
      rpcCache: params.rpcCache,
      takePolicy: params.takePolicy,
      outcome,
      purpose,
    });
  };
  const recordLifiCircuitOutcome = (
    outcome: LifiCircuitOutcome,
    purpose?: LifiCircuitPurpose
  ): void => {
    recordLifiCircuitOutcomeForDiscovery({
      rpcCache: params.rpcCache,
      config: params.config,
      outcome,
      purpose,
    });
  };
  const externalTakeProviderRegistry =
    createDiscoveryExternalTakeProviderRegistry({
      config: params.config,
      rpcCache: params.rpcCache,
      quoteOneInchPath,
      quoteKeeperTakerOneInchTake,
      quoteFactoryPath,
      quoteLifiPath,
      recordOneInchCircuitOutcome,
      recordLifiCircuitOutcome,
    });
  let externalTakeAttemptedSubmission = false;
  const recordExternalTakeExecutionFailure =
    (path: ExternalTakePathKind) =>
    (result: { preBroadcast: boolean; error?: string }): void => {
      recordExternalTakePathFailureStats({
        stats: params.stats,
        path,
        preBroadcast: result.preBroadcast,
      });

      if (!result.preBroadcast) {
        externalTakeAttemptedSubmission = true;
      }
    };
  const externalTakeAdapter = createExternalTakeAdapterForDiscovery({
    target: params.target,
    takePolicy: params.takePolicy,
    externalTakePaths,
    routeSelectionMode: normalizeExternalTakeRouteSelectionMode(
      params.takePolicy?.externalTakeRouteSelectionMode
    ),
    probeTimeoutMs: params.externalTakeProbeTimeoutMs,
    approveExternalTake,
    stats: params.stats,
    providerRegistry: externalTakeProviderRegistry,
  });
  const externalExecutionConfig: DiscoveryExternalExecutionConfig = {
    dryRun: params.target.dryRun,
    connectorTokens: params.config.connectorTokens,
    oneInchAggregationExecutorAllowlist:
      params.config.oneInchAggregationExecutorAllowlist,
    oneInchDefaultSlippage: params.config.oneInchDefaultSlippage,
    oneInchRouters: params.config.oneInchRouters,
    keeperTaker: params.config.keeperTaker,
    keeperTakerFactory: params.config.keeperTakerFactory,
    lifi: params.config.lifi,
    lifiTaker:
      params.config.lifiTaker ??
      lifiExecutionModule.getLifiTakerAddress(params.config.takerContracts),
    uniswapV3RouterOverrides: params.config.uniswapV3RouterOverrides,
    sushiswapRouterOverrides: params.config.sushiswapRouterOverrides,
    curveRouterOverrides: params.config.curveRouterOverrides,
    tokenAddresses: params.config.tokenAddresses,
    takeWriteTransport: params.takeWriteTransport,
    runtimeCache: params.rpcCache?.factoryQuoteProviders,
    oneInchRequestTimeoutMs: getOneInchQuoteTimeoutMs(params.takePolicy),
    chainId: params.rpcCache?.chainId,
    tokenDecimalsCache: getDiscoveryTokenDecimalsCache(params.rpcCache),
    onOneInchSwapDataResult: (result: {
      success: boolean;
      retryable?: boolean;
      errorCode?: number | string;
      error?: string;
    }) => {
      if (result.success) {
        recordOneInchCircuitOutcome('success', 'swap_data');
        return;
      }
      params.stats.oneInchSwapDataFailures += 1;
      if (result.retryable !== false) {
        recordOneInchCircuitOutcome('failure', 'swap_data');
      }
    },
    onOneInchExecutionFailure: recordExternalTakeExecutionFailure('oneinch'),
    onFactoryExecutionFailure: recordExternalTakeExecutionFailure('factory'),
    onLifiQuoteResult: (result: {
      success: boolean;
      retryable?: boolean;
      errorCode?: number | string;
      error?: string;
    }) => {
      recordLifiCircuitOutcome(
        result.success
          ? 'success'
          : result.retryable === true
            ? 'failure'
            : 'neutral',
        'execution_refresh'
      );
      if (!result.success) {
        logger.debug(
          `LI.FI execution quote refresh failed: ${result.error ?? result.errorCode ?? 'unknown error'}`
        );
      }
    },
    onLifiExecutionFailure: recordExternalTakeExecutionFailure('lifi'),
  };

  return {
    externalTakePaths,
    defaultFactoryLiquiditySource,
    factoryQuoteConfig,
    externalTakeProbeTimeoutMs: params.externalTakeProbeTimeoutMs,
    externalTakeAdapter,
    externalExecutionConfig,
    approveExternalTake,
    resetExternalTakeAttemptSubmission: () => {
      externalTakeAttemptedSubmission = false;
    },
    didExternalTakeAttemptSubmission: () => externalTakeAttemptedSubmission,
  };
}
