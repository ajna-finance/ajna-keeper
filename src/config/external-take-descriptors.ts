import {
  CalldataAggregatorProviderId,
  ExternalTakePathKind,
  LiquiditySource,
} from './schema';

export type DirectDexLiquiditySource =
  | LiquiditySource.UNISWAPV3
  | LiquiditySource.CURVE;

export type ExternalTakeTakerContractKey =
  | 'OneInchAggregator'
  | 'UniswapV3'
  | 'Curve'
  | 'Lifi'
  | 'SushiAggregator';

export type CalldataAggregatorLiquiditySource =
  | LiquiditySource.LIFI
  | LiquiditySource.SUSHI_AGGREGATOR
  | LiquiditySource.ONEINCH;

export type ExternalTakeLiquiditySource =
  | DirectDexLiquiditySource
  | CalldataAggregatorLiquiditySource;

export type ExternalTakePathCategory = 'aggregator' | 'direct_dex';

interface ExternalTakeSourceIdentityBase<
  TSource extends ExternalTakeLiquiditySource,
  TPath extends ExternalTakePathKind,
> {
  readonly source: TSource;
  readonly path: TPath;
  readonly label: string;
  readonly takerContractKey: ExternalTakeTakerContractKey;
}

export type DirectDexSourceIdentity = ExternalTakeSourceIdentityBase<
  DirectDexLiquiditySource,
  'direct_dex'
>;

export interface CalldataAggregatorSourceIdentity
  extends ExternalTakeSourceIdentityBase<
    CalldataAggregatorLiquiditySource,
    'calldata_aggregator'
  > {
  readonly providerId: CalldataAggregatorProviderId;
}

export type ExternalTakeSourceIdentity =
  | DirectDexSourceIdentity
  | CalldataAggregatorSourceIdentity;

/**
 * Canonical declarative identity for external-take route sources.
 * Provider-local behavior remains in provider modules; this table owns only the
 * shared source/path/provider/taker/config metadata used by validation,
 * discovery, and deployment resolution.
 */
export const EXTERNAL_TAKE_SOURCE_IDENTITIES = {
  [LiquiditySource.UNISWAPV3]: {
    source: LiquiditySource.UNISWAPV3,
    path: 'direct_dex',
    label: 'Uniswap V3',
    takerContractKey: 'UniswapV3',
  },
  [LiquiditySource.CURVE]: {
    source: LiquiditySource.CURVE,
    path: 'direct_dex',
    label: 'Curve',
    takerContractKey: 'Curve',
  },
  [LiquiditySource.LIFI]: {
    source: LiquiditySource.LIFI,
    path: 'calldata_aggregator',
    label: 'LI.FI',
    takerContractKey: 'Lifi',
    providerId: 'lifi',
  },
  [LiquiditySource.SUSHI_AGGREGATOR]: {
    source: LiquiditySource.SUSHI_AGGREGATOR,
    path: 'calldata_aggregator',
    label: 'Sushi Aggregator',
    takerContractKey: 'SushiAggregator',
    providerId: 'sushi_aggregator',
  },
  [LiquiditySource.ONEINCH]: {
    source: LiquiditySource.ONEINCH,
    path: 'calldata_aggregator',
    label: '1inch',
    takerContractKey: 'OneInchAggregator',
    providerId: 'oneinch',
  },
} as const satisfies Record<
  ExternalTakeLiquiditySource,
  ExternalTakeSourceIdentity
>;

type CalldataAggregatorProviderIdsFromSourceIdentities = Extract<
  (typeof EXTERNAL_TAKE_SOURCE_IDENTITIES)[ExternalTakeLiquiditySource],
  { path: 'calldata_aggregator' }
>['providerId'];

type ExactCalldataAggregatorProviderIds =
  CalldataAggregatorProviderId extends CalldataAggregatorProviderIdsFromSourceIdentities
    ? CalldataAggregatorProviderIdsFromSourceIdentities extends CalldataAggregatorProviderId
      ? true
      : never
    : never;

// Compile-time guard: schema provider IDs and source-table provider IDs must
// stay exact mirrors before the runtime provider map is derived.
const _EXACT_CALLDATA_AGGREGATOR_PROVIDER_IDS: ExactCalldataAggregatorProviderIds =
  true;

// Explicit operator-facing order (do NOT derive from the identities map: its
// numeric-enum keys would iterate ascending and silently reorder this list,
// which feeds the "liquiditySource must be …" validation message). The guard
// below enforces exhaustiveness at compile time without touching the order.
const EXTERNAL_TAKE_SOURCE_ORDER = [
  LiquiditySource.UNISWAPV3,
  LiquiditySource.CURVE,
  LiquiditySource.LIFI,
  LiquiditySource.SUSHI_AGGREGATOR,
  LiquiditySource.ONEINCH,
] as const satisfies readonly ExternalTakeLiquiditySource[];

// Compile-time exhaustiveness: every external-take source must appear above.
type _MissingFromSourceOrder = Exclude<
  ExternalTakeLiquiditySource,
  (typeof EXTERNAL_TAKE_SOURCE_ORDER)[number]
>;
const _EXTERNAL_TAKE_SOURCE_ORDER_EXHAUSTIVE: [
  _MissingFromSourceOrder,
] extends [never]
  ? true
  : never = true;

function isDirectDexIdentitySource(
  source: ExternalTakeLiquiditySource
): source is DirectDexLiquiditySource {
  return EXTERNAL_TAKE_SOURCE_IDENTITIES[source].path === 'direct_dex';
}

function isAggregatorProviderIdentitySource(
  identity: ExternalTakeSourceIdentity
): identity is CalldataAggregatorSourceIdentity {
  return identity.path === 'calldata_aggregator';
}

export interface ExternalTakePathDescriptor {
  readonly path: ExternalTakePathKind;
  readonly category: ExternalTakePathCategory;
  readonly label: string;
  readonly sources: readonly LiquiditySource[];
  readonly requiresRouteDeploymentValidation?: boolean;
  readonly requiresDexGasOverride?: boolean;
}

export interface ExternalTakeLiquiditySourceDescriptor {
  readonly source: ExternalTakeLiquiditySource;
  readonly path: ExternalTakePathKind;
  readonly label: string;
  readonly takerContractKey?: ExternalTakeTakerContractKey;
}

export type ExternalTakeDeploymentType =
  | 'direct_dex'
  | 'calldata_aggregator'
  | 'none';
export type ActiveExternalTakeDeploymentType = Exclude<
  ExternalTakeDeploymentType,
  'none'
>;

export interface ExternalTakeDeploymentRuntimeConfig {
  keeperTakerRouter?: string;
  takerContracts?: Partial<Record<ExternalTakeTakerContractKey, string>>;
}

export type DirectDexExternalTakeDeploymentResolution = {
  deploymentType: 'direct_dex';
  requestedLiquiditySource: DirectDexLiquiditySource;
  resolvedTakerAddress: string;
};

export type CalldataAggregatorExternalTakeDeploymentResolution = {
  deploymentType: 'calldata_aggregator';
  providerId: CalldataAggregatorProviderId;
  requestedLiquiditySource: CalldataAggregatorLiquiditySource;
  resolvedTakerAddress: string;
};

export type ActiveExternalTakeDeploymentResolution =
  | DirectDexExternalTakeDeploymentResolution
  | CalldataAggregatorExternalTakeDeploymentResolution;

export type ExternalTakeDeploymentResolution =
  | ActiveExternalTakeDeploymentResolution
  | {
      deploymentType: 'none';
      requestedLiquiditySource: LiquiditySource | undefined;
      unavailableReason?: string;
    };

export const DIRECT_DEX_DYNAMIC_SOURCES: readonly DirectDexLiquiditySource[] = [
  ...EXTERNAL_TAKE_SOURCE_ORDER.filter(isDirectDexIdentitySource),
];

export const SUPPORTED_EXTERNAL_TAKE_PATHS: readonly ExternalTakePathKind[] = [
  'direct_dex',
  'calldata_aggregator',
];

export const EXTERNAL_TAKE_PATHS: ReadonlySet<ExternalTakePathKind> = new Set(
  SUPPORTED_EXTERNAL_TAKE_PATHS
);

export const SUPPORTED_EXTERNAL_TAKE_LIQUIDITY_SOURCES: readonly ExternalTakeLiquiditySource[] =
  EXTERNAL_TAKE_SOURCE_ORDER;

const CALLDATA_AGGREGATOR_PROVIDER_IDENTITY_ORDER: readonly CalldataAggregatorSourceIdentity[] =
  EXTERNAL_TAKE_SOURCE_ORDER.map(
    (source): ExternalTakeSourceIdentity =>
      EXTERNAL_TAKE_SOURCE_IDENTITIES[source]
  ).filter(isAggregatorProviderIdentitySource);

export const CALLDATA_AGGREGATOR_LIQUIDITY_SOURCES: readonly CalldataAggregatorLiquiditySource[] =
  CALLDATA_AGGREGATOR_PROVIDER_IDENTITY_ORDER.map(
    (identity) => identity.source
  );

const CALLDATA_AGGREGATOR_LIQUIDITY_SOURCE_SET = new Set<LiquiditySource>(
  CALLDATA_AGGREGATOR_LIQUIDITY_SOURCES
);

const EXTERNAL_TAKE_PATH_METADATA = {
  direct_dex: {
    path: 'direct_dex',
    category: 'direct_dex',
    label: 'direct DEX',
  },
  calldata_aggregator: {
    path: 'calldata_aggregator',
    category: 'aggregator',
    label: 'calldata aggregator',
    requiresRouteDeploymentValidation: true,
    requiresDexGasOverride: true,
  },
} satisfies Record<
  ExternalTakePathKind,
  Omit<ExternalTakePathDescriptor, 'sources'>
>;

function getSourcesForPath<TPath extends ExternalTakePathKind>(
  path: TPath
): Array<
  TPath extends 'direct_dex'
    ? DirectDexLiquiditySource
    : CalldataAggregatorLiquiditySource
> {
  return EXTERNAL_TAKE_SOURCE_ORDER.map(
    (source) => EXTERNAL_TAKE_SOURCE_IDENTITIES[source]
  )
    .filter((identity) => identity.path === path)
    .map((identity) => identity.source) as Array<
    TPath extends 'direct_dex'
      ? DirectDexLiquiditySource
      : CalldataAggregatorLiquiditySource
  >;
}

export const EXTERNAL_TAKE_PATH_DESCRIPTORS = {
  direct_dex: {
    ...EXTERNAL_TAKE_PATH_METADATA.direct_dex,
    sources: getSourcesForPath('direct_dex'),
  },
  calldata_aggregator: {
    ...EXTERNAL_TAKE_PATH_METADATA.calldata_aggregator,
    sources: getSourcesForPath('calldata_aggregator'),
  },
} satisfies Record<ExternalTakePathKind, ExternalTakePathDescriptor>;

export const EXTERNAL_TAKE_LIQUIDITY_SOURCE_DESCRIPTORS =
  EXTERNAL_TAKE_SOURCE_IDENTITIES satisfies Record<
    ExternalTakeLiquiditySource,
    ExternalTakeLiquiditySourceDescriptor
  >;

function buildAggregatorProviderIdentities(
  identities: readonly CalldataAggregatorSourceIdentity[]
): Record<CalldataAggregatorProviderId, CalldataAggregatorSourceIdentity> {
  const identitiesByProvider: Partial<
    Record<CalldataAggregatorProviderId, CalldataAggregatorSourceIdentity>
  > = {};
  const seenProviderIds = new Set<CalldataAggregatorProviderId>();

  for (const identity of identities) {
    if (seenProviderIds.has(identity.providerId)) {
      throw new Error(
        `Duplicate calldata aggregator provider id: ${identity.providerId}`
      );
    }
    seenProviderIds.add(identity.providerId);
    identitiesByProvider[identity.providerId] = identity;
  }

  return identitiesByProvider as Record<
    CalldataAggregatorProviderId,
    CalldataAggregatorSourceIdentity
  >;
}

export const AGGREGATOR_PROVIDER_IDENTITIES =
  buildAggregatorProviderIdentities(CALLDATA_AGGREGATOR_PROVIDER_IDENTITY_ORDER);

export const CALLDATA_AGGREGATOR_PROVIDER_IDS: readonly CalldataAggregatorProviderId[] =
  Object.keys(AGGREGATOR_PROVIDER_IDENTITIES) as CalldataAggregatorProviderId[];

function formatList(values: readonly string[]): string {
  if (values.length <= 1) {
    return values[0] ?? '';
  }
  if (values.length === 2) {
    return `${values[0]} or ${values[1]}`;
  }
  return `${values.slice(0, -1).join(', ')}, and ${values[values.length - 1]}`;
}

export function isExternalTakePath(
  path: unknown
): path is ExternalTakePathKind {
  return (
    typeof path === 'string' &&
    EXTERNAL_TAKE_PATHS.has(path as ExternalTakePathKind)
  );
}

export function getExternalTakePathDescriptor(
  path: ExternalTakePathKind
): ExternalTakePathDescriptor {
  return EXTERNAL_TAKE_PATH_DESCRIPTORS[path];
}

export function getExternalTakePathDescriptors(
  paths: Iterable<ExternalTakePathKind> = SUPPORTED_EXTERNAL_TAKE_PATHS
): ExternalTakePathDescriptor[] {
  return Array.from(paths, getExternalTakePathDescriptor);
}

export function isAggregatorExternalTakePath(
  path: ExternalTakePathKind
): boolean {
  return getExternalTakePathDescriptor(path).category === 'aggregator';
}

export function isCalldataAggregatorLiquiditySource(
  source: LiquiditySource | undefined
): source is CalldataAggregatorLiquiditySource {
  return (
    source !== undefined && CALLDATA_AGGREGATOR_LIQUIDITY_SOURCE_SET.has(source)
  );
}

export function isDirectDexLiquiditySource(
  source: LiquiditySource | undefined
): source is DirectDexLiquiditySource {
  return (
    source !== undefined &&
    DIRECT_DEX_DYNAMIC_SOURCES.includes(source as DirectDexLiquiditySource)
  );
}

export function isExternalTakeLiquiditySource(
  source: LiquiditySource | undefined
): source is ExternalTakeLiquiditySource {
  return (
    source !== undefined &&
    SUPPORTED_EXTERNAL_TAKE_LIQUIDITY_SOURCES.includes(
      source as ExternalTakeLiquiditySource
    )
  );
}

export function getExternalTakeLiquiditySourceDescriptor(
  source: ExternalTakeLiquiditySource
): ExternalTakeLiquiditySourceDescriptor {
  return EXTERNAL_TAKE_LIQUIDITY_SOURCE_DESCRIPTORS[source];
}

export function isCalldataAggregatorProviderId(
  value: unknown
): value is CalldataAggregatorProviderId {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(AGGREGATOR_PROVIDER_IDENTITIES, value)
  );
}

export function getAggregatorProviderIdentity(
  providerId: CalldataAggregatorProviderId
): CalldataAggregatorSourceIdentity {
  return AGGREGATOR_PROVIDER_IDENTITIES[providerId];
}

export function resolveCalldataAggregatorProviderForSource(
  source: LiquiditySource | undefined
): CalldataAggregatorProviderId | undefined {
  if (source === undefined) {
    return undefined;
  }
  for (const providerId of CALLDATA_AGGREGATOR_PROVIDER_IDS) {
    if (AGGREGATOR_PROVIDER_IDENTITIES[providerId].source === source) {
      return providerId;
    }
  }
  return undefined;
}

export function formatCalldataAggregatorProviderIds(): string {
  return CALLDATA_AGGREGATOR_PROVIDER_IDS.join(', ');
}

export function getExternalTakeTakerContractKeyForSource(
  source: LiquiditySource | undefined
): ExternalTakeTakerContractKey | undefined {
  if (!isExternalTakeLiquiditySource(source)) {
    return undefined;
  }
  return getExternalTakeLiquiditySourceDescriptor(source).takerContractKey;
}

export function resolveExternalTakePathFromSource(
  source: LiquiditySource | undefined
): ExternalTakePathKind | undefined {
  if (!isExternalTakeLiquiditySource(source)) {
    return undefined;
  }
  return getExternalTakeLiquiditySourceDescriptor(source).path;
}

function getConfiguredExternalTakeTaker(params: {
  source: ExternalTakeLiquiditySource;
  config: ExternalTakeDeploymentRuntimeConfig;
}): string | undefined {
  const contractKey = getExternalTakeTakerContractKeyForSource(params.source);
  if (!contractKey) {
    return undefined;
  }

  return params.config.takerContracts?.[contractKey];
}

export function resolveExternalTakeDeployment(params: {
  liquiditySource: LiquiditySource | undefined;
  config: ExternalTakeDeploymentRuntimeConfig;
}): ExternalTakeDeploymentResolution {
  const source = params.liquiditySource;
  if (!isExternalTakeLiquiditySource(source)) {
    return {
      deploymentType: 'none',
      requestedLiquiditySource: source,
    };
  }

  const contractKey = getExternalTakeTakerContractKeyForSource(source);
  const resolvedTakerAddress = getConfiguredExternalTakeTaker({
    source,
    config: params.config,
  });
  if (!params.config.keeperTakerRouter) {
    return {
      deploymentType: 'none',
      requestedLiquiditySource: source,
      unavailableReason: 'keeperTakerRouter is not configured',
    };
  }
  if (!resolvedTakerAddress) {
    return {
      deploymentType: 'none',
      requestedLiquiditySource: source,
      unavailableReason: contractKey
        ? `takerContracts.${contractKey} is not configured`
        : 'registered taker contract is not configured',
    };
  }
  if (isCalldataAggregatorLiquiditySource(source)) {
    const providerId = resolveCalldataAggregatorProviderForSource(source);
    if (!providerId) {
      return {
        deploymentType: 'none',
        requestedLiquiditySource: source,
        unavailableReason: 'calldata aggregator provider is not configured',
      };
    }
    return {
      deploymentType: 'calldata_aggregator',
      providerId,
      requestedLiquiditySource: source,
      resolvedTakerAddress,
    };
  }
  return {
    deploymentType: 'direct_dex',
    requestedLiquiditySource: source,
    resolvedTakerAddress,
  };
}

export function formatSupportedExternalTakePaths(): string {
  return formatList(SUPPORTED_EXTERNAL_TAKE_PATHS);
}

export function formatSupportedExternalTakeLiquiditySources(): string {
  return formatList(
    SUPPORTED_EXTERNAL_TAKE_LIQUIDITY_SOURCES.map(
      (source) => LiquiditySource[source]
    )
  );
}
