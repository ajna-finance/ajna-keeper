import { LiquiditySource } from '../../config';
import { getOneInchAggregatorPathQuoteEvaluation } from '../../take/oneinch-aggregator/quote-evaluation';
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
  CalldataAggregatorPathQuoteInput,
  QuoteCircuitPolicy,
  quoteCalldataAggregatorPathForDiscovery,
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
  } & CalldataAggregatorPathQuoteInput
): Promise<ExternalTakeQuoteEvaluation> {
  return quoteCalldataAggregatorPathForDiscovery(params, {
    label: '1inch',
    selectedLiquiditySource: LiquiditySource.ONEINCH,
    abortErrorMessage: '1inch aggregator external take quote aborted',
    timeoutLabel: '1inch aggregator external take quote',
    circuitFactory: (params): QuoteCircuitPolicy => {
      const circuitOpenReason = getOneInchCircuitOpenReason({
        rpcCache: params.rpcCache,
        takePolicy: params.takePolicy,
      });
      return params.quoteCircuitMode === 'observe'
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
    },
    evaluate: async (signal, params, quoteCollateralWad) =>
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
