import { BigNumber } from 'ethers';
import { LifiFeeCostPolicy } from '../../config';

export const DEFAULT_LIFI_API_BASE_URL = 'https://li.quest/v1';
export const DEFAULT_LIFI_SLIPPAGE = 0.005;
export const DEFAULT_LIFI_QUOTE_TIMEOUT_MS = 2_000;
export const DEFAULT_LIFI_QUOTE_MAX_AGE_MS = 30_000;
export const DEFAULT_LIFI_QUOTE_FAILURE_COOLDOWN_MS = 30_000;
export const DEFAULT_LIFI_QUOTE_FAILURE_THRESHOLD = 2;
export const DEFAULT_LIFI_FEE_COST_POLICY: LifiFeeCostPolicy = 'included_only';

export interface LifiQuoteRequest {
  chainId: number;
  fromToken: string;
  toToken: string;
  fromAmount: string;
  fromAddress: string;
  toAddress: string;
  slippage?: number;
  allowExchanges?: readonly string[];
  denyExchanges?: readonly string[];
  preferExchanges?: readonly string[];
  maxPriceImpact?: number;
  integrator?: string;
}

export interface LifiToken {
  address?: unknown;
  chainId?: unknown;
  symbol?: unknown;
  decimals?: unknown;
}

export interface LifiAction {
  fromToken?: LifiToken;
  toToken?: LifiToken;
  fromAmount?: unknown;
  fromChainId?: unknown;
  toChainId?: unknown;
  fromAddress?: unknown;
  toAddress?: unknown;
  destinationCall?: unknown;
}

export interface LifiFeeCost {
  token?: LifiToken;
  amount?: unknown;
  included?: unknown;
  name?: unknown;
}

export interface LifiEstimate {
  approvalAddress?: unknown;
  toAmount?: unknown;
  toAmountMin?: unknown;
  fromAmount?: unknown;
  feeCosts?: unknown;
}

export interface LifiTransactionRequest {
  to?: unknown;
  data?: unknown;
  value?: unknown;
  from?: unknown;
  chainId?: unknown;
  gasLimit?: unknown;
  gasPrice?: unknown;
}

export interface LifiStep {
  type?: unknown;
  tool?: unknown;
  action?: LifiAction;
  estimate?: LifiEstimate;
  includedSteps?: unknown;
}

export interface LifiQuoteResponse extends LifiStep {
  includedSteps?: unknown;
  transactionRequest?: LifiTransactionRequest;
  integrator?: unknown;
  transactionId?: unknown;
}

export interface LifiRateLimitInfo {
  limit?: string;
  remaining?: string;
  reset?: string;
  retryAfter?: string;
}

export interface LifiQuoteHttpResult {
  data: unknown;
  status: number;
  rateLimit?: LifiRateLimitInfo;
}

export interface ApprovedLifiFeeCost {
  source: 'top_level' | 'included_fee_collection_step' | 'included_swap_step';
  token: string;
  amount: string;
  included: true;
  name?: string;
}

export interface ApprovedLifiQuote {
  raw: LifiQuoteResponse;
  quoteAmountRaw: BigNumber;
  routeMinOutRaw: BigNumber;
  amountInTokenUnits: BigNumber;
  srcToken: string;
  dstToken: string;
  dstReceiver: string;
  approvalSpender: string;
  transactionTarget: string;
  transactionRequest: {
    to: string;
    data: string;
    value: string;
    from?: string;
    chainId: number;
    gasLimit?: string;
    gasPrice?: string;
  };
  tool: string;
  topLevelTool?: string;
  feeCosts: ApprovedLifiFeeCost[];
  selector: string;
  quotedAtMs: number;
}
