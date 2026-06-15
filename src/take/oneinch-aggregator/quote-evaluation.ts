import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber } from 'ethers';
import { LiquiditySource } from '../../config';
import { ExternalTakeQuoteEvaluation, TakeActionConfig } from '../types';
import { evaluateCalldataAggregatorPathQuote } from '../aggregator-calldata/quote-evaluation';
import { OneInchAggregatorQuoteConfig } from './types';
import {
  getOneInchAggregatorQuoteFailureMetadata,
  requestValidatedOneInchAggregatorQuote,
  resolveOneInchAggregatorChainId,
} from './quote-service';

export async function getOneInchAggregatorPathQuoteEvaluation(
  pool: FungiblePool,
  price: number,
  collateral: BigNumber,
  poolConfig: TakeActionConfig,
  config: Partial<OneInchAggregatorQuoteConfig>,
  signer: Signer,
  auctionPriceWad?: BigNumber
): Promise<ExternalTakeQuoteEvaluation> {
  return evaluateCalldataAggregatorPathQuote({
    label: '1inch aggregator',
    liquiditySource: LiquiditySource.ONEINCH,
    marketPriceFactorMissingReason: '1inch marketPriceFactor is not configured',
    takerMissingReason: '1inch aggregator taker is not configured',
    tokenRoundedToZeroReason:
      '1inch collateral rounds to zero in token decimals',
    pool,
    price,
    collateral,
    poolConfig,
    config,
    signer,
    auctionPriceWad,
    getTakerAddress: (quoteConfig) => quoteConfig.oneInchAggregatorTaker,
    resolveChainId: resolveOneInchAggregatorChainId,
    requestValidatedQuote: async ({
      pool: quotePool,
      signer: quoteSigner,
      config: quoteConfig,
      takerAddress,
      chainId,
      collateralInTokenDecimals,
    }) =>
      await requestValidatedOneInchAggregatorQuote({
        pool: quotePool,
        signer: quoteSigner,
        config: quoteConfig,
        takerAddress,
        chainId,
        collateralInTokenDecimals,
      }),
    normalizeQuote: (quote) => quote,
    getFailureMetadata: getOneInchAggregatorQuoteFailureMetadata,
  });
}
