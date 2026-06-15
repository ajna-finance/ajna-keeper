import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber } from 'ethers';
import { LifiDexConfig, LiquiditySource } from '../../config';
import type { ExternalTakeTakerContractKey } from '../../config';
import { DEFAULT_LIFI_QUOTE_MAX_AGE_MS } from '../../dex/lifi';
import { getErrorMessage, weiToDecimaled } from '../../utils';
import {
  makeCalldataAggregatorProviderRejectionRecorder,
  prepareCalldataAggregatorExecution,
  takeLiquidationCalldataAggregatorProvider,
} from '../aggregator-calldata/execution';
import { ApprovedCalldataAggregatorQuote } from '../aggregator-calldata/types';
import { getExternalTakeExecutionPlanPrimaryEvaluation } from '../external-take/execution-plan';
import { LifiExecutionConfig } from './types';
import { getLifiPathQuoteEvaluation as evaluateLifiPathQuote } from './quote-evaluation';
import {
  getLifiQuoteFailureMetadata,
  getLifiTokenDecimals,
  normalizeApprovedLifiQuote,
  requestValidatedLifiQuote,
  requireProductionLifiConfig,
  resolveLifiChainId,
} from './quote-service';
import { TakeActionConfig, TakeLiquidationPlan } from '../types';

const LIFI_LABEL = 'LI.FI';

export const getLifiPathQuoteEvaluation = evaluateLifiPathQuote;

function getLifiTakerAddress(
  takerContracts:
    | Partial<Record<ExternalTakeTakerContractKey, string>>
    | undefined
): string | undefined {
  return takerContracts?.Lifi;
}

function resolveLifiTakerAddress(params: {
  lifiTaker?: string;
  takerContracts?: Partial<Record<ExternalTakeTakerContractKey, string>>;
}): string | undefined {
  const canonicalTaker = getLifiTakerAddress(params.takerContracts);
  if (
    canonicalTaker &&
    params.lifiTaker &&
    canonicalTaker.toLowerCase() !== params.lifiTaker.toLowerCase()
  ) {
    throw new Error(
      'LI.FI runtime lifiTaker override must match takers.contracts.Lifi'
    );
  }
  return canonicalTaker ?? params.lifiTaker;
}

function getLifiMaxQuoteAgeMs(config: LifiDexConfig): number {
  return config.maxQuoteAgeMs ?? DEFAULT_LIFI_QUOTE_MAX_AGE_MS;
}

async function requestFreshLifiExecutionQuote(params: {
  pool: FungiblePool;
  signer: Signer;
  config: LifiExecutionConfig;
  takerAddress: string;
  chainId: number;
  collateralInTokenDecimals: BigNumber;
}): Promise<ApprovedCalldataAggregatorQuote> {
  try {
    const lifiConfig = requireProductionLifiConfig(params.config.lifi);
    const validated = await requestValidatedLifiQuote({
      pool: params.pool,
      lifiConfig,
      lifiTaker: params.takerAddress,
      chainId: params.chainId,
      collateralInTokenDecimals: params.collateralInTokenDecimals,
      signal: params.config.lifiRequestAbortSignal,
    });
    return normalizeApprovedLifiQuote(validated, params.chainId);
  } catch (error) {
    const failure = getLifiQuoteFailureMetadata(error);
    params.config.onLifiQuoteResult?.({
      success: false,
      retryable: failure.retryable,
      errorCode: failure.code,
      error: getErrorMessage(error),
    });
    throw error;
  }
}

async function prepareLifiExecution(params: {
  pool: FungiblePool;
  signer: Signer;
  poolConfig: TakeActionConfig;
  liquidation: TakeLiquidationPlan;
  config: LifiExecutionConfig;
}) {
  const { pool, signer, poolConfig, liquidation, config } = params;
  return prepareCalldataAggregatorExecution({
    pool,
    signer,
    poolConfig,
    liquidation,
    config,
    providerId: 'lifi',
    label: LIFI_LABEL,
    missingRouterReason: 'LI.FI execution requires keeperTakerRouter',
    missingTakerReason: 'LI.FI execution requires lifiTaker',
    collateralRoundsToZeroReason:
      'LI.FI collateral rounds to zero in token decimals',
    getQuoteEvaluation: async ({ executionCollateralWad }) =>
      getExternalTakeExecutionPlanPrimaryEvaluation(
        liquidation.externalTakeExecutionPlan
      ) ??
      (await getLifiPathQuoteEvaluation(
        pool,
        Number(weiToDecimaled(liquidation.auctionPrice)),
        executionCollateralWad,
        poolConfig,
        config,
        signer,
        liquidation.auctionPrice
      )),
    getTakerAddress: (config) =>
      resolveLifiTakerAddress({ lifiTaker: config.lifiTaker }),
    resolveChainId: resolveLifiChainId,
    getCollateralTokenDecimals: ({ signer, tokenAddress, chainId, cache }) =>
      getLifiTokenDecimals({
        signer,
        tokenAddress,
        chainId,
        cache,
      }),
    requestFreshQuote: requestFreshLifiExecutionQuote,
    getMaxQuoteAgeMs: (config) =>
      getLifiMaxQuoteAgeMs(requireProductionLifiConfig(config.lifi)),
    onQuoteResult: (config, result) => config.onLifiQuoteResult?.(result),
  });
}

export async function takeLiquidationLifi(params: {
  pool: FungiblePool;
  signer: Signer;
  poolConfig: TakeActionConfig;
  liquidation: TakeLiquidationPlan;
  config: LifiExecutionConfig;
}): Promise<boolean> {
  return await takeLiquidationCalldataAggregatorProvider({
    ...params,
    providerId: 'lifi',
    liquiditySource: LiquiditySource.LIFI,
    label: LIFI_LABEL,
    prepareExecution: prepareLifiExecution,
    recordPreparedRejection:
      makeCalldataAggregatorProviderRejectionRecorder<LifiExecutionConfig>({
        onQuoteResult: (c, r) => c.onLifiQuoteResult?.(r),
        onExecutionFailure: (c, r) => c.onLifiExecutionFailure?.(r),
      }),
    onQuoteConsumed: (config) => config.onLifiQuoteResult?.({ success: true }),
    onExecutionFailure: (config, result) =>
      config.onLifiExecutionFailure?.(result),
  });
}

export { getLifiTakerAddress, resolveLifiTakerAddress };
