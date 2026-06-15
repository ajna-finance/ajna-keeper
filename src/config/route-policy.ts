import {
  CalldataAggregatorProviderId,
  ConfiguredExternalTakePathKind,
  ExternalTakePathKind,
  ExternalTakeRouteSelectionMode,
  HybridGasQuoteFailureFallbackMode,
  LiquiditySource,
} from './schema';
import {
  CALLDATA_AGGREGATOR_PROVIDER_IDS,
  isAggregatorExternalTakePath,
  isCalldataAggregatorProviderId,
  isDirectDexLiquiditySource,
  resolveCalldataAggregatorProviderForSource,
  resolveExternalTakePathFromSource,
} from './external-take-descriptors';
import type { DirectDexLiquiditySource } from './external-take-descriptors';

export {
  AGGREGATOR_PROVIDER_IDENTITIES,
  CALLDATA_AGGREGATOR_PROVIDER_IDS,
  formatCalldataAggregatorProviderIds,
  getAggregatorProviderIdentity,
  isCalldataAggregatorProviderId,
  resolveCalldataAggregatorProviderForSource,
} from './external-take-descriptors';
export type { AggregatorProviderIdentity } from './external-take-descriptors';

export {
  EXTERNAL_TAKE_PATH_DESCRIPTORS,
  EXTERNAL_TAKE_LIQUIDITY_SOURCE_DESCRIPTORS,
  EXTERNAL_TAKE_PATHS,
  DIRECT_DEX_DYNAMIC_SOURCES,
  SUPPORTED_EXTERNAL_TAKE_LIQUIDITY_SOURCES,
  SUPPORTED_EXTERNAL_TAKE_PATHS,
  formatSupportedExternalTakeLiquiditySources,
  formatSupportedExternalTakePaths,
  getExternalTakeLiquiditySourceDescriptor,
  getExternalTakePathDefaultSource,
  getExternalTakePathDescriptor,
  getExternalTakePathDescriptors,
  getExternalTakeTakerContractKeyForSource,
  isAggregatorExternalTakePath,
  isCalldataAggregatorLiquiditySource,
  isExternalTakeLiquiditySource,
  isExternalTakePath,
  resolveExternalTakeDeployment,
  resolveExternalTakePathFromSource,
} from './external-take-descriptors';
export type {
  ActiveExternalTakeDeploymentResolution,
  ActiveExternalTakeDeploymentType,
  CalldataAggregatorLiquiditySource,
  ExternalTakeDeploymentResolution,
  ExternalTakeDeploymentRuntimeConfig,
  ExternalTakeDeploymentType,
  DirectDexExternalTakeDeploymentResolution,
  ExternalTakePathDescriptor,
  ExternalTakePathCategory,
  ExternalTakeLiquiditySource,
  ExternalTakeLiquiditySourceDescriptor,
  ExternalTakeTakerContractKey,
  DirectDexLiquiditySource,
  CalldataAggregatorExternalTakeDeploymentResolution,
} from './external-take-descriptors';

export type ActiveExternalTakeRouteSelectionMode =
  ExternalTakeRouteSelectionMode;

export const EXTERNAL_TAKE_ROUTE_SELECTION_MODES =
  new Set<ExternalTakeRouteSelectionMode>([
    'maximize_profit',
    'direct_dex_first',
  ]);

export const HYBRID_GAS_QUOTE_FAILURE_FALLBACK_MODES =
  new Set<HybridGasQuoteFailureFallbackMode>(['disabled', 'direct_dex_first']);

export const DEFAULT_EXTERNAL_TAKE_ROUTE_SELECTION_MODE: ActiveExternalTakeRouteSelectionMode =
  'maximize_profit';

export type HybridGasQuoteFallbackPolicyResolution =
  | { eligible: true }
  | { eligible: false; reason: string };

export function isDirectDexDynamicSource(
  source: LiquiditySource | undefined
): source is DirectDexLiquiditySource {
  return isDirectDexLiquiditySource(source);
}

export function normalizeExternalTakeRouteSelectionMode(
  mode: ExternalTakeRouteSelectionMode | undefined
): ActiveExternalTakeRouteSelectionMode {
  return mode ?? DEFAULT_EXTERNAL_TAKE_ROUTE_SELECTION_MODE;
}

export function isConfiguredExternalTakePath(
  path: unknown
): path is ConfiguredExternalTakePathKind {
  return (
    typeof path === 'string' &&
    (path === 'direct_dex' || path === 'calldata_aggregator')
  );
}

export function normalizeConfiguredExternalTakePath(
  path: ConfiguredExternalTakePathKind
): ExternalTakePathKind {
  return path;
}

export function formatSupportedConfiguredExternalTakePaths(): string {
  return 'direct_dex or calldata_aggregator';
}

// Raw path resolution. Private: downstream runtime modules consume
// resolveExternalTakePolicy(...) instead of reinterpreting raw config.
function resolveExternalTakePaths(params: {
  defaultLiquiditySource: LiquiditySource | undefined;
  allowedExternalTakePaths?: readonly ConfiguredExternalTakePathKind[];
}): ExternalTakePathKind[] {
  if (params.allowedExternalTakePaths !== undefined) {
    return Array.from(
      new Set(
        params.allowedExternalTakePaths.map(normalizeConfiguredExternalTakePath)
      )
    );
  }
  const path = resolveExternalTakePathFromSource(params.defaultLiquiditySource);
  return path !== undefined ? [path] : [];
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
  if (params.fallbackMode !== 'direct_dex_first') {
    return { eligible: false, reason: 'fallback disabled' };
  }
  if (params.routeSelectionMode !== 'maximize_profit') {
    return {
      eligible: false,
      reason: 'route selection mode is not maximize_profit',
    };
  }
  if (
    !params.externalTakePaths.includes('direct_dex') ||
    !params.externalTakePaths.some(isAggregatorExternalTakePath)
  ) {
    return {
      eligible: false,
      reason:
        'hybrid paths do not include direct_dex and at least one aggregator path',
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

// Private: see resolveExternalTakePolicy(...).
function resolveDefaultDirectDexLiquiditySource(params: {
  defaultLiquiditySource: LiquiditySource | undefined;
  configuredDefaultDirectDexLiquiditySource?: LiquiditySource;
}): DirectDexLiquiditySource | undefined {
  if (isDirectDexDynamicSource(params.defaultLiquiditySource)) {
    return params.defaultLiquiditySource;
  }
  return isDirectDexDynamicSource(
    params.configuredDefaultDirectDexLiquiditySource
  )
    ? params.configuredDefaultDirectDexLiquiditySource
    : undefined;
}

// Private: see resolveExternalTakePolicy(...).
function resolveDirectDexRouteSelectionSources(params: {
  defaultLiquiditySource: LiquiditySource | undefined;
  allowedLiquiditySources?: readonly LiquiditySource[];
  configuredDefaultDirectDexLiquiditySource?: LiquiditySource;
}): DirectDexLiquiditySource[] {
  if (params.allowedLiquiditySources !== undefined) {
    return Array.from(new Set(params.allowedLiquiditySources)).filter(
      isDirectDexDynamicSource
    );
  }

  const defaultDirectDexLiquiditySource =
    resolveDefaultDirectDexLiquiditySource({
      defaultLiquiditySource: params.defaultLiquiditySource,
      configuredDefaultDirectDexLiquiditySource:
        params.configuredDefaultDirectDexLiquiditySource,
    });
  return defaultDirectDexLiquiditySource !== undefined
    ? [defaultDirectDexLiquiditySource]
    : [];
}

/**
 * Raw operator-facing take-policy fields consumed by the canonical resolver.
 * Structural subset of the discovery take-policy config.
 */
export interface RawExternalTakePolicyInputs {
  allowedExternalTakePaths?: readonly ConfiguredExternalTakePathKind[];
  allowedCalldataAggregatorProviders?: readonly CalldataAggregatorProviderId[];
  allowedLiquiditySources?: readonly LiquiditySource[];
  defaultDirectDexLiquiditySource?: LiquiditySource;
  externalTakeRouteSelectionMode?: ExternalTakeRouteSelectionMode;
}

/**
 * The single canonical post-validation policy object (Packet 2B). Route
 * preflight, discovery runtime, hybrid selection, execution planning, stats,
 * and telemetry consume this instead of reinterpreting raw config fields.
 */
export interface ResolvedExternalTakePolicy {
  /** Canonical execution families after legacy-alias normalization. */
  readonly externalTakePaths: readonly ExternalTakePathKind[];
  /**
   * Providers enabled inside the calldata_aggregator family. Empty when the
   * family is not enabled; defaults to ['lifi'] when the family is enabled
   * without an explicit list.
   */
  readonly calldataAggregatorProviders: readonly CalldataAggregatorProviderId[];
  /** Direct DEX route allowlist for the direct_dex family. */
  readonly directDexRouteSources: readonly DirectDexLiquiditySource[];
  readonly defaultDirectDexLiquiditySource:
    | DirectDexLiquiditySource
    | undefined;
  readonly routeSelectionMode: ActiveExternalTakeRouteSelectionMode;
  /**
   * True when the operator explicitly configured allowedExternalTakePaths
   * (hybrid machinery engages on explicit configuration, not on derived
   * single-path defaults).
   */
  readonly externalTakePathsExplicitlyConfigured: boolean;
}

export function resolveExternalTakePolicy(params: {
  defaultLiquiditySource: LiquiditySource | undefined;
  takePolicy?: RawExternalTakePolicyInputs;
}): ResolvedExternalTakePolicy {
  const takePolicy = params.takePolicy ?? {};
  const rawPaths = takePolicy.allowedExternalTakePaths;
  if (rawPaths !== undefined) {
    if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
      throw new Error(
        'AutoDiscoverConfig.take: allowedExternalTakePaths must be non-empty'
      );
    }
    const seen = new Set<ExternalTakePathKind>();
    for (const path of rawPaths) {
      if (!isConfiguredExternalTakePath(path)) {
        throw new Error(
          'AutoDiscoverConfig.take: allowedExternalTakePaths currently supports ' +
            `only ${formatSupportedConfiguredExternalTakePaths()}`
        );
      }
      const canonical = normalizeConfiguredExternalTakePath(path);
      if (seen.has(canonical)) {
        throw new Error(
          'AutoDiscoverConfig.take: allowedExternalTakePaths cannot contain duplicates'
        );
      }
      seen.add(canonical);
    }
  }

  const externalTakePaths = resolveExternalTakePaths({
    defaultLiquiditySource: params.defaultLiquiditySource,
    allowedExternalTakePaths: rawPaths,
  });
  const calldataAggregatorFamilyEnabled = externalTakePaths.includes(
    'calldata_aggregator'
  );

  const rawProviders = takePolicy.allowedCalldataAggregatorProviders;
  let calldataAggregatorProviders: CalldataAggregatorProviderId[];
  if (rawProviders !== undefined) {
    if (!Array.isArray(rawProviders) || rawProviders.length === 0) {
      throw new Error(
        'AutoDiscoverConfig.take: allowedCalldataAggregatorProviders must be non-empty when set'
      );
    }
    const seenProviders = new Set<CalldataAggregatorProviderId>();
    for (const providerId of rawProviders) {
      if (!isCalldataAggregatorProviderId(providerId)) {
        throw new Error(
          'AutoDiscoverConfig.take: allowedCalldataAggregatorProviders currently ' +
            `supports only ${CALLDATA_AGGREGATOR_PROVIDER_IDS.join(', ')}`
        );
      }
      if (seenProviders.has(providerId)) {
        throw new Error(
          'AutoDiscoverConfig.take: allowedCalldataAggregatorProviders cannot contain duplicates'
        );
      }
      seenProviders.add(providerId);
    }
    if (!calldataAggregatorFamilyEnabled) {
      throw new Error(
        'AutoDiscoverConfig.take: allowedCalldataAggregatorProviders requires the ' +
          'calldata_aggregator family to be enabled'
      );
    }
    calldataAggregatorProviders = Array.from(seenProviders);
  } else {
    // An omitted provider list keeps the historical LI.FI-only default when
    // the family is explicitly enabled, but follows source-derived defaults
    // such as ONEINCH -> provider oneinch.
    const defaultProvider = resolveCalldataAggregatorProviderForSource(
      params.defaultLiquiditySource
    );
    calldataAggregatorProviders = calldataAggregatorFamilyEnabled
      ? [defaultProvider ?? 'lifi']
      : [];
  }

  return {
    externalTakePaths,
    calldataAggregatorProviders,
    directDexRouteSources: resolveDirectDexRouteSelectionSources({
      defaultLiquiditySource: params.defaultLiquiditySource,
      allowedLiquiditySources: takePolicy.allowedLiquiditySources,
      configuredDefaultDirectDexLiquiditySource:
        takePolicy.defaultDirectDexLiquiditySource,
    }),
    defaultDirectDexLiquiditySource: resolveDefaultDirectDexLiquiditySource({
      defaultLiquiditySource: params.defaultLiquiditySource,
      configuredDefaultDirectDexLiquiditySource:
        takePolicy.defaultDirectDexLiquiditySource,
    }),
    routeSelectionMode: normalizeExternalTakeRouteSelectionMode(
      takePolicy.externalTakeRouteSelectionMode
    ),
    externalTakePathsExplicitlyConfigured: rawPaths !== undefined,
  };
}
