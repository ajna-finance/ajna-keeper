import { BigNumber } from 'ethers';
import { ExternalTakeQuoteEvaluation } from '../take/types';

export {
  bindExternalTakeRoute,
  isFactoryExternalTakeRoute,
  isLifiExternalTakeRoute,
  isOneInchExternalTakeRoute,
  resolveExternalTakePathFromEvaluation,
  resolveExternalTakePathFromSource,
  resolveExternalTakeRouteIdentity,
} from '../take/external-take-route';
export type {
  ExternalTakeRouteBinding,
  ExternalTakeRouteBindingFailure,
  ExternalTakeRouteIdentity,
} from '../take/external-take-route';

export function cloneExternalTakeQuoteEvaluation<
  TQuoteEvaluation extends ExternalTakeQuoteEvaluation,
>(quoteEvaluation: TQuoteEvaluation): TQuoteEvaluation {
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

export function withExternalTakeApprovalContext<
  TQuoteEvaluation extends ExternalTakeQuoteEvaluation,
>(params: {
  quoteEvaluation: TQuoteEvaluation;
  auctionPrice: BigNumber;
  collateral: BigNumber;
}): TQuoteEvaluation {
  return {
    ...params.quoteEvaluation,
    quotedAuctionPriceWad: params.auctionPrice,
    quotedCollateralWad: params.collateral,
  };
}
