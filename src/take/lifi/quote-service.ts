import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber } from 'ethers';
import { LifiDexConfig } from '../../config';
import {
  ApprovedLifiQuote,
  fetchLifiQuote,
  validateLifiQuote,
} from '../../dex/lifi';
import { normalizeLifiProductionPolicy } from '../../dex/lifi/chain-policy';
import {
  getCachedTokenDecimals,
  resolveExternalTakeChainId,
} from '../external-take/chain';
import { LifiQuoteConfig } from './types';
import { ApprovedCalldataAggregatorQuote } from '../aggregator-calldata/types';

export function getLifiApiKey(
  config: LifiDexConfig | undefined
): string | undefined {
  return config?.apiKeyEnvVar ? process.env[config.apiKeyEnvVar] : undefined;
}

export function getLifiQuoteFailureMetadata(error: unknown): {
  retryable?: boolean;
  code: number | string;
} {
  const typed = error as { retryable?: boolean; status?: number };
  return {
    retryable: typed.retryable ?? false,
    code: typed.status ?? 'exception',
  };
}

export async function getLifiTokenDecimals(params: {
  signer: Signer;
  tokenAddress: string;
  chainId?: number;
  cache?: Map<string, number>;
}): Promise<number> {
  return getCachedTokenDecimals(params);
}

export async function resolveLifiChainId(
  config: Partial<Pick<LifiQuoteConfig, 'chainId'>>,
  signer: Signer
): Promise<number> {
  return resolveExternalTakeChainId(config, signer, 'LI.FI');
}

export function requireProductionLifiConfig(
  config: LifiDexConfig | undefined
): LifiDexConfig & { mode: 'production' } {
  if (!config || config.mode !== 'production') {
    throw new Error('LI.FI production config is required for live quotes');
  }
  return config;
}

export async function requestValidatedLifiQuote(params: {
  pool: FungiblePool;
  lifiConfig: LifiDexConfig;
  lifiTaker: string;
  chainId: number;
  collateralInTokenDecimals: BigNumber;
  signal?: AbortSignal;
}): Promise<ApprovedLifiQuote> {
  const productionConfig = requireProductionLifiConfig(params.lifiConfig);
  const productionPolicy = normalizeLifiProductionPolicy({
    config: productionConfig,
    fieldName: 'LI.FI',
    chainId: params.chainId,
  });
  const chainPolicy = productionPolicy.chains.find(
    (entry) => entry.chainId === params.chainId
  );
  if (!chainPolicy) {
    throw new Error(`LI.FI.callTargetAllowlist.${params.chainId} is required`);
  }
  const result = await fetchLifiQuote({
    config: productionConfig,
    apiKey: getLifiApiKey(productionConfig),
    signal: params.signal,
    request: {
      chainId: params.chainId,
      fromToken: params.pool.collateralAddress,
      toToken: params.pool.quoteAddress,
      fromAmount: params.collateralInTokenDecimals.toString(),
      fromAddress: params.lifiTaker,
      toAddress: params.lifiTaker,
      slippage: productionConfig.defaultSlippage,
      maxPriceImpact: productionConfig.maxPriceImpact,
    },
  });

  return validateLifiQuote({
    quote: result.data,
    chainId: params.chainId,
    fromToken: params.pool.collateralAddress,
    toToken: params.pool.quoteAddress,
    fromAmount: params.collateralInTokenDecimals,
    takerAddress: params.lifiTaker,
    exchangePolicy: productionPolicy.exchangePolicy,
    callTargetAllowlist: chainPolicy.callTargets,
    approvalSpenderAllowlist: chainPolicy.approvalSpenders,
    selectorAllowlist: chainPolicy.selectorAllowlist,
    feeCostPolicy: productionConfig.feeCostPolicy,
  });
}

/**
 * Normalizes the provider-local validated LI.FI quote into the shared
 * calldata-aggregator execution quote (Packet 2B). The raw LI.FI response
 * stays behind in ApprovedLifiQuote for provider diagnostics; everything
 * crossing into route binding, approval, or execution is normalized here.
 */
export function normalizeApprovedLifiQuote(
  quote: ApprovedLifiQuote,
  chainId: number
): ApprovedCalldataAggregatorQuote {
  return {
    providerId: 'lifi',
    quotedAtMs: quote.quotedAtMs,
    chainId,
    srcToken: quote.srcToken,
    dstToken: quote.dstToken,
    dstReceiver: quote.dstReceiver,
    amountInTokenUnits: quote.amountInTokenUnits,
    quoteAmountRaw: quote.quoteAmountRaw,
    routeMinOutRaw: quote.routeMinOutRaw,
    transactionTarget: quote.transactionTarget,
    approvalSpender: quote.approvalSpender,
    callData: quote.transactionRequest.data,
    selector: quote.selector,
    txValue: quote.transactionRequest.value,
    routeSummary: {
      providerId: 'lifi',
      tool: quote.tool,
      ...(quote.topLevelTool ? { topLevelTool: quote.topLevelTool } : {}),
      feeCosts: quote.feeCosts,
    },
  };
}
