import {
  normalizeLifiAddressAllowlist,
} from './address-allowlist';
import {
  getConcreteProductionLifiPolicyError,
  normalizeLifiExchangeFilters,
  type LifiExchangeFilterConfig,
  type NormalizedLifiExchangeFilters,
} from './filters';
import {
  normalizeLifiSelectorAllowlistRecord,
} from './selector-allowlist';

export const LIFI_CHAIN_POLICY_BOUNDS = {
  maxAllowlistEntries: 128,
  maxSelectorsPerTarget: 32,
};

export interface LifiChainPolicyConfig extends LifiExchangeFilterConfig {
  callTargetAllowlist?: { [chainId: number]: string[] };
  approvalSpenderAllowlist?: { [chainId: number]: string[] };
  selectorAllowlist?: { [chainId: number]: { [callTarget: string]: string[] } };
  observedSelectorAllowlist?: {
    [chainId: number]: { [callTarget: string]: string[] };
  };
}

export interface LifiProductionChainPolicyConfig
  extends LifiChainPolicyConfig {
  mode: 'production';
}

export interface NormalizedLifiAllowlistPolicy {
  callTargets: string[];
  approvalSpenders: string[];
  selectorAllowlist: Record<string, string[]>;
}

export interface NormalizedLifiChainPolicy
  extends NormalizedLifiAllowlistPolicy {
  chainId: number;
}

export interface NormalizedLifiProductionPolicy {
  filters: NormalizedLifiExchangeFilters;
  chains: NormalizedLifiChainPolicy[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateCanonicalChainIdKey(chainId: string, fieldName: string): void {
  const parsedChainId = Number(chainId);
  if (
    !/^[1-9]\d*$/.test(chainId) ||
    !Number.isInteger(parsedChainId) ||
    parsedChainId <= 0 ||
    String(parsedChainId) !== chainId
  ) {
    throw new Error(
      `${fieldName} entries must use canonical positive integer chain ID keys`
    );
  }
}

function getChainIdsFromRecord(
  value: unknown,
  fieldName: string,
  required: boolean
): number[] {
  if (value === undefined) {
    if (required) {
      throw new Error(`${fieldName} is required`);
    }
    return [];
  }
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object keyed by chainId`);
  }
  return Object.keys(value)
    .map((chainId) => {
      validateCanonicalChainIdKey(chainId, fieldName);
      return Number(chainId);
    })
    .sort((a, b) => a - b);
}

function normalizeAddressPolicyByChain(params: {
  value: { [chainId: number]: string[] } | undefined;
  fieldName: string;
  required: boolean;
}): Map<number, string[]> {
  const chainIds = getChainIdsFromRecord(
    params.value,
    params.fieldName,
    params.required
  );
  const normalized = new Map<number, string[]>();
  for (const chainId of chainIds) {
    const addresses = params.value?.[chainId];
    if (!Array.isArray(addresses)) {
      throw new Error(`${params.fieldName}.${chainId} must be non-empty`);
    }
    if (addresses.length > LIFI_CHAIN_POLICY_BOUNDS.maxAllowlistEntries) {
      throw new Error(
        `${params.fieldName}.${chainId} cannot contain more than ${LIFI_CHAIN_POLICY_BOUNDS.maxAllowlistEntries} addresses`
      );
    }
    normalized.set(
      chainId,
      normalizeLifiAddressAllowlist(addresses, {
        label: `${params.fieldName}.${chainId}`,
        requireNonEmpty: true,
      })
    );
  }
  return normalized;
}

function normalizeSelectorPolicyByChain(params: {
  value: { [chainId: number]: { [callTarget: string]: string[] } } | undefined;
  fieldName: string;
  required: boolean;
  callTargetsByChain?: Map<number, string[]>;
}): Map<number, Record<string, string[]>> {
  const chainIds = getChainIdsFromRecord(
    params.value,
    params.fieldName,
    params.required
  );
  const normalized = new Map<number, Record<string, string[]>>();
  for (const chainId of chainIds) {
    const selectorsByTarget = params.value?.[chainId];
    if (
      selectorsByTarget === undefined ||
      typeof selectorsByTarget !== 'object' ||
      Array.isArray(selectorsByTarget)
    ) {
      throw new Error(
        `${params.fieldName}.${chainId} must be an object keyed by call target`
      );
    }
    const callTargets = params.callTargetsByChain?.get(chainId);
    const normalizedSelectors = normalizeLifiSelectorAllowlistRecord(
      selectorsByTarget,
      {
        label: `${params.fieldName}.${chainId}`,
        requireNonEmpty: true,
        callTargetAllowlist: callTargets,
        requireCallTargetCoverage: callTargets !== undefined,
      }
    );
    for (const [target, selectors] of Object.entries(normalizedSelectors)) {
      if (selectors.length > LIFI_CHAIN_POLICY_BOUNDS.maxSelectorsPerTarget) {
        throw new Error(
          `${params.fieldName}.${chainId}.${target} cannot contain more than ${LIFI_CHAIN_POLICY_BOUNDS.maxSelectorsPerTarget} selectors`
        );
      }
    }
    normalized.set(chainId, normalizedSelectors);
  }
  return normalized;
}

function ensureRequiredChain(
  value: Map<number, unknown>,
  chainId: number | undefined,
  fieldName: string
): void {
  if (chainId !== undefined && !value.has(chainId)) {
    throw new Error(`${fieldName}.${chainId} is required`);
  }
}

function normalizeProductionChains(params: {
  config: LifiProductionChainPolicyConfig;
  fieldName: string;
  chainId?: number;
}): NormalizedLifiChainPolicy[] {
  const callTargetsByChain = normalizeAddressPolicyByChain({
    value: params.config.callTargetAllowlist,
    fieldName: `${params.fieldName}.callTargetAllowlist`,
    required: true,
  });
  const approvalSpendersByChain = normalizeAddressPolicyByChain({
    value: params.config.approvalSpenderAllowlist,
    fieldName: `${params.fieldName}.approvalSpenderAllowlist`,
    required: true,
  });
  ensureRequiredChain(
    callTargetsByChain,
    params.chainId,
    `${params.fieldName}.callTargetAllowlist`
  );
  ensureRequiredChain(
    approvalSpendersByChain,
    params.chainId,
    `${params.fieldName}.approvalSpenderAllowlist`
  );

  for (const configuredChainId of Array.from(callTargetsByChain.keys())) {
    if (!approvalSpendersByChain.has(configuredChainId)) {
      throw new Error(
        `${params.fieldName}.approvalSpenderAllowlist.${configuredChainId} is required`
      );
    }
  }
  for (const configuredChainId of Array.from(approvalSpendersByChain.keys())) {
    if (!callTargetsByChain.has(configuredChainId)) {
      throw new Error(
        `${params.fieldName}.callTargetAllowlist.${configuredChainId} is required`
      );
    }
  }

  const selectorsByChain = normalizeSelectorPolicyByChain({
    value: params.config.selectorAllowlist,
    fieldName: `${params.fieldName}.selectorAllowlist`,
    required: true,
    callTargetsByChain,
  });
  ensureRequiredChain(
    selectorsByChain,
    params.chainId,
    `${params.fieldName}.selectorAllowlist`
  );
  for (const configuredChainId of Array.from(callTargetsByChain.keys())) {
    if (!selectorsByChain.has(configuredChainId)) {
      throw new Error(
        `${params.fieldName}.selectorAllowlist.${configuredChainId} is required`
      );
    }
  }

  return Array.from(callTargetsByChain.keys())
    .sort((a, b) => a - b)
    .map((chainId) => ({
      chainId,
      callTargets: callTargetsByChain.get(chainId)!,
      approvalSpenders: approvalSpendersByChain.get(chainId)!,
      selectorAllowlist: selectorsByChain.get(chainId)!,
    }));
}

export function assertValidLifiCanaryAllowlistPolicy(params: {
  config: LifiChainPolicyConfig;
  fieldName: string;
}): void {
  normalizeAddressPolicyByChain({
    value: params.config.callTargetAllowlist,
    fieldName: `${params.fieldName}.callTargetAllowlist`,
    required: false,
  });
  normalizeAddressPolicyByChain({
    value: params.config.approvalSpenderAllowlist,
    fieldName: `${params.fieldName}.approvalSpenderAllowlist`,
    required: false,
  });
  normalizeSelectorPolicyByChain({
    value: params.config.observedSelectorAllowlist,
    fieldName: `${params.fieldName}.observedSelectorAllowlist`,
    required: false,
  });
}

export function normalizeLifiProductionPolicy(params: {
  config: LifiChainPolicyConfig;
  fieldName: string;
  chainId?: number;
}): NormalizedLifiProductionPolicy {
  if (params.config.mode !== 'production') {
    throw new Error(`${params.fieldName}.mode must be production`);
  }
  const productionConfig = params.config as LifiProductionChainPolicyConfig;
  const filters = normalizeLifiExchangeFilters(productionConfig, {
    fieldName: params.fieldName,
    mode: productionConfig.mode,
  });
  if ((filters.allowExchanges ?? []).length === 0) {
    throw new Error(
      `${params.fieldName}.allowExchanges must be non-empty in production`
    );
  }
  return {
    filters,
    chains: normalizeProductionChains({
      config: productionConfig,
      fieldName: params.fieldName,
      chainId: params.chainId,
    }),
  };
}

export function normalizeLifiProductionChainPolicy(params: {
  config: LifiChainPolicyConfig;
  fieldName: string;
  chainId: number;
}): NormalizedLifiChainPolicy {
  const policy = normalizeLifiProductionPolicy({
    config: params.config,
    fieldName: params.fieldName,
    chainId: params.chainId,
  });
  const chain = policy.chains.find((entry) => entry.chainId === params.chainId);
  if (!chain) {
    throw new Error(
      `${params.fieldName}.callTargetAllowlist.${params.chainId} is required`
    );
  }
  return chain;
}

export function requireConcreteProductionLifiChainPolicy(params: {
  config: LifiChainPolicyConfig;
  chainId: number;
  fieldName: string;
  context: string;
}): NormalizedLifiChainPolicy {
  const concretePolicyError = getConcreteProductionLifiPolicyError({
    config: params.config,
    context: params.context,
  });
  if (concretePolicyError !== undefined) {
    throw new Error(concretePolicyError);
  }
  return normalizeLifiProductionChainPolicy({
    config: params.config,
    fieldName: params.fieldName,
    chainId: params.chainId,
  });
}

export function normalizeLifiCanaryChainPolicy(params: {
  callTargets: readonly string[];
  approvalSpenders: readonly string[];
  selectorAllowlist: Record<string, readonly string[]>;
  fieldName: string;
}): NormalizedLifiAllowlistPolicy {
  const callTargets = normalizeLifiAddressAllowlist(params.callTargets, {
    label: `${params.fieldName}.callTargetAllowlist`,
    requireNonEmpty: true,
  });
  const approvalSpenders = normalizeLifiAddressAllowlist(
    params.approvalSpenders,
    {
      label: `${params.fieldName}.approvalSpenderAllowlist`,
      requireNonEmpty: true,
    }
  );
  const selectorAllowlist = normalizeLifiSelectorAllowlistRecord(
    params.selectorAllowlist,
    {
      label: `${params.fieldName}.selectorAllowlist`,
      requireNonEmpty: true,
      callTargetAllowlist: callTargets,
      requireCallTargetCoverage: true,
    }
  );
  return {
    callTargets,
    approvalSpenders,
    selectorAllowlist,
  };
}

export function getConfiguredLifiCompletePolicyChainIds(
  config: LifiChainPolicyConfig | undefined
): number[] {
  if (config?.mode !== 'production') {
    return [];
  }
  const getChainIds = (record: unknown): Set<number> => {
    if (!isRecord(record)) {
      return new Set();
    }
    return new Set(
      Object.keys(record)
        .map(Number)
        .filter((chainId) => Number.isInteger(chainId) && chainId > 0)
    );
  };
  const chainSets = [
    getChainIds(config.callTargetAllowlist),
    getChainIds(config.approvalSpenderAllowlist),
    getChainIds(config.selectorAllowlist),
  ];
  const [first, ...rest] = chainSets;
  return Array.from(first)
    .filter((chainId) => rest.every((chainSet) => chainSet.has(chainId)))
    .sort((a, b) => a - b);
}
