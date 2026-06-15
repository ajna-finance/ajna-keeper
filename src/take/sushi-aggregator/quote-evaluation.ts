import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber } from 'ethers';
import { LiquiditySource } from '../../config';
import { evaluateCalldataAggregatorPathQuote } from '../aggregator-calldata/quote-evaluation';
import { SushiAggregatorQuoteConfig } from './types';
import {
  getSushiAggregatorQuoteFailureMetadata,
  requestValidatedSushiAggregatorQuote,
  requireSushiAggregatorConfig,
  resolveSushiAggregatorChainId,
} from './quote-service';
import { ExternalTakeQuoteEvaluation, TakeActionConfig } from '../types';

export async function getSushiAggregatorPathQuoteEvaluation(
  pool: FungiblePool,
  price: number,
  collateral: BigNumber,
  poolConfig: TakeActionConfig,
  config: Partial<SushiAggregatorQuoteConfig>,
  signer: Signer,
  auctionPriceWad?: BigNumber
): Promise<ExternalTakeQuoteEvaluation> {
  return evaluateCalldataAggregatorPathQuote({
    label: 'Sushi aggregator',
    liquiditySource: LiquiditySource.SUSHI_AGGREGATOR,
    marketPriceFactorMissingReason:
      'Sushi aggregator marketPriceFactor is not configured',
    takerMissingReason: 'Sushi aggregator taker is not configured',
    tokenRoundedToZeroReason:
      'Sushi aggregator collateral rounds to zero in token decimals',
    pool,
    price,
    collateral,
    poolConfig,
    config,
    signer,
    auctionPriceWad,
    prepareConfig: (quoteConfig) =>
      requireSushiAggregatorConfig(quoteConfig.sushiAggregator),
    getTakerAddress: (quoteConfig) => quoteConfig.sushiAggregatorTaker,
    resolveChainId: resolveSushiAggregatorChainId,
    requestValidatedQuote: async ({
      pool: quotePool,
      config: quoteConfig,
      preparedConfig,
      takerAddress,
      chainId,
      collateralInTokenDecimals,
    }) =>
      await requestValidatedSushiAggregatorQuote({
        pool: quotePool,
        sushiConfig: preparedConfig,
        takerAddress,
        chainId,
        collateralInTokenDecimals,
        signal: quoteConfig.sushiAggregatorRequestAbortSignal,
      }),
    normalizeQuote: (quote) => quote,
    getFailureMetadata: getSushiAggregatorQuoteFailureMetadata,
  });
}
