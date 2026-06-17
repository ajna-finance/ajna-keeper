import { BigNumber } from 'ethers';
import { ExternalTakePathKind } from '../../config';
import { compareExternalTakeBySubsidyThenRank } from '../../take/external-take/policy';
import { ExternalTakeQuoteEvaluation } from '../../take/types';
import {
  bindExternalTakeRoute,
  formatExternalTakeRouteSelectionFailure,
  resolveExternalTakeRouteIdentity,
} from '../../take/external-take/route-binding';
import type { ExternalTakeRouteIdentity } from '../../take/external-take/route-binding';

function rankExternalTakeQuote(
  evaluation: ExternalTakeQuoteEvaluation
): BigNumber | undefined {
  return (
    evaluation.routeProfitability?.expectedNetProfitQuoteRaw ??
    evaluation.quoteAmountRaw
  );
}

function compareBigNumberDescending(
  left: BigNumber | undefined,
  right: BigNumber | undefined
): number {
  if (!left && !right) {
    return 0;
  }
  if (!left) {
    return 1;
  }
  if (!right) {
    return -1;
  }
  return left.eq(right) ? 0 : left.gt(right) ? -1 : 1;
}

function compareExternalTakeQuoteSelection(
  left: ExternalTakeQuoteEvaluation,
  right: ExternalTakeQuoteEvaluation
): number {
  return compareExternalTakeBySubsidyThenRank(left, right, {
    getQuote: (evaluation) => evaluation,
    compareRank: (leftEvaluation, rightEvaluation) =>
      compareBigNumberDescending(
        rankExternalTakeQuote(leftEvaluation),
        rankExternalTakeQuote(rightEvaluation)
      ),
  });
}

export function sortExternalTakeQuoteEvaluationsForSelection<
  TQuoteEvaluation extends ExternalTakeQuoteEvaluation,
>(params: {
  evaluations: TQuoteEvaluation[];
  externalTakePaths: readonly ExternalTakePathKind[];
}): TQuoteEvaluation[] {
  const pathOrder = new Map<ExternalTakePathKind, number>(
    params.externalTakePaths.map((path, index) => [path, index])
  );
  return [...params.evaluations].sort((left, right) => {
    const policyCompare = compareExternalTakeQuoteSelection(left, right);
    if (policyCompare !== 0) {
      return policyCompare;
    }

    const leftPath = resolveExternalTakeRouteIdentity(left)?.path;
    const rightPath = resolveExternalTakeRouteIdentity(right)?.path;
    const orderCompare =
      (leftPath !== undefined
        ? (pathOrder.get(leftPath) ?? Number.MAX_SAFE_INTEGER)
        : Number.MAX_SAFE_INTEGER) -
      (rightPath !== undefined
        ? (pathOrder.get(rightPath) ?? Number.MAX_SAFE_INTEGER)
        : Number.MAX_SAFE_INTEGER);
    if (orderCompare !== 0) {
      return orderCompare;
    }

    return compareBigNumberDescending(
      left.quoteAmountRaw,
      right.quoteAmountRaw
    );
  });
}

export function selectBestExternalTakeQuoteEvaluation<
  TQuoteEvaluation extends ExternalTakeQuoteEvaluation,
>(params: {
  evaluations: TQuoteEvaluation[];
  externalTakePaths: readonly ExternalTakePathKind[];
}): TQuoteEvaluation | undefined {
  return sortExternalTakeQuoteEvaluationsForSelection(params)[0];
}

export type HybridExternalTakeExecutionSelection =
  | {
      approved: true;
      routeIdentity: ExternalTakeRouteIdentity;
    }
  | {
      approved: false;
      reason: string;
    };

export function resolveHybridExternalTakeExecutionSelection(params: {
  quoteEvaluation?: ExternalTakeQuoteEvaluation;
  resolvedExternalTakePaths: ExternalTakePathKind[];
}): HybridExternalTakeExecutionSelection {
  const route = bindExternalTakeRoute({
    quoteEvaluation: params.quoteEvaluation,
    resolvedExternalTakePaths: params.resolvedExternalTakePaths,
  });
  if (!route.bound) {
    return {
      approved: false,
      reason: formatExternalTakeRouteSelectionFailure(route),
    };
  }
  return {
    approved: true,
    routeIdentity: route.identity,
  };
}
