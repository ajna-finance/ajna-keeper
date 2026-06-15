import { FungiblePool, Signer } from '@ajna-finance/sdk';
import {
  ExternalTakePathKind,
  LiquiditySource,
  formatLiquiditySource,
  getAggregatorProviderIdentity,
  normalizeExternalTakeRouteSelectionMode,
  resolveExternalTakePolicy,
} from '../config';
import { logger } from '../logging';
import { ExternalTakeAdapter } from '../take/engine';
import { TakeAuctionStatusReader } from '../take/liquidation-status';
import { TakeWriteTransport } from '../take/write-transport';
import { AsyncOperationLimiter } from '../utils';
import { DiscoveryReadTransports } from '../read-transports';
import { DiscoveryExternalExecutionConfig } from './external-take/provider';
import {
  DiscoveryExternalTakeApprovalContext,
  DiscoveryExternalTakeApprover,
  resolveDiscoveryExternalTakeApprovalMode,
} from './external-take/approval';
import { createExternalTakeAdapterForDiscovery } from './external-take/discovery-adapter';
import { createDiscoveryExternalTakeProviderRegistry } from './external-take/providers';
import {
  AutoDiscoverTakePolicyRuntime,
  DiscoveryDirectDexQuoteConfig,
  DiscoveryDirectDexRouteProfitabilityContextBuilder,
  DirectDexPathQuoteFn,
  LifiCircuitOutcome,
  LifiPathQuoteFn,
  OneInchAggregatorPathQuoteFn,
  OneInchCircuitOutcome,
  SushiAggregatorPathQuoteFn,
  quoteDirectDexPathForDiscovery,
  quoteOneInchAggregatorPathForDiscovery,
  quoteLifiPathForDiscovery,
  quoteSushiAggregatorPathForDiscovery,
  recordLifiCircuitOutcomeForDiscovery,
  recordOneInchCircuitOutcomeForDiscovery,
} from './external-take/quotes';
import {
  DiscoveredTakeTargetStats,
  recordCalldataAggregatorProviderQuoteFailureStats,
  recordExternalTakeRouteFailureStats,
} from './external-take/stats';
import type { ExternalTakeRouteIdentity } from '../take/external-take/route-binding';
import { getOneInchQuoteTimeoutMs } from './external-take/one-inch-circuit';
import {
  DiscoveryExecutionConfig,
  DiscoveryRpcCache,
  LifiCircuitPurpose,
  OneInchQuoteCircuitPurpose,
} from './types';
import { ResolvedTakeTarget } from './targets';
import { approveExternalTakeForDiscovery } from './external-take/approval-policy';

function getDiscoveryTokenDecimalsCache(
  rpcCache?: DiscoveryRpcCache
): Map<string, number> | undefined {
  if (!rpcCache?.directDexQuoteProviders) {
    return undefined;
  }
  rpcCache.directDexQuoteProviders.tokenDecimals ??= new Map();
  return rpcCache.directDexQuoteProviders.tokenDecimals;
}

function formatExternalTakeRouteLabel(
  route: ExternalTakeRouteIdentity
): string {
  return route.path === 'calldata_aggregator'
    ? getAggregatorProviderIdentity(route.providerId).label
    : formatLiquiditySource(route.source);
}

export interface DiscoveredTakeTargetRuntime {
  externalTakePaths: ExternalTakePathKind[];
  defaultDirectDexLiquiditySource: LiquiditySource | undefined;
  directDexQuoteConfig: DiscoveryDirectDexQuoteConfig;
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
  takeAuctionStatusReader: TakeAuctionStatusReader;
  externalTakeProbeTimeoutMs: number;
  buildDirectDexRouteProfitabilityContext: DiscoveryDirectDexRouteProfitabilityContextBuilder;
}): DiscoveredTakeTargetRuntime {
  const resolvedExternalTakePolicy = resolveExternalTakePolicy({
    defaultLiquiditySource: params.target.take.liquiditySource,
    takePolicy: params.takePolicy,
  });
  const externalTakePaths = Array.from(
    resolvedExternalTakePolicy.externalTakePaths
  );
  const defaultDirectDexLiquiditySource =
    resolvedExternalTakePolicy.defaultDirectDexLiquiditySource;
  const directDexQuoteConfig = {
    uniswapV3RouterOverrides: params.config.uniswapV3RouterOverrides,
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
  const quoteDirectDexPath: DirectDexPathQuoteFn = (quoteParams) =>
    quoteDirectDexPathForDiscovery({
      ...quoteParams,
      config: params.config,
      transports: params.transports,
      rpcCache: params.rpcCache,
      takePolicy: params.takePolicy,
      resolvedDefaultDirectDexLiquiditySource: defaultDirectDexLiquiditySource,
      routeProbeLimiter: params.routeProbeLimiter,
      directDexQuoteConfig,
      buildDirectDexRouteProfitabilityContext:
        params.buildDirectDexRouteProfitabilityContext,
    });
  const quoteOneInchAggregatorPath: OneInchAggregatorPathQuoteFn = (
    quoteParams
  ) =>
    quoteOneInchAggregatorPathForDiscovery({
      ...quoteParams,
      config: params.config,
      rpcCache: params.rpcCache,
      takePolicy: params.takePolicy,
      recordCircuitOutcome: quoteParams.recordCircuitOutcome,
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
  const quoteSushiAggregatorPath: SushiAggregatorPathQuoteFn = (quoteParams) =>
    quoteSushiAggregatorPathForDiscovery({
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
      quoteOneInchAggregatorPath,
      quoteDirectDexPath,
      quoteLifiPath,
      quoteSushiAggregatorPath,
      recordOneInchCircuitOutcome,
      recordLifiCircuitOutcome,
    });
  let externalTakeAttemptedSubmission = false;
  const recordExternalTakeExecutionFailure = (event: {
    route: ExternalTakeRouteIdentity;
    result: { preBroadcast: boolean; error?: string };
  }): void => {
    recordExternalTakeRouteFailureStats({
      stats: params.stats,
      routeIdentity: event.route,
      preBroadcast: event.result.preBroadcast,
    });

    if (!event.result.preBroadcast) {
      externalTakeAttemptedSubmission = true;
    }
  };
  const recordExternalTakeQuoteResult = (event: {
    route: ExternalTakeRouteIdentity;
    result: {
      success: boolean;
      retryable?: boolean;
      errorCode?: number | string;
      error?: string;
    };
  }): void => {
    const { route, result } = event;
    if (!result.success) {
      recordCalldataAggregatorProviderQuoteFailureStats({
        stats: params.stats,
        routeIdentity: route,
      });
    }

    if (
      route.path === 'calldata_aggregator' &&
      route.source === LiquiditySource.ONEINCH
    ) {
      if (result.success) {
        recordOneInchCircuitOutcome('success', 'swap_data');
        return;
      }
      if (result.retryable !== false) {
        recordOneInchCircuitOutcome('failure', 'swap_data');
      }
    }

    if (
      route.path === 'calldata_aggregator' &&
      route.source === LiquiditySource.LIFI
    ) {
      recordLifiCircuitOutcome(
        result.success
          ? 'success'
          : result.retryable === true
            ? 'failure'
            : 'neutral',
        'execution_refresh'
      );
    }

    if (!result.success) {
      logger.debug(
        `${formatExternalTakeRouteLabel(route)} execution quote refresh failed: ${result.error ?? result.errorCode ?? 'unknown error'}`
      );
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
    takeAuctionStatusReader: params.takeAuctionStatusReader,
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
    keeperTakerRouter: params.config.keeperTakerRouter,
    oneInchAggregatorTaker: params.config.oneInchAggregatorTaker,
    lifi: params.config.lifi,
    lifiTaker: params.config.lifiTaker,
    uniswapV3RouterOverrides: params.config.uniswapV3RouterOverrides,
    curveRouterOverrides: params.config.curveRouterOverrides,
    tokenAddresses: params.config.tokenAddresses,
    takeWriteTransport: params.takeWriteTransport,
    runtimeCache: params.rpcCache?.directDexQuoteProviders,
    oneInchRequestTimeoutMs: getOneInchQuoteTimeoutMs(params.takePolicy),
    chainId: params.rpcCache?.chainId,
    tokenDecimalsCache: getDiscoveryTokenDecimalsCache(params.rpcCache),
    onExternalTakeQuoteResult: recordExternalTakeQuoteResult,
    onExternalTakeExecutionFailure: recordExternalTakeExecutionFailure,
  };

  return {
    externalTakePaths,
    defaultDirectDexLiquiditySource,
    directDexQuoteConfig,
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
