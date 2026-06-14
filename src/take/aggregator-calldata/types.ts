import { BigNumber } from 'ethers';
import { CalldataAggregatorProviderId } from '../../config/schema';

/**
 * Shared offchain calldata-aggregator quote contract (SushiSwap aggregator
 * roadmap, Packet 2B). ApprovedCalldataAggregatorQuote is the ONLY
 * execution-facing quote shape for calldata aggregators: provider adapters
 * (LI.FI today) parse their raw API responses locally and normalize into
 * this shape before route binding or approval. Raw provider responses must
 * never cross into execution approval — keep them in provider diagnostics,
 * recorded fixtures, or telemetry envelopes.
 *
 * Field shape is frozen from the Packet 2A route-shape evidence (the
 * tooling-only evidence directory) and the live LI.FI execution surface, and
 * was reviewed against 1inch's request shape (router target + opaque
 * exact-fill calldata + single approval spender) so a future `oneinch`
 * provider id is not structurally precluded (roadmap Packet 5 candidate).
 */
export interface CalldataAggregatorFeeCost {
  source: 'top_level' | 'included_fee_collection_step' | 'included_swap_step';
  token: string;
  amount: string;
  included: true;
  name?: string;
}

/**
 * The only shared route-summary shape for calldata aggregators: typed,
 * normalized, execution-independent telemetry and source-filter data. No raw
 * provider responses, untyped blobs, or fields execution approval needs to
 * interpret.
 */
export interface CalldataAggregatorRouteSummary {
  providerId: CalldataAggregatorProviderId;
  /** Effective tool/exchange label reported by the provider. */
  tool: string;
  /** Top-level provider tool label when it differs from the step tool. */
  topLevelTool?: string;
  /** Normalized included fee/cost rows needed for comparison. */
  feeCosts: CalldataAggregatorFeeCost[];
  /** Provider warnings as stable strings, if any. */
  warnings?: string[];
}

export interface ApprovedCalldataAggregatorQuote {
  providerId: CalldataAggregatorProviderId;
  /** Provider quote timestamp (ms) used by execution freshness checks. */
  quotedAtMs: number;
  chainId: number;
  srcToken: string;
  dstToken: string;
  dstReceiver: string;
  /** Exact-fill input amount in source-token units. */
  amountInTokenUnits: BigNumber;
  /** Expected output in quote-token raw units. */
  quoteAmountRaw: BigNumber;
  /** Route-minimum output in quote-token raw units. */
  routeMinOutRaw: BigNumber;
  /** Allowlisted execution call target. */
  transactionTarget: string;
  /** Allowlisted approval spender for the source token. */
  approvalSpender: string;
  /** Opaque provider calldata executed by the taker. */
  callData: string;
  /** 4-byte selector of callData, validated against the taker allowlist. */
  selector: string;
  /** Native value of the provider transaction; '0' for ERC20-input takes. */
  txValue: string;
  routeSummary: CalldataAggregatorRouteSummary;
}
