import { LiquiditySource } from '../../config';
import { getOneInchAggregatorPathQuoteEvaluation } from '../../take/oneinch-aggregator/quote-evaluation';
import { getDebtConstrainedTakeCollateralWad } from '../../take/take-sizing';
import { ExternalTakeQuoteEvaluation } from '../../take/types';
import { AsyncOperationLimiter } from '../../utils';
import { DiscoveryExecutionConfig, DiscoveryRpcCache } from '../types';
import {
  getOneInchCircuitOpenReason,
  getOneInchQuoteTimeoutMs,
} from './one-inch-circuit';
import {
  AutoDiscoverTakePolicyRuntime,
  DiscoveryTokenDecimalsCacheResolver,
  OneInchAggregatorPathQuoteInput,
  QuoteCircuitPolicy,
  quoteCircuitGuardedPath,
  recordOneInchCircuitOutcomeForDiscovery,
} from './quotes';

export async function quoteOneInchAggregatorPathForDiscovery(
  params: {
    config: DiscoveryExecutionConfig;
    rpcCache?: DiscoveryRpcCache;
    takePolicy: AutoDiscoverTakePolicyRuntime;
    routeProbeLimiter?: AsyncOperationLimiter;
    probeTimeoutMs: number;
    getTokenDecimalsCache: DiscoveryTokenDecimalsCacheResolver;
  } & OneInchAggregatorPathQuoteInput
): Promise<ExternalTakeQuoteEvaluation> {
  const circuitOpenReason = getOneInchCircuitOpenReason({
    rpcCache: params.rpcCache,
    takePolicy: params.takePolicy,
  });
  const circuit: QuoteCircuitPolicy =
    params.quoteCircuitMode === 'observe'
      ? { kind: 'observe', openReason: circuitOpenReason }
      : {
          kind: 'record',
          openReason: circuitOpenReason,
          recordOutcome: (outcome) =>
            recordOneInchCircuitOutcomeForDiscovery({
              rpcCache: params.rpcCache,
              takePolicy: params.takePolicy,
              outcome,
            }),
        };
  const quoteCollateralWad = getDebtConstrainedTakeCollateralWad(params);
  return quoteCircuitGuardedPath({
    poolName: params.pool.name,
    label: '1inch',
    externalTakePath: 'calldata_aggregator',
    selectedLiquiditySource: LiquiditySource.ONEINCH,
    auctionPrice: params.auctionPrice,
    collateral: quoteCollateralWad,
    circuit,
    routeProbeLimiter: params.routeProbeLimiter,
    routeProbeAbortSignal: params.routeProbeAbortSignal,
    probeTimeoutMs: params.probeTimeoutMs,
    abortErrorMessage: '1inch aggregator external take quote aborted',
    timeoutLabel: '1inch aggregator external take quote',
    evaluate: async (signal) =>
      await getOneInchAggregatorPathQuoteEvaluation(
        params.pool,
        params.price,
        quoteCollateralWad,
        params.poolConfig,
        {
          connectorTokens: params.config.connectorTokens,
          oneInchAggregatorTaker: params.config.oneInchAggregatorTaker,
          oneInchAggregationExecutorAllowlist:
            params.config.oneInchAggregationExecutorAllowlist,
          oneInchDefaultSlippage: params.config.oneInchDefaultSlippage,
          oneInchRouters: params.config.oneInchRouters,
          oneInchRequestAbortSignal: signal,
          oneInchRequestTimeoutMs: getOneInchQuoteTimeoutMs(params.takePolicy),
          chainId: params.rpcCache?.chainId,
          tokenDecimalsCache: params.getTokenDecimalsCache(params.rpcCache),
        },
        params.signer,
        params.auctionPrice
      ),
  });
}
