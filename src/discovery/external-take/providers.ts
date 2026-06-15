import {
  CalldataAggregatorProviderId,
  DirectDexLiquiditySource,
  ExternalTakePathKind,
  LiquiditySource,
  getAggregatorProviderIdentity,
  isDirectDexDynamicSource,
} from '../../config';
import { logger } from '../../logging';
import * as directDexModule from '../../take/direct-dex';
import { getExternalTakeExecutionPlanPrimaryEvaluation } from '../../take/external-take/execution-plan';
import type { ExternalTakeRouteIdentity } from '../../take/external-take/route-binding';
import * as lifiExecutionModule from '../../take/lifi/execution';
import * as sushiAggregatorExecutionModule from '../../take/sushi-aggregator/execution';
import * as oneInchAggregatorExecutionModule from '../../take/oneinch-aggregator/execution';
import { ResolvedTakeTarget } from '../targets';
import {
  createPreBroadcastFailureCapture,
  DiscoveryExternalExecutionConfig,
  ExternalTakeExecuteParams,
  ExternalTakeQuoteIntent,
  ExternalTakeRouteProvider,
  withTakeLiquiditySource,
} from './provider';
import {
  DirectDexPathQuoteInput,
  DirectDexPathQuoteFn,
  getCircuitGuardedQuoteOutcome,
  LifiCircuitOutcome,
  LifiPathQuoteInput,
  LifiPathQuoteFn,
  OneInchCircuitOutcome,
  OneInchAggregatorPathQuoteFn,
  SushiAggregatorPathQuoteFn,
} from './quotes';
import { getLifiCircuitOpenReason } from './lifi-circuit';
import { DiscoveryExecutionConfig, DiscoveryRpcCache } from '../types';
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
}

function routeProviderKey(params: {
  selectedPath: ExternalTakePathKind;
  providerId?: CalldataAggregatorProviderId;
}): string {
  return params.providerId
    ? `${params.selectedPath}:${params.providerId}`
    : params.selectedPath;
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

function createQuoteResultHandler(
  config: DiscoveryExternalExecutionConfig,
  route: ExternalTakeRouteIdentity
) {
  return (result: { success: boolean; retryable?: boolean; error?: string }) =>
    config.onExternalTakeQuoteResult?.({ route, result });
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
): Pick<LifiPathQuoteInput, 'routeProbeAbortSignal' | 'recordCircuitOutcome'> {
  if (intent.kind !== 'hybrid_probe') {
    return {};
  }
  return {
    routeProbeAbortSignal: intent.abortSignal,
    recordCircuitOutcome: false,
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

type CalldataAggregatorPathQuoteFn = (
  quoteParams: LifiPathQuoteInput
) => ReturnType<LifiPathQuoteFn>;

type CalldataAggregatorExecutionConfig = DiscoveryExternalExecutionConfig;

function createCalldataAggregatorRouteProvider<
  TExecutionConfig extends CalldataAggregatorExecutionConfig,
>(params: {
  providerId: CalldataAggregatorProviderId;
  quotePath: CalldataAggregatorPathQuoteFn;
  executeTake: (
    params: ExternalTakeExecuteParams<ResolvedTakeTarget, TExecutionConfig>
  ) => Promise<boolean>;
  decorateExecutionConfig: (params: {
    config: DiscoveryExternalExecutionConfig;
    route: Extract<
      ExternalTakeRouteIdentity,
      { path: 'calldata_aggregator' }
    >;
    executionFailureHandler: ReturnType<
      typeof createPreBroadcastFailureCapture
    >['handler'];
  }) => TExecutionConfig;
  getQuoteCircuitOutcome?: DiscoveryExternalTakeRouteProvider['getQuoteCircuitOutcome'];
  recordQuoteCircuitOutcome?: DiscoveryExternalTakeRouteProvider['recordQuoteCircuitOutcome'];
  getExecutionRefreshCircuitOpenReason?: (
    config: Pick<DiscoveryExternalExecutionConfig, 'dryRun'>
  ) => string | undefined;
}): DiscoveryExternalTakeRouteProvider {
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
  config: Pick<DiscoveryExecutionConfig, 'lifi'>;
  rpcCache?: DiscoveryRpcCache;
  quoteOneInchAggregatorPath: OneInchAggregatorPathQuoteFn;
  quoteDirectDexPath: DirectDexPathQuoteFn;
  quoteLifiPath: LifiPathQuoteFn;
  quoteSushiAggregatorPath: SushiAggregatorPathQuoteFn;
  recordOneInchCircuitOutcome: (outcome: OneInchCircuitOutcome) => void;
  recordLifiCircuitOutcome: (outcome: LifiCircuitOutcome) => void;
}): DiscoveryExternalTakeProviderRegistry {
  const getLifiExecutionRefreshCircuitOpenReason = (
    executionConfig: Pick<DiscoveryExternalExecutionConfig, 'dryRun'>
  ): string | undefined => {
    if (executionConfig.dryRun === true) {
      return undefined;
    }
    return getLifiCircuitOpenReason({
      rpcCache: params.rpcCache,
      lifiConfig: params.config.lifi,
      purpose: 'execution_refresh',
    });
  };

  const calldataAggregatorProviders: DiscoveryExternalTakeRouteProvider[] = [
    createCalldataAggregatorRouteProvider({
      providerId: 'lifi',
      quotePath: params.quoteLifiPath,
      getQuoteCircuitOutcome: getCircuitGuardedQuoteOutcome,
      recordQuoteCircuitOutcome: params.recordLifiCircuitOutcome,
      decorateExecutionConfig: ({
        config,
        route,
        executionFailureHandler,
      }) => ({
        ...config,
        onLifiQuoteResult: createQuoteResultHandler(config, route),
        onLifiExecutionFailure: executionFailureHandler,
      }),
      getExecutionRefreshCircuitOpenReason:
        getLifiExecutionRefreshCircuitOpenReason,
      executeTake: lifiExecutionModule.takeLiquidationLifi,
    }),
    createCalldataAggregatorRouteProvider({
      providerId: 'oneinch',
      quotePath: params.quoteOneInchAggregatorPath,
      getQuoteCircuitOutcome: getCircuitGuardedQuoteOutcome,
      recordQuoteCircuitOutcome: params.recordOneInchCircuitOutcome,
      decorateExecutionConfig: ({
        config,
        route,
        executionFailureHandler,
      }) => ({
        ...config,
        onOneInchAggregatorQuoteResult: createQuoteResultHandler(config, route),
        onOneInchAggregatorExecutionFailure: executionFailureHandler,
      }),
      executeTake:
        oneInchAggregatorExecutionModule.takeLiquidationOneInchAggregator,
    }),
    createCalldataAggregatorRouteProvider({
      providerId: 'sushi_aggregator',
      quotePath: params.quoteSushiAggregatorPath,
      decorateExecutionConfig: ({
        config,
        route,
        executionFailureHandler,
      }) => ({
        ...config,
        onSushiAggregatorQuoteResult: createQuoteResultHandler(config, route),
        onSushiAggregatorExecutionFailure: executionFailureHandler,
      }),
      executeTake: sushiAggregatorExecutionModule.takeLiquidationSushiAggregator,
    }),
  ];

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
    ...calldataAggregatorProviders.map((provider) => [
      routeProviderKey({
        selectedPath: provider.path,
        providerId: provider.providerId,
      }),
      provider,
    ] as const),
  ]);

  return {
    selectExternalTakeProvider: ({ selectedPath, providerId }) => {
      const provider = providersByRoute.get(
        routeProviderKey({ selectedPath, providerId })
      );
      if (provider === undefined) {
        throw new Error(
          `Unsupported external take route: ${selectedPath}` +
            (providerId ? `/${providerId}` : '')
        );
      }
      return provider;
    },
  };
}
