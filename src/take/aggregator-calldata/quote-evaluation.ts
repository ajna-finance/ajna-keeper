import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber } from 'ethers';
import {
  CalldataAggregatorLiquiditySource,
  resolveCalldataAggregatorProviderForSource,
} from '../../config';
import { convertWadToTokenDecimals } from '../../erc20';
import { logger } from '../../logging';
import { getErrorMessage } from '../../utils';
import { getCachedTokenDecimals } from '../external-take/chain';
import {
  EXTERNAL_TAKE_REJECTION_REASONS,
  ExternalTakeRoutePolicyResult,
  mergeRoutePolicyIntoEvaluation,
} from '../external-take/policy';
import {
  buildExternalTakeQuoteEconomics,
  ExternalTakeQuoteEconomics,
} from '../external-take/quote-economics';
import { ExternalTakeQuoteEvaluation, TakeActionConfig } from '../types';
import { ApprovedCalldataAggregatorQuote } from './types';

interface CalldataAggregatorProviderQuote {
  quoteAmountRaw: BigNumber;
  routeMinOutRaw: BigNumber;
}

interface CalldataAggregatorQuoteConfigBase {
  tokenDecimalsCache?: Map<string, number>;
}

export interface CalldataAggregatorQuoteFailureMetadata {
  retryable?: boolean;
  code?: number | string;
}

export interface CalldataAggregatorQuoteLogContext<
  TPreparedConfig,
  TProviderQuote extends CalldataAggregatorProviderQuote,
> {
  pool: FungiblePool;
  poolConfig: TakeActionConfig;
  price: number;
  preparedConfig: TPreparedConfig;
  providerQuote: TProviderQuote;
  calldataQuote: ApprovedCalldataAggregatorQuote;
  economics: ExternalTakeQuoteEconomics;
  policy: ExternalTakeRoutePolicyResult;
}

export interface CalldataAggregatorPathQuoteEvaluationParams<
  TConfig extends CalldataAggregatorQuoteConfigBase,
  TPreparedConfig,
  TProviderQuote extends CalldataAggregatorProviderQuote,
> {
  label: string;
  liquiditySource: CalldataAggregatorLiquiditySource;
  marketPriceFactorMissingReason: string;
  takerMissingReason: string;
  tokenRoundedToZeroReason: string;
  pool: FungiblePool;
  price: number;
  collateral: BigNumber;
  poolConfig: TakeActionConfig;
  config: Partial<TConfig>;
  signer: Signer;
  auctionPriceWad?: BigNumber;
  prepareConfig?: (
    config: Partial<TConfig>
  ) => TPreparedConfig | Promise<TPreparedConfig>;
  getTakerAddress: (
    config: Partial<TConfig>,
    preparedConfig: TPreparedConfig
  ) => string | undefined;
  resolveChainId: (config: Partial<TConfig>, signer: Signer) => Promise<number>;
  requestValidatedQuote: (params: {
    pool: FungiblePool;
    signer: Signer;
    config: Partial<TConfig>;
    preparedConfig: TPreparedConfig;
    takerAddress: string;
    chainId: number;
    collateralInTokenDecimals: BigNumber;
  }) => Promise<TProviderQuote>;
  normalizeQuote: (
    quote: TProviderQuote,
    chainId: number
  ) => ApprovedCalldataAggregatorQuote;
  getFailureMetadata: (
    error: unknown
  ) => CalldataAggregatorQuoteFailureMetadata;
  formatLogFields?: (
    context: CalldataAggregatorQuoteLogContext<TPreparedConfig, TProviderQuote>
  ) => readonly string[];
}

export async function evaluateCalldataAggregatorPathQuote<
  TConfig extends CalldataAggregatorQuoteConfigBase,
  TPreparedConfig = undefined,
  TProviderQuote extends
    CalldataAggregatorProviderQuote = ApprovedCalldataAggregatorQuote,
>(
  params: CalldataAggregatorPathQuoteEvaluationParams<
    TConfig,
    TPreparedConfig,
    TProviderQuote
  >
): Promise<ExternalTakeQuoteEvaluation> {
  const rejected = (
    reason: string,
    extra: Partial<ExternalTakeQuoteEvaluation> = {}
  ): ExternalTakeQuoteEvaluation => ({
    isTakeable: false,
    externalTakePath: 'calldata_aggregator',
    selectedLiquiditySource: params.liquiditySource,
    reason,
    ...extra,
  });

  if (!params.poolConfig.take.marketPriceFactor) {
    return rejected(params.marketPriceFactorMissingReason);
  }
  if (!params.collateral.gt(0)) {
    return rejected('collateral must be greater than zero');
  }

  try {
    const preparedConfig = params.prepareConfig
      ? await params.prepareConfig(params.config)
      : (undefined as TPreparedConfig);
    const takerAddress = params.getTakerAddress(params.config, preparedConfig);
    if (!takerAddress) {
      return rejected(params.takerMissingReason);
    }

    const chainId = await params.resolveChainId(params.config, params.signer);
    const collateralDecimals = await getCachedTokenDecimals({
      signer: params.signer,
      tokenAddress: params.pool.collateralAddress,
      chainId,
      cache: params.config.tokenDecimalsCache,
    });
    const collateralInTokenDecimals = convertWadToTokenDecimals(
      params.collateral,
      collateralDecimals
    );
    if (collateralInTokenDecimals.isZero()) {
      return rejected(params.tokenRoundedToZeroReason);
    }

    const providerQuote = await params.requestValidatedQuote({
      pool: params.pool,
      signer: params.signer,
      config: params.config,
      preparedConfig,
      takerAddress,
      chainId,
      collateralInTokenDecimals,
    });
    const calldataQuote = params.normalizeQuote(providerQuote, chainId);
    const expectedProviderId = resolveCalldataAggregatorProviderForSource(
      params.liquiditySource
    );
    if (
      expectedProviderId === undefined ||
      calldataQuote.providerId !== expectedProviderId
    ) {
      return rejected(
        `${params.label} quote providerId ${calldataQuote.providerId} does not match source ${params.liquiditySource}`
      );
    }

    const quoteDecimals = await getCachedTokenDecimals({
      signer: params.signer,
      tokenAddress: params.pool.quoteAddress,
      chainId,
      cache: params.config.tokenDecimalsCache,
    });
    const executableQuoteAmountRaw = calldataQuote.routeMinOutRaw;
    const economics = await buildExternalTakeQuoteEconomics({
      pool: params.pool,
      displayAuctionPrice: params.price,
      auctionPriceWad: params.auctionPriceWad,
      collateralWad: params.collateral,
      collateralInTokenDecimals,
      collateralDecimals,
      quoteDecimals,
      quoteAmountRaw: executableQuoteAmountRaw,
      routeMinOutRaw: calldataQuote.routeMinOutRaw,
      marketPriceFactor: params.poolConfig.take.marketPriceFactor,
      allowSubsidy: params.poolConfig.take.allowSubsidy,
    });
    const policy = economics.policy;
    const providerLogFields =
      params.formatLogFields?.({
        pool: params.pool,
        poolConfig: params.poolConfig,
        price: params.price,
        preparedConfig,
        providerQuote,
        calldataQuote,
        economics,
        policy,
      }) ?? [];

    logger.info(
      `${params.label} take check for pool ${params.pool.name}: ${[
        `marketPrice=${economics.marketPrice.toFixed(6)}`,
        `takeablePrice=${economics.takeablePrice.toFixed(6)}`,
        `auctionPrice=${params.price.toFixed(6)}`,
        `collateral=${economics.collateralAmount}`,
        `factor=${params.poolConfig.take.marketPriceFactor}`,
        ...providerLogFields,
        `expectedOutputRaw=${providerQuote.quoteAmountRaw.toString()}`,
        `routeMinOutRaw=${providerQuote.routeMinOutRaw.toString()}`,
        `approvedMinOutRaw=${policy.approvedMinOutRaw.toString()}`,
        `target=${calldataQuote.transactionTarget}`,
        `approvalSpender=${calldataQuote.approvalSpender}`,
        `selector=${calldataQuote.selector}`,
        `rejectionReason=${policy.rejectionReason ?? 'none'}`,
      ].join(', ')} -> ${policy.isEconomicallyExecutable ? 'TAKEABLE' : 'skip'}`
    );

    return mergeRoutePolicyIntoEvaluation({
      evaluation: {
        isTakeable: policy.isEconomicallyExecutable,
        externalTakePath: 'calldata_aggregator',
        providerId: calldataQuote.providerId,
        marketPrice: economics.marketPrice,
        takeablePrice: economics.takeablePrice,
        quoteAmount: economics.quoteAmount,
        quoteAmountRaw: executableQuoteAmountRaw,
        selectedLiquiditySource: params.liquiditySource,
        collateralAmount: economics.collateralAmount,
        quotedCollateralWad: params.collateral,
        quotedAuctionPriceWad: economics.effectiveAuctionPriceWad,
        calldataQuote,
        reason: policy.isEconomicallyExecutable
          ? undefined
          : (policy.rejectionReason ??
            EXTERNAL_TAKE_REJECTION_REASONS.auctionPriceAboveThreshold),
      },
      policy,
      auctionRepayRequirementQuoteRaw: economics.quoteAmountDueRaw,
      configuredMarketPriceFactor: params.poolConfig.take.marketPriceFactor,
      marketFactorFloorQuoteRaw: economics.marketFactorFloorQuoteRaw,
    });
  } catch (error) {
    const failure = params.getFailureMetadata(error);
    return rejected(getErrorMessage(error), {
      quoteFailureRetryable: failure.retryable ?? true,
      quoteFailureCode: failure.code,
    });
  }
}
