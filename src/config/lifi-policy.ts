import { LifiDexConfig, LifiProductionDexConfig } from './schema';
import {
  NormalizedLifiExchangeFilters,
  isBroadLifiExchangeFilter,
  isUnsupportedLifiExchangeTool,
} from '../dex/lifi/filters';
import { normalizeLifiAddressAllowlist } from '../dex/lifi/address-allowlist';
import { normalizeLifiSelectorAllowlistRecord } from '../dex/lifi/selector-allowlist';

export const MAX_LIFI_INTEGRATOR_LENGTH = 23;

const LIFI_INTEGRATOR_PATTERN = /^[A-Za-z0-9_.-]+$/;

export const LIFI_POLICY_BOUNDS = {
  maxQuoteTimeoutMs: 10_000,
  maxQuoteAgeMs: 60_000,
  maxSlippage: 0.5,
  maxPriceImpact: 0.5,
  maxAllowlistEntries: 128,
  maxSelectorsPerTarget: 32,
};

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function normalizeFilterList(params: {
  values: readonly string[] | undefined;
  fieldName: string;
  mode: 'canary' | 'production';
  allowBroadExchangeFilters?: boolean;
}): string[] | undefined {
  if (params.values === undefined) {
    return undefined;
  }
  if (!Array.isArray(params.values)) {
    throw new Error(`${params.fieldName} must be an array of exchange keys`);
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of params.values) {
    if (typeof value !== 'string') {
      throw new Error(`${params.fieldName} entries must be exchange keys`);
    }
    const key = value.trim().toLowerCase();
    if (
      isBroadLifiExchangeFilter(key) &&
      !(params.mode === 'canary' && params.allowBroadExchangeFilters === true)
    ) {
      throw new Error(
        `${params.fieldName} cannot use broad LI.FI filter keyword ${JSON.stringify(value)} outside canary allowBroadExchangeFilters mode`
      );
    }
    if (isUnsupportedLifiExchangeTool(key)) {
      throw new Error(
        `${params.fieldName} cannot use unsupported LI.FI filter keyword ${JSON.stringify(value)}`
      );
    }
    if (seen.has(key)) {
      throw new Error(`${params.fieldName} cannot contain duplicate entries`);
    }
    seen.add(key);
    normalized.push(key);
  }
  return normalized;
}

function normalizeLifiPolicyExchangeFilters(
  config: LifiDexConfig,
  fieldName: string
): NormalizedLifiExchangeFilters {
  const allowExchanges = normalizeFilterList({
    values: config.allowExchanges,
    fieldName: `${fieldName}.allowExchanges`,
    mode: config.mode,
    allowBroadExchangeFilters: config.allowBroadExchangeFilters,
  });
  const denyExchanges = normalizeFilterList({
    values: config.denyExchanges,
    fieldName: `${fieldName}.denyExchanges`,
    mode: config.mode,
    allowBroadExchangeFilters: config.allowBroadExchangeFilters,
  });
  const preferExchanges = normalizeFilterList({
    values: config.preferExchanges,
    fieldName: `${fieldName}.preferExchanges`,
    mode: config.mode,
    allowBroadExchangeFilters: config.allowBroadExchangeFilters,
  });

  const allow = new Set(allowExchanges ?? []);
  const deny = new Set(denyExchanges ?? []);
  const prefer = new Set(preferExchanges ?? []);
  for (const key of Array.from(allow)) {
    if (prefer.has(key)) {
      throw new Error(
        `${fieldName} exchange filter ${key} cannot appear in both allowExchanges and preferExchanges`
      );
    }
    if (deny.has(key)) {
      throw new Error(
        `${fieldName} exchange filter ${key} cannot appear in both allowExchanges and denyExchanges`
      );
    }
  }
  for (const key of Array.from(prefer)) {
    if (deny.has(key)) {
      throw new Error(
        `${fieldName} exchange filter ${key} cannot appear in both preferExchanges and denyExchanges`
      );
    }
  }

  return {
    ...(allowExchanges !== undefined ? { allowExchanges } : {}),
    ...(denyExchanges !== undefined ? { denyExchanges } : {}),
    ...(preferExchanges !== undefined ? { preferExchanges } : {}),
  };
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
    if (addresses.length > LIFI_POLICY_BOUNDS.maxAllowlistEntries) {
      throw new Error(
        `${params.fieldName}.${chainId} cannot contain more than ${LIFI_POLICY_BOUNDS.maxAllowlistEntries} addresses`
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
      if (selectors.length > LIFI_POLICY_BOUNDS.maxSelectorsPerTarget) {
        throw new Error(
          `${params.fieldName}.${chainId}.${target} cannot contain more than ${LIFI_POLICY_BOUNDS.maxSelectorsPerTarget} selectors`
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
  config: LifiProductionDexConfig;
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

export function normalizeLifiApiBaseUrl(
  value: unknown,
  fieldName: string,
  options: { requireHttps?: boolean } = {}
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    throw new Error(
      `${fieldName} must be an http(s) URL without credentials, query, or fragment`
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      `${fieldName} must be an http(s) URL without credentials, query, or fragment`
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `${fieldName} must be an http(s) URL without credentials, query, or fragment`
    );
  }
  if (options.requireHttps === true && parsed.protocol !== 'https:') {
    throw new Error(`${fieldName} must be HTTPS in production`);
  }
  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error(
      `${fieldName} must be an http(s) URL without credentials, query, or fragment`
    );
  }

  const pathname = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.protocol}//${parsed.host}${pathname}`;
}

export function validateLifiIntegrator(
  value: unknown,
  fieldName: string
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_LIFI_INTEGRATOR_LENGTH ||
    !LIFI_INTEGRATOR_PATTERN.test(value)
  ) {
    throw new Error(
      `${fieldName} must be 1-${MAX_LIFI_INTEGRATOR_LENGTH} characters and contain only letters, numbers, hyphens, underscores, or dots`
    );
  }
  return value;
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

  const filters = normalizeLifiPolicyExchangeFilters(lifi, params.fieldName);
  if (lifi.mode === 'production') {
    if ((filters.allowExchanges ?? []).length === 0) {
      throw new Error(
        `${params.fieldName}.allowExchanges must be non-empty in production`
      );
    }
    normalizeProductionChains({
      config: lifi,
      fieldName: params.fieldName,
      chainId: params.chainId,
    });
  } else {
    normalizeAddressPolicyByChain({
      value: lifi.callTargetAllowlist,
      fieldName: `${params.fieldName}.callTargetAllowlist`,
      required: false,
    });
    normalizeAddressPolicyByChain({
      value: lifi.approvalSpenderAllowlist,
      fieldName: `${params.fieldName}.approvalSpenderAllowlist`,
      required: false,
    });
    normalizeSelectorPolicyByChain({
      value: lifi.observedSelectorAllowlist,
      fieldName: `${params.fieldName}.observedSelectorAllowlist`,
      required: false,
    });
  }
}

export function normalizeLifiProductionPolicy(params: {
  config: LifiDexConfig;
  fieldName: string;
  chainId?: number;
}): NormalizedLifiProductionPolicy {
  if (params.config.mode !== 'production') {
    throw new Error(`${params.fieldName}.mode must be production`);
  }
  const filters = normalizeLifiPolicyExchangeFilters(
    params.config,
    params.fieldName
  );
  if ((filters.allowExchanges ?? []).length === 0) {
    throw new Error(
      `${params.fieldName}.allowExchanges must be non-empty in production`
    );
  }
  return {
    filters,
    chains: normalizeProductionChains({
      config: params.config,
      fieldName: params.fieldName,
      chainId: params.chainId,
    }),
  };
}

export function normalizeLifiProductionChainPolicy(params: {
  config: LifiDexConfig;
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
  config: LifiDexConfig | undefined
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

export function getLifiRequiredLiveProductionPolicyError(
  config: LifiDexConfig,
  fieldName = 'config.dex.lifi'
): string | undefined {
  try {
    const policy = normalizeLifiProductionPolicy({ config, fieldName });
    if (policy.chains.length === 0) {
      return 'AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE requires at least one complete production LI.FI chain policy';
    }
  } catch (error) {
    return `AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE requires complete production LI.FI policy for every configured chain: ${getErrorMessage(error)}`;
  }
  return undefined;
}
