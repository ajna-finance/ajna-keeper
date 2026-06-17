import { getSushiAggregatorPathQuoteEvaluation } from '../../take/sushi-aggregator/quote-evaluation';
import { ExternalTakeQuoteEvaluation } from '../../take/types';
import { AsyncOperationLimiter } from '../../utils';
import { DiscoveryExecutionConfig, DiscoveryRpcCache } from '../types';
import {
  AutoDiscoverTakePolicyRuntime,
  DiscoveryTokenDecimalsCacheResolver,
  quoteCalldataAggregatorPathForDiscovery,
  CalldataAggregatorPathQuoteInput,
} from './quotes';

export async function quoteSushiAggregatorPathForDiscovery(
  params: {
    config: DiscoveryExecutionConfig;
    rpcCache?: DiscoveryRpcCache;
    takePolicy: AutoDiscoverTakePolicyRuntime;
    routeProbeLimiter?: AsyncOperationLimiter;
    probeTimeoutMs: number;
    getTokenDecimalsCache: DiscoveryTokenDecimalsCacheResolver;
  } & CalldataAggregatorPathQuoteInput
): Promise<ExternalTakeQuoteEvaluation> {
  return quoteCalldataAggregatorPathForDiscovery(params, {
    providerId: 'sushi_aggregator',
    abortErrorMessage: 'Sushi aggregator external take quote aborted',
    timeoutLabel: 'Sushi aggregator external take quote',
    // Sushi deliberately runs without a discovery quote circuit breaker: unlike
    // LI.FI/1inch, SushiAggregatorDexConfig exposes no quote-failure threshold/
    // cooldown fields to drive one, so failures fall through to the normal
    // per-probe timeout/abort handling. Now that the breaker mechanics are
    // unified on providerCircuits.*, wiring a Sushi circuit is a small follow-up
    // (add the two config fields + a sushi-circuit module) if its discovery
    // quote volume ever warrants the open-on-failure cooldown.
    circuitFactory: () => ({ kind: 'none' }),
    evaluate: async (signal, params, quoteCollateralWad) =>
      await getSushiAggregatorPathQuoteEvaluation(
        params.pool,
        params.price,
        quoteCollateralWad,
        params.poolConfig,
        {
          sushiAggregator: params.config.sushiAggregator,
          sushiAggregatorTaker: params.config.sushiAggregatorTaker,
          sushiAggregatorRequestAbortSignal: signal,
          chainId: params.rpcCache?.chainId,
          tokenDecimalsCache: params.getTokenDecimalsCache(params.rpcCache),
        },
        params.signer,
        params.auctionPrice
      ),
  });
}
