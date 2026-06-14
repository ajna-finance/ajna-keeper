import {
  CalldataAggregatorProviderId,
  ExternalTakePathKind,
  isFactoryDynamicSource,
} from '../../config';
import { logger } from '../../logging';
import * as takeFactoryModule from '../../take/factory';
import { getExternalTakeExecutionPlanPrimaryEvaluation } from '../../take/external-take/execution-plan';
import * as lifiExecutionModule from '../../take/lifi/execution';
import * as sushiAggregatorExecutionModule from '../../take/sushi-aggregator/execution';
import * as oneInchExecutionModule from '../../take/one-inch-execution';
import { ResolvedTakeTarget } from '../targets';
import {
  createPreBroadcastFailureCapture,
  createPreSubmitResultCapture,
  DiscoveryExternalExecutionConfig,
  ExternalTakeQuoteIntent,
  ExternalTakeRouteProvider,
  withTakeLiquiditySource,
} from './provider';
import {
  FactoryPathQuoteInput,
  FactoryPathQuoteFn,
  getCircuitGuardedQuoteOutcome,
  LifiCircuitOutcome,
  LifiPathQuoteInput,
  LifiPathQuoteFn,
  OneInchCircuitOutcome,
  OneInchPathQuoteInput,
  OneInchPathQuoteFn,
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
  oneInchProvider: DiscoveryExternalTakeRouteProvider;
  lifiProvider: DiscoveryExternalTakeRouteProvider;
  sushiAggregatorProvider: DiscoveryExternalTakeRouteProvider;
  factoryProvider: DiscoveryExternalTakeRouteProvider;
  // Calldata-aggregator dispatch is path + provider id: LI.FI and Sushi
  // never compete for a single path-keyed slot.
  selectExternalTakeProvider(params: {
    selectedPath: DiscoveryExternalTakeRouteProvider['path'];
    providerId?: CalldataAggregatorProviderId;
  }): DiscoveryExternalTakeRouteProvider;
}

function getAggregatorQuoteIntentOptions(
  intent: ExternalTakeQuoteIntent
): Pick<
  OneInchPathQuoteInput | LifiPathQuoteInput,
  'routeProbeAbortSignal' | 'recordCircuitOutcome'
> {
  if (intent.kind !== 'hybrid_probe') {
    return {};
  }
  return {
    routeProbeAbortSignal: intent.abortSignal,
    recordCircuitOutcome: false,
  };
}

function getFactoryQuoteIntentOptions(
  intent: ExternalTakeQuoteIntent
): Pick<
  FactoryPathQuoteInput,
  'routeProbeAbortSignal' | 'factoryGasQuoteFallback'
> {
  if (intent.kind === 'hybrid_probe') {
    return { routeProbeAbortSignal: intent.abortSignal };
  }
  return {
    factoryGasQuoteFallback: intent.kind === HYBRID_GAS_QUOTE_FALLBACK_KIND,
  };
}

export function createDiscoveryExternalTakeProviderRegistry(params: {
  config: Pick<DiscoveryExecutionConfig, 'lifi'>;
  rpcCache?: DiscoveryRpcCache;
  quoteOneInchPath: OneInchPathQuoteFn;
  quoteKeeperTakerOneInchTake: OneInchPathQuoteFn;
  quoteFactoryPath: FactoryPathQuoteFn;
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

  const oneInchProvider: DiscoveryExternalTakeRouteProvider = {
    path: 'oneinch',
    quote: async ({
      intent,
      pool,
      signer,
      poolConfig,
      price,
      auctionPrice,
      collateral,
      debtToCover,
    }) => {
      const quoteOneInch =
        intent.kind === 'direct'
          ? params.quoteKeeperTakerOneInchTake
          : params.quoteOneInchPath;
      return quoteOneInch({
        pool,
        signer,
        poolConfig,
        price,
        auctionPrice,
        collateral,
        debtToCover,
        ...getAggregatorQuoteIntentOptions(intent),
      });
    },
    getQuoteCircuitOutcome: getCircuitGuardedQuoteOutcome,
    recordQuoteCircuitOutcome: params.recordOneInchCircuitOutcome,
    execute: async ({ pool, signer, poolConfig, liquidation, config }) => {
      const swapDataCapture = createPreSubmitResultCapture(
        config.onOneInchSwapDataResult
      );
      const executionFailureCapture = createPreBroadcastFailureCapture(
        config.onOneInchExecutionFailure
      );
      const oneInchConfig = {
        ...config,
        onOneInchSwapDataResult: swapDataCapture.handler,
        onOneInchExecutionFailure: executionFailureCapture.handler,
      };
      const succeeded = await oneInchExecutionModule.takeLiquidation({
        pool,
        signer,
        poolConfig,
        liquidation,
        config: oneInchConfig,
      });
      return {
        succeeded,
        preBroadcastFailed:
          swapDataCapture.didRejectBeforeSubmit() ||
          executionFailureCapture.didFailPreBroadcast(),
      };
    },
  };

  const lifiProvider: DiscoveryExternalTakeRouteProvider = {
    path: 'calldata_aggregator',
    providerId: 'lifi',
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
      params.quoteLifiPath({
        pool,
        signer,
        poolConfig,
        price,
        auctionPrice,
        collateral,
        debtToCover,
        ...getAggregatorQuoteIntentOptions(intent),
      }),
    getQuoteCircuitOutcome: getCircuitGuardedQuoteOutcome,
    recordQuoteCircuitOutcome: params.recordLifiCircuitOutcome,
    execute: async ({ pool, signer, poolConfig, liquidation, config }) => {
      const executionFailureCapture = createPreBroadcastFailureCapture(
        config.onLifiExecutionFailure
      );
      const lifiConfig = {
        ...config,
        onLifiExecutionFailure: executionFailureCapture.handler,
      };
      const circuitOpenReason =
        getLifiExecutionRefreshCircuitOpenReason(config);
      if (circuitOpenReason) {
        logger.warn(
          `LI.FI execution refresh circuit is open for ${pool.name}/${liquidation.borrower}; skipping LI.FI external take attempt`
        );
        lifiConfig.onLifiExecutionFailure?.({
          preBroadcast: true,
          error: circuitOpenReason,
        });
        return {
          succeeded: false,
          preBroadcastFailed: true,
        };
      }
      const succeeded = await lifiExecutionModule.takeLiquidationLifi({
        pool,
        signer,
        poolConfig,
        liquidation,
        config: lifiConfig,
      });
      return {
        succeeded,
        preBroadcastFailed: executionFailureCapture.didFailPreBroadcast(),
      };
    },
  };

  const sushiAggregatorProvider: DiscoveryExternalTakeRouteProvider = {
    path: 'calldata_aggregator',
    providerId: 'sushi_aggregator',
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
      params.quoteSushiAggregatorPath({
        pool,
        signer,
        poolConfig,
        price,
        auctionPrice,
        collateral,
        debtToCover,
        ...getAggregatorQuoteIntentOptions(intent),
      }),
    execute: async ({ pool, signer, poolConfig, liquidation, config }) => {
      const executionFailureCapture = createPreBroadcastFailureCapture(
        config.onSushiAggregatorExecutionFailure
      );
      const sushiConfig = {
        ...config,
        onSushiAggregatorExecutionFailure: executionFailureCapture.handler,
      };
      const succeeded =
        await sushiAggregatorExecutionModule.takeLiquidationSushiAggregator({
          pool,
          signer,
          poolConfig,
          liquidation,
          config: sushiConfig,
        });
      return {
        succeeded,
        preBroadcastFailed: executionFailureCapture.didFailPreBroadcast(),
      };
    },
  };

  const factoryProvider: DiscoveryExternalTakeRouteProvider = {
    path: 'factory',
    quote: async ({
      intent,
      pool,
      signer,
      poolConfig,
      auctionPrice,
      collateral,
    }) =>
      params.quoteFactoryPath({
        pool,
        signer,
        poolConfig,
        auctionPrice,
        collateral,
        ...getFactoryQuoteIntentOptions(intent),
      }),
    execute: async ({ pool, signer, poolConfig, liquidation, config }) => {
      const selectedSource = getExternalTakeExecutionPlanPrimaryEvaluation(
        liquidation.externalTakeExecutionPlan
      )?.selectedLiquiditySource;
      const factoryPoolConfig =
        selectedSource !== undefined && isFactoryDynamicSource(selectedSource)
          ? withTakeLiquiditySource(poolConfig, selectedSource)
          : poolConfig;
      const executionFailureCapture = createPreBroadcastFailureCapture(
        config.onFactoryExecutionFailure
      );
      const factoryConfig = {
        ...config,
        onFactoryExecutionFailure: executionFailureCapture.handler,
      };
      const succeeded = await takeFactoryModule.takeLiquidationFactory({
        pool,
        signer,
        poolConfig: factoryPoolConfig,
        liquidation,
        config: factoryConfig,
      });
      return {
        succeeded,
        preBroadcastFailed: executionFailureCapture.didFailPreBroadcast(),
      };
    },
  };
  const providersByPath: Record<
    ExternalTakePathKind,
    DiscoveryExternalTakeRouteProvider
  > = {
    oneinch: oneInchProvider,
    calldata_aggregator: lifiProvider,
    factory: factoryProvider,
  };

  return {
    oneInchProvider,
    lifiProvider,
    sushiAggregatorProvider,
    factoryProvider,
    selectExternalTakeProvider: ({ selectedPath, providerId }) => {
      if (
        selectedPath === 'calldata_aggregator' &&
        providerId === 'sushi_aggregator'
      ) {
        return sushiAggregatorProvider;
      }
      const provider = providersByPath[selectedPath];
      if (provider === undefined) {
        throw new Error(`Unsupported external take path: ${selectedPath}`);
      }
      return provider;
    },
  };
}
