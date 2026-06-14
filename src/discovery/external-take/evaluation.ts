import { getExpectedQuotedCollateralWad } from '../../take/take-sizing';
import {
  AuctionTakeFacts,
  BoundExternalTakeRouteEvaluation,
  ExternalTakeQuoteEvaluation,
} from '../../take/types';

export {
  bindExternalTakeRoute,
  isCalldataAggregatorExternalTakeRoute,
  isFactoryExternalTakeRoute,
  isOneInchExternalTakeRoute,
  resolveExternalTakePathFromEvaluation,
  resolveExternalTakePathFromSource,
  resolveExternalTakeRouteIdentity,
} from '../../take/external-take/route';
export type {
  ExternalTakeRouteBinding,
  ExternalTakeRouteBindingFailure,
  ExternalTakeRouteIdentity,
} from '../../take/external-take/route';

export function cloneExternalTakeQuoteEvaluation<
  TQuoteEvaluation extends ExternalTakeQuoteEvaluation,
>(quoteEvaluation: TQuoteEvaluation): TQuoteEvaluation {
  return {
    ...quoteEvaluation,
    routeProfitability: quoteEvaluation.routeProfitability
      ? { ...quoteEvaluation.routeProfitability }
      : undefined,
    curvePool: quoteEvaluation.curvePool
      ? { ...quoteEvaluation.curvePool }
      : undefined,
  };
}

export function withExternalTakeApprovalContext<
  TQuoteEvaluation extends BoundExternalTakeRouteEvaluation,
>(
  params: AuctionTakeFacts & { quoteEvaluation: TQuoteEvaluation }
): TQuoteEvaluation {
  return {
    ...params.quoteEvaluation,
    quotedAuctionPriceWad: params.auctionPrice,
    // Aggregator quotes are denominated in the debt-clamped take size, so the
    // re-bound context must use the same path-aware size.
    quotedCollateralWad: getExpectedQuotedCollateralWad({
      externalTakePath: params.quoteEvaluation.externalTakePath,
      collateral: params.collateral,
      auctionPrice: params.auctionPrice,
      debtToCover: params.debtToCover,
    }),
  };
}
