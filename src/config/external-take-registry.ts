import { ExternalTakePathKind, LiquiditySource } from './schema';

export type FactoryLiquiditySource =
  | LiquiditySource.UNISWAPV3
  | LiquiditySource.SUSHISWAP
  | LiquiditySource.CURVE;

export type ExternalTakeTakerContractKey =
  | 'UniswapV3'
  | 'SushiSwap'
  | 'Curve'
  | 'Lifi';

export type ExternalTakeLiquiditySource =
  | LiquiditySource.ONEINCH
  | FactoryLiquiditySource
  | LiquiditySource.LIFI;

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

export interface ExternalTakeLiquiditySourceDescriptor {
  readonly source: ExternalTakeLiquiditySource;
  readonly path: ExternalTakePathKind;
  readonly label: string;
  readonly takerContractKey?: ExternalTakeTakerContractKey;
}

export type ExternalTakeDeploymentType =
  | 'factory'
  | 'oneinch'
  | 'lifi'
  | 'none';
export type ActiveExternalTakeDeploymentType = Exclude<
  ExternalTakeDeploymentType,
  'none'
>;

export interface ExternalTakeDeploymentRuntimeConfig {
  keeperTaker?: string;
  keeperTakerFactory?: string;
  takerContracts?: Partial<Record<ExternalTakeTakerContractKey, string>>;
}

export type OneInchExternalTakeDeploymentResolution = {
  deploymentType: 'oneinch';
  requestedLiquiditySource: LiquiditySource.ONEINCH;
  resolvedTakerAddress: string;
};

export type FactoryExternalTakeDeploymentResolution = {
  deploymentType: 'factory';
  requestedLiquiditySource: FactoryLiquiditySource;
  resolvedTakerAddress: string;
};

export type LifiExternalTakeDeploymentResolution = {
  deploymentType: 'lifi';
  requestedLiquiditySource: LiquiditySource.LIFI;
  resolvedTakerAddress: string;
};

export type ActiveExternalTakeDeploymentResolution =
  | OneInchExternalTakeDeploymentResolution
  | FactoryExternalTakeDeploymentResolution
  | LifiExternalTakeDeploymentResolution;

export type ExternalTakeDeploymentResolution =
  | ActiveExternalTakeDeploymentResolution
  | {
      deploymentType: 'none';
      requestedLiquiditySource: LiquiditySource | undefined;
      unavailableReason?: string;
    };

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

export const SUPPORTED_EXTERNAL_TAKE_LIQUIDITY_SOURCES: readonly ExternalTakeLiquiditySource[] =
  [LiquiditySource.ONEINCH, ...FACTORY_DYNAMIC_SOURCES, LiquiditySource.LIFI];

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

export const EXTERNAL_TAKE_LIQUIDITY_SOURCE_DESCRIPTORS = {
  [LiquiditySource.ONEINCH]: {
    source: LiquiditySource.ONEINCH,
    path: 'oneinch',
    label: '1inch',
  },
  [LiquiditySource.UNISWAPV3]: {
    source: LiquiditySource.UNISWAPV3,
    path: 'factory',
    label: 'Uniswap V3',
    takerContractKey: 'UniswapV3',
  },
  [LiquiditySource.SUSHISWAP]: {
    source: LiquiditySource.SUSHISWAP,
    path: 'factory',
    label: 'SushiSwap',
    takerContractKey: 'SushiSwap',
  },
  [LiquiditySource.CURVE]: {
    source: LiquiditySource.CURVE,
    path: 'factory',
    label: 'Curve',
    takerContractKey: 'Curve',
  },
  [LiquiditySource.LIFI]: {
    source: LiquiditySource.LIFI,
    path: 'lifi',
    label: 'LI.FI',
    takerContractKey: 'Lifi',
  },
} satisfies Record<
  ExternalTakeLiquiditySource,
  ExternalTakeLiquiditySourceDescriptor
>;

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
  if (params.source === LiquiditySource.ONEINCH) {
    return params.config.keeperTaker;
  }

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

  if (source === LiquiditySource.ONEINCH) {
    const resolvedTakerAddress = getConfiguredExternalTakeTaker({
      source,
      config: params.config,
    });
    if (resolvedTakerAddress) {
      return {
        deploymentType: 'oneinch',
        requestedLiquiditySource: source,
        resolvedTakerAddress,
      };
    }
    return {
      deploymentType: 'none',
      requestedLiquiditySource: source,
      unavailableReason: 'keeperTaker is not configured',
    };
  }

  const contractKey = getExternalTakeTakerContractKeyForSource(source);
  const resolvedTakerAddress = getConfiguredExternalTakeTaker({
    source,
    config: params.config,
  });
  if (!params.config.keeperTakerFactory) {
    return {
      deploymentType: 'none',
      requestedLiquiditySource: source,
      unavailableReason: 'keeperTakerFactory is not configured',
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
  if (source === LiquiditySource.LIFI) {
    return {
      deploymentType: 'lifi',
      requestedLiquiditySource: source,
      resolvedTakerAddress,
    };
  }
  return {
    deploymentType: 'factory',
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
