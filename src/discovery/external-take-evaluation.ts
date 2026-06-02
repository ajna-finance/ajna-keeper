import { BigNumber } from 'ethers';
import {
  ExternalTakePathKind,
  LiquiditySource,
  isFactoryDynamicSource,
} from '../config';
import { ExternalTakeQuoteEvaluation } from '../take/types';

export function isOneInchExternalTakeRoute(
  quoteEvaluation: ExternalTakeQuoteEvaluation | undefined
): boolean {
  return (
    quoteEvaluation?.externalTakePath === 'oneinch' ||
    quoteEvaluation?.selectedLiquiditySource === LiquiditySource.ONEINCH
  );
}

export function isFactoryExternalTakeRoute(
  quoteEvaluation: ExternalTakeQuoteEvaluation | undefined
): boolean {
  const source = quoteEvaluation?.selectedLiquiditySource;
  return (
    quoteEvaluation?.externalTakePath === 'factory' ||
    (source !== undefined && isFactoryDynamicSource(source))
  );
}

export function isLifiExternalTakeRoute(
  quoteEvaluation: ExternalTakeQuoteEvaluation | undefined
): boolean {
  return (
    quoteEvaluation?.externalTakePath === 'lifi' ||
    quoteEvaluation?.selectedLiquiditySource === LiquiditySource.LIFI
  );
}

export function resolveExternalTakePathFromEvaluation(
  quoteEvaluation: ExternalTakeQuoteEvaluation | undefined
): ExternalTakePathKind | undefined {
  if (quoteEvaluation?.externalTakePath !== undefined) {
    return quoteEvaluation.externalTakePath;
  }
  const source = quoteEvaluation?.selectedLiquiditySource;
  if (source === LiquiditySource.ONEINCH) {
    return 'oneinch';
  }
  if (source === LiquiditySource.LIFI) {
    return 'lifi';
  }
  return source !== undefined && isFactoryDynamicSource(source)
    ? 'factory'
    : undefined;
}

export function cloneExternalTakeQuoteEvaluation(
  quoteEvaluation: ExternalTakeQuoteEvaluation
): ExternalTakeQuoteEvaluation {
  return {
    ...quoteEvaluation,
    routeProfitability: quoteEvaluation.routeProfitability
      ? { ...quoteEvaluation.routeProfitability }
      : undefined,
    fallbackExternalTakeQuoteEvaluations:
      quoteEvaluation.fallbackExternalTakeQuoteEvaluations?.map(
        cloneExternalTakeQuoteEvaluation
      ),
    curvePool: quoteEvaluation.curvePool
      ? { ...quoteEvaluation.curvePool }
      : undefined,
  };
}

export function withExternalTakeApprovalContext(params: {
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  auctionPrice: BigNumber;
  collateral: BigNumber;
}): ExternalTakeQuoteEvaluation {
  return {
    ...params.quoteEvaluation,
    quotedAuctionPriceWad: params.auctionPrice,
    quotedCollateralWad: params.collateral,
  };
}
