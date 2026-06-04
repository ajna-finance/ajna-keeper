import { BigNumber } from 'ethers';
import {
  ExternalTakePathKind,
  LiquiditySource,
  TakeWriteTransportMode,
  formatLiquiditySource,
  getAutoDiscoverTakePolicy,
} from '../../config';
import { BASIS_POINTS_DENOMINATOR_BN } from '../../constants';
import { logger } from '../../logging';
import { DiscoveryReadTransports } from '../../read-transports';
import {
  ExternalTakeQuoteEvaluation,
  RouteProfitabilityBreakdown,
} from '../../take/types';
import { TakeWriteTransport } from '../../take/write-transport';
import { getErrorMessage } from '../../utils';
import {
  GasPolicyResult,
  getDiscoveryGasPriceFreshnessTtlMs,
  getEffectiveL2GasCostBufferBasisPoints,
} from '../gas-policy';
import { DiscoveryRpcCache } from '../types';
import type { AutoDiscoverTakePolicyRuntime } from './quotes';

export const EXTERNAL_TAKE_GAS_LIMIT = BigNumber.from(900000);
const CURVE_EXTERNAL_TAKE_GAS_LIMIT = BigNumber.from(1_500_000);

function getGasPriceDriftBasisPoints(params: {
  evaluatedGasPrice: BigNumber;
  currentGasPrice: BigNumber;
}): number {
  const { evaluatedGasPrice, currentGasPrice } = params;
  if (evaluatedGasPrice.isZero()) {
    return currentGasPrice.isZero() ? 0 : Number.POSITIVE_INFINITY;
  }
  if (!currentGasPrice.gt(evaluatedGasPrice)) {
    return 0;
  }
  const delta = currentGasPrice.sub(evaluatedGasPrice);
  return delta
    .mul(BASIS_POINTS_DENOMINATOR_BN)
    .div(evaluatedGasPrice)
    .toNumber();
}

export function getExternalTakeGasLimit(
  policy: ReturnType<typeof getAutoDiscoverTakePolicy>,
  source: LiquiditySource
): BigNumber {
  const override = policy?.dexGasOverrides?.[source];
  if (override) {
    return BigNumber.from(override);
  }
  return source === LiquiditySource.CURVE
    ? CURVE_EXTERNAL_TAKE_GAS_LIMIT
    : EXTERNAL_TAKE_GAS_LIMIT;
}

export function getGasPriceAgeMs(
  rpcCache?: DiscoveryRpcCache
): number | undefined {
  return rpcCache?.gasPriceFetchedAt !== undefined
    ? Date.now() - rpcCache.gasPriceFetchedAt
    : undefined;
}

function getWriteTransportMode(
  takeWriteTransport?: TakeWriteTransport
): string {
  return takeWriteTransport?.mode ?? TakeWriteTransportMode.PUBLIC_RPC;
}

export function formatExternalTakeGasTelemetry(params: {
  poolAddress: string;
  borrower?: string;
  path?: ExternalTakePathKind;
  source?: LiquiditySource;
  routeProfitability?: ExternalTakeQuoteEvaluation['routeProfitability'];
  rpcCache?: DiscoveryRpcCache;
  takePolicy: ReturnType<typeof getAutoDiscoverTakePolicy>;
  writeTransport?: TakeWriteTransport;
}): string {
  const routeProfitability = params.routeProfitability;
  const chainId = params.rpcCache?.chainId;
  const ttlMs = getDiscoveryGasPriceFreshnessTtlMs(params.takePolicy, chainId);
  const gasAgeMs =
    getGasPriceAgeMs(params.rpcCache) ?? routeProfitability?.gasPriceAgeMs;
  const currentGasPrice = params.rpcCache?.gasPrice;
  const evaluatedGasPrice = routeProfitability?.gasPriceWei;
  const driftBps =
    evaluatedGasPrice && currentGasPrice
      ? getGasPriceDriftBasisPoints({
          evaluatedGasPrice,
          currentGasPrice,
        })
      : undefined;
  const configuredDexGasOverride =
    params.source !== undefined
      ? params.takePolicy?.dexGasOverrides?.[params.source]
      : undefined;
  const routeGasLimit =
    routeProfitability?.routeGasLimit ??
    (params.source !== undefined
      ? getExternalTakeGasLimit(params.takePolicy, params.source)
      : undefined);
  const routeGasModel =
    params.source === undefined
      ? 'n/a'
      : configuredDexGasOverride !== undefined
        ? 'dexGasOverrides'
        : 'default';
  return (
    `pool=${params.poolAddress}` +
    ` borrower=${params.borrower ?? 'n/a'}` +
    ` path=${params.path ?? 'n/a'}` +
    ` source=${formatLiquiditySource(params.source)}` +
    ` routeGasModel=${routeGasModel}` +
    ` configuredDexGasOverrideRaw=${configuredDexGasOverride ?? 'none'}` +
    ` routeGasLimit=${routeGasLimit?.toString() ?? 'n/a'}` +
    ` evaluatedGasGwei=${routeProfitability?.gasPriceGwei ?? 'n/a'}` +
    ` currentGasWei=${currentGasPrice?.toString() ?? 'n/a'}` +
    ` gasAgeMs=${gasAgeMs ?? 'n/a'}` +
    ` gasTtlMs=${routeProfitability?.gasPriceFreshnessTtlMs ?? ttlMs}` +
    ` gasDriftBps=${driftBps ?? 'n/a'}` +
    ` l2BufferBps=${routeProfitability?.l2GasCostBufferBasisPoints ?? getEffectiveL2GasCostBufferBasisPoints(params.takePolicy, chainId) ?? 'n/a'}` +
    ` configuredMarketPriceFactor=${routeProfitability?.configuredMarketPriceFactor ?? 'n/a'}` +
    ` routeBreakEvenMarketPriceFactor=${routeProfitability?.routeBreakEvenMarketPriceFactor ?? 'n/a'}` +
    ` effectiveMarketPriceFactor=${routeProfitability?.effectiveMarketPriceFactor ?? 'n/a'}` +
    ` allowSubsidy=${routeProfitability?.subsidyAllowed ?? false}` +
    ` quoteDueRaw=${routeProfitability?.auctionRepayRequirementQuoteRaw?.toString() ?? 'n/a'}` +
    ` requiredNonSubsidizedOutputRaw=${routeProfitability?.requiredNonSubsidizedOutputRaw?.toString() ?? 'n/a'}` +
    ` expectedShortfallQuoteRaw=${routeProfitability?.expectedShortfallQuoteRaw?.toString() ?? 'n/a'}` +
    ` expectedSubsidyQuoteRaw=${routeProfitability?.expectedSubsidyQuoteRaw?.toString() ?? 'n/a'}` +
    ` writeTransport=${getWriteTransportMode(params.writeTransport)}`
  );
}

export function getApprovalGasTelemetryFields(params: {
  routeGasLimit: BigNumber;
  gasPolicy: GasPolicyResult;
  rpcCache?: DiscoveryRpcCache;
  takePolicy: AutoDiscoverTakePolicyRuntime;
}): Pick<
  RouteProfitabilityBreakdown,
  | 'routeGasLimit'
  | 'gasPriceWei'
  | 'gasPriceGwei'
  | 'gasPriceAgeMs'
  | 'gasPriceFreshnessTtlMs'
  | 'l2GasCostBufferBasisPoints'
  | 'gasPolicyEvaluatedAt'
> {
  return {
    routeGasLimit: params.routeGasLimit,
    gasPriceWei: params.gasPolicy.gasPriceRaw,
    gasPriceGwei: params.gasPolicy.gasPriceGwei,
    gasPriceAgeMs: getGasPriceAgeMs(params.rpcCache),
    gasPriceFreshnessTtlMs: getDiscoveryGasPriceFreshnessTtlMs(
      params.takePolicy,
      params.rpcCache?.chainId
    ),
    l2GasCostBufferBasisPoints: params.gasPolicy.l2GasCostBufferBasisPoints,
    gasPolicyEvaluatedAt: Date.now(),
  };
}

export function hasFreshExternalTakeGasPolicy(params: {
  quoteEvaluation: {
    routeProfitability?: {
      gasPriceWei?: BigNumber;
      gasPolicyEvaluatedAt?: number;
    };
  };
  currentGasPrice?: BigNumber;
  chainId?: number;
  takePolicy?: ReturnType<typeof getAutoDiscoverTakePolicy>;
  now?: number;
}): { fresh: boolean; reason?: string } {
  const evaluatedAt =
    params.quoteEvaluation.routeProfitability?.gasPolicyEvaluatedAt;
  if (evaluatedAt === undefined) {
    return { fresh: false, reason: 'missing gas policy timestamp' };
  }

  const ageMs = (params.now ?? Date.now()) - evaluatedAt;
  const ttlMs = getDiscoveryGasPriceFreshnessTtlMs(
    params.takePolicy,
    params.chainId
  );
  if (ageMs > ttlMs) {
    return {
      fresh: false,
      reason: `gas policy age ${ageMs}ms exceeds ${ttlMs}ms TTL`,
    };
  }

  const driftToleranceBps =
    params.takePolicy?.gasPriceDriftToleranceBasisPoints;
  if (driftToleranceBps === undefined) {
    return { fresh: true };
  }

  const evaluatedGasPrice =
    params.quoteEvaluation.routeProfitability?.gasPriceWei;
  if (!evaluatedGasPrice || !params.currentGasPrice) {
    return {
      fresh: false,
      reason: 'missing gas price snapshot for drift check',
    };
  }

  const driftBps = getGasPriceDriftBasisPoints({
    evaluatedGasPrice,
    currentGasPrice: params.currentGasPrice,
  });
  if (driftBps > driftToleranceBps) {
    return {
      fresh: false,
      reason: `gas price drift ${driftBps}bps exceeds tolerance ${driftToleranceBps}bps`,
    };
  }

  return { fresh: true };
}

export async function refreshDiscoveryGasPriceIfStale(params: {
  rpcCache?: DiscoveryRpcCache;
  transports: DiscoveryReadTransports;
  maxAgeMs?: number;
  force?: boolean;
}): Promise<void> {
  const rpcCache = params.rpcCache;
  if (!rpcCache) {
    return;
  }

  const fetchedAt = rpcCache.gasPriceFetchedAt;
  const hasFreshGasPrice =
    !params.force &&
    rpcCache.gasPrice !== undefined &&
    fetchedAt !== undefined &&
    Date.now() - fetchedAt <=
      (params.maxAgeMs ??
        getDiscoveryGasPriceFreshnessTtlMs(undefined, rpcCache.chainId));
  if (hasFreshGasPrice) {
    return;
  }

  if (rpcCache.gasPriceInflight) {
    try {
      rpcCache.gasPrice = await rpcCache.gasPriceInflight;
      rpcCache.gasPriceFetchedAt = Date.now();
    } catch (error) {
      logger.warn(
        `Shared discovery gas price fetch failed: ${getErrorMessage(error)}`
      );
      throw error;
    }
    return;
  }

  const gasPriceInflight = params.transports.readRpc.getGasPrice();
  rpcCache.gasPriceInflight = gasPriceInflight;
  try {
    rpcCache.gasPrice = await gasPriceInflight;
    rpcCache.gasPriceFetchedAt = Date.now();
  } catch (error) {
    logger.warn(`Discovery gas price fetch failed: ${getErrorMessage(error)}`);
    throw error;
  } finally {
    if (rpcCache.gasPriceInflight === gasPriceInflight) {
      rpcCache.gasPriceInflight = undefined;
    }
  }
}
