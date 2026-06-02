import { BigNumber } from 'ethers';
import { GasPolicyResult } from './gas-policy';
import { ExternalTakeQuoteEvaluation } from '../take/types';

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

export interface ExternalTakeApprovalResult {
  approved: boolean;
  reason?: string;
  rejectCategory?: ExternalTakeApprovalRejectCategory;
  gasPolicyRejectCode?: GasPolicyResult['rejectCode'];
  gasQuoteAttempts?: GasPolicyResult['gasQuoteAttempts'];
  quoteEvaluation?: ExternalTakeQuoteEvaluation;
}

export type DiscoveryExternalTakeApprover = (
  approvalParams: ExternalTakeApprovalInput
) => Promise<ExternalTakeApprovalResult>;
