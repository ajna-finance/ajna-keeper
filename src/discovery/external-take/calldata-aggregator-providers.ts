import { AsyncOperationLimiter } from '../../utils';
import {
  CALLDATA_AGGREGATOR_PROVIDER_IDS,
  CalldataAggregatorProviderId,
} from '../../config';
import * as lifiExecutionModule from '../../take/lifi/execution';
import * as oneInchAggregatorExecutionModule from '../../take/oneinch-aggregator/execution';
import * as sushiAggregatorExecutionModule from '../../take/sushi-aggregator/execution';
import {
  DiscoveryExecutionConfig,
  DiscoveryRpcCache,
  LifiCircuitPurpose,
  OneInchQuoteCircuitPurpose,
} from '../types';
import { getLifiCircuitOpenReason } from './lifi-circuit';
import { quoteLifiPathForDiscovery } from './lifi-quote';
import { quoteOneInchAggregatorPathForDiscovery } from './oneinch-aggregator-quote';
import {
  createCalldataAggregatorRouteProvider,
  createQuoteResultHandler,
  DiscoveryExternalTakeRouteProvider,
} from './providers';
import {
  AutoDiscoverTakePolicyRuntime,
  DiscoveryTokenDecimalsCacheResolver,
  getCircuitGuardedQuoteOutcome,
  LifiCircuitOutcome,
  LifiPathQuoteFn,
  OneInchAggregatorPathQuoteFn,
  OneInchCircuitOutcome,
  recordLifiCircuitOutcomeForDiscovery,
  recordOneInchCircuitOutcomeForDiscovery,
  SushiAggregatorPathQuoteFn,
} from './quotes';
import { quoteSushiAggregatorPathForDiscovery } from './sushi-aggregator-quote';

export function createDiscoveryCalldataAggregatorRouteProviders(params: {
  config: DiscoveryExecutionConfig;
  rpcCache?: DiscoveryRpcCache;
  takePolicy: AutoDiscoverTakePolicyRuntime;
  routeProbeLimiter?: AsyncOperationLimiter;
  probeTimeoutMs: number;
  getTokenDecimalsCache: DiscoveryTokenDecimalsCacheResolver;
}): DiscoveryExternalTakeRouteProvider[] {
  const quoteLifiPath: LifiPathQuoteFn = (quoteParams) =>
    quoteLifiPathForDiscovery({
      ...quoteParams,
      config: params.config,
      rpcCache: params.rpcCache,
      takePolicy: params.takePolicy,
      routeProbeLimiter: params.routeProbeLimiter,
      probeTimeoutMs: params.probeTimeoutMs,
      getTokenDecimalsCache: params.getTokenDecimalsCache,
    });
  const quoteOneInchAggregatorPath: OneInchAggregatorPathQuoteFn = (
    quoteParams
  ) =>
    quoteOneInchAggregatorPathForDiscovery({
      ...quoteParams,
      config: params.config,
      rpcCache: params.rpcCache,
      takePolicy: params.takePolicy,
      routeProbeLimiter: params.routeProbeLimiter,
      probeTimeoutMs: params.probeTimeoutMs,
      getTokenDecimalsCache: params.getTokenDecimalsCache,
    });
  const quoteSushiAggregatorPath: SushiAggregatorPathQuoteFn = (quoteParams) =>
    quoteSushiAggregatorPathForDiscovery({
      ...quoteParams,
      config: params.config,
      rpcCache: params.rpcCache,
      takePolicy: params.takePolicy,
      routeProbeLimiter: params.routeProbeLimiter,
      probeTimeoutMs: params.probeTimeoutMs,
      getTokenDecimalsCache: params.getTokenDecimalsCache,
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
  const getLifiExecutionRefreshCircuitOpenReason = (executionConfig: {
    dryRun?: boolean;
  }): string | undefined => {
    if (executionConfig.dryRun === true) {
      return undefined;
    }
    return getLifiCircuitOpenReason({
      rpcCache: params.rpcCache,
      lifiConfig: params.config.lifi,
      purpose: 'execution_refresh',
    });
  };

  const providersById = {
    lifi: createCalldataAggregatorRouteProvider({
      providerId: 'lifi',
      quotePath: quoteLifiPath,
      getQuoteCircuitOutcome: getCircuitGuardedQuoteOutcome,
      recordQuoteCircuitOutcome: recordLifiCircuitOutcome,
      decorateExecutionConfig: ({
        config,
        route,
        executionFailureHandler,
      }) => ({
        ...config,
        onLifiQuoteResult: createQuoteResultHandler(config, route, (result) =>
          recordLifiCircuitOutcome(
            result.success
              ? 'success'
              : result.retryable === true
                ? 'failure'
                : 'neutral',
            'execution_refresh'
          )
        ),
        onLifiExecutionFailure: executionFailureHandler,
      }),
      getExecutionRefreshCircuitOpenReason:
        getLifiExecutionRefreshCircuitOpenReason,
      executeTake: lifiExecutionModule.takeLiquidationLifi,
    }),
    oneinch: createCalldataAggregatorRouteProvider({
      providerId: 'oneinch',
      quotePath: quoteOneInchAggregatorPath,
      getQuoteCircuitOutcome: getCircuitGuardedQuoteOutcome,
      recordQuoteCircuitOutcome: recordOneInchCircuitOutcome,
      decorateExecutionConfig: ({
        config,
        route,
        executionFailureHandler,
      }) => ({
        ...config,
        onOneInchAggregatorQuoteResult: createQuoteResultHandler(
          config,
          route,
          (result) => {
            if (result.success) {
              recordOneInchCircuitOutcome('success', 'swap_data');
              return;
            }
            // Only an explicitly-retryable failure trips the circuit; an
            // ambiguous/undefined retryable is neutral (matches LI.FI's mapping
            // above so the two providers' circuit behavior stays symmetric).
            if (result.retryable === true) {
              recordOneInchCircuitOutcome('failure', 'swap_data');
            }
          }
        ),
        onOneInchAggregatorExecutionFailure: executionFailureHandler,
      }),
      executeTake:
        oneInchAggregatorExecutionModule.takeLiquidationOneInchAggregator,
    }),
    sushi_aggregator: createCalldataAggregatorRouteProvider({
      providerId: 'sushi_aggregator',
      quotePath: quoteSushiAggregatorPath,
      decorateExecutionConfig: ({
        config,
        route,
        executionFailureHandler,
      }) => ({
        ...config,
        onSushiAggregatorQuoteResult: createQuoteResultHandler(config, route),
        onSushiAggregatorExecutionFailure: executionFailureHandler,
      }),
      executeTake:
        sushiAggregatorExecutionModule.takeLiquidationSushiAggregator,
    }),
  } satisfies Record<
    CalldataAggregatorProviderId,
    DiscoveryExternalTakeRouteProvider
  >;

  return CALLDATA_AGGREGATOR_PROVIDER_IDS.map(
    (providerId) => providersById[providerId]
  );
}
