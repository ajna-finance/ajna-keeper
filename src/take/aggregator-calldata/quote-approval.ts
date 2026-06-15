import { LiquiditySource } from '../../config';
import {
  CalldataAggregatorProviderId,
  getAggregatorProviderIdentity,
} from '../../config';
import { deriveApprovedMinOutRaw } from '../external-take/quote-economics';
import {
  ApprovedCalldataAggregatorQuoteEvaluation,
  ExternalTakeQuoteEvaluation,
} from '../types';

export type CalldataAggregatorQuoteApprovalResult =
  | {
      approved: true;
      quoteEvaluation: ApprovedCalldataAggregatorQuoteEvaluation;
    }
  | { approved: false; reason: string };

function deriveRouteExecutionFloorRaw(
  quoteEvaluation: ExternalTakeQuoteEvaluation
): ExternalTakeQuoteEvaluation['routeExecutionFloorRaw'] {
  return (
    quoteEvaluation.routeExecutionFloorRaw ??
    deriveApprovedMinOutRaw({
      routeMinOutRaw: quoteEvaluation.routeMinOutRaw,
      profitMinOutRaw: quoteEvaluation.profitMinOutRaw,
      fallbackMinOutRaw: quoteEvaluation.approvedMinOutRaw,
    })
  );
}

/**
 * The single calldata-aggregator execution approval helper (Packet 2B).
 * Validates the canonical path, the expected provider id, the provider's
 * liquidity source, takeability, the raw quote amount, the min-out floor,
 * and the normalized calldataQuote before execution. Provider wrappers must
 * not clone this into provider-specific approval helpers.
 */
export function approveCalldataAggregatorQuoteForExecution(params: {
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  providerId: CalldataAggregatorProviderId;
  poolName: string;
  borrower: string;
}): CalldataAggregatorQuoteApprovalResult {
  const { quoteEvaluation, providerId, poolName, borrower } = params;
  const identity = getAggregatorProviderIdentity(providerId);
  const label = identity.label;
  const context = `${poolName}/${borrower}`;

  if (!quoteEvaluation.isTakeable) {
    return {
      approved: false,
      reason: `${label} quote no longer satisfies execution policy for ${context}: ${quoteEvaluation.reason ?? 'not takeable'}`,
    };
  }
  if (!quoteEvaluation.quoteAmountRaw) {
    return {
      approved: false,
      reason: `${label} quote is missing raw quote amount for ${context}`,
    };
  }
  if (quoteEvaluation.externalTakePath !== 'calldata_aggregator') {
    return {
      approved: false,
      reason: `${label} execution received a non-calldata-aggregator approved path for ${context}`,
    };
  }
  if (quoteEvaluation.selectedLiquiditySource !== identity.liquiditySource) {
    return {
      approved: false,
      reason: `${label} execution received an unexpected approved source for ${context}`,
    };
  }
  if (!quoteEvaluation.calldataQuote) {
    return {
      approved: false,
      reason: `${label} execution is missing validated route details for ${context}`,
    };
  }
  if (quoteEvaluation.calldataQuote.providerId !== providerId) {
    return {
      approved: false,
      reason: `${label} execution received a quote from provider ${quoteEvaluation.calldataQuote.providerId} for ${context}`,
    };
  }
  const approvedMinOutRaw = deriveRouteExecutionFloorRaw(quoteEvaluation);
  if (!approvedMinOutRaw) {
    return {
      approved: false,
      reason: `${label} execution is missing approved min-out floor for ${context}`,
    };
  }
  return {
    approved: true,
    quoteEvaluation: {
      ...quoteEvaluation,
      isTakeable: true,
      externalTakePath: 'calldata_aggregator',
      providerId,
      quoteAmountRaw: quoteEvaluation.quoteAmountRaw,
      selectedLiquiditySource: identity.liquiditySource,
      routeExecutionFloorRaw:
        quoteEvaluation.routeExecutionFloorRaw ?? approvedMinOutRaw,
      approvedMinOutRaw,
      calldataQuote: quoteEvaluation.calldataQuote,
    },
  };
}
