import axios, { AxiosResponse } from 'axios';
import { ethers } from 'ethers';
import { normalizeLifiApiBaseUrl, validateLifiIntegrator } from './api-policy';
import { getErrorMessage } from '../../utils';
import {
  normalizeLifiExchangeFilters,
  type LifiExchangeFilterConfig,
} from './filters';
import {
  normalizeProductionLifiExchangePolicy,
  type LifiProductionExchangePolicyKind,
  type LifiProductionExchangePolicyConfig,
} from './exchange-policy';
import {
  DEFAULT_LIFI_API_BASE_URL,
  DEFAULT_LIFI_QUOTE_TIMEOUT_MS,
  DEFAULT_LIFI_SLIPPAGE,
  LifiQuoteHttpResult,
  LifiQuoteRequest,
  LifiRateLimitInfo,
} from './schema';

const MAX_LIFI_DECIMAL_POLICY_VALUE = 0.5;

export interface LifiQuoteClientConfig extends LifiExchangeFilterConfig {
  exchangePolicy?: LifiProductionExchangePolicyKind;
  apiBaseUrl?: string;
  defaultSlippage?: number;
  quoteTimeoutMs?: number;
  maxPriceImpact?: number;
  integrator?: string;
}

type ProductionLifiQuoteClientConfig = LifiQuoteClientConfig &
  LifiProductionExchangePolicyConfig;

function requirePositiveChainId(chainId: number): number {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error('LI.FI request.chainId must be a positive integer');
  }
  return chainId;
}

function requireAddress(value: string, label: string): string {
  let normalized: string;
  try {
    normalized = ethers.utils.getAddress(value);
  } catch {
    throw new Error(`${label} must be an address`);
  }
  if (normalized === ethers.constants.AddressZero) {
    throw new Error(`${label} cannot be zero address`);
  }
  return normalized;
}

function requirePositiveDecimalInteger(value: string, label: string): string {
  // Canonical positive integer: no leading zeros, no zero. Mirrors the strict
  // form used by validate-route's requirePositiveAmount so the request and
  // response helpers cannot drift on what counts as a valid amount string.
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${label} must be a positive decimal integer string`);
  }
  return value;
}

function requireLifiDecimalPolicyValue(value: number, label: string): string {
  if (
    !Number.isFinite(value) ||
    value <= 0 ||
    value > MAX_LIFI_DECIMAL_POLICY_VALUE
  ) {
    throw new Error(
      `${label} must be greater than 0 and at most ${MAX_LIFI_DECIMAL_POLICY_VALUE}`
    );
  }
  return String(value);
}

function normalizeLifiQuoteRequest(
  request: LifiQuoteRequest
): LifiQuoteRequest {
  const normalized = {
    ...request,
    chainId: requirePositiveChainId(request.chainId),
    fromToken: requireAddress(request.fromToken, 'LI.FI request.fromToken'),
    toToken: requireAddress(request.toToken, 'LI.FI request.toToken'),
    fromAmount: requirePositiveDecimalInteger(
      request.fromAmount,
      'LI.FI request.fromAmount'
    ),
    fromAddress: requireAddress(
      request.fromAddress,
      'LI.FI request.fromAddress'
    ),
    toAddress: requireAddress(request.toAddress, 'LI.FI request.toAddress'),
  };
  if (normalized.fromAddress !== normalized.toAddress) {
    throw new Error(
      'LI.FI request.fromAddress and toAddress must both be the taker address'
    );
  }
  return normalized;
}

function parseRateLimitHeaders(
  headers: AxiosResponse['headers']
): LifiRateLimitInfo | undefined {
  const limit =
    headers['x-ratelimit-limit'] ??
    headers['x-rate-limit-limit'] ??
    headers['ratelimit-limit'];
  const remaining =
    headers['x-ratelimit-remaining'] ??
    headers['x-rate-limit-remaining'] ??
    headers['ratelimit-remaining'];
  const reset =
    headers['x-ratelimit-reset'] ??
    headers['x-rate-limit-reset'] ??
    headers['ratelimit-reset'];
  const retryAfter = headers['retry-after'];
  if (
    limit === undefined &&
    remaining === undefined &&
    reset === undefined &&
    retryAfter === undefined
  ) {
    return undefined;
  }
  return {
    ...(limit !== undefined ? { limit: String(limit) } : {}),
    ...(remaining !== undefined ? { remaining: String(remaining) } : {}),
    ...(reset !== undefined ? { reset: String(reset) } : {}),
    ...(retryAfter !== undefined ? { retryAfter: String(retryAfter) } : {}),
  };
}

function appendCsvParam(
  params: URLSearchParams,
  name: string,
  values: readonly string[] | undefined
): void {
  if (values !== undefined && values.length > 0) {
    params.set(name, values.join(','));
  }
}

function resolveLifiIntegrator(params: {
  config: LifiQuoteClientConfig;
  request: LifiQuoteRequest;
}): string | undefined {
  if (params.request.integrator !== undefined) {
    return validateLifiIntegrator(
      params.request.integrator,
      'LI.FI request.integrator'
    );
  }
  if (params.config.integrator !== undefined) {
    return validateLifiIntegrator(
      params.config.integrator,
      'dex.lifi.integrator'
    );
  }
  return undefined;
}

export function buildLifiQuoteUrl(params: {
  config: LifiQuoteClientConfig;
  request: LifiQuoteRequest;
}): string {
  const request = normalizeLifiQuoteRequest(params.request);
  const allowExchanges = request.allowExchanges ?? params.config.allowExchanges;
  const denyExchanges = request.denyExchanges ?? params.config.denyExchanges;
  const preferExchanges =
    request.preferExchanges ?? params.config.preferExchanges;
  const filterConfig = {
    ...params.config,
    ...(allowExchanges !== undefined ? { allowExchanges } : {}),
    ...(denyExchanges !== undefined ? { denyExchanges } : {}),
    ...(preferExchanges !== undefined ? { preferExchanges } : {}),
  };
  const filters =
    filterConfig.mode === 'production'
      ? normalizeProductionLifiExchangePolicy({
          config: filterConfig as ProductionLifiQuoteClientConfig,
          fieldName: 'dex.lifi',
        }).filters
      : normalizeLifiExchangeFilters(filterConfig);
  const query = new URLSearchParams();
  query.set('fromChain', String(request.chainId));
  query.set('toChain', String(request.chainId));
  query.set('fromToken', request.fromToken);
  query.set('toToken', request.toToken);
  query.set('fromAmount', request.fromAmount);
  query.set('fromAddress', request.fromAddress);
  query.set('toAddress', request.toAddress);
  query.set(
    'slippage',
    requireLifiDecimalPolicyValue(
      request.slippage ??
        params.config.defaultSlippage ??
        DEFAULT_LIFI_SLIPPAGE,
      'dex.lifi.defaultSlippage'
    )
  );
  query.set('skipSimulation', 'true');
  query.set('allowDestinationCall', 'false');
  query.set('denyBridges', 'all');
  const allowExchangeFilters = (
    filters as { allowExchanges?: readonly string[] }
  ).allowExchanges;
  appendCsvParam(query, 'allowExchanges', allowExchangeFilters);
  appendCsvParam(query, 'denyExchanges', filters.denyExchanges);
  appendCsvParam(query, 'preferExchanges', filters.preferExchanges);
  const maxPriceImpact = request.maxPriceImpact ?? params.config.maxPriceImpact;
  if (maxPriceImpact !== undefined) {
    query.set(
      'maxPriceImpact',
      requireLifiDecimalPolicyValue(maxPriceImpact, 'dex.lifi.maxPriceImpact')
    );
  }
  const integrator = resolveLifiIntegrator({
    config: params.config,
    request,
  });
  if (integrator !== undefined) {
    query.set('integrator', integrator);
  }

  const baseUrl = normalizeLifiApiBaseUrl(
    params.config.apiBaseUrl ?? DEFAULT_LIFI_API_BASE_URL,
    'dex.lifi.apiBaseUrl'
  );
  return `${baseUrl}/quote?${query.toString()}`;
}

export async function fetchLifiQuote(params: {
  config: LifiQuoteClientConfig;
  request: LifiQuoteRequest;
  apiKey?: string;
  signal?: AbortSignal;
}): Promise<LifiQuoteHttpResult> {
  const url = buildLifiQuoteUrl({
    config: params.config,
    request: params.request,
  });
  try {
    const response = await axios.get(url, {
      timeout: params.config.quoteTimeoutMs ?? DEFAULT_LIFI_QUOTE_TIMEOUT_MS,
      signal: params.signal,
      headers: params.apiKey ? { 'x-lifi-api-key': params.apiKey } : undefined,
      validateStatus: () => true,
    });
    if (response.status < 200 || response.status >= 300) {
      const retryable =
        response.status === 429 ||
        response.status === 502 ||
        response.status === 503 ||
        response.status === 504;
      const error = new Error(
        `LI.FI quote request failed status=${response.status}`
      ) as Error & {
        retryable?: boolean;
        status?: number;
        responseBody?: unknown;
      };
      error.retryable = retryable;
      error.status = response.status;
      error.responseBody = response.data;
      throw error;
    }
    return {
      data: response.data,
      status: response.status,
      rateLimit: parseRateLimitHeaders(response.headers),
    };
  } catch (error) {
    if ((error as { status?: number }).status !== undefined) {
      throw error;
    }
    const wrapped = new Error(
      `LI.FI quote request failed: ${getErrorMessage(error)}`
    ) as Error & { retryable?: boolean };
    wrapped.retryable = true;
    throw wrapped;
  }
}

export async function fetchLifiTools(params: {
  config: Pick<LifiQuoteClientConfig, 'apiBaseUrl' | 'quoteTimeoutMs'>;
  apiKey?: string;
  signal?: AbortSignal;
}): Promise<unknown> {
  const baseUrl = normalizeLifiApiBaseUrl(
    params.config.apiBaseUrl ?? DEFAULT_LIFI_API_BASE_URL,
    'dex.lifi.apiBaseUrl'
  );
  const response = await axios.get(`${baseUrl}/tools`, {
    timeout: params.config.quoteTimeoutMs ?? DEFAULT_LIFI_QUOTE_TIMEOUT_MS,
    signal: params.signal,
    headers: params.apiKey ? { 'x-lifi-api-key': params.apiKey } : undefined,
  });
  return response.data;
}
