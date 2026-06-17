import {
  ExternalTakePathKind,
  LiquiditySource,
  formatLiquiditySource,
} from '../../config';
import {
  BoundExternalTakeRouteBinding,
  bindExternalTakeRoute,
  formatExternalTakeRouteBindingFailure,
} from './route-binding';
import { deriveRouteExecutionFloorRaw } from './quote-economics';
import {
  ApprovedExternalTakeQuoteEvaluation,
  ApprovedDirectDexQuoteEvaluation,
  BoundCalldataAggregatorRouteEvaluation,
  BoundExternalTakeRouteEvaluation,
  BoundDirectDexRouteEvaluation,
  CurvePoolSelection,
  ExternalTakeQuoteEvaluation,
} from '../types';
import { approveCalldataAggregatorQuoteForExecution } from '../aggregator-calldata/quote-approval';

export type ExternalTakeQuoteApprovalResult<
  TQuote extends ApprovedExternalTakeQuoteEvaluation,
> =
  | { approved: true; quoteEvaluation: TQuote }
  | { approved: false; reason: string };

export type ExternalTakeRouteBindingResult<
  TQuote extends BoundExternalTakeRouteEvaluation,
> = { bound: true; quoteEvaluation: TQuote } | { bound: false; reason: string };

type ResolvedExternalTakeRouteBinding =
  | {
      bound: true;
      route: BoundExternalTakeRouteBinding<ExternalTakeQuoteEvaluation>;
    }
  | { bound: false; reason: string };

function getExecutionContext(params: {
  poolName: string;
  borrower: string;
}): string {
  return `${params.poolName}/${params.borrower}`;
}

function resolveExternalTakeRouteBinding(params: {
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  selectedLiquiditySource?: LiquiditySource;
  poolName: string;
  borrower: string;
  pathMismatchReason?: (params: {
    selectedPath: ExternalTakePathKind;
    selectedLiquiditySource: LiquiditySource;
  }) => string;
}): ResolvedExternalTakeRouteBinding {
  const route = bindExternalTakeRoute({
    quoteEvaluation: params.quoteEvaluation,
    selectedLiquiditySource: params.selectedLiquiditySource,
  });
  if (!route.bound) {
    return {
      bound: false,
      reason: formatExternalTakeRouteBindingFailure({
        failure: route,
        context: getExecutionContext(params),
        pathMismatchReason: params.pathMismatchReason,
      }),
    };
  }

  return {
    bound: true,
    route,
  };
}

type DirectDexRouteBase = ExternalTakeQuoteEvaluation & {
  isTakeable: true;
  externalTakePath: 'direct_dex';
  quoteAmountRaw: NonNullable<ExternalTakeQuoteEvaluation['quoteAmountRaw']>;
  routeExecutionFloorRaw: NonNullable<
    ExternalTakeQuoteEvaluation['routeExecutionFloorRaw']
  >;
};

type ApprovedDirectDexRouteBase = DirectDexRouteBase & {
  approvedMinOutRaw: NonNullable<
    ExternalTakeQuoteEvaluation['approvedMinOutRaw']
  >;
};

type DirectDexRouteFields =
  | {
      selectedLiquiditySource: LiquiditySource.UNISWAPV3;
      selectedFeeTier: number;
    }
  | {
      selectedLiquiditySource: LiquiditySource.CURVE;
      curvePool: CurvePoolSelection;
    };

type DirectDexRouteEvaluation<TBase extends DirectDexRouteBase> = TBase &
  DirectDexRouteFields;

function resolveDirectDexRouteFields(params: {
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  selectedLiquiditySource: LiquiditySource;
  context: string;
  action: 'bind' | 'execute';
}): { ok: true; fields: DirectDexRouteFields } | { ok: false; reason: string } {
  const action = `${params.action} an unbound route`;

  if (params.selectedLiquiditySource === LiquiditySource.UNISWAPV3) {
    if (params.quoteEvaluation.selectedFeeTier === undefined) {
      return {
        ok: false,
        reason: `Direct DEX: Missing selected fee tier for ${params.context}; refusing to ${action}`,
      };
    }
    return {
      ok: true,
      fields: {
        selectedLiquiditySource: params.selectedLiquiditySource,
        selectedFeeTier: params.quoteEvaluation.selectedFeeTier,
      },
    };
  }

  if (params.selectedLiquiditySource === LiquiditySource.CURVE) {
    if (!params.quoteEvaluation.curvePool) {
      return {
        ok: false,
        reason: `Direct DEX: Missing selected Curve pool for ${params.context}; refusing to ${action}`,
      };
    }
    return {
      ok: true,
      fields: {
        selectedLiquiditySource: LiquiditySource.CURVE,
        curvePool: params.quoteEvaluation.curvePool,
      },
    };
  }

  return {
    ok: false,
    reason: `Direct DEX: Unsupported liquidity source: ${params.selectedLiquiditySource}`,
  };
}

function withDirectDexRouteFields<TBase extends DirectDexRouteBase>(params: {
  base: TBase;
  fields: DirectDexRouteFields;
}): DirectDexRouteEvaluation<TBase> {
  return {
    ...params.base,
    ...params.fields,
  };
}

function approveDirectDexRouteBinding(params: {
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  selectedLiquiditySource: LiquiditySource;
  quoteAmountRaw: NonNullable<ExternalTakeQuoteEvaluation['quoteAmountRaw']>;
  approvedMinOutRaw: NonNullable<
    ExternalTakeQuoteEvaluation['approvedMinOutRaw']
  >;
  context: string;
}): ExternalTakeQuoteApprovalResult<ApprovedDirectDexQuoteEvaluation> {
  const fields = resolveDirectDexRouteFields({ ...params, action: 'execute' });
  if (!fields.ok) {
    return { approved: false, reason: fields.reason };
  }

  const approvedBase: ApprovedDirectDexRouteBase = {
    ...params.quoteEvaluation,
    isTakeable: true,
    externalTakePath: 'direct_dex',
    quoteAmountRaw: params.quoteAmountRaw,
    routeExecutionFloorRaw:
      params.quoteEvaluation.routeExecutionFloorRaw ?? params.approvedMinOutRaw,
    approvedMinOutRaw: params.approvedMinOutRaw,
  };
  return {
    approved: true,
    quoteEvaluation: withDirectDexRouteFields({
      base: approvedBase,
      fields: fields.fields,
    }),
  };
}

function bindDirectDexRouteEvaluation(params: {
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  selectedLiquiditySource: LiquiditySource;
  quoteAmountRaw: NonNullable<ExternalTakeQuoteEvaluation['quoteAmountRaw']>;
  routeExecutionFloorRaw: NonNullable<
    ExternalTakeQuoteEvaluation['routeExecutionFloorRaw']
  >;
  context: string;
}): ExternalTakeRouteBindingResult<BoundDirectDexRouteEvaluation> {
  const fields = resolveDirectDexRouteFields({ ...params, action: 'bind' });
  if (!fields.ok) {
    return { bound: false, reason: fields.reason };
  }

  const boundBase: DirectDexRouteBase = {
    ...params.quoteEvaluation,
    isTakeable: true,
    externalTakePath: 'direct_dex',
    quoteAmountRaw: params.quoteAmountRaw,
    routeExecutionFloorRaw: params.routeExecutionFloorRaw,
  };
  return {
    bound: true,
    quoteEvaluation: withDirectDexRouteFields({
      base: boundBase,
      fields: fields.fields,
    }),
  };
}

function bindCalldataAggregatorRouteEvaluation(params: {
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  selectedLiquiditySource: BoundCalldataAggregatorRouteEvaluation['selectedLiquiditySource'];
  providerId: BoundCalldataAggregatorRouteEvaluation['providerId'];
  quoteAmountRaw: NonNullable<ExternalTakeQuoteEvaluation['quoteAmountRaw']>;
  routeExecutionFloorRaw: NonNullable<
    ExternalTakeQuoteEvaluation['routeExecutionFloorRaw']
  >;
  calldataQuote: BoundCalldataAggregatorRouteEvaluation['calldataQuote'];
}): ExternalTakeRouteBindingResult<BoundCalldataAggregatorRouteEvaluation> {
  return {
    bound: true,
    quoteEvaluation: {
      ...params.quoteEvaluation,
      isTakeable: true,
      externalTakePath: 'calldata_aggregator',
      quoteAmountRaw: params.quoteAmountRaw,
      selectedLiquiditySource: params.selectedLiquiditySource,
      routeExecutionFloorRaw: params.routeExecutionFloorRaw,
      providerId: params.providerId,
      calldataQuote: params.calldataQuote,
    },
  };
}

function requireRouteExecutionFloorRaw(params: {
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  context: string;
}):
  | {
      ok: true;
      routeExecutionFloorRaw: NonNullable<
        ExternalTakeQuoteEvaluation['routeExecutionFloorRaw']
      >;
    }
  | { ok: false; reason: string } {
  const routeExecutionFloorRaw = deriveRouteExecutionFloorRaw(
    params.quoteEvaluation
  );
  if (!routeExecutionFloorRaw) {
    return {
      ok: false,
      reason: `external take quote is missing route execution floor for ${params.context}`,
    };
  }

  return { ok: true, routeExecutionFloorRaw };
}

export function approveDirectDexQuoteForExecution(params: {
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  poolName: string;
  borrower: string;
}): ExternalTakeQuoteApprovalResult<ApprovedDirectDexQuoteEvaluation> {
  const { quoteEvaluation, poolName, borrower } = params;
  const context = getExecutionContext({ poolName, borrower });

  if (!quoteEvaluation.isTakeable) {
    return {
      approved: false,
      reason: `Direct DEX: Take quote no longer satisfies execution policy for ${context}: ${quoteEvaluation.reason ?? 'not takeable'}`,
    };
  }

  if (!quoteEvaluation.quoteAmountRaw) {
    return {
      approved: false,
      reason: `Direct DEX: Missing raw quote amount for ${context}; refusing to send an unbounded swap`,
    };
  }
  const quoteAmountRaw = quoteEvaluation.quoteAmountRaw;

  const route = resolveExternalTakeRouteBinding({
    quoteEvaluation,
    selectedLiquiditySource: quoteEvaluation.selectedLiquiditySource,
    poolName,
    borrower,
  });
  if (!route.bound) {
    return {
      approved: false,
      reason: route.reason,
    };
  }
  if (route.route.identity.path !== 'direct_dex') {
    return {
      approved: false,
      reason: `Direct DEX: Received non-direct_dex approved path for ${context}; refusing to execute an unbound route`,
    };
  }

  const approvedMinOutRaw = deriveRouteExecutionFloorRaw(
    route.route.quoteEvaluation
  );
  if (!approvedMinOutRaw) {
    return {
      approved: false,
      reason: `Direct DEX: Missing approved min-out floor for ${context}; refusing to execute an unbound swap`,
    };
  }

  return approveDirectDexRouteBinding({
    quoteEvaluation: route.route.quoteEvaluation,
    selectedLiquiditySource: route.route.identity.source,
    quoteAmountRaw,
    approvedMinOutRaw,
    context,
  });
}

export function bindExternalTakeRouteForDiscovery(params: {
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  selectedLiquiditySource?: LiquiditySource;
  poolName: string;
  borrower: string;
}): ExternalTakeRouteBindingResult<BoundExternalTakeRouteEvaluation> {
  const context = getExecutionContext(params);
  const route = resolveExternalTakeRouteBinding({
    ...params,
    pathMismatchReason: ({ selectedLiquiditySource }) =>
      `selected inconsistent path=${params.quoteEvaluation.externalTakePath} source=${formatLiquiditySource(selectedLiquiditySource)}`,
  });
  if (!route.bound) {
    return route;
  }
  if (!route.route.quoteEvaluation.isTakeable) {
    return {
      bound: false,
      reason: `external take quote no longer satisfies discovery policy for ${context}: ${route.route.quoteEvaluation.reason ?? 'not takeable'}`,
    };
  }
  if (!route.route.quoteEvaluation.quoteAmountRaw) {
    return {
      bound: false,
      reason: `external take quote is missing raw quote amount for ${context}`,
    };
  }

  if (route.route.identity.path === 'calldata_aggregator') {
    const calldataQuote = route.route.quoteEvaluation.calldataQuote;
    if (!calldataQuote) {
      return {
        bound: false,
        reason: `calldata-aggregator route is missing validated route details for ${context}`,
      };
    }

    const routeExecutionFloor = requireRouteExecutionFloorRaw({
      quoteEvaluation: route.route.quoteEvaluation,
      context,
    });
    if (!routeExecutionFloor.ok) {
      return { bound: false, reason: routeExecutionFloor.reason };
    }

    return bindCalldataAggregatorRouteEvaluation({
      quoteEvaluation: route.route.quoteEvaluation,
      selectedLiquiditySource: route.route.identity.source,
      providerId: route.route.identity.providerId,
      quoteAmountRaw: route.route.quoteEvaluation.quoteAmountRaw,
      routeExecutionFloorRaw: routeExecutionFloor.routeExecutionFloorRaw,
      calldataQuote,
    });
  }

  const routeExecutionFloor = requireRouteExecutionFloorRaw({
    quoteEvaluation: route.route.quoteEvaluation,
    context,
  });
  if (!routeExecutionFloor.ok) {
    return { bound: false, reason: routeExecutionFloor.reason };
  }

  return bindDirectDexRouteEvaluation({
    quoteEvaluation: route.route.quoteEvaluation,
    selectedLiquiditySource: route.route.identity.source,
    quoteAmountRaw: route.route.quoteEvaluation.quoteAmountRaw,
    routeExecutionFloorRaw: routeExecutionFloor.routeExecutionFloorRaw,
    context,
  });
}

export function bindExternalTakeRouteForCandidate(params: {
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  poolName: string;
  borrower: string;
}): ExternalTakeRouteBindingResult<BoundExternalTakeRouteEvaluation> {
  return bindExternalTakeRouteForDiscovery({
    quoteEvaluation: params.quoteEvaluation,
    poolName: params.poolName,
    borrower: params.borrower,
  });
}
