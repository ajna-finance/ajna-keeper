import { LiquiditySource } from '../../config';
import {
  GasPolicyRejectCode,
  GasQuoteAttempt,
  ExternalTakeQuoteEvaluation,
} from '../types';

/**
 * Builds the rejection evaluation shape shared by the direct-DEX route
 * prefilter, the gas-policy rejection path, and the route-profitability
 * policy.
 *
 * Two modes, matching the three original literals byte-for-byte:
 * - Fresh route mode (`route` provided): emits a fresh evaluation pinning
 *   `selectedLiquiditySource`/`selectedFeeTier` from the route (both keys
 *   always present, mirroring the index.ts prefilter and gas-policy literals).
 * - Base-spread mode (`base` provided): spreads the existing evaluation and
 *   its `routeProfitability` (mirroring the route-profitability literal).
 */
export function buildRouteRejectionEvaluation(params: {
  reason: string;
  gasPolicyRejectCode?: GasPolicyRejectCode;
  gasQuoteAttempts?: GasQuoteAttempt[];
  base?: ExternalTakeQuoteEvaluation;
  route?: { liquiditySource: LiquiditySource; feeTier?: number };
}): ExternalTakeQuoteEvaluation {
  if (params.route) {
    return {
      isTakeable: false,
      reason: params.reason,
      selectedLiquiditySource: params.route.liquiditySource,
      selectedFeeTier: params.route.feeTier,
      routeProfitability: {
        gasPolicyRejectCode: params.gasPolicyRejectCode,
        gasQuoteAttempts: params.gasQuoteAttempts,
      },
    };
  }

  return {
    ...params.base,
    isTakeable: false,
    reason: params.reason,
    routeProfitability: {
      ...params.base?.routeProfitability,
      gasPolicyRejectCode: params.gasPolicyRejectCode,
      gasQuoteAttempts: params.gasQuoteAttempts,
    },
  };
}
