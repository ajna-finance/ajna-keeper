import {
  CalldataAggregatorProviderId,
  ConfiguredExternalTakePathKind,
  ExternalTakePathKind,
  ExternalTakeRouteSelectionMode,
  HybridGasQuoteFailureFallbackMode,
  LiquiditySource,
} from './schema';
import {
  isAggregatorExternalTakePath,
  isFactoryLiquiditySource,
  resolveExternalTakePathFromSource,
} from './external-take-registry';
import type { FactoryLiquiditySource } from './external-take-registry';
import {
  CALLDATA_AGGREGATOR_PROVIDER_IDS,
  isCalldataAggregatorProviderId,
} from './aggregator-provider-identity';

export {
  AGGREGATOR_PROVIDER_IDENTITIES,
  CALLDATA_AGGREGATOR_PROVIDER_IDS,
  formatCalldataAggregatorProviderIds,
  getAggregatorProviderIdentity,
  isCalldataAggregatorProviderId,
  resolveCalldataAggregatorProviderForSource,
} from './aggregator-provider-identity';
export type { AggregatorProviderIdentity } from './aggregator-provider-identity';

export {
  EXTERNAL_TAKE_PATH_DESCRIPTORS,
  EXTERNAL_TAKE_LIQUIDITY_SOURCE_DESCRIPTORS,
  EXTERNAL_TAKE_PATHS,
  FACTORY_DYNAMIC_SOURCES,
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
} from './external-take-registry';
export type {
  ActiveExternalTakeDeploymentResolution,
  ActiveExternalTakeDeploymentType,
  CalldataAggregatorLiquiditySource,
  ExternalTakeDeploymentResolution,
  ExternalTakeDeploymentRuntimeConfig,
  ExternalTakeDeploymentType,
  FactoryExternalTakeDeploymentResolution,
  ExternalTakePathDescriptor,
  ExternalTakePathCategory,
  ExternalTakeLiquiditySource,
  ExternalTakeLiquiditySourceDescriptor,
  ExternalTakeTakerContractKey,
  FactoryLiquiditySource,
  CalldataAggregatorExternalTakeDeploymentResolution,
  OneInchExternalTakeDeploymentResolution,
} from './external-take-registry';

export type ActiveExternalTakeRouteSelectionMode =
  ExternalTakeRouteSelectionMode;

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
  return isFactoryLiquiditySource(source);
}

export function normalizeExternalTakeRouteSelectionMode(
  mode: ExternalTakeRouteSelectionMode | undefined
): ActiveExternalTakeRouteSelectionMode {
  return mode ?? DEFAULT_EXTERNAL_TAKE_ROUTE_SELECTION_MODE;
}

const LEGACY_EXTERNAL_TAKE_PATH_ALIASES: Readonly<
  Record<string, ExternalTakePathKind>
> = {
  lifi: 'calldata_aggregator',
};

export function isConfiguredExternalTakePath(
  path: unknown
): path is ConfiguredExternalTakePathKind {
  return (
    typeof path === 'string' &&
    (path === 'oneinch' ||
      path === 'factory' ||
      path === 'calldata_aggregator' ||
      LEGACY_EXTERNAL_TAKE_PATH_ALIASES[path] !== undefined)
  );
}

export function normalizeConfiguredExternalTakePath(
  path: ConfiguredExternalTakePathKind
): ExternalTakePathKind {
  return LEGACY_EXTERNAL_TAKE_PATH_ALIASES[path] ?? (path as ExternalTakePathKind);
}

export function formatSupportedConfiguredExternalTakePaths(): string {
  return 'oneinch, factory, and calldata_aggregator (legacy alias: lifi)';
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
    !params.externalTakePaths.some(isAggregatorExternalTakePath)
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

// Private: see resolveExternalTakePolicy(...).
function resolveDefaultFactoryLiquiditySource(params: {
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

// Private: see resolveExternalTakePolicy(...).
function resolveFactoryRouteSelectionSources(params: {
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

/**
 * Raw operator-facing take-policy fields consumed by the canonical resolver.
 * Structural subset of the discovery take-policy config.
 */
export interface RawExternalTakePolicyInputs {
  allowedExternalTakePaths?: readonly ConfiguredExternalTakePathKind[];
  allowedCalldataAggregatorProviders?: readonly CalldataAggregatorProviderId[];
  allowedLiquiditySources?: readonly LiquiditySource[];
  defaultFactoryLiquiditySource?: LiquiditySource;
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
  /** Factory route allowlist for the factory family. */
  readonly factoryRouteSources: readonly FactoryLiquiditySource[];
  readonly defaultFactoryLiquiditySource: FactoryLiquiditySource | undefined;
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
  const calldataAggregatorFamilyEnabled =
    externalTakePaths.includes('calldata_aggregator');

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
          'calldata_aggregator family (or legacy lifi path) to be enabled'
      );
    }
    calldataAggregatorProviders = Array.from(seenProviders);
  } else {
    // An omitted provider list resolves to lifi only when the family is
    // enabled. Adding a provider id in a later packet must not silently
    // enable it for existing configs.
    calldataAggregatorProviders = calldataAggregatorFamilyEnabled
      ? ['lifi']
      : [];
  }

  return {
    externalTakePaths,
    calldataAggregatorProviders,
    factoryRouteSources: resolveFactoryRouteSelectionSources({
      defaultLiquiditySource: params.defaultLiquiditySource,
      allowedLiquiditySources: takePolicy.allowedLiquiditySources,
      configuredDefaultFactoryLiquiditySource:
        takePolicy.defaultFactoryLiquiditySource,
    }),
    defaultFactoryLiquiditySource: resolveDefaultFactoryLiquiditySource({
      defaultLiquiditySource: params.defaultLiquiditySource,
      configuredDefaultFactoryLiquiditySource:
        takePolicy.defaultFactoryLiquiditySource,
    }),
    routeSelectionMode: normalizeExternalTakeRouteSelectionMode(
      takePolicy.externalTakeRouteSelectionMode
    ),
    externalTakePathsExplicitlyConfigured: rawPaths !== undefined,
  };
}
