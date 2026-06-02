import { BigNumber } from 'ethers';
import { GasPolicyResult } from './gas-policy';
import {
  BoundExternalTakeRouteEvaluation,
  ExternalTakeQuoteEvaluation,
} from '../take/types';

export interface ExternalTakeApprovalInput {
  price: number;
  auctionPrice: BigNumber;
  collateral: BigNumber;
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  approvalMode?: DiscoveryExternalTakeApprovalMode;
  countStats?: boolean;
  forceGasRefresh?: boolean;
}

export type ExternalTakeApprovalRejectCategory = 'gasPolicy' | 'profitFloor';
export type DiscoveryExternalTakeApprovalMode =
  | 'strict_hybrid'
  | 'factory_gas_quote_fallback';

export type ExternalTakeApprovalResult =
  | {
      approved: true;
      quoteEvaluation: BoundExternalTakeRouteEvaluation;
    }
  | {
      approved: false;
      reason?: string;
      rejectCategory?: ExternalTakeApprovalRejectCategory;
      gasPolicyRejectCode?: GasPolicyResult['rejectCode'];
      gasQuoteAttempts?: GasPolicyResult['gasQuoteAttempts'];
    };

export type DiscoveryExternalTakeApprover = (
  approvalParams: ExternalTakeApprovalInput
) => Promise<ExternalTakeApprovalResult>;
