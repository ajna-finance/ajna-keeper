import { BigNumber, constants } from 'ethers';
import { ExternalTakePathKind } from '../config/schema';
import { isAggregatorExternalTakePath } from '../config/external-take-descriptors';
import { AuctionTakeFacts } from './types';

/**
 * Conservative lower bound of the collateral Ajna's take() will purchase when
 * borrower debt is the binding constraint.
 *
 * Ajna computes the debt-constrained purchase as
 * roundUpToScale(ceilWdiv(debt, (1 - |bpf|) * auctionPrice)), so dividing the
 * debt by the undiscounted auction price and rounding down can only
 * underestimate it. Auction price decays monotonically and debt only accrues
 * interest between planning and inclusion, so a take submitted with
 * maxAmount <= this bound fills exactly maxAmount. Aggregator paths rely on
 * that exact-fill property: LI.FI calldata cannot be re-sized on-chain and the
 * 1inch executor calldata is only reliable at its quoted input size.
 */
export function getDebtConstrainedTakeCollateralWad(
  params: AuctionTakeFacts
): BigNumber {
  if (
    params.debtToCover === undefined ||
    !params.debtToCover.gt(0) ||
    !params.auctionPrice.gt(0)
  ) {
    return params.collateral;
  }
  const debtConstrainedWad = params.debtToCover
    .mul(constants.WeiPerEther)
    .div(params.auctionPrice);
  return debtConstrainedWad.lt(params.collateral)
    ? debtConstrainedWad
    : params.collateral;
}

/**
 * The collateral size a route's quote is expected to be denominated in.
 * Aggregator-category paths (1inch and calldata aggregators such as LI.FI)
 * quote and execute the debt-clamped size; factory paths quote the full
 * collateral and let the taker contract pro-rate the min-out to whatever
 * Ajna actually fills. The non-resizable classification is keyed on the
 * registry's aggregator category, not the calldata_aggregator family alone,
 * so 1inch keeps exact-fill sizing and Packet 3B providers inherit it
 * without touching this module.
 */
export function getExpectedQuotedCollateralWad(
  params: AuctionTakeFacts & {
    externalTakePath: ExternalTakePathKind | undefined;
  }
): BigNumber {
  if (
    params.externalTakePath === undefined ||
    !isAggregatorExternalTakePath(params.externalTakePath)
  ) {
    return params.collateral;
  }
  return getDebtConstrainedTakeCollateralWad(params);
}
