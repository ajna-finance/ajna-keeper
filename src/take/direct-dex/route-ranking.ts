import { LiquiditySource } from '../../config';
import { logger } from '../../logging';
import { compareExternalTakeBySubsidyThenRank } from '../external-take/policy';
import { ExternalTakeQuoteEvaluation } from '../types';
import {
  DirectDexQuoteConfig,
  DirectDexRouteCandidate,
} from './route-types';
import { getDefaultDirectDexFeeTierForSource } from './route-candidates';

export interface DirectDexRouteEvaluationResult {
  route: DirectDexRouteCandidate;
  evaluation: ExternalTakeQuoteEvaluation;
}

function compareDirectDexRouteRank(
  left: DirectDexRouteEvaluationResult,
  right: DirectDexRouteEvaluationResult,
  params: {
    defaultLiquiditySource: LiquiditySource;
    config: Pick<DirectDexQuoteConfig, 'uniswapV3RouterOverrides'>;
  }
): number {
  const leftProfit =
    left.evaluation.routeProfitability?.expectedNetProfitQuoteRaw;
  const rightProfit =
    right.evaluation.routeProfitability?.expectedNetProfitQuoteRaw;
  if (!leftProfit || !rightProfit) {
    throw new Error(
      'Direct DEX: takeable route missing expected net profit metadata'
    );
  }
  if (!leftProfit.eq(rightProfit)) {
    return leftProfit.gt(rightProfit) ? -1 : 1;
  }

  if (
    left.route.liquiditySource === params.defaultLiquiditySource &&
    right.route.liquiditySource !== params.defaultLiquiditySource
  ) {
    return -1;
  }
  if (
    left.route.liquiditySource !== params.defaultLiquiditySource &&
    right.route.liquiditySource === params.defaultLiquiditySource
  ) {
    return 1;
  }

  const leftDefaultFeeTier = getDefaultDirectDexFeeTierForSource(
    left.route.liquiditySource,
    params.config
  );
  const rightDefaultFeeTier = getDefaultDirectDexFeeTierForSource(
    right.route.liquiditySource,
    params.config
  );
  const leftUsesDefaultFeeTier =
    leftDefaultFeeTier !== undefined &&
    left.route.feeTier === leftDefaultFeeTier;
  const rightUsesDefaultFeeTier =
    rightDefaultFeeTier !== undefined &&
    right.route.feeTier === rightDefaultFeeTier;
  if (leftUsesDefaultFeeTier !== rightUsesDefaultFeeTier) {
    return leftUsesDefaultFeeTier ? -1 : 1;
  }

  const leftQuote = left.evaluation.quoteAmountRaw;
  const rightQuote = right.evaluation.quoteAmountRaw;
  if (!leftQuote && !rightQuote) {
    return 0;
  }
  if (!leftQuote) {
    return 1;
  }
  if (!rightQuote) {
    return -1;
  }
  if (!leftQuote.eq(rightQuote)) {
    return leftQuote.gt(rightQuote) ? -1 : 1;
  }

  return 0;
}

function compareDirectDexRouteEvaluations(
  left: DirectDexRouteEvaluationResult,
  right: DirectDexRouteEvaluationResult,
  params: {
    defaultLiquiditySource: LiquiditySource;
    config: Pick<DirectDexQuoteConfig, 'uniswapV3RouterOverrides'>;
  }
): number {
  return compareExternalTakeBySubsidyThenRank(left, right, {
    getQuote: (result) => result.evaluation,
    compareRank: (leftResult, rightResult) =>
      compareDirectDexRouteRank(leftResult, rightResult, params),
  });
}

export function selectBestDirectDexRouteEvaluation(params: {
  evaluations: DirectDexRouteEvaluationResult[];
  defaultLiquiditySource: LiquiditySource;
  config: Pick<DirectDexQuoteConfig, 'uniswapV3RouterOverrides'>;
}): DirectDexRouteEvaluationResult | undefined {
  const takeableEvaluations = params.evaluations.filter(({ evaluation }) => {
    if (!evaluation.isTakeable || !evaluation.quoteAmountRaw) {
      return false;
    }
    if (!evaluation.routeProfitability?.expectedNetProfitQuoteRaw) {
      logger.warn(
        'Direct DEX: skipping takeable route missing expected net profit metadata'
      );
      return false;
    }
    return true;
  });

  return takeableEvaluations.sort((left, right) =>
    compareDirectDexRouteEvaluations(left, right, {
      defaultLiquiditySource: params.defaultLiquiditySource,
      config: params.config,
    })
  )[0];
}
