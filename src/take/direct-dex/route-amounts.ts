import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { quoteTokenScale } from '@ajna-finance/sdk/dist/contracts/pool';
import { BigNumber, ethers } from 'ethers';
import { LiquiditySource } from '../../config';
import { convertWadToTokenDecimals, getDecimalsErc20 } from '../../erc20';
import { logger } from '../../logging';
import { BASIS_POINTS_DENOMINATOR } from '../../constants';
import { getErrorMessage, pruneMapToMaxSize, withTimeout } from '../../utils';
import {
  applyExternalTakeRoutePolicy,
  mergeRoutePolicyIntoEvaluation,
} from '../external-take/policy';
import {
  deriveApprovedMinOutRaw,
  getMarketFactorFloorQuoteRaw,
  getQuoteAmountDueRawForScale,
} from '../external-take/quote-economics';
import {
  ApprovedDirectDexQuoteEvaluation,
  ExternalTakeQuoteEvaluation,
  TakeLiquidationPlan,
} from '../types';
import { DirectDexQuoteProviderRuntimeCache } from './runtime-cache';
import { incrementDirectDexRuntimeStat } from './runtime-cache';
import { DirectDexRouteEvaluationContext } from './route-types';

const MAX_TOKEN_DECIMAL_CACHE_ENTRIES = 512;
const MAX_QUOTE_TOKEN_SCALE_CACHE_ENTRIES = 512;
export const DEFAULT_DIRECT_DEX_ROUTE_RPC_TIMEOUT_MS = 2_000;
const DIRECT_DEX_TOKEN_DECIMALS_CHAIN_ID_TIMEOUT_MS =
  DEFAULT_DIRECT_DEX_ROUTE_RPC_TIMEOUT_MS;

export {
  ceilDiv,
  ceilWmul,
  deriveApprovedMinOutRaw,
  getMarketPriceFactorUnits,
} from '../external-take/quote-economics';

export async function getSwapDeadline(
  signer: Signer,
  ttlSeconds: number = 1800
): Promise<number> {
  const latestBlock = await signer.provider?.getBlock('latest');
  const baseTimestamp = latestBlock?.timestamp ?? Math.floor(Date.now() / 1000);
  return baseTimestamp + ttlSeconds;
}

export async function getSwapDeadlineCached(params: {
  signer: Signer;
  runtimeCache?: DirectDexQuoteProviderRuntimeCache;
  ttlSeconds?: number;
  freshnessMs?: number;
}): Promise<number> {
  const ttlSeconds = params.ttlSeconds ?? 1800;
  const freshnessMs = params.freshnessMs ?? 1500;
  const now = Date.now();
  const cached = params.runtimeCache?.swapDeadline;
  if (
    cached &&
    cached.ttlSeconds === ttlSeconds &&
    now - cached.fetchedAtMs <= freshnessMs
  ) {
    incrementDirectDexRuntimeStat(
      params.runtimeCache?.stats,
      'swapDeadlineCacheHits'
    );
    return cached.deadline;
  }

  incrementDirectDexRuntimeStat(
    params.runtimeCache?.stats,
    'swapDeadlineCacheMisses'
  );
  const latestBlock = await params.signer.provider?.getBlock('latest');
  const baseTimestamp = latestBlock?.timestamp ?? Math.floor(now / 1000);
  const deadline = baseTimestamp + ttlSeconds;
  if (params.runtimeCache) {
    params.runtimeCache.swapDeadline = {
      fetchedAtMs: now,
      blockTimestamp: baseTimestamp,
      deadline,
      ttlSeconds,
    };
  }
  return deadline;
}

export function getSlippageBasisPoints(
  defaultSlippage: number | undefined
): number {
  const slippagePercentage = defaultSlippage ?? 1.0;
  const basisPoints = Math.floor(slippagePercentage * 100);
  return Math.max(0, Math.min(BASIS_POINTS_DENOMINATOR, basisPoints));
}

export function getSlippageFloorQuoteRaw(
  quoteAmountRaw: BigNumber,
  defaultSlippage: number | undefined
): BigNumber {
  const slippageBasisPoints = getSlippageBasisPoints(defaultSlippage);
  return quoteAmountRaw
    .mul(BASIS_POINTS_DENOMINATOR - slippageBasisPoints)
    .div(BASIS_POINTS_DENOMINATOR);
}

export async function getQuoteAmountDueRaw(
  pool: FungiblePool,
  auctionPrice: BigNumber,
  collateral: BigNumber,
  runtimeCache?: DirectDexQuoteProviderRuntimeCache
): Promise<BigNumber> {
  const scale = await getCachedQuoteTokenScale(pool, runtimeCache);
  return getQuoteAmountDueRawForScale({
    quoteTokenScale: scale,
    auctionPriceWad: auctionPrice,
    collateralWad: collateral,
  });
}

export async function getCachedDirectDexTokenDecimals(
  signer: Signer,
  tokenAddress: string,
  runtimeCache?: DirectDexQuoteProviderRuntimeCache
): Promise<number> {
  const normalizedTokenAddress = tokenAddress.toLowerCase();
  const unknownCacheKey = getDirectDexTokenDecimalsCacheKey(
    normalizedTokenAddress,
    undefined
  );
  if (runtimeCache?.chainId !== undefined) {
    migrateUnknownDirectDexTokenDecimals(runtimeCache, runtimeCache.chainId);
    const cached = runtimeCache.tokenDecimals?.get(
      getDirectDexTokenDecimalsCacheKey(
        normalizedTokenAddress,
        runtimeCache.chainId
      )
    );
    if (cached !== undefined) {
      return cached;
    }
  } else {
    const cached = runtimeCache?.tokenDecimals?.get(unknownCacheKey);
    if (cached !== undefined) {
      startDirectDexTokenDecimalsChainIdResolutionIfPossible({
        signer,
        runtimeCache,
      });
      return cached;
    }
  }

  let chainId = await resolveDirectDexTokenDecimalsChainId({
    signer,
    runtimeCache,
  });
  if (runtimeCache?.chainId !== undefined) {
    chainId = runtimeCache.chainId;
  }

  const cacheKey = getDirectDexTokenDecimalsCacheKey(
    normalizedTokenAddress,
    chainId
  );
  const cached = runtimeCache?.tokenDecimals?.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const decimals = await getDecimalsErc20(signer, tokenAddress, chainId);
  if (runtimeCache) {
    if (!runtimeCache.tokenDecimals) {
      runtimeCache.tokenDecimals = new Map();
    }
    const storeChainId = runtimeCache.chainId ?? chainId;
    const storeCacheKey = getDirectDexTokenDecimalsCacheKey(
      normalizedTokenAddress,
      storeChainId
    );
    runtimeCache.tokenDecimals.set(storeCacheKey, decimals);
    if (storeChainId !== undefined) {
      runtimeCache.tokenDecimals.delete(unknownCacheKey);
    }
    pruneMapToMaxSize(
      runtimeCache.tokenDecimals,
      MAX_TOKEN_DECIMAL_CACHE_ENTRIES
    );
  }
  return decimals;
}

function getDirectDexTokenDecimalsCacheKey(
  normalizedTokenAddress: string,
  chainId: number | undefined
): string {
  return `${chainId ?? 'unknown'}:${normalizedTokenAddress}`;
}

function migrateUnknownDirectDexTokenDecimals(
  runtimeCache: DirectDexQuoteProviderRuntimeCache,
  chainId: number
): void {
  const tokenDecimals = runtimeCache.tokenDecimals;
  if (!tokenDecimals) {
    return;
  }

  for (const [key, decimals] of Array.from(tokenDecimals.entries())) {
    if (!key.startsWith('unknown:')) {
      continue;
    }
    const normalizedTokenAddress = key.slice('unknown:'.length);
    const chainKey = getDirectDexTokenDecimalsCacheKey(
      normalizedTokenAddress,
      chainId
    );
    if (!tokenDecimals.has(chainKey)) {
      tokenDecimals.set(chainKey, decimals);
    }
    tokenDecimals.delete(key);
  }
}

function startDirectDexTokenDecimalsChainIdResolution(params: {
  signer: Signer;
  runtimeCache: DirectDexQuoteProviderRuntimeCache;
}): Promise<number | undefined> {
  const pending = Promise.resolve()
    .then(() => params.signer.getChainId())
    .then((resolvedChainId) => {
      params.runtimeCache.chainId = resolvedChainId;
      migrateUnknownDirectDexTokenDecimals(params.runtimeCache, resolvedChainId);
      return resolvedChainId;
    })
    .catch((error) => {
      logger.debug(
        `Direct DEX token decimals cache could not resolve chainId; using address-only fallback key: ${getErrorMessage(error)}`
      );
      return undefined;
    })
    .finally(() => {
      if (params.runtimeCache.chainIdInflight === pending) {
        params.runtimeCache.chainIdInflight = undefined;
      }
    });
  params.runtimeCache.chainIdInflight = pending;
  return pending;
}

function startDirectDexTokenDecimalsChainIdResolutionIfPossible(params: {
  signer: Signer;
  runtimeCache?: DirectDexQuoteProviderRuntimeCache;
}): void {
  const runtimeCache = params.runtimeCache;
  if (
    !runtimeCache ||
    runtimeCache.chainId !== undefined ||
    runtimeCache.chainIdInflight ||
    typeof params.signer.getChainId !== 'function'
  ) {
    return;
  }
  startDirectDexTokenDecimalsChainIdResolution({
    signer: params.signer,
    runtimeCache,
  });
}

async function resolveDirectDexTokenDecimalsChainId(params: {
  signer: Signer;
  runtimeCache?: DirectDexQuoteProviderRuntimeCache;
}): Promise<number | undefined> {
  const runtimeCache = params.runtimeCache;
  if (!runtimeCache) {
    return undefined;
  }
  if (runtimeCache.chainId !== undefined) {
    migrateUnknownDirectDexTokenDecimals(runtimeCache, runtimeCache.chainId);
    return runtimeCache.chainId;
  }
  if (typeof params.signer.getChainId !== 'function') {
    return undefined;
  }

  const pending =
    runtimeCache.chainIdInflight ??
    startDirectDexTokenDecimalsChainIdResolution({
      signer: params.signer,
      runtimeCache,
    });
  try {
    return await withTimeout(
      pending,
      DIRECT_DEX_TOKEN_DECIMALS_CHAIN_ID_TIMEOUT_MS,
      'Direct DEX token decimals chainId'
    );
  } catch (error) {
    logger.debug(
      `Direct DEX token decimals cache chainId lookup timed out; using address-only fallback key: ${getErrorMessage(error)}`
    );
    return undefined;
  }
}

async function getCachedQuoteTokenScale(
  pool: FungiblePool,
  runtimeCache?: DirectDexQuoteProviderRuntimeCache
): Promise<BigNumber> {
  if (!runtimeCache) {
    return await quoteTokenScale(pool.contract);
  }

  const poolAddress =
    'poolAddress' in pool && typeof pool.poolAddress === 'string'
      ? pool.poolAddress
      : undefined;
  const poolKey = poolAddress
    ? poolAddress.toLowerCase()
    : pool.collateralAddress && pool.quoteAddress
      ? `${pool.collateralAddress.toLowerCase()}:${pool.quoteAddress.toLowerCase()}`
      : undefined;
  if (!poolKey) {
    return await quoteTokenScale(pool.contract);
  }

  const cached = runtimeCache?.quoteTokenScales?.get(poolKey);
  if (cached) {
    return cached;
  }

  const scale = await quoteTokenScale(pool.contract);
  if (!runtimeCache.quoteTokenScales) {
    runtimeCache.quoteTokenScales = new Map();
  }
  runtimeCache.quoteTokenScales.set(poolKey, scale);
  pruneMapToMaxSize(
    runtimeCache.quoteTokenScales,
    MAX_QUOTE_TOKEN_SCALE_CACHE_ENTRIES
  );
  return scale;
}

export async function buildDirectDexRouteEvaluationContext(params: {
  pool: FungiblePool;
  signer: Signer;
  auctionPriceWad: BigNumber;
  collateral: BigNumber;
  marketPriceFactor: number;
  runtimeCache?: DirectDexQuoteProviderRuntimeCache;
}): Promise<DirectDexRouteEvaluationContext> {
  const [
    collateralTokenDecimals,
    quoteTokenDecimals,
    auctionRepayRequirementQuoteRaw,
  ] = await Promise.all([
    getCachedDirectDexTokenDecimals(
      params.signer,
      params.pool.collateralAddress,
      params.runtimeCache
    ),
    getCachedDirectDexTokenDecimals(
      params.signer,
      params.pool.quoteAddress,
      params.runtimeCache
    ),
    getQuoteAmountDueRaw(
      params.pool,
      params.auctionPriceWad,
      params.collateral,
      params.runtimeCache
    ),
  ]);
  const collateralInTokenDecimals = convertWadToTokenDecimals(
    params.collateral,
    collateralTokenDecimals
  );
  return {
    quoteTokenAddress: params.pool.quoteAddress,
    collateralTokenAddress: params.pool.collateralAddress,
    quoteTokenDecimals,
    collateralTokenDecimals,
    collateralInTokenDecimals,
    collateralAmount: Number(
      ethers.utils.formatUnits(
        collateralInTokenDecimals,
        collateralTokenDecimals
      )
    ),
    auctionPriceWad: params.auctionPriceWad,
    collateralWad: params.collateral,
    auctionRepayRequirementQuoteRaw,
    marketPriceFactor: params.marketPriceFactor,
  };
}

export async function computeDirectDexAmountOutMinimum({
  pool,
  liquidation,
  quoteEvaluation,
}: {
  pool: FungiblePool;
  liquidation: Pick<TakeLiquidationPlan, 'auctionPrice' | 'collateral'>;
  quoteEvaluation: ApprovedDirectDexQuoteEvaluation;
}): Promise<BigNumber> {
  const approvedMinOutRaw = deriveApprovedMinOutRaw({
    routeMinOutRaw: quoteEvaluation.routeMinOutRaw,
    profitMinOutRaw: quoteEvaluation.profitMinOutRaw,
    fallbackMinOutRaw: quoteEvaluation.approvedMinOutRaw,
  });
  if (!approvedMinOutRaw) {
    throw new Error('Direct DEX: approvedMinOutRaw missing from evaluation');
  }

  const quoteAmountDueRaw = await getQuoteAmountDueRaw(
    pool,
    liquidation.auctionPrice,
    liquidation.collateral
  );
  if (approvedMinOutRaw.lt(quoteAmountDueRaw)) {
    throw new Error('Direct DEX: approvedMinOutRaw below auction repayment floor');
  }

  return approvedMinOutRaw;
}

export async function buildDirectDexQuoteEvaluation(params: {
  pool: FungiblePool;
  auctionPriceWad: BigNumber;
  collateral: BigNumber;
  marketPriceFactor: number;
  quoteAmountRaw: BigNumber;
  quoteAmount: number;
  collateralAmount: number;
  selectedLiquiditySource: LiquiditySource;
  selectedFeeTier?: number;
  existingSlippageFloorQuoteRaw?: BigNumber;
  allowSubsidy?: boolean;
  routeContext?: DirectDexRouteEvaluationContext;
  successReason?: string;
  failureReason: string;
}): Promise<ExternalTakeQuoteEvaluation> {
  const quoteAmountDueRaw =
    params.routeContext?.auctionRepayRequirementQuoteRaw ??
    (await getQuoteAmountDueRaw(
      params.pool,
      params.auctionPriceWad,
      params.collateral
    ));
  const marketPriceFactor =
    params.routeContext?.marketPriceFactor ?? params.marketPriceFactor;
  const collateralAmount =
    params.routeContext?.collateralAmount ?? params.collateralAmount;
  const marketFactorFloorQuoteRaw = getMarketFactorFloorQuoteRaw({
    quoteAmountDueRaw,
    marketPriceFactor,
  });
  const routeMinOutRaw = params.existingSlippageFloorQuoteRaw;
  const policy = applyExternalTakeRoutePolicy({
    configuredMarketPriceFactor: marketPriceFactor,
    allowSubsidy: params.allowSubsidy === true,
    quoteAmountRaw: params.quoteAmountRaw,
    quoteDueRaw: quoteAmountDueRaw,
    marketFactorFloorQuoteRaw,
    routeMinOutRaw,
  });

  return mergeRoutePolicyIntoEvaluation({
    evaluation: {
      isTakeable: policy.isEconomicallyExecutable,
      externalTakePath: 'direct_dex',
      marketPrice: params.quoteAmount / collateralAmount,
      quoteAmount: params.quoteAmount,
      quoteAmountRaw: params.quoteAmountRaw,
      selectedLiquiditySource: params.selectedLiquiditySource,
      selectedFeeTier: params.selectedFeeTier,
      collateralAmount,
      quotedAuctionPriceWad: params.auctionPriceWad,
      quotedCollateralWad: params.collateral,
      reason: policy.isEconomicallyExecutable
        ? params.successReason
        : (policy.rejectionReason ?? params.failureReason),
    },
    policy,
    auctionRepayRequirementQuoteRaw: quoteAmountDueRaw,
    configuredMarketPriceFactor: marketPriceFactor,
    marketFactorFloorQuoteRaw,
  });
}
