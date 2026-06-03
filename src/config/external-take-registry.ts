import { ExternalTakePathKind, LiquiditySource } from './schema';

export type FactoryLiquiditySource =
  | LiquiditySource.UNISWAPV3
  | LiquiditySource.SUSHISWAP
  | LiquiditySource.CURVE;

export type ExternalTakePathCategory = 'aggregator' | 'factory';

export interface ExternalTakePathDescriptor {
  readonly path: ExternalTakePathKind;
  readonly category: ExternalTakePathCategory;
  readonly label: string;
  readonly defaultSource?: LiquiditySource;
  readonly sources: readonly LiquiditySource[];
  readonly requiresRouteDeploymentValidation?: boolean;
  readonly requiresDexGasOverride?: boolean;
}

export const FACTORY_DYNAMIC_SOURCES: readonly FactoryLiquiditySource[] = [
  LiquiditySource.UNISWAPV3,
  LiquiditySource.SUSHISWAP,
  LiquiditySource.CURVE,
];

export const SUPPORTED_EXTERNAL_TAKE_PATHS: readonly ExternalTakePathKind[] = [
  'oneinch',
  'factory',
  'lifi',
];

export const EXTERNAL_TAKE_PATHS: ReadonlySet<ExternalTakePathKind> = new Set(
  SUPPORTED_EXTERNAL_TAKE_PATHS
);

export const SUPPORTED_EXTERNAL_TAKE_LIQUIDITY_SOURCES: readonly LiquiditySource[] =
  [
    LiquiditySource.ONEINCH,
    ...FACTORY_DYNAMIC_SOURCES,
    LiquiditySource.LIFI,
  ];

export const EXTERNAL_TAKE_PATH_DESCRIPTORS = {
  oneinch: {
    path: 'oneinch',
    category: 'aggregator',
    label: '1inch',
    defaultSource: LiquiditySource.ONEINCH,
    sources: [LiquiditySource.ONEINCH],
  },
  factory: {
    path: 'factory',
    category: 'factory',
    label: 'factory',
    sources: FACTORY_DYNAMIC_SOURCES,
  },
  lifi: {
    path: 'lifi',
    category: 'aggregator',
    label: 'LI.FI',
    defaultSource: LiquiditySource.LIFI,
    sources: [LiquiditySource.LIFI],
    requiresRouteDeploymentValidation: true,
    requiresDexGasOverride: true,
  },
} satisfies Record<ExternalTakePathKind, ExternalTakePathDescriptor>;

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

export function getExternalTakePathDefaultSource(
  path: ExternalTakePathKind
): LiquiditySource | undefined {
  return getExternalTakePathDescriptor(path).defaultSource;
}

export function isAggregatorExternalTakePath(
  path: ExternalTakePathKind
): boolean {
  return getExternalTakePathDescriptor(path).category === 'aggregator';
}

export function isFactoryLiquiditySource(
  source: LiquiditySource | undefined
): source is FactoryLiquiditySource {
  return (
    source !== undefined &&
    FACTORY_DYNAMIC_SOURCES.includes(source as FactoryLiquiditySource)
  );
}

export function isExternalTakeLiquiditySource(
  source: LiquiditySource | undefined
): source is LiquiditySource {
  return (
    source !== undefined &&
    SUPPORTED_EXTERNAL_TAKE_LIQUIDITY_SOURCES.includes(source)
  );
}

export function resolveExternalTakePathFromSource(
  source: LiquiditySource | undefined
): ExternalTakePathKind | undefined {
  if (source === undefined) {
    return undefined;
  }
  return getExternalTakePathDescriptors().find((descriptor) =>
    descriptor.sources.includes(source)
  )?.path;
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
