import { Signer } from '@ajna-finance/sdk';
import { ResolvedUniswapV3DirectDexQuoteConfig } from '../../config';
import { logger } from '../../logging';
import { getErrorMessage, withTimeout } from '../../utils';
import { CurveQuoteProvider } from '../../dex/providers/curve-quote-provider';
import { UniswapV3QuoteProvider } from '../../dex/providers/uniswap-quote-provider';
import { BASIS_POINTS_DENOMINATOR } from '../../constants';
import { DirectDexQuoteProviderRuntimeCache } from './runtime-cache';
import { DirectDexQuoteConfig } from './route-types';
import { DEFAULT_DIRECT_DEX_ROUTE_RPC_TIMEOUT_MS } from './route-amounts';

const PROVIDER_INIT_FAILURE_RETRY_MS = 30_000;
const PROVIDER_INIT_FAILURE_RETRY_JITTER_BPS = 2_000;

function getProviderInitFailureRetryMs(): number {
  const jitterRangeMs = Math.floor(
    (PROVIDER_INIT_FAILURE_RETRY_MS * PROVIDER_INIT_FAILURE_RETRY_JITTER_BPS) /
      BASIS_POINTS_DENOMINATOR
  );
  return (
    PROVIDER_INIT_FAILURE_RETRY_MS -
    jitterRangeMs +
    Math.floor(Math.random() * (jitterRangeMs * 2 + 1))
  );
}

interface InitializableQuoteProvider {
  initialize(): Promise<boolean>;
}

export function throwIfRouteProbeAborted(
  signal?: AbortSignal,
  label: string = 'direct DEX route probe'
): void {
  if (!signal?.aborted) {
    return;
  }
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error(`${label} aborted`);
}

async function initializeQuoteProviderWithCooldown<
  TProvider extends InitializableQuoteProvider,
>(params: {
  runtimeCache?: DirectDexQuoteProviderRuntimeCache;
  label: string;
  getCachedProvider: () => TProvider | null | undefined;
  setCachedProvider: (provider: TProvider | null) => void;
  getUnavailableUntilMs: () => number | undefined;
  setUnavailableUntilMs: (untilMs: number | undefined) => void;
  getInitializationInflight?: () => Promise<TProvider | null> | undefined;
  setInitializationInflight?: (
    pending: Promise<TProvider | null> | undefined
  ) => void;
  createProvider: () => TProvider;
}): Promise<TProvider | undefined> {
  let quoteProvider = params.getCachedProvider();
  const unavailableUntilMs = params.getUnavailableUntilMs();
  if (
    quoteProvider === undefined &&
    params.runtimeCache &&
    unavailableUntilMs !== undefined &&
    unavailableUntilMs > Date.now()
  ) {
    logger.debug(
      `${params.label} quote provider initialization cooldown active for ${Math.max(
        0,
        unavailableUntilMs - Date.now()
      )}ms`
    );
    return undefined;
  }

  if (quoteProvider === undefined) {
    const initializeProvider = async (): Promise<TProvider | null> => {
      const candidateProvider = params.createProvider();
      const initialized = await withTimeout(
        candidateProvider.initialize(),
        DEFAULT_DIRECT_DEX_ROUTE_RPC_TIMEOUT_MS,
        `${params.label} quote provider initialization`
      ).catch((error) => {
        logger.warn(
          `${params.label} quote provider initialization failed: ${getErrorMessage(error)}`
        );
        return false;
      });
      const initializedProvider = initialized ? candidateProvider : null;
      if (params.runtimeCache) {
        if (initializedProvider) {
          if (unavailableUntilMs !== undefined) {
            logger.info(
              `${params.label} quote provider initialization recovered`
            );
          }
          params.setCachedProvider(initializedProvider);
          params.setUnavailableUntilMs(undefined);
        } else {
          const retryMs = getProviderInitFailureRetryMs();
          params.setUnavailableUntilMs(Date.now() + retryMs);
          logger.warn(
            `${params.label} quote provider unavailable; retrying initialization in ${retryMs}ms`
          );
        }
      }
      return initializedProvider;
    };

    const cachedInitialization = params.getInitializationInflight?.();
    if (cachedInitialization) {
      quoteProvider = await cachedInitialization;
    } else {
      const pendingInitialization = initializeProvider();
      params.setInitializationInflight?.(pendingInitialization);
      try {
        quoteProvider = await pendingInitialization;
      } finally {
        if (params.getInitializationInflight?.() === pendingInitialization) {
          params.setInitializationInflight?.(undefined);
        }
      }
    }
  }

  return quoteProvider ?? undefined;
}

export function getUniswapV3QuoteProvider(params: {
  signer: Signer;
  quoteConfig?: ResolvedUniswapV3DirectDexQuoteConfig;
  runtimeCache?: DirectDexQuoteProviderRuntimeCache;
}): UniswapV3QuoteProvider | undefined {
  const quoteConfig = params.quoteConfig;
  if (!quoteConfig) {
    return undefined;
  }

  let quoteProvider = params.runtimeCache?.uniswapV3;
  if (quoteProvider === undefined) {
    const candidateProvider = new UniswapV3QuoteProvider(params.signer, {
      poolFactoryAddress: quoteConfig.poolFactoryAddress,
      defaultFeeTier: quoteConfig.defaultFeeTier,
      wethAddress: quoteConfig.wethAddress,
      quoterV2Address: quoteConfig.quoterV2Address,
    });
    quoteProvider = candidateProvider.isAvailable() ? candidateProvider : null;
    if (params.runtimeCache) {
      params.runtimeCache.uniswapV3 = quoteProvider;
    }
  }

  return quoteProvider ?? undefined;
}
export async function getCurveQuoteProvider(params: {
  signer: Signer;
  routerConfig?: DirectDexQuoteConfig['curveRouterOverrides'];
  tokenAddresses?: DirectDexQuoteConfig['tokenAddresses'];
  runtimeCache?: DirectDexQuoteProviderRuntimeCache;
}): Promise<CurveQuoteProvider | undefined> {
  const routerConfig = params.routerConfig;
  if (!routerConfig?.poolConfigs || !routerConfig.wethAddress) {
    return undefined;
  }
  const poolConfigs = routerConfig.poolConfigs;
  const wethAddress = routerConfig.wethAddress;

  return initializeQuoteProviderWithCooldown({
    runtimeCache: params.runtimeCache,
    label: 'Curve',
    getCachedProvider: () => params.runtimeCache?.curve,
    setCachedProvider: (provider) => {
      if (params.runtimeCache) {
        params.runtimeCache.curve = provider;
      }
    },
    getUnavailableUntilMs: () => params.runtimeCache?.curveUnavailableUntilMs,
    setUnavailableUntilMs: (untilMs) => {
      if (params.runtimeCache) {
        params.runtimeCache.curveUnavailableUntilMs = untilMs;
      }
    },
    getInitializationInflight: () => params.runtimeCache?.curveInitInflight,
    setInitializationInflight: (pending) => {
      if (params.runtimeCache) {
        params.runtimeCache.curveInitInflight = pending;
      }
    },
    createProvider: () =>
      new CurveQuoteProvider(params.signer, {
        poolConfigs,
        defaultSlippage: routerConfig.defaultSlippage ?? 1.0,
        wethAddress,
        tokenAddresses: params.tokenAddresses ?? {},
      }),
  });
}
