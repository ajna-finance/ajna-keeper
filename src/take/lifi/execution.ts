import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { LifiDexConfig } from '../../config';
import type { ExternalTakeTakerContractKey } from '../../config';
import { DEFAULT_LIFI_QUOTE_MAX_AGE_MS } from '../../dex/lifi';
import {
  prepareCalldataAggregatorExecution,
  takeLiquidationCalldataAggregatorProvider,
} from '../aggregator-calldata/execution';
import { LifiExecutionConfig } from './types';
import { getLifiPathQuoteEvaluation } from './quote-evaluation';
import {
  getLifiQuoteFailureMetadata,
  normalizeApprovedLifiQuote,
  requestValidatedLifiQuote,
  requireProductionLifiConfig,
  resolveLifiChainId,
} from './quote-service';
import { TakeActionConfig, TakeLiquidationPlan } from '../types';

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
    missingRouterReason: 'LI.FI execution requires keeperTakerRouter',
    missingTakerReason: 'LI.FI execution requires lifiTaker',
    collateralRoundsToZeroReason:
      'LI.FI collateral rounds to zero in token decimals',
    getPathQuoteEvaluation: getLifiPathQuoteEvaluation,
    getTakerAddress: (config) =>
      resolveLifiTakerAddress({ lifiTaker: config.lifiTaker }),
    resolveChainId: resolveLifiChainId,
    requestValidatedQuote: async ({
      pool,
      config,
      takerAddress,
      chainId,
      collateralInTokenDecimals,
    }) => {
      const lifiConfig = requireProductionLifiConfig(config.lifi);
      const validated = await requestValidatedLifiQuote({
        pool,
        lifiConfig,
        lifiTaker: takerAddress,
        chainId,
        collateralInTokenDecimals,
        signal: config.lifiRequestAbortSignal,
      });
      return normalizeApprovedLifiQuote(validated, chainId);
    },
    getFailureMetadata: getLifiQuoteFailureMetadata,
    getMaxQuoteAgeMs: (config) =>
      getLifiMaxQuoteAgeMs(requireProductionLifiConfig(config.lifi)),
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
    prepareExecution: prepareLifiExecution,
  });
}

export { getLifiTakerAddress, resolveLifiTakerAddress };
