import {
  ExternalTakePathKind,
  ExternalTakeRouteSelectionMode,
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
]);

export const EXTERNAL_TAKE_ROUTE_SELECTION_MODES =
  new Set<ExternalTakeRouteSelectionMode>(['maximize_profit', 'factory_first']);

export const DEFAULT_EXTERNAL_TAKE_ROUTE_SELECTION_MODE: ActiveExternalTakeRouteSelectionMode =
  'maximize_profit';

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
  if (isFactoryDynamicSource(params.defaultLiquiditySource)) {
    return ['factory'];
  }
  return [];
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
