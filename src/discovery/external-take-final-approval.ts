import { FungiblePool } from '@ajna-finance/sdk';
import { BigNumber } from 'ethers';
import {
  BoundExternalTakeRouteEvaluation,
  ExternalTakeQuoteEvaluation,
  TakeLiquidationPlan,
} from '../take/types';
import { TakeAuctionStatusReader } from '../take/liquidation-status';
import { getErrorMessage, weiToDecimaled } from '../utils';
import {
  DiscoveryExternalTakeApprovalContext,
  DiscoveryExternalTakeApprover,
  ExternalTakeApprovalResult,
} from './external-take-approval';
import { withExternalTakeApprovalContext } from './external-take-evaluation';

export async function reapproveDiscoveryExternalTakeForAuction(params: {
  approveExternalTake: DiscoveryExternalTakeApprover;
  price?: number;
  auctionPrice: BigNumber;
  collateral: BigNumber;
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  externalTakeApprovalContext?: DiscoveryExternalTakeApprovalContext;
  countStats?: boolean;
  forceGasRefresh?: boolean;
}): Promise<ExternalTakeApprovalResult> {
  const approval = await params.approveExternalTake({
    price: params.price ?? Number(weiToDecimaled(params.auctionPrice)),
    auctionPrice: params.auctionPrice,
    collateral: params.collateral,
    quoteEvaluation: params.quoteEvaluation,
    externalTakeApprovalContext: params.externalTakeApprovalContext,
    countStats: params.countStats,
    forceGasRefresh: params.forceGasRefresh,
  });
  if (!approval.approved) {
    return approval;
  }
  return {
    ...approval,
    quoteEvaluation: withExternalTakeApprovalContext({
      quoteEvaluation: approval.quoteEvaluation,
      auctionPrice: params.auctionPrice,
      collateral: params.collateral,
    }),
  };
}

export type RefreshedDiscoveryExternalTakeApproval =
  | {
      approved: true;
      liquidation: TakeLiquidationPlan<DiscoveryExternalTakeApprovalContext>;
      quoteEvaluation: BoundExternalTakeRouteEvaluation;
    }
  | {
      approved: false;
      kind: 'auction_refresh_failed' | 'approval_rejected';
      reason: string;
    };

export async function refreshAndReapproveDiscoveryExternalTake(params: {
  pool: FungiblePool;
  takeAuctionStatusReader: TakeAuctionStatusReader;
  liquidation: TakeLiquidationPlan<DiscoveryExternalTakeApprovalContext>;
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  externalTakeApprovalContext?: DiscoveryExternalTakeApprovalContext;
  approveExternalTake: DiscoveryExternalTakeApprover;
  countStats?: boolean;
  forceGasRefresh?: boolean;
}): Promise<RefreshedDiscoveryExternalTakeApproval> {
  let refreshedStatus;
  try {
    refreshedStatus = await params.takeAuctionStatusReader.read({
      pool: params.pool,
      borrower: params.liquidation.borrower,
    });
  } catch (error) {
    return {
      approved: false,
      kind: 'auction_refresh_failed',
      reason: getErrorMessage(error),
    };
  }

  const liquidation = {
    ...params.liquidation,
    auctionPrice: refreshedStatus.auctionPrice,
    collateral: refreshedStatus.collateral,
  };
  const approval = await reapproveDiscoveryExternalTakeForAuction({
    approveExternalTake: params.approveExternalTake,
    auctionPrice: liquidation.auctionPrice,
    collateral: liquidation.collateral,
    quoteEvaluation: params.quoteEvaluation,
    externalTakeApprovalContext: params.externalTakeApprovalContext,
    countStats: params.countStats,
    forceGasRefresh: params.forceGasRefresh,
  });
  if (!approval.approved) {
    return {
      approved: false,
      kind: 'approval_rejected',
      reason: approval.reason ?? 'policy rejected fallback path',
    };
  }
  return {
    approved: true,
    liquidation,
    quoteEvaluation: approval.quoteEvaluation,
  };
}
