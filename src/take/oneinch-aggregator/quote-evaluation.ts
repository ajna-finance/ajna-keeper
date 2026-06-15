import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber, ethers } from 'ethers';
import { LiquiditySource } from '../../config';
import { convertWadToTokenDecimals } from '../../erc20';
import { logger } from '../../logging';
import { decimaledToWei, getErrorMessage } from '../../utils';
import {
  EXTERNAL_TAKE_REJECTION_REASONS,
  applyExternalTakeRoutePolicy,
  mergeRoutePolicyIntoEvaluation,
} from '../external-take/policy';
import * as factoryShared from '../direct-dex/shared';
import { ExternalTakeQuoteEvaluation, TakeActionConfig } from '../types';
import { OneInchAggregatorQuoteConfig } from './types';
import {
  getOneInchAggregatorQuoteFailureMetadata,
  getOneInchAggregatorTokenDecimals,
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
  const rejected = (reason: string): ExternalTakeQuoteEvaluation => ({
    isTakeable: false,
    externalTakePath: 'calldata_aggregator',
    selectedLiquiditySource: LiquiditySource.ONEINCH,
    reason,
  });
  if (!poolConfig.take.marketPriceFactor) {
    return rejected('1inch marketPriceFactor is not configured');
  }
  if (!collateral.gt(0)) {
    return rejected('collateral must be greater than zero');
  }
  if (!config.oneInchAggregatorTaker) {
    return rejected('1inch aggregator taker is not configured');
  }

  try {
    const chainId = await resolveOneInchAggregatorChainId(config, signer);
    const collateralDecimals = await getOneInchAggregatorTokenDecimals({
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
      return rejected('1inch collateral rounds to zero in token decimals');
    }
    const approvedQuote = await requestValidatedOneInchAggregatorQuote({
      pool,
      signer,
      config,
      takerAddress: config.oneInchAggregatorTaker,
      chainId,
      collateralInTokenDecimals,
    });

    const quoteDecimals = await getOneInchAggregatorTokenDecimals({
      signer,
      tokenAddress: pool.quoteAddress,
      chainId,
      cache: config.tokenDecimalsCache,
    });
    // 1inch calldata is opaque and exact-sized in the shared aggregator taker.
    // Use the encoded min-return floor as the executable quote.
    const executableQuoteAmountRaw = approvedQuote.routeMinOutRaw;
    const collateralAmount = Number(
      ethers.utils.formatUnits(collateralInTokenDecimals, collateralDecimals)
    );
    const quoteAmount = Number(
      ethers.utils.formatUnits(executableQuoteAmountRaw, quoteDecimals)
    );
    const marketPrice = quoteAmount / collateralAmount;
    const effectiveAuctionPriceWad = auctionPriceWad ?? decimaledToWei(price);
    const quoteAmountDueRaw = await factoryShared.getQuoteAmountDueRaw(
      pool,
      effectiveAuctionPriceWad,
      collateral
    );
    const marketFactorFloorQuoteRaw = factoryShared.ceilDiv(
      quoteAmountDueRaw.mul(factoryShared.MARKET_FACTOR_SCALE),
      BigNumber.from(
        factoryShared.getMarketPriceFactorUnits(
          poolConfig.take.marketPriceFactor
        )
      )
    );
    const policy = applyExternalTakeRoutePolicy({
      configuredMarketPriceFactor: poolConfig.take.marketPriceFactor,
      allowSubsidy: poolConfig.take.allowSubsidy === true,
      quoteAmountRaw: executableQuoteAmountRaw,
      quoteDueRaw: quoteAmountDueRaw,
      marketFactorFloorQuoteRaw,
      routeMinOutRaw: approvedQuote.routeMinOutRaw,
    });
    const takeablePrice = marketPrice * policy.effectiveMarketPriceFactor;

    logger.info(
      `1inch aggregator take check for pool ${pool.name}: marketPrice=${marketPrice.toFixed(6)}, takeablePrice=${takeablePrice.toFixed(6)}, auctionPrice=${price.toFixed(6)}, collateral=${collateralAmount}, factor=${poolConfig.take.marketPriceFactor}, expectedOutputRaw=${approvedQuote.quoteAmountRaw.toString()}, routeMinOutRaw=${approvedQuote.routeMinOutRaw.toString()}, approvedMinOutRaw=${policy.approvedMinOutRaw.toString()}, target=${approvedQuote.transactionTarget}, approvalSpender=${approvedQuote.approvalSpender}, selector=${approvedQuote.selector}, rejectionReason=${policy.rejectionReason ?? 'none'} -> ${policy.isEconomicallyExecutable ? 'TAKEABLE' : 'skip'}`
    );

    return mergeRoutePolicyIntoEvaluation({
      evaluation: {
        isTakeable: policy.isEconomicallyExecutable,
        externalTakePath: 'calldata_aggregator',
        marketPrice,
        takeablePrice,
        quoteAmount,
        quoteAmountRaw: executableQuoteAmountRaw,
        selectedLiquiditySource: LiquiditySource.ONEINCH,
        collateralAmount,
        quotedCollateralWad: collateral,
        quotedAuctionPriceWad: effectiveAuctionPriceWad,
        calldataQuote: approvedQuote,
        reason: policy.isEconomicallyExecutable
          ? undefined
          : (policy.rejectionReason ??
            EXTERNAL_TAKE_REJECTION_REASONS.auctionPriceAboveThreshold),
      },
      policy,
      auctionRepayRequirementQuoteRaw: quoteAmountDueRaw,
      configuredMarketPriceFactor: poolConfig.take.marketPriceFactor,
      marketFactorFloorQuoteRaw,
    });
  } catch (error) {
    const failure = getOneInchAggregatorQuoteFailureMetadata(error);
    return {
      isTakeable: false,
      externalTakePath: 'calldata_aggregator',
      selectedLiquiditySource: LiquiditySource.ONEINCH,
      quoteFailureRetryable: failure.retryable ?? true,
      quoteFailureCode: failure.code,
      reason: getErrorMessage(error),
    };
  }
}
