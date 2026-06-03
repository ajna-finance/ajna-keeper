import {
  ExternalTakePathKind,
  LiquiditySource,
  formatLiquiditySource,
} from '../config';
import {
  BoundExternalTakeRouteBinding,
  bindExternalTakeRoute,
  formatExternalTakeRouteBindingFailure,
} from './external-take-route';
import {
  ApprovedExternalTakeQuoteEvaluation,
  ApprovedFactoryQuoteEvaluation,
  ApprovedLifiQuoteEvaluation,
  ApprovedOneInchQuoteEvaluation,
  BoundExternalTakeRouteEvaluation,
  BoundFactoryRouteEvaluation,
  BoundLifiRouteEvaluation,
  BoundOneInchRouteEvaluation,
  CurvePoolSelection,
  ExternalTakeQuoteEvaluation,
} from './types';
import { deriveApprovedMinOutRaw } from './factory/shared';

export type ExternalTakeQuoteApprovalResult<
  TQuote extends ApprovedExternalTakeQuoteEvaluation,
> =
  | { approved: true; quoteEvaluation: TQuote }
  | { approved: false; reason: string };

export type ExternalTakeRouteBindingResult<
  TQuote extends BoundExternalTakeRouteEvaluation,
> =
  | { bound: true; quoteEvaluation: TQuote }
  | { bound: false; reason: string };

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
    inferSourceFromPath: false,
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

function deriveRouteExecutionFloorRaw(
  quoteEvaluation: ExternalTakeQuoteEvaluation
): ExternalTakeQuoteEvaluation['routeExecutionFloorRaw'] {
  return (
    quoteEvaluation.routeExecutionFloorRaw ??
    deriveApprovedMinOutRaw({
      routeMinOutRaw: quoteEvaluation.routeMinOutRaw,
      profitMinOutRaw: quoteEvaluation.profitMinOutRaw,
      fallbackMinOutRaw: quoteEvaluation.approvedMinOutRaw,
    })
  );
}

type FactoryRouteBase = ExternalTakeQuoteEvaluation & {
  isTakeable: true;
  externalTakePath: 'factory';
  quoteAmountRaw: NonNullable<ExternalTakeQuoteEvaluation['quoteAmountRaw']>;
  routeExecutionFloorRaw: NonNullable<
    ExternalTakeQuoteEvaluation['routeExecutionFloorRaw']
  >;
};

type ApprovedFactoryRouteBase = FactoryRouteBase & {
  approvedMinOutRaw: NonNullable<
    ExternalTakeQuoteEvaluation['approvedMinOutRaw']
  >;
};

type FactoryRouteFields =
  | {
      selectedLiquiditySource: LiquiditySource.UNISWAPV3;
      selectedFeeTier: number;
    }
  | {
      selectedLiquiditySource: LiquiditySource.SUSHISWAP;
      selectedFeeTier: number;
    }
  | {
      selectedLiquiditySource: LiquiditySource.CURVE;
      curvePool: CurvePoolSelection;
    };

type FactoryRouteEvaluation<TBase extends FactoryRouteBase> =
  TBase & FactoryRouteFields;

function resolveFactoryRouteFields(params: {
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  selectedLiquiditySource: LiquiditySource;
  context: string;
  action: 'bind' | 'execute';
}): { ok: true; fields: FactoryRouteFields } | { ok: false; reason: string } {
  const action = `${params.action} an unbound route`;

  if (
    params.selectedLiquiditySource === LiquiditySource.UNISWAPV3 ||
    params.selectedLiquiditySource === LiquiditySource.SUSHISWAP
  ) {
    if (params.quoteEvaluation.selectedFeeTier === undefined) {
      return {
        ok: false,
        reason: `Factory: Missing selected fee tier for ${params.context}; refusing to ${action}`,
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
        reason: `Factory: Missing selected Curve pool for ${params.context}; refusing to ${action}`,
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
    reason: `Factory: Unsupported liquidity source: ${params.selectedLiquiditySource}`,
  };
}

function withFactoryRouteFields<TBase extends FactoryRouteBase>(params: {
  base: TBase;
  fields: FactoryRouteFields;
}): FactoryRouteEvaluation<TBase> {
  return {
    ...params.base,
    ...params.fields,
  };
}

function approveFactoryRouteBinding(params: {
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  selectedLiquiditySource: LiquiditySource;
  quoteAmountRaw: NonNullable<ExternalTakeQuoteEvaluation['quoteAmountRaw']>;
  approvedMinOutRaw: NonNullable<
    ExternalTakeQuoteEvaluation['approvedMinOutRaw']
  >;
  context: string;
}): ExternalTakeQuoteApprovalResult<ApprovedFactoryQuoteEvaluation> {
  const fields = resolveFactoryRouteFields({ ...params, action: 'execute' });
  if (!fields.ok) {
    return { approved: false, reason: fields.reason };
  }

  const approvedBase: ApprovedFactoryRouteBase = {
    ...params.quoteEvaluation,
    isTakeable: true,
    externalTakePath: 'factory',
    quoteAmountRaw: params.quoteAmountRaw,
    routeExecutionFloorRaw:
      params.quoteEvaluation.routeExecutionFloorRaw ?? params.approvedMinOutRaw,
    approvedMinOutRaw: params.approvedMinOutRaw,
  };
  return {
    approved: true,
    quoteEvaluation: withFactoryRouteFields({
      base: approvedBase,
      fields: fields.fields,
    }),
  };
}

function bindFactoryRouteEvaluation(params: {
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  selectedLiquiditySource: LiquiditySource;
  quoteAmountRaw: NonNullable<ExternalTakeQuoteEvaluation['quoteAmountRaw']>;
  routeExecutionFloorRaw: NonNullable<
    ExternalTakeQuoteEvaluation['routeExecutionFloorRaw']
  >;
  context: string;
}): ExternalTakeRouteBindingResult<BoundFactoryRouteEvaluation> {
  const fields = resolveFactoryRouteFields({ ...params, action: 'bind' });
  if (!fields.ok) {
    return { bound: false, reason: fields.reason };
  }

  const boundBase: FactoryRouteBase = {
    ...params.quoteEvaluation,
    isTakeable: true,
    externalTakePath: 'factory',
    quoteAmountRaw: params.quoteAmountRaw,
    routeExecutionFloorRaw: params.routeExecutionFloorRaw,
  };
  return {
    bound: true,
    quoteEvaluation: withFactoryRouteFields({
      base: boundBase,
      fields: fields.fields,
    }),
  };
}

export function approveOneInchQuoteForExecution(params: {
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  poolName: string;
  borrower: string;
}): ExternalTakeQuoteApprovalResult<ApprovedOneInchQuoteEvaluation> {
  const { quoteEvaluation, poolName, borrower } = params;
  const context = getExecutionContext({ poolName, borrower });

  if (!quoteEvaluation.isTakeable) {
    return {
      approved: false,
      reason: `1inch atomic take quote no longer satisfies execution policy for ${context}: ${quoteEvaluation.reason ?? 'not takeable'}`,
    };
  }

  if (!quoteEvaluation.quoteAmountRaw) {
    return {
      approved: false,
      reason: `1inch atomic take is missing raw quote amount for ${context}; refusing to send an unbounded swap`,
    };
  }

  if (
    quoteEvaluation.externalTakePath !== undefined &&
    quoteEvaluation.externalTakePath !== 'oneinch'
  ) {
    return {
      approved: false,
      reason: `1inch atomic take received non-1inch approved path for ${context}`,
    };
  }

  if (
    quoteEvaluation.selectedLiquiditySource !== undefined &&
    quoteEvaluation.selectedLiquiditySource !== LiquiditySource.ONEINCH
  ) {
    return {
      approved: false,
      reason: `1inch atomic take received non-1inch approved source for ${context}`,
    };
  }

  const approvedMinOutRaw = deriveRouteExecutionFloorRaw(quoteEvaluation);
  if (!approvedMinOutRaw) {
    return {
      approved: false,
      reason: `1inch atomic take is missing approved min-out floor for ${context}; refusing to execute an unbound swap`,
    };
  }

  return {
    approved: true,
    quoteEvaluation: {
      ...quoteEvaluation,
      isTakeable: true,
      externalTakePath: 'oneinch',
      quoteAmountRaw: quoteEvaluation.quoteAmountRaw,
      selectedLiquiditySource: LiquiditySource.ONEINCH,
      routeExecutionFloorRaw:
        quoteEvaluation.routeExecutionFloorRaw ?? approvedMinOutRaw,
      approvedMinOutRaw,
    },
  };
}

export function approveLifiQuoteForExecution(params: {
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  poolName: string;
  borrower: string;
}): ExternalTakeQuoteApprovalResult<ApprovedLifiQuoteEvaluation> {
  const { quoteEvaluation, poolName, borrower } = params;
  const context = getExecutionContext({ poolName, borrower });

  if (!quoteEvaluation.isTakeable) {
    return {
      approved: false,
      reason: `LI.FI quote no longer satisfies execution policy for ${context}: ${quoteEvaluation.reason ?? 'not takeable'}`,
    };
  }
  if (!quoteEvaluation.quoteAmountRaw) {
    return {
      approved: false,
      reason: `LI.FI quote is missing raw quote amount for ${context}`,
    };
  }
  if (quoteEvaluation.externalTakePath !== 'lifi') {
    return {
      approved: false,
      reason: `LI.FI execution received non-LI.FI approved path for ${context}`,
    };
  }
  if (quoteEvaluation.selectedLiquiditySource !== LiquiditySource.LIFI) {
    return {
      approved: false,
      reason: `LI.FI execution received non-LI.FI approved source for ${context}`,
    };
  }
  if (!quoteEvaluation.lifiQuote) {
    return {
      approved: false,
      reason: `LI.FI execution is missing validated route details for ${context}`,
    };
  }
  const approvedMinOutRaw = deriveRouteExecutionFloorRaw(quoteEvaluation);
  if (!approvedMinOutRaw) {
    return {
      approved: false,
      reason: `LI.FI execution is missing approved min-out floor for ${context}`,
    };
  }
  return {
    approved: true,
    quoteEvaluation: {
      ...quoteEvaluation,
      isTakeable: true,
      externalTakePath: 'lifi',
      quoteAmountRaw: quoteEvaluation.quoteAmountRaw,
      selectedLiquiditySource: LiquiditySource.LIFI,
      routeExecutionFloorRaw:
        quoteEvaluation.routeExecutionFloorRaw ?? approvedMinOutRaw,
      approvedMinOutRaw,
      lifiQuote: quoteEvaluation.lifiQuote,
    },
  };
}

export function approveFactoryQuoteForExecution(params: {
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  poolName: string;
  borrower: string;
}): ExternalTakeQuoteApprovalResult<ApprovedFactoryQuoteEvaluation> {
  const { quoteEvaluation, poolName, borrower } = params;
  const context = getExecutionContext({ poolName, borrower });

  if (!quoteEvaluation.isTakeable) {
    return {
      approved: false,
      reason: `Factory: Take quote no longer satisfies execution policy for ${context}: ${quoteEvaluation.reason ?? 'not takeable'}`,
    };
  }

  if (!quoteEvaluation.quoteAmountRaw) {
    return {
      approved: false,
      reason: `Factory: Missing raw quote amount for ${context}; refusing to send an unbounded swap`,
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
  if (route.route.identity.path !== 'factory') {
    return {
      approved: false,
      reason: `Factory: Received non-factory approved path for ${context}; refusing to execute an unbound route`,
    };
  }

  const approvedMinOutRaw = deriveRouteExecutionFloorRaw(
    route.route.quoteEvaluation
  );
  if (!approvedMinOutRaw) {
    return {
      approved: false,
      reason: `Factory: Missing approved min-out floor for ${context}; refusing to execute an unbound swap`,
    };
  }

  return approveFactoryRouteBinding({
    quoteEvaluation: route.route.quoteEvaluation,
    selectedLiquiditySource: route.route.identity.source,
    quoteAmountRaw,
    approvedMinOutRaw,
    context,
  });
}

export function approveExternalTakeQuoteForExecution(params: {
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  selectedLiquiditySource?: LiquiditySource;
  poolName: string;
  borrower: string;
}): ExternalTakeQuoteApprovalResult<ApprovedExternalTakeQuoteEvaluation> {
  const route = resolveExternalTakeRouteBinding(params);
  if (!route.bound) {
    return {
      approved: false,
      reason: route.reason,
    };
  }

  if (route.route.identity.source === LiquiditySource.ONEINCH) {
    return approveOneInchQuoteForExecution({
      ...params,
      quoteEvaluation: route.route.quoteEvaluation,
    });
  }
  if (route.route.identity.source === LiquiditySource.LIFI) {
    return approveLifiQuoteForExecution({
      ...params,
      quoteEvaluation: route.route.quoteEvaluation,
    });
  }
  return approveFactoryQuoteForExecution({
    ...params,
    quoteEvaluation: route.route.quoteEvaluation,
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

  const routeExecutionFloorRaw =
    deriveRouteExecutionFloorRaw(route.route.quoteEvaluation) ??
    route.route.quoteEvaluation.quoteAmountRaw;
  const boundBase = {
    ...route.route.quoteEvaluation,
    isTakeable: true as const,
    externalTakePath: route.route.identity.path,
    quoteAmountRaw: route.route.quoteEvaluation.quoteAmountRaw,
    selectedLiquiditySource: route.route.identity.source,
    routeExecutionFloorRaw,
  };

  if (route.route.identity.source === LiquiditySource.ONEINCH) {
    return {
      bound: true,
      quoteEvaluation: {
        ...boundBase,
        externalTakePath: 'oneinch',
        selectedLiquiditySource: LiquiditySource.ONEINCH,
      } satisfies BoundOneInchRouteEvaluation,
    };
  }
  if (route.route.identity.source === LiquiditySource.LIFI) {
    if (!route.route.quoteEvaluation.lifiQuote) {
      return {
        bound: false,
        reason: `LI.FI route is missing validated route details for ${context}`,
      };
    }
    return {
      bound: true,
      quoteEvaluation: {
        ...boundBase,
        externalTakePath: 'lifi',
        selectedLiquiditySource: LiquiditySource.LIFI,
        lifiQuote: route.route.quoteEvaluation.lifiQuote,
      } satisfies BoundLifiRouteEvaluation,
    };
  }

  return bindFactoryRouteEvaluation({
    quoteEvaluation: boundBase,
    selectedLiquiditySource: route.route.identity.source,
    quoteAmountRaw: route.route.quoteEvaluation.quoteAmountRaw,
    routeExecutionFloorRaw,
    context,
  });
}

export function bindExternalTakeRouteForCandidate(params: {
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  selectedLiquiditySource?: LiquiditySource;
  configuredLiquiditySource?: LiquiditySource;
  poolName: string;
  borrower: string;
}): ExternalTakeRouteBindingResult<BoundExternalTakeRouteEvaluation> {
  return bindExternalTakeRouteForDiscovery({
    quoteEvaluation: params.quoteEvaluation,
    selectedLiquiditySource:
      params.quoteEvaluation.selectedLiquiditySource ??
      params.selectedLiquiditySource ??
      params.configuredLiquiditySource,
    poolName: params.poolName,
    borrower: params.borrower,
  });
}
