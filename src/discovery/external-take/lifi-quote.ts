import { LiquiditySource } from '../../config';
import { getLifiPathQuoteEvaluation } from '../../take/lifi/quote-evaluation';
import { getDebtConstrainedTakeCollateralWad } from '../../take/take-sizing';
import { ExternalTakeQuoteEvaluation } from '../../take/types';
import { AsyncOperationLimiter } from '../../utils';
import { DiscoveryExecutionConfig, DiscoveryRpcCache } from '../types';
import { getLifiCircuitOpenReason } from './lifi-circuit';
import {
  AutoDiscoverTakePolicyRuntime,
  DiscoveryTokenDecimalsCacheResolver,
  LifiPathQuoteInput,
  QuoteCircuitPolicy,
  quoteCircuitGuardedPath,
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
  } & LifiPathQuoteInput
): Promise<ExternalTakeQuoteEvaluation> {
  const circuitOpenReason = getLifiCircuitOpenReason({
    rpcCache: params.rpcCache,
    lifiConfig: params.config.lifi,
  });
  const circuit: QuoteCircuitPolicy =
    params.quoteCircuitMode === 'observe'
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
  const quoteCollateralWad = getDebtConstrainedTakeCollateralWad(params);
  return quoteCircuitGuardedPath({
    poolName: params.pool.name,
    label: 'LI.FI',
    externalTakePath: 'calldata_aggregator',
    selectedLiquiditySource: LiquiditySource.LIFI,
    auctionPrice: params.auctionPrice,
    collateral: quoteCollateralWad,
    circuit,
    routeProbeLimiter: params.routeProbeLimiter,
    routeProbeAbortSignal: params.routeProbeAbortSignal,
    probeTimeoutMs: params.probeTimeoutMs,
    abortErrorMessage: 'LI.FI external take quote aborted',
    timeoutLabel: 'LI.FI external take quote',
    evaluate: async (signal) =>
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
