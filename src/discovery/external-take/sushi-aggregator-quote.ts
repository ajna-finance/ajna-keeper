import { LiquiditySource } from '../../config';
import { getSushiAggregatorPathQuoteEvaluation } from '../../take/sushi-aggregator/quote-evaluation';
import { getDebtConstrainedTakeCollateralWad } from '../../take/take-sizing';
import { ExternalTakeQuoteEvaluation } from '../../take/types';
import { AsyncOperationLimiter } from '../../utils';
import { DiscoveryExecutionConfig, DiscoveryRpcCache } from '../types';
import {
  AutoDiscoverTakePolicyRuntime,
  DiscoveryTokenDecimalsCacheResolver,
  quoteCircuitGuardedPath,
  SushiAggregatorPathQuoteInput,
} from './quotes';

export async function quoteSushiAggregatorPathForDiscovery(
  params: {
    config: DiscoveryExecutionConfig;
    rpcCache?: DiscoveryRpcCache;
    takePolicy: AutoDiscoverTakePolicyRuntime;
    routeProbeLimiter?: AsyncOperationLimiter;
    probeTimeoutMs: number;
    getTokenDecimalsCache: DiscoveryTokenDecimalsCacheResolver;
  } & SushiAggregatorPathQuoteInput
): Promise<ExternalTakeQuoteEvaluation> {
  const quoteCollateralWad = getDebtConstrainedTakeCollateralWad(params);
  return quoteCircuitGuardedPath({
    poolName: params.pool.name,
    label: 'Sushi Aggregator',
    externalTakePath: 'calldata_aggregator',
    selectedLiquiditySource: LiquiditySource.SUSHI_AGGREGATOR,
    auctionPrice: params.auctionPrice,
    collateral: quoteCollateralWad,
    circuit: { kind: 'none' },
    routeProbeLimiter: params.routeProbeLimiter,
    routeProbeAbortSignal: params.routeProbeAbortSignal,
    probeTimeoutMs: params.probeTimeoutMs,
    abortErrorMessage: 'Sushi aggregator external take quote aborted',
    timeoutLabel: 'Sushi aggregator external take quote',
    evaluate: async (signal) =>
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
