import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber } from 'ethers';
import { LiquiditySource } from '../../config';
import { convertWadToTokenDecimals } from '../../erc20';
import { logger } from '../../logging';
import { getErrorMessage } from '../../utils';
import {
  EXTERNAL_TAKE_REJECTION_REASONS,
  mergeRoutePolicyIntoEvaluation,
} from '../external-take/policy';
import { buildExternalTakeQuoteEconomics } from '../external-take/quote-economics';
import { SushiAggregatorQuoteConfig } from './types';
import {
  getSushiAggregatorQuoteFailureMetadata,
  getSushiAggregatorTokenDecimals,
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
  const rejected = (reason: string): ExternalTakeQuoteEvaluation => ({
    isTakeable: false,
    externalTakePath: 'calldata_aggregator',
    selectedLiquiditySource: LiquiditySource.SUSHI_AGGREGATOR,
    reason,
  });
  if (!poolConfig.take.marketPriceFactor) {
    return rejected('Sushi aggregator marketPriceFactor is not configured');
  }
  if (!collateral.gt(0)) {
    return rejected('collateral must be greater than zero');
  }

  try {
    const sushiConfig = requireSushiAggregatorConfig(config.sushiAggregator);
    if (!config.sushiAggregatorTaker) {
      return rejected('Sushi aggregator taker is not configured');
    }
    const chainId = await resolveSushiAggregatorChainId(config, signer);
    const collateralDecimals = await getSushiAggregatorTokenDecimals({
      signer,
      tokenAddress: pool.collateralAddress,
      chainId,
      cache: config.tokenDecimalsCache,
    });
    const collateralInTokenDecimals = convertWadToTokenDecimals(
      collateral,
      collateralDecimals
    );
    if (collateralInTokenDecimals.isZero()) {
      return rejected(
        'Sushi aggregator collateral rounds to zero in token decimals'
      );
    }
    const approvedQuote = await requestValidatedSushiAggregatorQuote({
      pool,
      sushiConfig,
      takerAddress: config.sushiAggregatorTaker,
      chainId,
      collateralInTokenDecimals,
      signal: config.sushiAggregatorRequestAbortSignal,
    });

    const quoteDecimals = await getSushiAggregatorTokenDecimals({
      signer,
      tokenAddress: pool.quoteAddress,
      chainId,
      cache: config.tokenDecimalsCache,
    });
    // Sushi calldata is opaque and cannot be patched with a higher provider
    // min-out. Use the route's encoded floor as the economic quote.
    const executableQuoteAmountRaw = approvedQuote.routeMinOutRaw;
    const economics = await buildExternalTakeQuoteEconomics({
      pool,
      displayAuctionPrice: price,
      auctionPriceWad,
      collateralWad: collateral,
      collateralInTokenDecimals,
      collateralDecimals,
      quoteDecimals,
      quoteAmountRaw: executableQuoteAmountRaw,
      routeMinOutRaw: approvedQuote.routeMinOutRaw,
      marketPriceFactor: poolConfig.take.marketPriceFactor,
      allowSubsidy: poolConfig.take.allowSubsidy,
    });
    const policy = economics.policy;

    logger.info(
      `Sushi aggregator take check for pool ${pool.name}: marketPrice=${economics.marketPrice.toFixed(6)}, takeablePrice=${economics.takeablePrice.toFixed(6)}, auctionPrice=${price.toFixed(6)}, collateral=${economics.collateralAmount}, factor=${poolConfig.take.marketPriceFactor}, expectedOutputRaw=${approvedQuote.quoteAmountRaw.toString()}, routeMinOutRaw=${approvedQuote.routeMinOutRaw.toString()}, approvedMinOutRaw=${policy.approvedMinOutRaw.toString()}, target=${approvedQuote.transactionTarget}, approvalSpender=${approvedQuote.approvalSpender}, selector=${approvedQuote.selector}, rejectionReason=${policy.rejectionReason ?? 'none'} -> ${policy.isEconomicallyExecutable ? 'TAKEABLE' : 'skip'}`
    );

    return mergeRoutePolicyIntoEvaluation({
      evaluation: {
        isTakeable: policy.isEconomicallyExecutable,
        externalTakePath: 'calldata_aggregator',
        marketPrice: economics.marketPrice,
        takeablePrice: economics.takeablePrice,
        quoteAmount: economics.quoteAmount,
        quoteAmountRaw: executableQuoteAmountRaw,
        selectedLiquiditySource: LiquiditySource.SUSHI_AGGREGATOR,
        collateralAmount: economics.collateralAmount,
        quotedCollateralWad: collateral,
        quotedAuctionPriceWad: economics.effectiveAuctionPriceWad,
        calldataQuote: approvedQuote,
        reason: policy.isEconomicallyExecutable
          ? undefined
          : (policy.rejectionReason ??
            EXTERNAL_TAKE_REJECTION_REASONS.auctionPriceAboveThreshold),
      },
      policy,
      auctionRepayRequirementQuoteRaw: economics.quoteAmountDueRaw,
      configuredMarketPriceFactor: poolConfig.take.marketPriceFactor,
      marketFactorFloorQuoteRaw: economics.marketFactorFloorQuoteRaw,
    });
  } catch (error) {
    const failure = getSushiAggregatorQuoteFailureMetadata(error);
    return {
      isTakeable: false,
      externalTakePath: 'calldata_aggregator',
      selectedLiquiditySource: LiquiditySource.SUSHI_AGGREGATOR,
      quoteFailureRetryable: failure.retryable ?? true,
      quoteFailureCode: failure.code,
      reason: getErrorMessage(error),
    };
  }
}
