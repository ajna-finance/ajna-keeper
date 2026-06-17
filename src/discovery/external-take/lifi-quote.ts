import { LiquiditySource } from '../../config';
import { getLifiPathQuoteEvaluation } from '../../take/lifi/quote-evaluation';
import { ExternalTakeQuoteEvaluation } from '../../take/types';
import { AsyncOperationLimiter } from '../../utils';
import { DiscoveryExecutionConfig, DiscoveryRpcCache } from '../types';
import { getLifiCircuitOpenReason } from './lifi-circuit';
import {
  AutoDiscoverTakePolicyRuntime,
  DiscoveryTokenDecimalsCacheResolver,
  CalldataAggregatorPathQuoteInput,
  QuoteCircuitPolicy,
  quoteCalldataAggregatorPathForDiscovery,
  recordLifiCircuitOutcomeForDiscovery,
} from './quotes';

export async function quoteLifiPathForDiscovery(
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
    label: 'LI.FI',
    selectedLiquiditySource: LiquiditySource.LIFI,
    abortErrorMessage: 'LI.FI external take quote aborted',
    timeoutLabel: 'LI.FI external take quote',
    circuitFactory: (params): QuoteCircuitPolicy => {
      const circuitOpenReason = getLifiCircuitOpenReason({
        rpcCache: params.rpcCache,
        lifiConfig: params.config.lifi,
      });
      return params.quoteCircuitMode === 'observe'
        ? { kind: 'observe', openReason: circuitOpenReason }
        : {
            kind: 'record',
            openReason: circuitOpenReason,
            recordOutcome: (outcome) =>
              recordLifiCircuitOutcomeForDiscovery({
                rpcCache: params.rpcCache,
                config: params.config,
                outcome,
              }),
          };
    },
    evaluate: async (signal, params, quoteCollateralWad) =>
      await getLifiPathQuoteEvaluation(
        params.pool,
        params.price,
        quoteCollateralWad,
        params.poolConfig,
        {
          lifi: params.config.lifi,
          lifiTaker: params.config.lifiTaker,
          lifiRequestAbortSignal: signal,
          chainId: params.rpcCache?.chainId,
          tokenDecimalsCache: params.getTokenDecimalsCache(params.rpcCache),
        },
        params.signer,
        params.auctionPrice
      ),
  });
}
