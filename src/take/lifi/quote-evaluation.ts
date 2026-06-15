import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber } from 'ethers';
import { LiquiditySource } from '../../config';
import { ApprovedLifiQuote } from '../../dex/lifi';
import { convertWadToTokenDecimals } from '../../erc20';
import { logger } from '../../logging';
import { getErrorMessage } from '../../utils';
import {
  EXTERNAL_TAKE_REJECTION_REASONS,
  mergeRoutePolicyIntoEvaluation,
} from '../external-take/policy';
import { buildExternalTakeQuoteEconomics } from '../external-take/quote-economics';
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
  if (!poolConfig.take.marketPriceFactor) {
    return {
      isTakeable: false,
      externalTakePath: 'calldata_aggregator',
      selectedLiquiditySource: LiquiditySource.LIFI,
      reason: 'LI.FI marketPriceFactor is not configured',
    };
  }
  if (!collateral.gt(0)) {
    return {
      isTakeable: false,
      externalTakePath: 'calldata_aggregator',
      selectedLiquiditySource: LiquiditySource.LIFI,
      reason: 'collateral must be greater than zero',
    };
  }

  try {
    const lifiConfig = requireProductionLifiConfig(config.lifi);
    if (!config.lifiTaker) {
      return {
        isTakeable: false,
        externalTakePath: 'calldata_aggregator',
        selectedLiquiditySource: LiquiditySource.LIFI,
        reason: 'LI.FI taker is not configured',
      };
    }
    const chainId = await resolveLifiChainId(config, signer);
    const collateralDecimals = await getLifiTokenDecimals({
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
      return {
        isTakeable: false,
        externalTakePath: 'calldata_aggregator',
        selectedLiquiditySource: LiquiditySource.LIFI,
        reason: 'LI.FI collateral rounds to zero in token decimals',
      };
    }
    const approvedQuote = await requestValidatedLifiQuote({
      pool,
      lifiConfig,
      lifiTaker: config.lifiTaker,
      chainId,
      collateralInTokenDecimals,
      signal: config.lifiRequestAbortSignal,
    });

    const quoteDecimals = await getLifiTokenDecimals({
      signer,
      tokenAddress: pool.quoteAddress,
      chainId,
      cache: config.tokenDecimalsCache,
    });
    // LI.FI calldata is opaque and cannot be patched with a higher provider
    // min-out. Use the provider's post-fee floor as the economic quote.
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
      `LI.FI take check for pool ${pool.name}: marketPrice=${economics.marketPrice.toFixed(6)}, takeablePrice=${economics.takeablePrice.toFixed(6)}, auctionPrice=${price.toFixed(6)}, collateral=${economics.collateralAmount}, factor=${poolConfig.take.marketPriceFactor}, lifiMode=${lifiConfig.mode}, topLevelType=${getLifiTopLevelQuoteType(approvedQuote)}, topLevelTool=${getLifiTopLevelQuoteTool(approvedQuote)}, effectiveTool=${approvedQuote.tool}, expectedOutputRaw=${approvedQuote.quoteAmountRaw.toString()}, routeMinOutRaw=${approvedQuote.routeMinOutRaw.toString()}, approvedMinOutRaw=${policy.approvedMinOutRaw.toString()}, target=${approvedQuote.transactionTarget}, transactionTarget=${approvedQuote.transactionRequest.to}, approvalSpender=${approvedQuote.approvalSpender}, selector=${approvedQuote.selector}, rejectionReason=${policy.rejectionReason ?? 'none'} -> ${policy.isEconomicallyExecutable ? 'TAKEABLE' : 'skip'}`
    );

    return mergeRoutePolicyIntoEvaluation({
      evaluation: {
        isTakeable: policy.isEconomicallyExecutable,
        externalTakePath: 'calldata_aggregator',
        marketPrice: economics.marketPrice,
        takeablePrice: economics.takeablePrice,
        quoteAmount: economics.quoteAmount,
        quoteAmountRaw: executableQuoteAmountRaw,
        selectedLiquiditySource: LiquiditySource.LIFI,
        collateralAmount: economics.collateralAmount,
        quotedCollateralWad: collateral,
        quotedAuctionPriceWad: economics.effectiveAuctionPriceWad,
        calldataQuote: normalizeApprovedLifiQuote(approvedQuote, chainId),
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
    const failure = getLifiQuoteFailureMetadata(error);
    return {
      isTakeable: false,
      externalTakePath: 'calldata_aggregator',
      selectedLiquiditySource: LiquiditySource.LIFI,
      quoteFailureRetryable: failure.retryable ?? true,
      quoteFailureCode: failure.code,
      reason: getErrorMessage(error),
    };
  }
}
