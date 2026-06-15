import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber } from 'ethers';
import { SushiAggregatorDexConfig } from '../../config';
import {
  DEFAULT_SUSHI_AGGREGATOR_MAX_PRICE_IMPACT,
  DEFAULT_SUSHI_AGGREGATOR_SLIPPAGE,
  normalizeSushiAggregatorChainPolicy,
} from '../../config/sushi-aggregator-policy';
import {
  fetchSushiAggregatorQuote,
  isRetryableSushiAggregatorQuoteFailure,
} from '../../dex/sushi-aggregator/client';
import {
  SushiAggregatorRouteValidationError,
  validateSushiAggregatorQuote,
} from '../../dex/sushi-aggregator/validate-route';
import { ApprovedCalldataAggregatorQuote } from '../aggregator-calldata/types';
import {
  getCachedTokenDecimals,
  resolveExternalTakeChainId,
} from '../external-take/chain';
import { SushiAggregatorQuoteConfig } from './types';

export function requireSushiAggregatorConfig(
  config: SushiAggregatorDexConfig | undefined
): SushiAggregatorDexConfig {
  if (!config || config.mode !== 'production') {
    throw new Error(
      'KeeperConfig.dex.sushiAggregator with mode production is required for Sushi aggregator takes'
    );
  }
  return config;
}

export async function resolveSushiAggregatorChainId(
  config: Pick<SushiAggregatorQuoteConfig, 'chainId'>,
  signer: Signer
): Promise<number> {
  return resolveExternalTakeChainId(config, signer, 'Sushi Aggregator');
}

export async function getSushiAggregatorTokenDecimals(params: {
  signer: Signer;
  tokenAddress: string;
  chainId?: number;
  cache?: Map<string, number>;
}): Promise<number> {
  return getCachedTokenDecimals(params);
}

export interface SushiAggregatorQuoteFailureMetadata {
  retryable?: boolean;
  code?: number | string;
}

export function getSushiAggregatorQuoteFailureMetadata(
  error: unknown
): SushiAggregatorQuoteFailureMetadata {
  if (error instanceof SushiAggregatorRouteValidationError) {
    // Local fail-closed validation rejects are not provider health signals.
    return { retryable: false, code: 'route_validation' };
  }
  const status = (error as { response?: { status?: number } })?.response
    ?.status;
  return {
    retryable: isRetryableSushiAggregatorQuoteFailure(status),
    code: status,
  };
}

/**
 * Fetches a Sushi v7 quote for the taker and normalizes it through the
 * fail-closed validator into the shared calldata-aggregator quote. The raw
 * provider response never escapes this provider boundary.
 */
export async function requestValidatedSushiAggregatorQuote(params: {
  pool: FungiblePool;
  sushiConfig: SushiAggregatorDexConfig;
  takerAddress: string;
  chainId: number;
  collateralInTokenDecimals: BigNumber;
  signal?: AbortSignal;
}): Promise<ApprovedCalldataAggregatorQuote> {
  const maxSlippage =
    params.sushiConfig.defaultSlippage ?? DEFAULT_SUSHI_AGGREGATOR_SLIPPAGE;
  const chainPolicy = normalizeSushiAggregatorChainPolicy({
    config: params.sushiConfig,
    fieldName: 'dex.sushiAggregator',
    chainId: params.chainId,
  });
  const result = await fetchSushiAggregatorQuote({
    config: params.sushiConfig,
    signal: params.signal,
    request: {
      chainId: params.chainId,
      tokenIn: params.pool.collateralAddress,
      tokenOut: params.pool.quoteAddress,
      amount: params.collateralInTokenDecimals.toString(),
      takerAddress: params.takerAddress,
      maxSlippage,
    },
  });
  if (result.status !== 200) {
    const error: Error & { response?: { status: number } } = new Error(
      `Sushi aggregator quote failed with HTTP ${result.status}`
    );
    error.response = { status: result.status };
    throw error;
  }
  return validateSushiAggregatorQuote({
    quote: result.data,
    chainId: params.chainId,
    fromToken: params.pool.collateralAddress,
    toToken: params.pool.quoteAddress,
    fromAmount: params.collateralInTokenDecimals,
    takerAddress: params.takerAddress,
    maxSlippage,
    maxPriceImpact:
      params.sushiConfig.maxPriceImpact ??
      DEFAULT_SUSHI_AGGREGATOR_MAX_PRICE_IMPACT,
    chainPolicy,
    quotedAtMs: result.requestedAtMs,
  });
}
