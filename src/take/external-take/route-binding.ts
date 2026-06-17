import {
  CalldataAggregatorProviderId,
  DirectDexLiquiditySource,
  ExternalTakePathKind,
  LiquiditySource,
  formatLiquiditySource,
  getAggregatorProviderIdentity,
  isDirectDexDynamicSource,
  isCalldataAggregatorLiquiditySource,
  resolveCalldataAggregatorProviderForSource,
  resolveExternalTakePathFromSource,
} from '../../config';
import type { CalldataAggregatorLiquiditySource } from '../../config';
import { ExternalTakeQuoteEvaluation } from '../types';

export type ExternalTakeRouteIdentity =
  | {
      path: 'calldata_aggregator';
      providerId: CalldataAggregatorProviderId;
      source: CalldataAggregatorLiquiditySource;
    }
  | {
      path: 'direct_dex';
      source: DirectDexLiquiditySource;
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
      code: 'provider_mismatch';
      providerId: CalldataAggregatorProviderId;
      calldataQuoteProviderId: CalldataAggregatorProviderId;
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

type BoundCalldataAggregatorExternalTakeRouteBinding<
  TQuoteEvaluation extends ExternalTakeQuoteEvaluation,
> = {
  bound: true;
  identity: Extract<ExternalTakeRouteIdentity, { path: 'calldata_aggregator' }>;
  path: 'calldata_aggregator';
  providerId: CalldataAggregatorProviderId;
  source: CalldataAggregatorLiquiditySource;
  quoteEvaluation: ExternalTakeRouteQuoteEvaluation<
    TQuoteEvaluation,
    'calldata_aggregator',
    CalldataAggregatorLiquiditySource
  >;
};

type BoundDirectDexExternalTakeRouteBinding<
  TQuoteEvaluation extends ExternalTakeQuoteEvaluation,
> = {
  bound: true;
  identity: Extract<ExternalTakeRouteIdentity, { path: 'direct_dex' }>;
  path: 'direct_dex';
  source: DirectDexLiquiditySource;
  quoteEvaluation: ExternalTakeRouteQuoteEvaluation<
    TQuoteEvaluation,
    'direct_dex',
    DirectDexLiquiditySource
  >;
};

export type BoundExternalTakeRouteBinding<
  TQuoteEvaluation extends ExternalTakeQuoteEvaluation,
> =
  | BoundCalldataAggregatorExternalTakeRouteBinding<TQuoteEvaluation>
  | BoundDirectDexExternalTakeRouteBinding<TQuoteEvaluation>;

export type ExternalTakeRouteBinding<
  TQuoteEvaluation extends ExternalTakeQuoteEvaluation,
> =
  | BoundExternalTakeRouteBinding<TQuoteEvaluation>
  | ExternalTakeRouteBindingFailure;

export { resolveExternalTakePathFromSource };

export type CalldataAggregatorQuoteIdentity = {
  providerId?: CalldataAggregatorProviderId;
  source?: CalldataAggregatorLiquiditySource;
  mismatch?: {
    providerId: CalldataAggregatorProviderId;
    calldataQuoteProviderId: CalldataAggregatorProviderId;
  };
};

export function resolveCalldataAggregatorQuoteIdentity(
  quoteEvaluation: ExternalTakeQuoteEvaluation | undefined
): CalldataAggregatorQuoteIdentity {
  const providerId = quoteEvaluation?.providerId;
  const calldataQuoteProviderId = quoteEvaluation?.calldataQuote?.providerId;
  if (
    providerId !== undefined &&
    calldataQuoteProviderId !== undefined &&
    providerId !== calldataQuoteProviderId
  ) {
    return {
      providerId,
      source: getAggregatorProviderIdentity(providerId).source,
      mismatch: {
        providerId,
        calldataQuoteProviderId,
      },
    };
  }

  const resolvedProviderId = providerId ?? calldataQuoteProviderId;
  return {
    providerId: resolvedProviderId,
    source:
      resolvedProviderId !== undefined
        ? getAggregatorProviderIdentity(resolvedProviderId).source
        : undefined,
  };
}

export function resolveExternalTakeRouteIdentityFromParts(params: {
  path: ExternalTakePathKind;
  source: LiquiditySource;
}): ExternalTakeRouteIdentity | undefined {
  if (
    params.path === 'calldata_aggregator' &&
    isCalldataAggregatorLiquiditySource(params.source)
  ) {
    const providerId = resolveCalldataAggregatorProviderForSource(
      params.source
    );
    return (
      providerId && {
        path: 'calldata_aggregator',
        providerId,
        source: params.source,
      }
    );
  }
  if (params.path === 'direct_dex' && isDirectDexDynamicSource(params.source)) {
    return { path: 'direct_dex', source: params.source };
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
    case 'calldata_aggregator':
      return {
        bound: true,
        identity,
        path: 'calldata_aggregator',
        providerId: identity.providerId,
        source: identity.source,
        quoteEvaluation: {
          ...params.quoteEvaluation,
          externalTakePath: 'calldata_aggregator',
          providerId: identity.providerId,
          selectedLiquiditySource: identity.source,
        },
      };
    case 'direct_dex':
      return {
        bound: true,
        identity,
        path: 'direct_dex',
        source: identity.source,
        quoteEvaluation: {
          ...params.quoteEvaluation,
          externalTakePath: 'direct_dex',
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
  resolvedExternalTakePaths?: readonly ExternalTakePathKind[];
}): ExternalTakeRouteBinding<TQuoteEvaluation> {
  const quoteSource = params.quoteEvaluation?.selectedLiquiditySource;
  const selectedSource = params.selectedLiquiditySource;
  const calldataAggregatorIdentity = resolveCalldataAggregatorQuoteIdentity(
    params.quoteEvaluation
  );
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
  if (calldataAggregatorIdentity.mismatch !== undefined) {
    return {
      bound: false,
      code: 'provider_mismatch',
      providerId: calldataAggregatorIdentity.mismatch.providerId,
      calldataQuoteProviderId:
        calldataAggregatorIdentity.mismatch.calldataQuoteProviderId,
      source: explicitSource,
      path: selectedPath,
    };
  }
  if (
    calldataAggregatorIdentity.source !== undefined &&
    explicitSource !== undefined &&
    calldataAggregatorIdentity.source !== explicitSource
  ) {
    return {
      bound: false,
      code: 'source_mismatch',
      quoteSource: calldataAggregatorIdentity.source,
      selectedSource: explicitSource,
      source: explicitSource,
      path: selectedPath,
    };
  }
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

  if (selectedPath === undefined) {
    return {
      bound: false,
      code: 'missing_path',
      source: explicitSource,
    };
  }

  const path = selectedPath;
  if (
    params.resolvedExternalTakePaths !== undefined &&
    !params.resolvedExternalTakePaths.includes(path)
  ) {
    return {
      bound: false,
      code: 'disabled_path',
      path,
      source: explicitSource,
    };
  }
  const source = explicitSource;
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
  });
  if (!route.bound) {
    return undefined;
  }
  return route.identity;
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
    case 'provider_mismatch':
      return `external take route has inconsistent calldata provider identity${context}`;
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
    case 'provider_mismatch':
      return `selected inconsistent provider=${failure.providerId} calldataQuoteProvider=${failure.calldataQuoteProviderId}`;
    case 'path_source_mismatch':
      return `selected inconsistent path=${failure.path} source=${formatLiquiditySource(failure.source)}`;
    case 'disabled_path':
      return `selected disabled path=${failure.path}`;
    case 'missing_path':
      return 'hybrid external take selection missing selected path';
    case 'missing_source':
      return failure.path === 'direct_dex'
        ? 'selected direct_dex path without a concrete direct DEX source'
        : `selected path=${failure.path} without a concrete source`;
    case 'unsupported_source':
      return `selected unsupported source=${formatLiquiditySource(failure.source)}`;
  }
}

export function isDirectDexExternalTakeRoute(
  quoteEvaluation: ExternalTakeQuoteEvaluation | undefined
): boolean {
  return (
    resolveExternalTakeRouteIdentity(quoteEvaluation)?.path === 'direct_dex'
  );
}

export function isCalldataAggregatorExternalTakeRoute(
  quoteEvaluation: ExternalTakeQuoteEvaluation | undefined
): boolean {
  const identity = resolveExternalTakeRouteIdentity(quoteEvaluation);
  return identity?.path === 'calldata_aggregator';
}

export function resolveExternalTakePathFromEvaluation(
  quoteEvaluation: ExternalTakeQuoteEvaluation | undefined
): ExternalTakePathKind | undefined {
  return resolveExternalTakeRouteIdentity(quoteEvaluation)?.path;
}
