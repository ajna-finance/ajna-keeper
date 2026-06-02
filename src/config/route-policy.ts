import {
  ExternalTakePathKind,
  ExternalTakeRouteSelectionMode,
  HybridGasQuoteFailureFallbackMode,
  LiquiditySource,
} from './schema';

export type FactoryLiquiditySource =
  | LiquiditySource.UNISWAPV3
  | LiquiditySource.SUSHISWAP
  | LiquiditySource.CURVE;

export type ActiveExternalTakeRouteSelectionMode =
  ExternalTakeRouteSelectionMode;

export const FACTORY_DYNAMIC_SOURCES: readonly FactoryLiquiditySource[] = [
  LiquiditySource.UNISWAPV3,
  LiquiditySource.SUSHISWAP,
  LiquiditySource.CURVE,
];

export const EXTERNAL_TAKE_PATHS = new Set<ExternalTakePathKind>([
  'oneinch',
  'factory',
  'lifi',
]);

export const EXTERNAL_TAKE_ROUTE_SELECTION_MODES =
  new Set<ExternalTakeRouteSelectionMode>(['maximize_profit', 'factory_first']);

export const HYBRID_GAS_QUOTE_FAILURE_FALLBACK_MODES =
  new Set<HybridGasQuoteFailureFallbackMode>(['disabled', 'factory_first']);

export const DEFAULT_EXTERNAL_TAKE_ROUTE_SELECTION_MODE: ActiveExternalTakeRouteSelectionMode =
  'maximize_profit';

export type HybridGasQuoteFallbackPolicyResolution =
  | { eligible: true }
  | { eligible: false; reason: string };

export function isFactoryDynamicSource(
  source: LiquiditySource | undefined
): source is FactoryLiquiditySource {
  return (
    source !== undefined &&
    FACTORY_DYNAMIC_SOURCES.includes(source as FactoryLiquiditySource)
  );
}

export function normalizeExternalTakeRouteSelectionMode(
  mode: ExternalTakeRouteSelectionMode | undefined
): ActiveExternalTakeRouteSelectionMode {
  return mode ?? DEFAULT_EXTERNAL_TAKE_ROUTE_SELECTION_MODE;
}

export function resolveExternalTakePaths(params: {
  defaultLiquiditySource: LiquiditySource | undefined;
  allowedExternalTakePaths?: readonly ExternalTakePathKind[];
}): ExternalTakePathKind[] {
  if (params.allowedExternalTakePaths !== undefined) {
    return Array.from(new Set(params.allowedExternalTakePaths));
  }
  if (params.defaultLiquiditySource === LiquiditySource.ONEINCH) {
    return ['oneinch'];
  }
  if (params.defaultLiquiditySource === LiquiditySource.LIFI) {
    return ['lifi'];
  }
  if (isFactoryDynamicSource(params.defaultLiquiditySource)) {
    return ['factory'];
  }
  return [];
}

export function resolveHybridGasQuoteFallbackPolicy(params: {
  fallbackMode: HybridGasQuoteFailureFallbackMode | undefined;
  routeSelectionMode: ActiveExternalTakeRouteSelectionMode;
  externalTakePaths: readonly ExternalTakePathKind[];
  maxGasCostNative?: number;
  maxGasCostQuote?: number;
  minExpectedProfitQuote?: number;
  minProfitNative?: string;
}): HybridGasQuoteFallbackPolicyResolution {
  if (params.fallbackMode !== 'factory_first') {
    return { eligible: false, reason: 'fallback disabled' };
  }
  if (params.routeSelectionMode !== 'maximize_profit') {
    return {
      eligible: false,
      reason: 'route selection mode is not maximize_profit',
    };
  }
  if (
    !params.externalTakePaths.includes('factory') ||
    (!params.externalTakePaths.includes('oneinch') &&
      !params.externalTakePaths.includes('lifi'))
  ) {
    return {
      eligible: false,
      reason:
        'hybrid paths do not include factory and at least one aggregator path',
    };
  }
  if (params.maxGasCostNative === undefined) {
    return { eligible: false, reason: 'maxGasCostNative is not configured' };
  }
  if (params.maxGasCostQuote !== undefined) {
    return { eligible: false, reason: 'maxGasCostQuote is configured' };
  }
  if (params.minExpectedProfitQuote !== undefined) {
    return { eligible: false, reason: 'minExpectedProfitQuote is configured' };
  }
  if (params.minProfitNative !== undefined) {
    return { eligible: false, reason: 'minProfitNative is configured' };
  }
  return { eligible: true };
}

export function resolveDefaultFactoryLiquiditySource(params: {
  defaultLiquiditySource: LiquiditySource | undefined;
  configuredDefaultFactoryLiquiditySource?: LiquiditySource;
}): FactoryLiquiditySource | undefined {
  if (isFactoryDynamicSource(params.defaultLiquiditySource)) {
    return params.defaultLiquiditySource;
  }
  return isFactoryDynamicSource(params.configuredDefaultFactoryLiquiditySource)
    ? params.configuredDefaultFactoryLiquiditySource
    : undefined;
}

export function resolveFactoryRouteSelectionSources(params: {
  defaultLiquiditySource: LiquiditySource | undefined;
  allowedLiquiditySources?: readonly LiquiditySource[];
  configuredDefaultFactoryLiquiditySource?: LiquiditySource;
}): FactoryLiquiditySource[] {
  if (params.allowedLiquiditySources !== undefined) {
    return Array.from(new Set(params.allowedLiquiditySources)).filter(
      isFactoryDynamicSource
    );
  }

  const defaultFactoryLiquiditySource = resolveDefaultFactoryLiquiditySource({
    defaultLiquiditySource: params.defaultLiquiditySource,
    configuredDefaultFactoryLiquiditySource:
      params.configuredDefaultFactoryLiquiditySource,
  });
  return defaultFactoryLiquiditySource !== undefined
    ? [defaultFactoryLiquiditySource]
    : [];
}
