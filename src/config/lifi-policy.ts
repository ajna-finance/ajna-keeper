import type { LifiDexConfig } from './schema';
import { normalizeLifiExchangeFilters } from '../dex/lifi/filters';
import {
  LIFI_CHAIN_POLICY_BOUNDS,
  assertValidLifiCanaryAllowlistPolicy,
  normalizeLifiProductionPolicy as normalizeProductionPolicyForValidation,
} from '../dex/lifi/chain-policy';
import {
  normalizeLifiApiBaseUrl,
  requirePositiveIntegerPolicy as requirePositiveIntegerApiPolicy,
  validateLifiIntegrator,
} from '../dex/lifi/api-policy';
export {
  getConfiguredLifiCompletePolicyChainIds,
  normalizeLifiCanaryChainPolicy,
  normalizeLifiProductionChainPolicy,
  normalizeLifiProductionPolicy,
  requireConcreteProductionLifiChainPolicy,
} from '../dex/lifi/chain-policy';
export type {
  NormalizedLifiAllowlistPolicy,
  NormalizedLifiChainPolicy,
  NormalizedLifiProductionPolicy,
} from '../dex/lifi/chain-policy';

export const LIFI_POLICY_BOUNDS = {
  maxQuoteTimeoutMs: 10_000,
  maxQuoteAgeMs: 60_000,
  maxSlippage: 0.5,
  maxPriceImpact: 0.5,
  ...LIFI_CHAIN_POLICY_BOUNDS,
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function requireOptionalPositive(value: unknown, message: string): void {
  if (value !== undefined && (!isFiniteNumber(value) || value <= 0)) {
    throw new Error(message);
  }
}

function requireOptionalIntegerRange(
  value: unknown,
  min: number,
  max: number,
  message: string
): void {
  if (value === undefined) {
    return;
  }
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(message);
  }
}

export function assertValidLifiDexConfig(params: {
  config: LifiDexConfig | undefined;
  fieldName: string;
  chainId?: number;
  requireProduction: boolean;
}): void {
  const lifi = params.config;
  if (!lifi) {
    throw new Error(`${params.fieldName} required when LI.FI is enabled`);
  }
  if (lifi.mode !== 'canary' && lifi.mode !== 'production') {
    throw new Error(`${params.fieldName}.mode must be canary or production`);
  }
  if (params.requireProduction && lifi.mode !== 'production') {
    throw new Error(
      `${params.fieldName}.mode must be production for live LI.FI external takes`
    );
  }
  if (lifi.apiBaseUrl !== undefined) {
    normalizeLifiApiBaseUrl(lifi.apiBaseUrl, `${params.fieldName}.apiBaseUrl`, {
      requireHttps: lifi.mode === 'production',
    });
  }
  if (
    lifi.apiKeyEnvVar !== undefined &&
    (typeof lifi.apiKeyEnvVar !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(lifi.apiKeyEnvVar))
  ) {
    throw new Error(
      `${params.fieldName}.apiKeyEnvVar must be an environment variable name`
    );
  }
  if (lifi.integrator !== undefined) {
    validateLifiIntegrator(lifi.integrator, `${params.fieldName}.integrator`);
  }
  requireOptionalIntegerRange(
    lifi.quoteTimeoutMs,
    1,
    LIFI_POLICY_BOUNDS.maxQuoteTimeoutMs,
    `${params.fieldName}.quoteTimeoutMs must be an integer between 1 and ${LIFI_POLICY_BOUNDS.maxQuoteTimeoutMs}`
  );
  requireOptionalIntegerRange(
    lifi.quoteFailureThreshold,
    1,
    100,
    `${params.fieldName}.quoteFailureThreshold must be an integer between 1 and 100`
  );
  requireOptionalPositive(
    lifi.quoteFailureCooldownMs,
    `${params.fieldName}.quoteFailureCooldownMs must be greater than 0`
  );
  requireOptionalIntegerRange(
    lifi.maxQuoteAgeMs,
    1,
    LIFI_POLICY_BOUNDS.maxQuoteAgeMs,
    `${params.fieldName}.maxQuoteAgeMs must be an integer between 1 and ${LIFI_POLICY_BOUNDS.maxQuoteAgeMs}`
  );
  if (
    lifi.defaultSlippage !== undefined &&
    (!isFiniteNumber(lifi.defaultSlippage) ||
      lifi.defaultSlippage <= 0 ||
      lifi.defaultSlippage > LIFI_POLICY_BOUNDS.maxSlippage)
  ) {
    throw new Error(
      `${params.fieldName}.defaultSlippage must be greater than 0 and at most ${LIFI_POLICY_BOUNDS.maxSlippage}`
    );
  }
  if (
    lifi.maxPriceImpact !== undefined &&
    (!isFiniteNumber(lifi.maxPriceImpact) ||
      lifi.maxPriceImpact <= 0 ||
      lifi.maxPriceImpact > LIFI_POLICY_BOUNDS.maxPriceImpact)
  ) {
    throw new Error(
      `${params.fieldName}.maxPriceImpact must be greater than 0 and at most ${LIFI_POLICY_BOUNDS.maxPriceImpact}`
    );
  }
  if (
    lifi.feeCostPolicy !== undefined &&
    lifi.feeCostPolicy !== 'included_only' &&
    lifi.feeCostPolicy !== 'reject_all'
  ) {
    throw new Error(
      `${params.fieldName}.feeCostPolicy must be included_only or reject_all`
    );
  }
  if (lifi.allowBroadExchangeFilters === true && lifi.mode !== 'canary') {
    throw new Error(
      `${params.fieldName}.allowBroadExchangeFilters is canary-only`
    );
  }

  if (lifi.mode === 'production') {
    normalizeProductionPolicyForValidation({
      config: lifi,
      fieldName: params.fieldName,
      chainId: params.chainId,
    });
  } else {
    normalizeLifiExchangeFilters(lifi, {
      fieldName: params.fieldName,
      mode: lifi.mode,
    });
    assertValidLifiCanaryAllowlistPolicy({
      config: lifi,
      fieldName: params.fieldName,
    });
  }
}

export function requirePositiveIntegerPolicy(params: {
  value: number | undefined;
  fallback: number;
  max?: number;
  label: string;
}): number {
  return requirePositiveIntegerApiPolicy({
    ...params,
    max: params.max ?? LIFI_POLICY_BOUNDS.maxQuoteTimeoutMs,
  });
}

export function getLifiRequiredLiveProductionPolicyError(
  config: LifiDexConfig,
  fieldName = 'config.dex.lifi'
): string | undefined {
  try {
    const policy = normalizeProductionPolicyForValidation({
      config,
      fieldName,
    });
    if (policy.chains.length === 0) {
      return 'AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE requires at least one complete production LI.FI chain policy';
    }
  } catch (error) {
    return `AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE requires complete production LI.FI policy for every configured chain: ${getErrorMessage(error)}`;
  }
  return undefined;
}
