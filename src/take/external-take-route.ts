import {
  ExternalTakePathKind,
  FactoryLiquiditySource,
  LiquiditySource,
  formatLiquiditySource,
  isFactoryDynamicSource,
} from '../config';
import { ExternalTakeQuoteEvaluation } from './types';

export type ExternalTakeRouteIdentity =
  | {
      path: 'oneinch';
      source: LiquiditySource.ONEINCH;
    }
  | {
      path: 'lifi';
      source: LiquiditySource.LIFI;
    }
  | {
      path: 'factory';
      source: FactoryLiquiditySource;
    };

export type ExternalTakeRouteBindingFailure =
  | {
      bound: false;
      code: 'source_mismatch';
      quoteSource: LiquiditySource;
      selectedSource: LiquiditySource;
      source?: LiquiditySource;
      path?: ExternalTakePathKind;
    }
  | {
      bound: false;
      code: 'path_source_mismatch';
      path: ExternalTakePathKind;
      source: LiquiditySource;
      sourcePath: ExternalTakePathKind;
    }
  | {
      bound: false;
      code: 'disabled_path';
      path: ExternalTakePathKind;
      source?: LiquiditySource;
    }
  | {
      bound: false;
      code: 'missing_path';
      source?: LiquiditySource;
    }
  | {
      bound: false;
      code: 'missing_source';
      path: ExternalTakePathKind;
      source?: LiquiditySource;
    }
  | {
      bound: false;
      code: 'unsupported_source';
      source: LiquiditySource;
      path?: ExternalTakePathKind;
    };

type ExternalTakeRouteQuoteEvaluation<
  TQuoteEvaluation extends ExternalTakeQuoteEvaluation,
  TPath extends ExternalTakePathKind,
  TSource extends LiquiditySource,
> = TQuoteEvaluation & {
  externalTakePath: TPath;
  selectedLiquiditySource: TSource;
};

type BoundOneInchExternalTakeRouteBinding<
  TQuoteEvaluation extends ExternalTakeQuoteEvaluation,
> = {
  bound: true;
  identity: Extract<ExternalTakeRouteIdentity, { path: 'oneinch' }>;
  path: 'oneinch';
  source: LiquiditySource.ONEINCH;
  quoteEvaluation: ExternalTakeRouteQuoteEvaluation<
    TQuoteEvaluation,
    'oneinch',
    LiquiditySource.ONEINCH
  >;
};

type BoundLifiExternalTakeRouteBinding<
  TQuoteEvaluation extends ExternalTakeQuoteEvaluation,
> = {
  bound: true;
  identity: Extract<ExternalTakeRouteIdentity, { path: 'lifi' }>;
  path: 'lifi';
  source: LiquiditySource.LIFI;
  quoteEvaluation: ExternalTakeRouteQuoteEvaluation<
    TQuoteEvaluation,
    'lifi',
    LiquiditySource.LIFI
  >;
};

type BoundFactoryExternalTakeRouteBinding<
  TQuoteEvaluation extends ExternalTakeQuoteEvaluation,
> = {
  bound: true;
  identity: Extract<ExternalTakeRouteIdentity, { path: 'factory' }>;
  path: 'factory';
  source: FactoryLiquiditySource;
  quoteEvaluation: ExternalTakeRouteQuoteEvaluation<
    TQuoteEvaluation,
    'factory',
    FactoryLiquiditySource
  >;
};

export type BoundExternalTakeRouteBinding<
  TQuoteEvaluation extends ExternalTakeQuoteEvaluation,
> =
  | BoundOneInchExternalTakeRouteBinding<TQuoteEvaluation>
  | BoundLifiExternalTakeRouteBinding<TQuoteEvaluation>
  | BoundFactoryExternalTakeRouteBinding<TQuoteEvaluation>;

export type ExternalTakeRouteBinding<
  TQuoteEvaluation extends ExternalTakeQuoteEvaluation,
> =
  | BoundExternalTakeRouteBinding<TQuoteEvaluation>
  | ExternalTakeRouteBindingFailure;

export function resolveExternalTakePathFromSource(
  source: LiquiditySource | undefined
): ExternalTakePathKind | undefined {
  if (source === LiquiditySource.ONEINCH) {
    return 'oneinch';
  }
  if (source === LiquiditySource.LIFI) {
    return 'lifi';
  }
  return isFactoryDynamicSource(source) ? 'factory' : undefined;
}

function getDefaultSourceForPath(
  path: ExternalTakePathKind
): LiquiditySource.ONEINCH | LiquiditySource.LIFI | undefined {
  if (path === 'oneinch') {
    return LiquiditySource.ONEINCH;
  }
  if (path === 'lifi') {
    return LiquiditySource.LIFI;
  }
  return undefined;
}

export function resolveExternalTakeRouteIdentityFromParts(params: {
  path: ExternalTakePathKind;
  source: LiquiditySource;
}): ExternalTakeRouteIdentity | undefined {
  if (params.path === 'oneinch' && params.source === LiquiditySource.ONEINCH) {
    return { path: 'oneinch', source: LiquiditySource.ONEINCH };
  }
  if (params.path === 'lifi' && params.source === LiquiditySource.LIFI) {
    return { path: 'lifi', source: LiquiditySource.LIFI };
  }
  if (params.path === 'factory' && isFactoryDynamicSource(params.source)) {
    return { path: 'factory', source: params.source };
  }
  return undefined;
}

function createBoundExternalTakeRouteBinding<
  TQuoteEvaluation extends ExternalTakeQuoteEvaluation,
>(params: {
  quoteEvaluation: TQuoteEvaluation;
  identity: ExternalTakeRouteIdentity;
}): BoundExternalTakeRouteBinding<TQuoteEvaluation> {
  const identity = params.identity;
  switch (identity.path) {
    case 'oneinch':
      return {
        bound: true,
        identity,
        path: 'oneinch',
        source: LiquiditySource.ONEINCH,
        quoteEvaluation: {
          ...params.quoteEvaluation,
          externalTakePath: 'oneinch',
          selectedLiquiditySource: LiquiditySource.ONEINCH,
        },
      };
    case 'lifi':
      return {
        bound: true,
        identity,
        path: 'lifi',
        source: LiquiditySource.LIFI,
        quoteEvaluation: {
          ...params.quoteEvaluation,
          externalTakePath: 'lifi',
          selectedLiquiditySource: LiquiditySource.LIFI,
        },
      };
    case 'factory':
      return {
        bound: true,
        identity,
        path: 'factory',
        source: identity.source,
        quoteEvaluation: {
          ...params.quoteEvaluation,
          externalTakePath: 'factory',
          selectedLiquiditySource: identity.source,
        },
      };
  }
}

export function bindExternalTakeRoute<
  TQuoteEvaluation extends ExternalTakeQuoteEvaluation,
>(params: {
  quoteEvaluation: TQuoteEvaluation | undefined;
  selectedLiquiditySource?: LiquiditySource;
  allowedExternalTakePaths?: readonly ExternalTakePathKind[];
  inferSourceFromPath?: boolean;
}): ExternalTakeRouteBinding<TQuoteEvaluation> {
  const quoteSource = params.quoteEvaluation?.selectedLiquiditySource;
  const selectedSource = params.selectedLiquiditySource;
  const selectedPath = params.quoteEvaluation?.externalTakePath;
  if (params.quoteEvaluation === undefined) {
    return {
      bound: false,
      code: 'missing_path',
      source: selectedSource,
    };
  }

  if (
    quoteSource !== undefined &&
    selectedSource !== undefined &&
    quoteSource !== selectedSource
  ) {
    return {
      bound: false,
      code: 'source_mismatch',
      quoteSource,
      selectedSource,
      source: selectedSource,
      path: selectedPath,
    };
  }

  const explicitSource = quoteSource ?? selectedSource;
  const sourcePath = resolveExternalTakePathFromSource(explicitSource);
  if (explicitSource !== undefined && sourcePath === undefined) {
    return {
      bound: false,
      code: 'unsupported_source',
      source: explicitSource,
      path: selectedPath,
    };
  }

  if (
    selectedPath !== undefined &&
    explicitSource !== undefined &&
    sourcePath !== undefined &&
    selectedPath !== sourcePath
  ) {
    return {
      bound: false,
      code: 'path_source_mismatch',
      path: selectedPath,
      source: explicitSource,
      sourcePath,
    };
  }

  const path = selectedPath ?? sourcePath;
  if (
    path !== undefined &&
    params.allowedExternalTakePaths !== undefined &&
    !params.allowedExternalTakePaths.includes(path)
  ) {
    return {
      bound: false,
      code: 'disabled_path',
      path,
      source: explicitSource,
    };
  }
  if (path === undefined) {
    return {
      bound: false,
      code: 'missing_path',
      source: explicitSource,
    };
  }

  const source =
    explicitSource ??
    (params.inferSourceFromPath !== false
      ? getDefaultSourceForPath(path)
      : undefined);
  const concreteSourcePath = resolveExternalTakePathFromSource(source);
  if (source === undefined || concreteSourcePath !== path) {
    return {
      bound: false,
      code: 'missing_source',
      path,
      source,
    };
  }

  const identity = resolveExternalTakeRouteIdentityFromParts({ path, source });
  if (!identity) {
    return {
      bound: false,
      code: 'path_source_mismatch',
      path,
      source,
      sourcePath: concreteSourcePath,
    };
  }

  return createBoundExternalTakeRouteBinding({
    quoteEvaluation: params.quoteEvaluation,
    identity,
  });
}

export function resolveExternalTakeRouteIdentity(
  quoteEvaluation: ExternalTakeQuoteEvaluation | undefined
): ExternalTakeRouteIdentity | undefined {
  const route = bindExternalTakeRoute({
    quoteEvaluation,
    inferSourceFromPath: true,
  });
  if (!route.bound) {
    return undefined;
  }
  return route.identity;
}

export function getExternalTakeRouteBindingFailurePath(
  failure: ExternalTakeRouteBindingFailure
): ExternalTakePathKind | undefined {
  return 'path' in failure ? failure.path : undefined;
}

export function getExternalTakeRouteBindingFailureSource(
  failure: ExternalTakeRouteBindingFailure
): LiquiditySource | undefined {
  switch (failure.code) {
    case 'source_mismatch':
      return failure.selectedSource;
    case 'path_source_mismatch':
    case 'unsupported_source':
      return failure.source;
    case 'disabled_path':
    case 'missing_path':
    case 'missing_source':
      return failure.source;
  }
}

export function formatExternalTakeRouteBindingFailure(params: {
  failure: ExternalTakeRouteBindingFailure;
  context?: string;
  pathMismatchReason?: (params: {
    selectedPath: ExternalTakePathKind;
    selectedLiquiditySource: LiquiditySource;
  }) => string;
}): string {
  const { failure } = params;
  const context = params.context ? ` for ${params.context}` : '';
  switch (failure.code) {
    case 'source_mismatch':
      return `external take route has inconsistent selected source${context}`;
    case 'path_source_mismatch':
      return (
        params.pathMismatchReason?.({
          selectedPath: failure.path,
          selectedLiquiditySource: failure.source,
        }) ?? `external take route has inconsistent path/source${context}`
      );
    case 'disabled_path':
      return `external take route selected disabled path=${failure.path}${context}`;
    case 'missing_path':
      return `external take route is missing selected path${context}`;
    case 'missing_source':
      return `external take route path=${failure.path} is missing selected liquidity source${context}`;
    case 'unsupported_source':
      return `external take route selected unsupported source=${formatLiquiditySource(failure.source)}${context}`;
  }
}

export function formatExternalTakeRouteSelectionFailure(
  failure: ExternalTakeRouteBindingFailure
): string {
  switch (failure.code) {
    case 'source_mismatch':
      return `selected inconsistent source=${formatLiquiditySource(failure.selectedSource)} quoteSource=${formatLiquiditySource(failure.quoteSource)}`;
    case 'path_source_mismatch':
      return `selected inconsistent path=${failure.path} source=${formatLiquiditySource(failure.source)}`;
    case 'disabled_path':
      return `selected disabled path=${failure.path}`;
    case 'missing_path':
      return 'hybrid external take selection missing selected path';
    case 'missing_source':
      return failure.path === 'factory'
        ? 'selected factory path without a concrete factory source'
        : `selected path=${failure.path} without a concrete source`;
    case 'unsupported_source':
      return `selected unsupported source=${formatLiquiditySource(failure.source)}`;
  }
}

export function isOneInchExternalTakeRoute(
  quoteEvaluation: ExternalTakeQuoteEvaluation | undefined
): boolean {
  return resolveExternalTakeRouteIdentity(quoteEvaluation)?.path === 'oneinch';
}

export function isFactoryExternalTakeRoute(
  quoteEvaluation: ExternalTakeQuoteEvaluation | undefined
): boolean {
  return resolveExternalTakeRouteIdentity(quoteEvaluation)?.path === 'factory';
}

export function isLifiExternalTakeRoute(
  quoteEvaluation: ExternalTakeQuoteEvaluation | undefined
): boolean {
  return resolveExternalTakeRouteIdentity(quoteEvaluation)?.path === 'lifi';
}

export function resolveExternalTakePathFromEvaluation(
  quoteEvaluation: ExternalTakeQuoteEvaluation | undefined
): ExternalTakePathKind | undefined {
  return resolveExternalTakeRouteIdentity(quoteEvaluation)?.path;
}
