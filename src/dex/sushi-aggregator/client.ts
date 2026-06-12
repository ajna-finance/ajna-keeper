import axios from 'axios';
import { SushiAggregatorDexConfig } from '../../config';
import {
  DEFAULT_SUSHI_AGGREGATOR_API_BASE_URL,
  DEFAULT_SUSHI_AGGREGATOR_QUOTE_TIMEOUT_MS,
  DEFAULT_SUSHI_AGGREGATOR_SLIPPAGE,
} from '../../config/sushi-aggregator-policy';

/**
 * Sushi same-chain swap API client (Packet 3B). Provider-local: builds the
 * v7 quote request (the chain id is pinned into the URL path, so a response
 * can never describe another chain's route) and returns the raw response
 * for the fail-closed validator. Keyless API; no credentials handled here.
 */
export interface SushiAggregatorQuoteRequest {
  chainId: number;
  tokenIn: string;
  tokenOut: string;
  /** Exact-fill input amount in source-token units. */
  amount: string;
  /** The taker contract: quote sender AND encoded recipient. */
  takerAddress: string;
  maxSlippage?: number;
}

export interface SushiAggregatorQuoteHttpResult {
  status: number;
  data: unknown;
  requestedAtMs: number;
}

export function buildSushiAggregatorQuoteUrl(params: {
  config: SushiAggregatorDexConfig;
  request: SushiAggregatorQuoteRequest;
}): string {
  const base =
    params.config.apiBaseUrl ?? DEFAULT_SUSHI_AGGREGATOR_API_BASE_URL;
  const slippage =
    params.request.maxSlippage ??
    params.config.defaultSlippage ??
    DEFAULT_SUSHI_AGGREGATOR_SLIPPAGE;
  return (
    `${base}/${params.request.chainId}` +
    `?tokenIn=${params.request.tokenIn}` +
    `&tokenOut=${params.request.tokenOut}` +
    `&amount=${params.request.amount}` +
    `&maxSlippage=${slippage}` +
    `&sender=${params.request.takerAddress}` +
    `&recipient=${params.request.takerAddress}`
  );
}

export async function fetchSushiAggregatorQuote(params: {
  config: SushiAggregatorDexConfig;
  request: SushiAggregatorQuoteRequest;
  signal?: AbortSignal;
}): Promise<SushiAggregatorQuoteHttpResult> {
  const url = buildSushiAggregatorQuoteUrl(params);
  const requestedAtMs = Date.now();
  const response = await axios.get(url, {
    timeout:
      params.config.quoteTimeoutMs ?? DEFAULT_SUSHI_AGGREGATOR_QUOTE_TIMEOUT_MS,
    signal: params.signal,
    validateStatus: () => true,
    headers: { accept: 'application/json' },
  });
  return { status: response.status, data: response.data, requestedAtMs };
}

export function isRetryableSushiAggregatorQuoteFailure(
  status: number | undefined
): boolean {
  return (
    status === undefined ||
    status === 429 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}
