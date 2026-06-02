import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber } from 'ethers';
import { LiquiditySource, getAutoDiscoverTakePolicy } from '../config';
import { DiscoveryReadTransports } from '../read-transports';
import * as takeFactoryModule from '../take/factory';
import { FactoryRouteProfitabilityContext } from '../take/factory';
import * as lifiExecutionModule from '../take/lifi-execution';
import * as oneInchExecutionModule from '../take/one-inch-execution';
import { ExternalTakeQuoteEvaluation } from '../take/types';
import {
  AsyncOperationLimiter,
  getErrorMessage,
  withTimeoutAbort,
} from '../utils';
import { withTakeLiquiditySource } from './external-take-provider';
import {
  getLifiCircuitOpenReason,
  recordLifiQuoteFailure,
  recordLifiQuoteSuccess,
} from './lifi-circuit';
import {
  getOneInchCircuitOpenReason,
  getOneInchQuoteTimeoutMs,
  recordOneInchQuoteFailure,
  recordOneInchQuoteSuccess,
} from './one-inch-circuit';
import { ResolvedTakeTarget } from './targets';
import {
  DiscoveryExecutionConfig,
  DiscoveryRpcCache,
  LifiCircuitPurpose,
  OneInchQuoteCircuitPurpose,
} from './types';

export type AutoDiscoverTakePolicyRuntime = ReturnType<
  typeof getAutoDiscoverTakePolicy
>;
export type OneInchCircuitOutcome = 'success' | 'failure' | 'neutral';
export type LifiCircuitOutcome = 'success' | 'failure' | 'neutral';

export interface FactoryPathQuoteInput {
  pool: FungiblePool;
  signer: Signer;
  poolConfig: ResolvedTakeTarget;
  auctionPrice: BigNumber;
  collateral: BigNumber;
  factoryGasQuoteFallback?: boolean;
  routeProbeAbortSignal?: AbortSignal;
}

export interface OneInchPathQuoteInput extends FactoryPathQuoteInput {
  price: number;
}

export interface LifiPathQuoteInput extends FactoryPathQuoteInput {
  price: number;
  recordCircuitOutcome?: boolean;
}

export type FactoryPathQuoteFn = (
  quoteParams: FactoryPathQuoteInput
) => Promise<ExternalTakeQuoteEvaluation>;

export type OneInchPathQuoteFn = (
  quoteParams: OneInchPathQuoteInput
) => Promise<ExternalTakeQuoteEvaluation>;

export type LifiPathQuoteFn = (
  quoteParams: LifiPathQuoteInput
) => Promise<ExternalTakeQuoteEvaluation>;

export type DiscoveryFactoryQuoteConfig = {
  uniswapV3RouterOverrides: DiscoveryExecutionConfig['uniswapV3RouterOverrides'];
  sushiswapRouterOverrides: DiscoveryExecutionConfig['sushiswapRouterOverrides'];
  curveRouterOverrides: DiscoveryExecutionConfig['curveRouterOverrides'];
  tokenAddresses: DiscoveryExecutionConfig['tokenAddresses'];
};

export type DiscoveryFactoryRouteProfitabilityContextBuilder = (params: {
  pool: FungiblePool;
  signer: Signer;
  config: DiscoveryExecutionConfig;
  transports: DiscoveryReadTransports;
  rpcCache?: DiscoveryRpcCache;
  defaultLiquiditySource: LiquiditySource | undefined;
  sources?: LiquiditySource[];
  allowSubsidy?: boolean;
  takePolicy: AutoDiscoverTakePolicyRuntime;
}) => Promise<FactoryRouteProfitabilityContext | undefined>;

export type DiscoveryTokenDecimalsCacheResolver = (
  rpcCache?: DiscoveryRpcCache
) => Map<string, number> | undefined;

type DiscoveryOneInchQuoteOptions = {
  oneInchRequestTimeoutMs: number;
  oneInchRequestAbortSignal?: AbortSignal;
  chainId?: number;
  tokenDecimalsCache?: Map<string, number>;
};

type OneInchDiscoveryQuoteEvaluator = (
  quoteOptions: DiscoveryOneInchQuoteOptions
) => Promise<ExternalTakeQuoteEvaluation>;

async function withCombinedAbortSignal<T>(
  signals: Array<AbortSignal | undefined>,
  fn: (signal?: AbortSignal) => Promise<T>
): Promise<T> {
  const activeSignals = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined
  );
  if (activeSignals.length === 0) {
    return await fn();
  }
  if (activeSignals.length === 1) {
    return await fn(activeSignals[0]);
  }

  const controller = new AbortController();
  const cleanup: Array<() => void> = [];
  const abortFrom = (signal: AbortSignal): void => {
    if (!controller.signal.aborted) {
      controller.abort(signal.reason);
    }
  };

  for (const signal of activeSignals) {
    if (signal.aborted) {
      abortFrom(signal);
      break;
    }
    const listener = () => abortFrom(signal);
    signal.addEventListener('abort', listener, { once: true });
    cleanup.push(() => signal.removeEventListener('abort', listener));
  }

  try {
    return await fn(controller.signal);
  } finally {
    for (const removeListener of cleanup) {
      removeListener();
    }
  }
}

export function recordOneInchCircuitOutcomeForDiscovery(params: {
  rpcCache?: DiscoveryRpcCache;
  takePolicy: AutoDiscoverTakePolicyRuntime;
  outcome: OneInchCircuitOutcome;
  purpose?: OneInchQuoteCircuitPurpose;
}): void {
  if (params.outcome === 'neutral') {
    return;
  }
  if (params.outcome === 'failure') {
    recordOneInchQuoteFailure({
      rpcCache: params.rpcCache,
      takePolicy: params.takePolicy,
      purpose: params.purpose,
    });
    return;
  }
  recordOneInchQuoteSuccess(params.rpcCache, params.purpose);
}

export function recordLifiCircuitOutcomeForDiscovery(params: {
  rpcCache?: DiscoveryRpcCache;
  config?: DiscoveryExecutionConfig;
  outcome: LifiCircuitOutcome;
  purpose?: LifiCircuitPurpose;
}): void {
  if (params.outcome === 'neutral') {
    return;
  }
  if (params.outcome === 'failure') {
    recordLifiQuoteFailure({
      rpcCache: params.rpcCache,
      lifiConfig: params.config?.lifi,
      purpose: params.purpose,
    });
    return;
  }
  recordLifiQuoteSuccess(params.rpcCache, params.purpose);
}

export async function quoteFactoryPathForDiscovery(
  params: {
    config: DiscoveryExecutionConfig;
    transports: DiscoveryReadTransports;
    rpcCache?: DiscoveryRpcCache;
    takePolicy: AutoDiscoverTakePolicyRuntime;
    defaultFactoryLiquiditySource: LiquiditySource | undefined;
    routeProbeLimiter?: AsyncOperationLimiter;
    factoryQuoteConfig: DiscoveryFactoryQuoteConfig;
    buildFactoryRouteProfitabilityContext: DiscoveryFactoryRouteProfitabilityContextBuilder;
  } & FactoryPathQuoteInput
): Promise<ExternalTakeQuoteEvaluation> {
  if (params.defaultFactoryLiquiditySource === undefined) {
    return {
      isTakeable: false,
      externalTakePath: 'factory',
      reason: 'factory external take path is not configured',
    };
  }
  const factoryPoolConfig = withTakeLiquiditySource(
    params.poolConfig,
    params.defaultFactoryLiquiditySource
  );
  const routeProfitabilityContextFactory = async (sources: LiquiditySource[]) =>
    await params.buildFactoryRouteProfitabilityContext({
      pool: params.pool,
      signer: params.signer,
      config: params.config,
      transports: params.transports,
      rpcCache: params.rpcCache,
      defaultLiquiditySource: params.defaultFactoryLiquiditySource,
      sources,
      allowSubsidy: params.poolConfig.take.allowSubsidy === true,
      takePolicy: params.takePolicy,
    });
  const routeSelection = {
    allowedLiquiditySources: params.takePolicy?.allowedLiquiditySources,
    routeQuoteBudgetPerCandidate:
      params.takePolicy?.takeRouteQuoteBudgetPerCandidate,
    routeProbeLimiter: params.routeProbeLimiter,
    routeProbeAbortSignal: params.routeProbeAbortSignal,
    routeProfitabilityContextFactory: params.factoryGasQuoteFallback
      ? undefined
      : routeProfitabilityContextFactory,
  };

  const evaluation = await takeFactoryModule.getFactoryTakeQuoteEvaluation(
    params.pool,
    params.auctionPrice,
    params.collateral,
    factoryPoolConfig,
    params.factoryQuoteConfig,
    params.signer,
    params.rpcCache?.factoryQuoteProviders,
    routeSelection
  );
  return {
    ...evaluation,
    externalTakePath: 'factory',
    quotedAuctionPriceWad:
      evaluation.quotedAuctionPriceWad ?? params.auctionPrice,
    quotedCollateralWad: evaluation.quotedCollateralWad ?? params.collateral,
  };
}

async function quoteOneInchForDiscovery(
  params: {
    rpcCache?: DiscoveryRpcCache;
    takePolicy: AutoDiscoverTakePolicyRuntime;
    recordCircuitOutcome?: boolean;
    evaluate: OneInchDiscoveryQuoteEvaluator;
    routeProbeLimiter?: AsyncOperationLimiter;
    probeTimeoutMs: number;
    getTokenDecimalsCache: DiscoveryTokenDecimalsCacheResolver;
  } & OneInchPathQuoteInput
): Promise<ExternalTakeQuoteEvaluation> {
  const circuitOpenReason = getOneInchCircuitOpenReason({
    rpcCache: params.rpcCache,
    takePolicy: params.takePolicy,
  });
  if (circuitOpenReason) {
    return {
      isTakeable: false,
      externalTakePath: 'oneinch',
      selectedLiquiditySource: LiquiditySource.ONEINCH,
      quotedAuctionPriceWad: params.auctionPrice,
      quotedCollateralWad: params.collateral,
      reason: circuitOpenReason,
    };
  }

  let evaluation: ExternalTakeQuoteEvaluation;
  const oneInchRequestTimeoutMs = getOneInchQuoteTimeoutMs(params.takePolicy);
  try {
    evaluation = await withTimeoutAbort(
      async (timeoutSignal) =>
        await withCombinedAbortSignal(
          [timeoutSignal, params.routeProbeAbortSignal],
          async (signal) => {
            if (signal?.aborted) {
              throw signal.reason instanceof Error
                ? signal.reason
                : new Error('1inch external take quote aborted');
            }
            const evaluateOneInchQuote = async () =>
              await params.evaluate({
                oneInchRequestTimeoutMs,
                oneInchRequestAbortSignal: signal,
                chainId: params.rpcCache?.chainId,
                tokenDecimalsCache: params.getTokenDecimalsCache(
                  params.rpcCache
                ),
              });
            return params.routeProbeLimiter
              ? await params.routeProbeLimiter.run(
                  `1inch quote ${params.pool.name}`,
                  evaluateOneInchQuote,
                  { signal }
                )
              : await evaluateOneInchQuote();
          }
        ),
      params.probeTimeoutMs,
      '1inch external take quote'
    );
  } catch (error) {
    if (params.recordCircuitOutcome !== false) {
      recordOneInchCircuitOutcomeForDiscovery({
        rpcCache: params.rpcCache,
        takePolicy: params.takePolicy,
        outcome: 'failure',
      });
    }
    return {
      isTakeable: false,
      externalTakePath: 'oneinch',
      selectedLiquiditySource: LiquiditySource.ONEINCH,
      quotedAuctionPriceWad: params.auctionPrice,
      quotedCollateralWad: params.collateral,
      reason: getErrorMessage(error),
      quoteFailureRetryable: true,
      quoteFailureCode: 'exception',
    };
  }

  if (params.recordCircuitOutcome !== false) {
    recordOneInchCircuitOutcomeForDiscovery({
      rpcCache: params.rpcCache,
      takePolicy: params.takePolicy,
      outcome:
        evaluation.quoteFailureRetryable === true
          ? 'failure'
          : evaluation.quoteAmountRaw !== undefined
            ? 'success'
            : 'neutral',
    });
  }

  return {
    ...evaluation,
    externalTakePath: 'oneinch',
    selectedLiquiditySource:
      evaluation.selectedLiquiditySource ?? LiquiditySource.ONEINCH,
    quotedAuctionPriceWad: params.auctionPrice,
    quotedCollateralWad: params.collateral,
  };
}

export async function quoteOneInchPathForDiscovery(
  params: {
    config: DiscoveryExecutionConfig;
    rpcCache?: DiscoveryRpcCache;
    takePolicy: AutoDiscoverTakePolicyRuntime;
    recordCircuitOutcome?: boolean;
    routeProbeLimiter?: AsyncOperationLimiter;
    probeTimeoutMs: number;
    getTokenDecimalsCache: DiscoveryTokenDecimalsCacheResolver;
  } & OneInchPathQuoteInput
): Promise<ExternalTakeQuoteEvaluation> {
  return quoteOneInchForDiscovery({
    ...params,
    evaluate: (quoteOptions) =>
      oneInchExecutionModule.getOneInchPathQuoteEvaluation(
        params.pool,
        params.price,
        params.collateral,
        params.poolConfig,
        {
          ...quoteOptions,
          oneInchDefaultSlippage: params.config.oneInchDefaultSlippage,
        },
        params.signer,
        params.config.oneInchRouters,
        params.config.connectorTokens,
        params.auctionPrice
      ),
  });
}

export async function quoteKeeperTakerOneInchTakeForDiscovery(
  params: {
    config: DiscoveryExecutionConfig;
    rpcCache?: DiscoveryRpcCache;
    takePolicy: AutoDiscoverTakePolicyRuntime;
    routeProbeLimiter?: AsyncOperationLimiter;
    probeTimeoutMs: number;
    getTokenDecimalsCache: DiscoveryTokenDecimalsCacheResolver;
  } & OneInchPathQuoteInput
): Promise<ExternalTakeQuoteEvaluation> {
  return quoteOneInchForDiscovery({
    ...params,
    evaluate: (quoteOptions) =>
      oneInchExecutionModule.getOneInchTakeQuoteEvaluation(
        params.pool,
        params.price,
        params.collateral,
        params.poolConfig,
        {
          ...quoteOptions,
          oneInchDefaultSlippage: params.config.oneInchDefaultSlippage,
        },
        params.signer,
        params.config.oneInchRouters,
        params.config.connectorTokens,
        params.auctionPrice
      ),
  });
}

export async function quoteLifiPathForDiscovery(
  params: {
    config: DiscoveryExecutionConfig;
    rpcCache?: DiscoveryRpcCache;
    takePolicy: AutoDiscoverTakePolicyRuntime;
    recordCircuitOutcome?: boolean;
    routeProbeLimiter?: AsyncOperationLimiter;
    probeTimeoutMs: number;
    getTokenDecimalsCache: DiscoveryTokenDecimalsCacheResolver;
  } & LifiPathQuoteInput
): Promise<ExternalTakeQuoteEvaluation> {
  const circuitOpenReason = getLifiCircuitOpenReason({
    rpcCache: params.rpcCache,
    lifiConfig: params.config.lifi,
  });
  if (circuitOpenReason) {
    return {
      isTakeable: false,
      externalTakePath: 'lifi',
      selectedLiquiditySource: LiquiditySource.LIFI,
      quotedAuctionPriceWad: params.auctionPrice,
      quotedCollateralWad: params.collateral,
      reason: circuitOpenReason,
    };
  }

  let evaluation: ExternalTakeQuoteEvaluation;
  try {
    evaluation = await withTimeoutAbort(
      async (timeoutSignal) =>
        await withCombinedAbortSignal(
          [timeoutSignal, params.routeProbeAbortSignal],
          async (signal) => {
            if (signal?.aborted) {
              throw signal.reason instanceof Error
                ? signal.reason
                : new Error('LI.FI external take quote aborted');
            }
            const evaluateLifiQuote = async () =>
              await lifiExecutionModule.getLifiPathQuoteEvaluation(
                params.pool,
                params.price,
                params.collateral,
                params.poolConfig,
                {
                  lifi: params.config.lifi,
                  lifiTaker:
                    params.config.lifiTaker ??
                    lifiExecutionModule.getLifiTakerAddress(
                      params.config.takerContracts
                    ),
                  lifiRequestAbortSignal: signal,
                  chainId: params.rpcCache?.chainId,
                  tokenDecimalsCache: params.getTokenDecimalsCache(
                    params.rpcCache
                  ),
                },
                params.signer,
                params.auctionPrice
              );
            return params.routeProbeLimiter
              ? await params.routeProbeLimiter.run(
                  `LI.FI quote ${params.pool.name}`,
                  evaluateLifiQuote,
                  { signal }
                )
              : await evaluateLifiQuote();
          }
        ),
      params.probeTimeoutMs,
      'LI.FI external take quote'
    );
  } catch (error) {
    if (params.recordCircuitOutcome !== false) {
      recordLifiCircuitOutcomeForDiscovery({
        rpcCache: params.rpcCache,
        config: params.config,
        outcome: 'failure',
      });
    }
    return {
      isTakeable: false,
      externalTakePath: 'lifi',
      selectedLiquiditySource: LiquiditySource.LIFI,
      quotedAuctionPriceWad: params.auctionPrice,
      quotedCollateralWad: params.collateral,
      reason: getErrorMessage(error),
      quoteFailureRetryable: true,
      quoteFailureCode: 'exception',
    };
  }

  if (params.recordCircuitOutcome !== false) {
    recordLifiCircuitOutcomeForDiscovery({
      rpcCache: params.rpcCache,
      config: params.config,
      outcome:
        evaluation.quoteFailureRetryable === true
          ? 'failure'
          : evaluation.quoteAmountRaw !== undefined
            ? 'success'
            : 'neutral',
    });
  }

  return {
    ...evaluation,
    externalTakePath: 'lifi',
    selectedLiquiditySource:
      evaluation.selectedLiquiditySource ?? LiquiditySource.LIFI,
    quotedAuctionPriceWad: params.auctionPrice,
    quotedCollateralWad: params.collateral,
  };
}
