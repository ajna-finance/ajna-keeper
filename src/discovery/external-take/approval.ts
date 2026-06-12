import { GasPolicyResult } from '../gas-policy';
import {
  AuctionTakeFacts,
  BoundExternalTakeRouteEvaluation,
  ExternalTakeQuoteEvaluation,
} from '../../take/types';

export const HYBRID_GAS_QUOTE_FALLBACK_KIND =
  'hybrid_gas_quote_fallback' as const;

export interface DiscoveryExternalTakeApprovalContext {
  kind: typeof HYBRID_GAS_QUOTE_FALLBACK_KIND;
}

export const HYBRID_GAS_QUOTE_FALLBACK_CONTEXT: DiscoveryExternalTakeApprovalContext =
  {
    kind: HYBRID_GAS_QUOTE_FALLBACK_KIND,
  };

export interface ExternalTakeApprovalInput extends AuctionTakeFacts {
  price: number;
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  externalTakeApprovalContext?: DiscoveryExternalTakeApprovalContext;
  approvalMode?: DiscoveryExternalTakeApprovalMode;
  countStats?: boolean;
  forceGasRefresh?: boolean;
}

export type ExternalTakeApprovalRejectCategory = 'gasPolicy' | 'profitFloor';
export type DiscoveryExternalTakeApprovalMode =
  | 'strict_hybrid'
  | typeof HYBRID_GAS_QUOTE_FALLBACK_KIND;

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

export function resolveDiscoveryExternalTakeApprovalMode(params: {
  approvalMode?: DiscoveryExternalTakeApprovalMode;
  externalTakeApprovalContext?: DiscoveryExternalTakeApprovalContext;
}): DiscoveryExternalTakeApprovalMode | undefined {
  if (params.approvalMode) {
    return params.approvalMode;
  }
  return params.externalTakeApprovalContext?.kind;
}
