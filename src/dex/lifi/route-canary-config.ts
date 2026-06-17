import type { KeeperConfig, LifiDexConfig } from '../../config';
import { getLifiRequiredLiveProductionPolicyError } from '../../config/lifi-policy';
import {
  getConfiguredLifiCompletePolicyChainIds,
  normalizeLifiCanaryChainPolicy,
  normalizeLifiProductionChainPolicy,
  normalizeLifiProductionPolicy,
} from './chain-policy';
import {
  getLifiPolicyApiKey,
  getSetLifiPolicyEnvNames,
  isDefaultLifiApiBaseUrl,
} from './api-policy';
import { hasBroadLifiPolicyExchangeFilter } from './filters';
import {
  DEFAULT_LIFI_CANARY_CHAIN_ID,
  normalizeAddress,
  optionalEnv,
  parseBooleanEnv,
  parseCsvEnv,
  parsePositiveInteger,
  parsePositiveIntegerEnv,
  parseRoutesEnv,
  parseSelectorAllowlistEnv,
} from './route-canary-env';
import type {
  LifiRouteCanaryEnv,
  LifiRouteCanaryRoute,
} from './route-canary-env';
import { DEFAULT_LIFI_API_BASE_URL } from './schema';

export type { LifiRouteCanaryEnv, LifiRouteCanaryRoute };

type ResolvedLifiRouteCanaryConfigBase = {
  requireLive: boolean;
  chainId: number;
  lifiConfig: LifiDexConfig;
  apiBaseUrl: string;
};

export type SkippedLifiRouteCanaryConfig = ResolvedLifiRouteCanaryConfigBase & {
  status: 'skipped';
  error: string;
  takerAddress?: string;
};

export type ReadyLifiRouteCanaryConfig = ResolvedLifiRouteCanaryConfigBase & {
  status: 'ready';
  takerAddress: string;
  callTargets: string[];
  approvalSpenders: string[];
  selectorAllowlist: Record<string, string[]>;
  routes: LifiRouteCanaryRoute[];
  apiKey?: string;
};

export type ResolvedLifiRouteCanaryConfig =
  | SkippedLifiRouteCanaryConfig
  | ReadyLifiRouteCanaryConfig;

const REQUIRED_LIVE_POLICY_OVERRIDE_ENVS = [
  'AJNA_AGENT_LIFI_CANARY_API_BASE_URL',
  'AJNA_AGENT_LIFI_CANARY_TAKER_ADDRESS',
  'AJNA_AGENT_LIFI_CANARY_ALLOW_EXCHANGES',
  'AJNA_AGENT_LIFI_CANARY_DENY_EXCHANGES',
  'AJNA_AGENT_LIFI_CANARY_PREFER_EXCHANGES',
  'AJNA_AGENT_LIFI_CANARY_ALLOW_BROAD_EXCHANGE_FILTERS',
  'AJNA_AGENT_LIFI_CANARY_CALL_TARGET_ALLOWLIST',
  'AJNA_AGENT_LIFI_CANARY_APPROVAL_SPENDER_ALLOWLIST',
  'AJNA_AGENT_LIFI_CANARY_SELECTOR_ALLOWLIST_JSON',
];

function getRequiredLivePolicySourceError(
  env: LifiRouteCanaryEnv,
  config: KeeperConfig | undefined
): string | undefined {
  if (!config) {
    return 'AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE requires --config with reviewed production keeper config';
  }
  if (!config.dex?.lifi) {
    return 'AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE requires config.dex.lifi';
  }
  if (config.dex.lifi.mode !== 'production') {
    return 'AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE requires config.dex.lifi.mode to be production';
  }
  if (!config.takers?.contracts?.Lifi) {
    return 'AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE requires config.takers.contracts.Lifi';
  }
  const incompletePolicyError = getLifiRequiredLiveProductionPolicyError(
    config.dex.lifi
  );
  if (incompletePolicyError !== undefined) {
    return incompletePolicyError;
  }

  const overrides = getSetLifiPolicyEnvNames({
    env,
    names: REQUIRED_LIVE_POLICY_OVERRIDE_ENVS,
    readEnv: optionalEnv,
  });
  if (overrides.length > 0) {
    return `AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE does not allow LI.FI policy env overrides: ${overrides.join(', ')}`;
  }
  return undefined;
}

function getRequiredLiveRouteTakerOverrideError(
  routes: readonly LifiRouteCanaryRoute[]
): string | undefined {
  const overrideLabels = routes
    .filter((route) => route.takerAddress !== undefined)
    .map((route) => route.label);
  if (overrideLabels.length === 0) {
    return undefined;
  }
  return `AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE does not allow route-level takerAddress overrides in AJNA_AGENT_LIFI_CANARY_ROUTES_JSON: ${overrideLabels.join(', ')}`;
}

function getConfiguredLifiChains(config: KeeperConfig | undefined): number[] {
  return getConfiguredLifiCompletePolicyChainIds(config?.dex?.lifi);
}

function resolveCanaryChainId(
  env: LifiRouteCanaryEnv,
  config: KeeperConfig | undefined
): number {
  const explicit = optionalEnv(env, 'AJNA_AGENT_LIFI_CANARY_CHAIN_ID');
  if (explicit !== undefined) {
    return parsePositiveInteger(explicit, 'AJNA_AGENT_LIFI_CANARY_CHAIN_ID');
  }

  const configuredChains = getConfiguredLifiChains(config);
  if (configuredChains.length === 1) {
    return configuredChains[0];
  }
  if (configuredChains.length > 1) {
    throw new Error(
      `AJNA_AGENT_LIFI_CANARY_CHAIN_ID is required when config.dex.lifi contains multiple production chains: ${configuredChains.join(', ')}`
    );
  }

  return DEFAULT_LIFI_CANARY_CHAIN_ID;
}

function getCanaryPolicy(params: {
  env: LifiRouteCanaryEnv;
  config: LifiDexConfig | undefined;
  chainId: number;
}): {
  callTargets: string[];
  approvalSpenders: string[];
  selectorAllowlist: Record<string, string[]>;
} {
  const callTargetOverride = parseCsvEnv(
    params.env,
    'AJNA_AGENT_LIFI_CANARY_CALL_TARGET_ALLOWLIST'
  );
  const approvalSpenderOverride = parseCsvEnv(
    params.env,
    'AJNA_AGENT_LIFI_CANARY_APPROVAL_SPENDER_ALLOWLIST'
  );
  const selectorOverride = parseSelectorAllowlistEnv(
    params.env,
    'AJNA_AGENT_LIFI_CANARY_SELECTOR_ALLOWLIST_JSON'
  );
  if (
    callTargetOverride === undefined &&
    approvalSpenderOverride === undefined &&
    selectorOverride === undefined &&
    params.config?.mode === 'production'
  ) {
    const policy = normalizeLifiProductionChainPolicy({
      config: params.config,
      fieldName: 'config.dex.lifi',
      chainId: params.chainId,
    });
    return {
      callTargets: policy.callTargets,
      approvalSpenders: policy.approvalSpenders,
      selectorAllowlist: policy.selectorAllowlist,
    };
  }

  const policy = normalizeLifiCanaryChainPolicy({
    callTargets:
      callTargetOverride ??
      params.config?.callTargetAllowlist?.[params.chainId] ??
      [],
    approvalSpenders:
      approvalSpenderOverride ??
      params.config?.approvalSpenderAllowlist?.[params.chainId] ??
      [],
    selectorAllowlist: selectorOverride ?? {},
    fieldName: 'LI.FI',
  });
  return {
    callTargets: policy.callTargets,
    approvalSpenders: policy.approvalSpenders,
    selectorAllowlist: policy.selectorAllowlist,
  };
}

function buildLifiConfig(params: {
  env: LifiRouteCanaryEnv;
  config: KeeperConfig | undefined;
  chainId: number;
}): LifiDexConfig {
  const configured = params.config?.dex?.lifi;
  const allowExchanges =
    parseCsvEnv(params.env, 'AJNA_AGENT_LIFI_CANARY_ALLOW_EXCHANGES') ??
    configured?.allowExchanges;
  const denyExchanges =
    parseCsvEnv(params.env, 'AJNA_AGENT_LIFI_CANARY_DENY_EXCHANGES') ??
    configured?.denyExchanges;
  const preferExchanges =
    parseCsvEnv(params.env, 'AJNA_AGENT_LIFI_CANARY_PREFER_EXCHANGES') ??
    configured?.preferExchanges;
  const allowBroadExchangeFiltersEnv = optionalEnv(
    params.env,
    'AJNA_AGENT_LIFI_CANARY_ALLOW_BROAD_EXCHANGE_FILTERS'
  );
  const allowBroadExchangeFilters =
    allowBroadExchangeFiltersEnv !== undefined
      ? parseBooleanEnv(
          params.env,
          'AJNA_AGENT_LIFI_CANARY_ALLOW_BROAD_EXCHANGE_FILTERS'
        )
      : configured?.allowBroadExchangeFilters === true;

  const apiBaseUrl =
    optionalEnv(params.env, 'AJNA_AGENT_LIFI_CANARY_API_BASE_URL') ??
    configured?.apiBaseUrl;
  const apiKeyEnvVar =
    optionalEnv(params.env, 'AJNA_AGENT_LIFI_CANARY_API_KEY_ENV_VAR') ??
    configured?.apiKeyEnvVar;
  const quoteTimeoutMs =
    optionalEnv(params.env, 'AJNA_AGENT_LIFI_CANARY_TIMEOUT_MS') !== undefined
      ? parsePositiveIntegerEnv(
          params.env,
          'AJNA_AGENT_LIFI_CANARY_TIMEOUT_MS',
          '5000'
        )
      : configured?.quoteTimeoutMs;

  if (configured?.mode === 'production') {
    const productionConfig = {
      ...configured,
      mode: 'production' as const,
      apiBaseUrl,
      apiKeyEnvVar,
      quoteTimeoutMs,
      denyExchanges,
      preferExchanges,
      ...(allowBroadExchangeFilters === false
        ? { allowBroadExchangeFilters }
        : {}),
    };
    if (
      allowExchanges !== undefined ||
      configured.exchangePolicy !== 'reviewed_broad'
    ) {
      return {
        ...productionConfig,
        allowExchanges: allowExchanges ?? configured.allowExchanges,
      } as LifiDexConfig;
    }
    return productionConfig as LifiDexConfig;
  }

  return {
    ...(configured ?? { mode: 'canary' as const }),
    mode: 'canary',
    apiBaseUrl,
    apiKeyEnvVar,
    quoteTimeoutMs,
    allowExchanges,
    denyExchanges,
    preferExchanges,
    allowBroadExchangeFilters,
  };
}

function getApiKey(
  env: LifiRouteCanaryEnv,
  config: LifiDexConfig
): string | undefined {
  return getLifiPolicyApiKey({
    config,
    env,
    fallbackEnvNames: [
      'AJNA_AGENT_LIFI_API_KEY',
      'AJNA_AGENT_LIFI_CANARY_API_KEY',
      'LIFI_API_KEY',
    ],
    readEnv: optionalEnv,
  });
}

export { hasBroadLifiPolicyExchangeFilter as hasBroadExchangeFilter } from './filters';

export function resolveLifiRouteCanaryConfig(input: {
  env?: LifiRouteCanaryEnv;
  config?: KeeperConfig;
}): ResolvedLifiRouteCanaryConfig {
  const env = input.env ?? process.env;
  const requireLive = parseBooleanEnv(
    env,
    'AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE'
  );
  const chainId = resolveCanaryChainId(env, input.config);
  const lifiConfig = buildLifiConfig({
    env,
    config: input.config,
    chainId,
  });
  const apiBaseUrl = lifiConfig.apiBaseUrl ?? DEFAULT_LIFI_API_BASE_URL;
  const skipped = (
    error: string,
    takerAddress?: string
  ): ResolvedLifiRouteCanaryConfig => ({
    status: 'skipped',
    requireLive,
    chainId,
    lifiConfig,
    apiBaseUrl,
    takerAddress,
    error,
  });

  if (requireLive && !isDefaultLifiApiBaseUrl(apiBaseUrl)) {
    return skipped(
      'AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE requires the default LI.FI API base URL; refusing custom or mocked API base URL'
    );
  }
  const requiredLivePolicyError = requireLive
    ? getRequiredLivePolicySourceError(env, input.config)
    : undefined;
  if (requiredLivePolicyError !== undefined) {
    return skipped(requiredLivePolicyError);
  }

  const takerAddressValue =
    optionalEnv(env, 'AJNA_AGENT_LIFI_CANARY_TAKER_ADDRESS') ??
    input.config?.takers?.contracts?.Lifi;
  const takerAddress = takerAddressValue
    ? normalizeAddress(
        takerAddressValue,
        'AJNA_AGENT_LIFI_CANARY_TAKER_ADDRESS'
      )
    : undefined;

  if (!takerAddress) {
    return skipped(
      'Missing AJNA_AGENT_LIFI_CANARY_TAKER_ADDRESS or config.takers.contracts.Lifi'
    );
  }
  const exchangePolicy =
    lifiConfig.mode === 'production'
      ? normalizeLifiProductionPolicy({
          config: lifiConfig,
          fieldName: 'config.dex.lifi',
          chainId,
        }).exchangePolicy
      : undefined;

  if (
    exchangePolicy?.kind !== 'reviewed_broad' &&
    (!lifiConfig.allowExchanges || lifiConfig.allowExchanges.length === 0)
  ) {
    return skipped(
      'Missing AJNA_AGENT_LIFI_CANARY_ALLOW_EXCHANGES or config.dex.lifi.allowExchanges; refusing broad LI.FI route discovery',
      takerAddress
    );
  }

  const { callTargets, approvalSpenders, selectorAllowlist } = getCanaryPolicy({
    env,
    config: lifiConfig,
    chainId,
  });
  const routes = parseRoutesEnv(env, chainId);
  const requiredLiveRouteTakerOverrideError = requireLive
    ? getRequiredLiveRouteTakerOverrideError(routes)
    : undefined;
  if (requiredLiveRouteTakerOverrideError !== undefined) {
    return skipped(requiredLiveRouteTakerOverrideError, takerAddress);
  }

  return {
    status: 'ready',
    requireLive,
    chainId,
    lifiConfig,
    apiBaseUrl,
    takerAddress,
    callTargets,
    approvalSpenders,
    selectorAllowlist,
    routes,
    apiKey: getApiKey(env, lifiConfig),
  };
}
