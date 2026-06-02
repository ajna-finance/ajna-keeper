import { BigNumber } from 'ethers';
import {
  ExternalTakePathKind,
  LiquiditySource,
  formatLiquiditySource,
  isFactoryDynamicSource,
} from '../config';
import { compareExternalTakeBySubsidyThenRank } from '../take/external-take-policy';
import { ExternalTakeQuoteEvaluation } from '../take/types';

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

export function sortExternalTakeQuoteEvaluationsForSelection(params: {
  evaluations: ExternalTakeQuoteEvaluation[];
  externalTakePaths: readonly ExternalTakePathKind[];
}): ExternalTakeQuoteEvaluation[] {
  const pathOrder = new Map<ExternalTakePathKind, number>(
    params.externalTakePaths.map((path, index) => [path, index])
  );
  return [...params.evaluations].sort((left, right) => {
    const policyCompare = compareExternalTakeQuoteSelection(left, right);
    if (policyCompare !== 0) {
      return policyCompare;
    }

    const orderCompare =
      (pathOrder.get(left.externalTakePath ?? 'factory') ??
        Number.MAX_SAFE_INTEGER) -
      (pathOrder.get(right.externalTakePath ?? 'factory') ??
        Number.MAX_SAFE_INTEGER);
    if (orderCompare !== 0) {
      return orderCompare;
    }

    return compareBigNumberDescending(
      left.quoteAmountRaw,
      right.quoteAmountRaw
    );
  });
}

export function selectBestExternalTakeQuoteEvaluation(params: {
  evaluations: ExternalTakeQuoteEvaluation[];
  externalTakePaths: readonly ExternalTakePathKind[];
}): ExternalTakeQuoteEvaluation | undefined {
  return sortExternalTakeQuoteEvaluationsForSelection(params)[0];
}

export function resolveHybridExternalTakeExecutionSelection(params: {
  quoteEvaluation?: ExternalTakeQuoteEvaluation;
  allowedExternalTakePaths: ExternalTakePathKind[];
}): {
  approved: boolean;
  effectiveSelectedPath?: ExternalTakePathKind;
  selectedSource?: LiquiditySource;
  reason?: string;
} {
  const selectedPath = params.quoteEvaluation?.externalTakePath;
  const selectedSource = params.quoteEvaluation?.selectedLiquiditySource;
  const sourceSelectedPath =
    selectedSource === LiquiditySource.ONEINCH
      ? 'oneinch'
      : selectedSource === LiquiditySource.LIFI
        ? 'lifi'
        : selectedSource !== undefined && isFactoryDynamicSource(selectedSource)
          ? 'factory'
          : undefined;
  if (
    selectedPath !== undefined &&
    sourceSelectedPath !== undefined &&
    selectedPath !== sourceSelectedPath
  ) {
    return {
      approved: false,
      reason: `selected inconsistent path=${selectedPath} source=${formatLiquiditySource(selectedSource)}`,
    };
  }

  const effectiveSelectedPath = selectedPath ?? sourceSelectedPath;
  if (
    effectiveSelectedPath !== undefined &&
    !params.allowedExternalTakePaths.includes(effectiveSelectedPath)
  ) {
    return {
      approved: false,
      effectiveSelectedPath,
      selectedSource,
      reason: `selected disabled path=${effectiveSelectedPath}`,
    };
  }
  if (effectiveSelectedPath === undefined) {
    return {
      approved: false,
      selectedSource,
      reason: 'hybrid external take selection missing selected path',
    };
  }
  if (
    effectiveSelectedPath === 'factory' &&
    (selectedSource === undefined || !isFactoryDynamicSource(selectedSource))
  ) {
    return {
      approved: false,
      effectiveSelectedPath,
      selectedSource,
      reason: 'selected factory path without a concrete factory source',
    };
  }
  return {
    approved: true,
    effectiveSelectedPath,
    selectedSource,
  };
}
