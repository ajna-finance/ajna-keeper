import {
  ActiveExternalTakeRouteSelectionMode,
  CalldataAggregatorProviderId,
  DirectDexLiquiditySource,
  ExternalTakePathKind,
  LiquiditySource,
  formatLiquiditySource,
  getAggregatorProviderIdentity,
  isDirectDexDynamicSource,
} from '../../config';
import { logger } from '../../logging';
import * as directDexModule from '../../take/direct-dex';
import { getExternalTakeExecutionPlanPrimaryEvaluation } from '../../take/external-take/execution-plan';
import type { ExternalTakeRouteIdentity } from '../../take/external-take/route-binding';
import { ResolvedTakeTarget } from '../targets';
import {
  createPreBroadcastFailureCapture,
  DiscoveryExternalExecutionConfig,
  ExternalTakeExecuteParams,
  ExternalTakeQuoteIntent,
  ExternalTakeQuoteResult,
  ExternalTakeRouteProvider,
  withTakeLiquiditySource,
} from './provider';
import {
  CalldataAggregatorPathQuoteInput,
  CalldataAggregatorPathQuoteFn,
  DirectDexPathQuoteInput,
  DirectDexPathQuoteFn,
} from './quotes';
import { HYBRID_GAS_QUOTE_FALLBACK_KIND } from './approval';

export type DiscoveryExternalTakeRouteProvider = ExternalTakeRouteProvider<
  ResolvedTakeTarget,
  DiscoveryExternalExecutionConfig
>;

export interface DiscoveryExternalTakeProviderRegistry {
  // Calldata-aggregator dispatch is path + provider id: LI.FI and Sushi
  // never compete for a single path-keyed slot.
  selectExternalTakeProvider(params: {
    selectedPath: DiscoveryExternalTakeRouteProvider['path'];
    providerId?: CalldataAggregatorProviderId;
  }): DiscoveryExternalTakeRouteProvider;
  selectExternalTakeProviderForRoute(
    route: ExternalTakeRouteIdentity
  ): DiscoveryExternalTakeRouteProvider;
  listExternalTakeProbeProviders(params: {
    externalTakePaths: readonly ExternalTakePathKind[];
    calldataAggregatorProviders: readonly CalldataAggregatorProviderId[];
    routeSelectionMode: ActiveExternalTakeRouteSelectionMode;
  }): DiscoveryExternalTakeRouteProvider[];
}

function routeProviderKey(params: {
  selectedPath: ExternalTakePathKind;
  providerId?: CalldataAggregatorProviderId;
}): string {
  return params.providerId
    ? `${params.selectedPath}:${params.providerId}`
    : params.selectedPath;
}

function routeProviderKeyFromRoute(route: ExternalTakeRouteIdentity): string {
  if (route.path !== 'calldata_aggregator') {
    return routeProviderKey({ selectedPath: route.path });
  }

  const identity = getAggregatorProviderIdentity(route.providerId);
  if (route.source !== identity.liquiditySource) {
    throw new Error(
      `Inconsistent external take route identity: ${route.path}/${route.providerId} source=${formatLiquiditySource(route.source)}`
    );
  }
  return routeProviderKey({
    selectedPath: route.path,
    providerId: route.providerId,
  });
}

function orderExternalTakeProbePaths(params: {
  externalTakePaths: readonly ExternalTakePathKind[];
  routeSelectionMode: ActiveExternalTakeRouteSelectionMode;
}): ExternalTakePathKind[] {
  if (params.routeSelectionMode !== 'direct_dex_first') {
    return [...params.externalTakePaths];
  }
  const pathOrder = new Map<ExternalTakePathKind, number>(
    params.externalTakePaths.map((path, index) => [path, index])
  );
  return [...params.externalTakePaths].sort((left, right) => {
    if (left === right) {
      return 0;
    }
    if (left === 'direct_dex') {
      return -1;
    }
    if (right === 'direct_dex') {
      return 1;
    }
    return (pathOrder.get(left) ?? 0) - (pathOrder.get(right) ?? 0);
  });
}

function resolveExternalTakeProbeProviderKeys(params: {
  externalTakePaths: readonly ExternalTakePathKind[];
  calldataAggregatorProviders: readonly CalldataAggregatorProviderId[];
  routeSelectionMode: ActiveExternalTakeRouteSelectionMode;
}): Array<{ key: string; label: string }> {
  const providers: Array<{ key: string; label: string }> = [];
  for (const path of orderExternalTakeProbePaths(params)) {
    if (path === 'calldata_aggregator') {
      for (const providerId of params.calldataAggregatorProviders) {
        providers.push({
          key: routeProviderKey({ selectedPath: path, providerId }),
          label: `${path}/${providerId}`,
        });
      }
      continue;
    }
    providers.push({
      key: routeProviderKey({ selectedPath: path }),
      label: path,
    });
  }
  return providers;
}

function getCalldataAggregatorRouteIdentity(
  providerId: CalldataAggregatorProviderId
): Extract<ExternalTakeRouteIdentity, { path: 'calldata_aggregator' }> {
  const identity = getAggregatorProviderIdentity(providerId);
  return {
    path: identity.canonicalPath,
    providerId: identity.providerId,
    source: identity.liquiditySource,
  };
}

function getDirectDexRouteIdentity(
  source: LiquiditySource | undefined
): Extract<ExternalTakeRouteIdentity, { path: 'direct_dex' }> | undefined {
  return source !== undefined && isDirectDexDynamicSource(source)
    ? { path: 'direct_dex', source: source as DirectDexLiquiditySource }
    : undefined;
}

export function createQuoteResultHandler(
  config: DiscoveryExternalExecutionConfig,
  route: ExternalTakeRouteIdentity,
  recordCircuitOutcome?: (result: ExternalTakeQuoteResult) => void
) {
  return (result: ExternalTakeQuoteResult) => {
    recordCircuitOutcome?.(result);
    config.onExternalTakeQuoteResult?.({ route, result });
  };
}

function createExecutionFailureHandler(
  config: DiscoveryExternalExecutionConfig,
  route: ExternalTakeRouteIdentity
) {
  return (result: { preBroadcast: boolean; error?: string }) =>
    config.onExternalTakeExecutionFailure?.({ route, result });
}

function getAggregatorQuoteIntentOptions(
  intent: ExternalTakeQuoteIntent
): Pick<
  CalldataAggregatorPathQuoteInput,
  'routeProbeAbortSignal' | 'quoteCircuitMode'
> {
  if (intent.kind !== 'hybrid_probe') {
    return {};
  }
  return {
    routeProbeAbortSignal: intent.abortSignal,
    quoteCircuitMode: 'observe',
  };
}

function getDirectDexQuoteIntentOptions(
  intent: ExternalTakeQuoteIntent
): Pick<
  DirectDexPathQuoteInput,
  'routeProbeAbortSignal' | 'directDexGasQuoteFallback'
> {
  if (intent.kind === 'hybrid_probe') {
    return { routeProbeAbortSignal: intent.abortSignal };
  }
  return {
    directDexGasQuoteFallback: intent.kind === HYBRID_GAS_QUOTE_FALLBACK_KIND,
  };
}

export type CalldataAggregatorExecutionConfig =
  DiscoveryExternalExecutionConfig;

export interface DiscoveryCalldataAggregatorProviderDescriptor<
  TExecutionConfig extends CalldataAggregatorExecutionConfig,
> {
  providerId: CalldataAggregatorProviderId;
  quotePath: CalldataAggregatorPathQuoteFn;
  executeTake: (
    params: ExternalTakeExecuteParams<ResolvedTakeTarget, TExecutionConfig>
  ) => Promise<boolean>;
  decorateExecutionConfig: (params: {
    config: DiscoveryExternalExecutionConfig;
    route: Extract<ExternalTakeRouteIdentity, { path: 'calldata_aggregator' }>;
    executionFailureHandler: ReturnType<
      typeof createPreBroadcastFailureCapture
    >['handler'];
  }) => TExecutionConfig;
  getQuoteCircuitOutcome?: DiscoveryExternalTakeRouteProvider['getQuoteCircuitOutcome'];
  recordQuoteCircuitOutcome?: DiscoveryExternalTakeRouteProvider['recordQuoteCircuitOutcome'];
  getExecutionRefreshCircuitOpenReason?: (
    config: Pick<DiscoveryExternalExecutionConfig, 'dryRun'>
  ) => string | undefined;
}

export function createCalldataAggregatorRouteProvider<
  TExecutionConfig extends CalldataAggregatorExecutionConfig,
>(
  params: DiscoveryCalldataAggregatorProviderDescriptor<TExecutionConfig>
): DiscoveryExternalTakeRouteProvider {
  const identity = getAggregatorProviderIdentity(params.providerId);
  return {
    path: identity.canonicalPath,
    providerId: identity.providerId,
    quote: async ({
      intent,
      pool,
      signer,
      poolConfig,
      price,
      auctionPrice,
      collateral,
      debtToCover,
    }) =>
      params.quotePath({
        pool,
        signer,
        poolConfig,
        price,
        auctionPrice,
        collateral,
        debtToCover,
        ...getAggregatorQuoteIntentOptions(intent),
      }),
    getQuoteCircuitOutcome: params.getQuoteCircuitOutcome,
    recordQuoteCircuitOutcome: params.recordQuoteCircuitOutcome,
    execute: async ({ pool, signer, poolConfig, liquidation, config }) => {
      const route = getCalldataAggregatorRouteIdentity(identity.providerId);
      const executionFailureCapture = createPreBroadcastFailureCapture(
        createExecutionFailureHandler(config, route)
      );
      const executionConfig = params.decorateExecutionConfig({
        config,
        route,
        executionFailureHandler: executionFailureCapture.handler,
      });
      const circuitOpenReason =
        params.getExecutionRefreshCircuitOpenReason?.(config);
      if (circuitOpenReason) {
        logger.warn(
          `${identity.label} execution refresh circuit is open for ${pool.name}/${liquidation.borrower}; skipping ${identity.label} external take attempt`
        );
        executionFailureCapture.handler({
          preBroadcast: true,
          error: circuitOpenReason,
        });
        return {
          succeeded: false,
          preBroadcastFailed: true,
        };
      }
      const succeeded = await params.executeTake({
        pool,
        signer,
        poolConfig,
        liquidation,
        config: executionConfig,
      });
      return {
        succeeded,
        preBroadcastFailed: executionFailureCapture.didFailPreBroadcast(),
      };
    },
  };
}

export function createDiscoveryExternalTakeProviderRegistry(params: {
  quoteDirectDexPath: DirectDexPathQuoteFn;
  calldataAggregatorProviders: readonly DiscoveryExternalTakeRouteProvider[];
}): DiscoveryExternalTakeProviderRegistry {
  const directDexProvider: DiscoveryExternalTakeRouteProvider = {
    path: 'direct_dex',
    quote: async ({
      intent,
      pool,
      signer,
      poolConfig,
      auctionPrice,
      collateral,
    }) =>
      params.quoteDirectDexPath({
        pool,
        signer,
        poolConfig,
        auctionPrice,
        collateral,
        ...getDirectDexQuoteIntentOptions(intent),
      }),
    execute: async ({ pool, signer, poolConfig, liquidation, config }) => {
      const selectedSource = getExternalTakeExecutionPlanPrimaryEvaluation(
        liquidation.externalTakeExecutionPlan
      )?.selectedLiquiditySource;
      const directDexPoolConfig =
        selectedSource !== undefined && isDirectDexDynamicSource(selectedSource)
          ? withTakeLiquiditySource(poolConfig, selectedSource)
          : poolConfig;
      const route = getDirectDexRouteIdentity(selectedSource);
      const executionFailureCapture = createPreBroadcastFailureCapture(
        route ? createExecutionFailureHandler(config, route) : undefined
      );
      const directDexConfig = {
        ...config,
        onDirectDexExecutionFailure: executionFailureCapture.handler,
      };
      const succeeded = await directDexModule.takeLiquidationDirectDex({
        pool,
        signer,
        poolConfig: directDexPoolConfig,
        liquidation,
        config: directDexConfig,
      });
      return {
        succeeded,
        preBroadcastFailed: executionFailureCapture.didFailPreBroadcast(),
      };
    },
  };
  const providersByRoute = new Map<string, DiscoveryExternalTakeRouteProvider>([
    [routeProviderKey({ selectedPath: 'direct_dex' }), directDexProvider],
    ...params.calldataAggregatorProviders.map(
      (provider) =>
        [
          routeProviderKey({
            selectedPath: provider.path,
            providerId: provider.providerId,
          }),
          provider,
        ] as const
    ),
  ]);
  const selectByRouteKey = (
    key: string,
    label: string
  ): DiscoveryExternalTakeRouteProvider => {
    const provider = providersByRoute.get(key);
    if (provider === undefined) {
      throw new Error(`Unsupported external take route: ${label}`);
    }
    return provider;
  };

  return {
    selectExternalTakeProvider: ({ selectedPath, providerId }) => {
      return selectByRouteKey(
        routeProviderKey({ selectedPath, providerId }),
        `${selectedPath}${providerId ? `/${providerId}` : ''}`
      );
    },
    selectExternalTakeProviderForRoute: (route) =>
      selectByRouteKey(
        routeProviderKeyFromRoute(route),
        route.path === 'calldata_aggregator'
          ? `${route.path}/${route.providerId}`
          : route.path
      ),
    listExternalTakeProbeProviders: (probeParams) =>
      resolveExternalTakeProbeProviderKeys(probeParams).map(({ key, label }) =>
        selectByRouteKey(key, label)
      ),
  };
}
