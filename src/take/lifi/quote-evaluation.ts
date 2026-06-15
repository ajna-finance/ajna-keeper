import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber } from 'ethers';
import { LiquiditySource } from '../../config';
import { ApprovedLifiQuote } from '../../dex/lifi';
import { evaluateCalldataAggregatorPathQuote } from '../aggregator-calldata/quote-evaluation';
import { LifiQuoteConfig } from './types';
import {
  getLifiQuoteFailureMetadata,
  getLifiTokenDecimals,
  normalizeApprovedLifiQuote,
  requestValidatedLifiQuote,
  requireProductionLifiConfig,
  resolveLifiChainId,
} from './quote-service';
import { ExternalTakeQuoteEvaluation, TakeActionConfig } from '../types';

function getLifiTopLevelQuoteType(quote: ApprovedLifiQuote): string {
  return typeof quote.raw.type === 'string' && quote.raw.type.trim().length > 0
    ? quote.raw.type.trim().toLowerCase()
    : 'n/a';
}

function getLifiTopLevelQuoteTool(quote: ApprovedLifiQuote): string {
  if (quote.topLevelTool) {
    return quote.topLevelTool;
  }
  return typeof quote.raw.tool === 'string' && quote.raw.tool.trim().length > 0
    ? quote.raw.tool.trim().toLowerCase()
    : 'n/a';
}

export async function getLifiPathQuoteEvaluation(
  pool: FungiblePool,
  price: number,
  collateral: BigNumber,
  poolConfig: TakeActionConfig,
  config: Partial<LifiQuoteConfig>,
  signer: Signer,
  auctionPriceWad?: BigNumber
): Promise<ExternalTakeQuoteEvaluation> {
  return evaluateCalldataAggregatorPathQuote({
    label: 'LI.FI',
    liquiditySource: LiquiditySource.LIFI,
    marketPriceFactorMissingReason: 'LI.FI marketPriceFactor is not configured',
    takerMissingReason: 'LI.FI taker is not configured',
    tokenRoundedToZeroReason:
      'LI.FI collateral rounds to zero in token decimals',
    pool,
    price,
    collateral,
    poolConfig,
    config,
    signer,
    auctionPriceWad,
    prepareConfig: (quoteConfig) =>
      requireProductionLifiConfig(quoteConfig.lifi),
    getTakerAddress: (quoteConfig) => quoteConfig.lifiTaker,
    resolveChainId: resolveLifiChainId,
    getTokenDecimals: getLifiTokenDecimals,
    requestValidatedQuote: async ({
      pool: quotePool,
      config: quoteConfig,
      preparedConfig,
      takerAddress,
      chainId,
      collateralInTokenDecimals,
    }) =>
      await requestValidatedLifiQuote({
        pool: quotePool,
        lifiConfig: preparedConfig,
        lifiTaker: takerAddress,
        chainId,
        collateralInTokenDecimals,
        signal: quoteConfig.lifiRequestAbortSignal,
      }),
    normalizeQuote: normalizeApprovedLifiQuote,
    getFailureMetadata: getLifiQuoteFailureMetadata,
    formatLogFields: ({ preparedConfig, providerQuote }) => [
      `lifiMode=${preparedConfig.mode}`,
      `topLevelType=${getLifiTopLevelQuoteType(providerQuote)}`,
      `topLevelTool=${getLifiTopLevelQuoteTool(providerQuote)}`,
      `effectiveTool=${providerQuote.tool}`,
      `transactionTarget=${providerQuote.transactionRequest.to}`,
    ],
  });
}
