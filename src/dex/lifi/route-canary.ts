import { BigNumber, ethers } from 'ethers';
import type { KeeperConfig, LifiDexConfig } from '../../config';
import {
  getConfiguredLifiCompletePolicyChainIds,
  getLifiRequiredLiveProductionPolicyError,
  normalizeLifiApiBaseUrl,
  normalizeLifiCanaryChainPolicy,
  normalizeLifiProductionChainPolicy,
} from '../../config/lifi-policy';
import { getErrorMessage } from '../../utils';
import { fetchLifiQuote, fetchLifiTools } from './client';
import {
  assertLifiToolsContainFilters,
  extractLifiExchangeToolKeys,
  isBroadLifiExchangeFilter,
  normalizeLifiExchangeFilters,
} from './filters';
import { validateLifiQuote } from './validate-route';
import { DEFAULT_LIFI_API_BASE_URL } from './schema';

export type LifiRouteCanaryCheck = {
  label: string;
  success: boolean;
  skipped?: boolean;
  source: 'lifi-tools' | 'lifi-quote' | 'canary-env';
  error?: string;
  chainId?: number;
  fromToken?: string;
  toToken?: string;
  fromAmount?: string;
  toAmountRaw?: string;
  toAmountMinRaw?: string;
  tool?: string;
  topLevelTool?: string;
  transactionTarget?: string;
  approvalSpender?: string;
  selector?: string;
};

export type LifiRouteCanarySummary = {
  status: 'passed' | 'failed' | 'skipped';
  chainId: number;
  apiBaseUrl: string;
  requireLive: boolean;
  takerAddress?: string;
  checks: LifiRouteCanaryCheck[];
  observedSelectorAllowlist?: Record<string, Record<string, string[]>>;
  observedSelectorsByTool?: Record<
    string,
    Record<string, Record<string, string[]>>
  >;
  failureCount: number;
};

export type LifiRouteCanaryRoute = {
  label: string;
  fromToken: string;
  toToken: string;
  fromAmount: string;
  takerAddress?: string;
};

export type LifiRouteCanaryEnv = Record<string, string | undefined>;

export type LifiRouteCanaryDeps = {
  fetchTools?: (params: {
    config: LifiDexConfig;
    apiKey?: string;
  }) => Promise<unknown>;
  fetchQuote?: typeof fetchLifiQuote;
};

export type RunLifiRouteCanaryInput = {
  env?: LifiRouteCanaryEnv;
  config?: KeeperConfig;
  deps?: LifiRouteCanaryDeps;
};

export type RunLifiRouteCanaryResult = {
  summary: LifiRouteCanarySummary;
  exitCode: number;
};

const BASE_CHAIN_ID = 8453;
const BASE_CADC = '0x043eb4b75d0805c43d7c834902e335621983cf03';
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const DEFAULT_BASE_CADC_AMOUNT_RAW = '4283573040064348752';
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

function optionalEnv(
  env: LifiRouteCanaryEnv,
  name: string
): string | undefined {
  const value = env[name];
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

function parseBooleanEnv(env: LifiRouteCanaryEnv, name: string): boolean {
  const value = optionalEnv(env, name);
  if (value === undefined) {
    return false;
  }
  return ['1', 'true', 'yes'].includes(value.trim().toLowerCase());
}

function normalizeApiBaseUrlForGate(value: string): string {
  return normalizeLifiApiBaseUrl(value, 'LI.FI API base URL');
}

function isDefaultLifiApiBaseUrl(value: string): boolean {
  return (
    normalizeApiBaseUrlForGate(value) ===
    normalizeApiBaseUrlForGate(DEFAULT_LIFI_API_BASE_URL)
  );
}

function getSetEnvNames(
  env: LifiRouteCanaryEnv,
  names: readonly string[]
): string[] {
  return names.filter((name) => optionalEnv(env, name) !== undefined);
}

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
  const allowBroadExchangeFilters: unknown =
    config.dex.lifi.allowBroadExchangeFilters;
  if (allowBroadExchangeFilters === true) {
    return 'AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE requires concrete production LI.FI exchange filters; config.dex.lifi.allowBroadExchangeFilters is canary-only';
  }
  if (hasBroadExchangeFilter(config.dex.lifi)) {
    return 'AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE requires concrete production LI.FI exchange filters; broad filter keywords are not allowed';
  }
  const incompletePolicyError = getLifiRequiredLiveProductionPolicyError(
    config.dex.lifi
  );
  if (incompletePolicyError !== undefined) {
    return incompletePolicyError;
  }

  const overrides = getSetEnvNames(env, REQUIRED_LIVE_POLICY_OVERRIDE_ENVS);
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

function parsePositiveIntegerEnv(
  env: LifiRouteCanaryEnv,
  name: string,
  fallback: string
): number {
  const value = Number(optionalEnv(env, name) ?? fallback);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
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

  return BASE_CHAIN_ID;
}

function parseCsvEnv(
  env: LifiRouteCanaryEnv,
  name: string
): string[] | undefined {
  const raw = optionalEnv(env, name);
  if (raw === undefined) {
    return undefined;
  }
  const values = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return values.length > 0 ? values : undefined;
}

function normalizeAddress(value: string, label: string): string {
  if (!ethers.utils.isAddress(value)) {
    throw new Error(`${label} must be an address`);
  }
  return ethers.utils.getAddress(value);
}

function parsePositiveRawAmount(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${label} must be a decimal integer string`);
  }
  const parsed = BigNumber.from(value);
  if (!parsed.gt(0)) {
    throw new Error(`${label} must be greater than zero`);
  }
  return parsed.toString();
}

function parseSelectorAllowlistEnv(
  env: LifiRouteCanaryEnv,
  name: string
): Record<string, string[]> | undefined {
  const raw = optionalEnv(env, name);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object of target to selectors`);
  }
  const allowlist: Record<string, string[]> = {};
  for (const [target, selectors] of Object.entries(parsed)) {
    if (
      !Array.isArray(selectors) ||
      selectors.some((selector) => typeof selector !== 'string')
    ) {
      throw new Error(`${name}.${target} must be an array of selectors`);
    }
    allowlist[target] = selectors;
  }
  return allowlist;
}

function parseRouteCandidate(
  route: unknown,
  index: number
): LifiRouteCanaryRoute {
  if (typeof route !== 'object' || route === null || Array.isArray(route)) {
    throw new Error(
      `AJNA_AGENT_LIFI_CANARY_ROUTES_JSON[${index}] must be an object`
    );
  }
  const label =
    'label' in route && route.label !== undefined
      ? route.label
      : `route-${index}`;
  if (typeof label !== 'string' || label.trim().length === 0) {
    throw new Error(
      `AJNA_AGENT_LIFI_CANARY_ROUTES_JSON[${index}].label must be a non-empty string`
    );
  }
  if (
    !('fromToken' in route) ||
    !('toToken' in route) ||
    !('fromAmount' in route)
  ) {
    throw new Error(
      `AJNA_AGENT_LIFI_CANARY_ROUTES_JSON[${index}] requires fromToken, toToken, and fromAmount`
    );
  }
  if (typeof route.fromToken !== 'string') {
    throw new Error(
      `AJNA_AGENT_LIFI_CANARY_ROUTES_JSON[${index}].fromToken must be an address`
    );
  }
  if (typeof route.toToken !== 'string') {
    throw new Error(
      `AJNA_AGENT_LIFI_CANARY_ROUTES_JSON[${index}].toToken must be an address`
    );
  }
  const fromAmount = parsePositiveRawAmount(
    route.fromAmount,
    `AJNA_AGENT_LIFI_CANARY_ROUTES_JSON[${index}].fromAmount`
  );
  const parsedRoute: LifiRouteCanaryRoute = {
    label,
    fromToken: normalizeAddress(
      route.fromToken,
      `AJNA_AGENT_LIFI_CANARY_ROUTES_JSON[${index}].fromToken`
    ),
    toToken: normalizeAddress(
      route.toToken,
      `AJNA_AGENT_LIFI_CANARY_ROUTES_JSON[${index}].toToken`
    ),
    fromAmount,
  };
  if ('takerAddress' in route && route.takerAddress !== undefined) {
    if (typeof route.takerAddress !== 'string') {
      throw new Error(
        `AJNA_AGENT_LIFI_CANARY_ROUTES_JSON[${index}].takerAddress must be an address`
      );
    }
    parsedRoute.takerAddress = normalizeAddress(
      route.takerAddress,
      `AJNA_AGENT_LIFI_CANARY_ROUTES_JSON[${index}].takerAddress`
    );
  }
  return parsedRoute;
}

function parseRoutesEnv(
  env: LifiRouteCanaryEnv,
  chainId: number
): LifiRouteCanaryRoute[] {
  const routesJson = optionalEnv(env, 'AJNA_AGENT_LIFI_CANARY_ROUTES_JSON');
  if (routesJson !== undefined) {
    const parsed = JSON.parse(routesJson);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error(
        'AJNA_AGENT_LIFI_CANARY_ROUTES_JSON must be a non-empty JSON array'
      );
    }
    return parsed.map((route, index) => parseRouteCandidate(route, index));
  }

  if (chainId !== BASE_CHAIN_ID) {
    throw new Error(
      'AJNA_AGENT_LIFI_CANARY_ROUTES_JSON is required when chainId is not Base'
    );
  }
  const fromToken = normalizeAddress(
    optionalEnv(env, 'AJNA_AGENT_LIFI_CANARY_FROM_TOKEN') ?? BASE_CADC,
    'AJNA_AGENT_LIFI_CANARY_FROM_TOKEN'
  );
  const toToken = normalizeAddress(
    optionalEnv(env, 'AJNA_AGENT_LIFI_CANARY_TO_TOKEN') ?? BASE_USDC,
    'AJNA_AGENT_LIFI_CANARY_TO_TOKEN'
  );
  const fromAmount = parsePositiveRawAmount(
    optionalEnv(env, 'AJNA_AGENT_LIFI_CANARY_FROM_AMOUNT_RAW') ??
      DEFAULT_BASE_CADC_AMOUNT_RAW,
    'AJNA_AGENT_LIFI_CANARY_FROM_AMOUNT_RAW'
  );
  return [
    {
      label:
        optionalEnv(env, 'AJNA_AGENT_LIFI_CANARY_ROUTE_LABEL') ?? 'CADC-USDC',
      fromToken,
      toToken,
      fromAmount,
    },
  ];
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
    return {
      ...configured,
      mode: 'production',
      apiBaseUrl,
      apiKeyEnvVar,
      quoteTimeoutMs,
      allowExchanges: allowExchanges ?? configured.allowExchanges,
      denyExchanges,
      preferExchanges,
      ...(allowBroadExchangeFilters === false
        ? { allowBroadExchangeFilters }
        : {}),
    };
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
  if (config.apiKeyEnvVar) {
    return optionalEnv(env, config.apiKeyEnvVar);
  }
  return (
    optionalEnv(env, 'AJNA_AGENT_LIFI_API_KEY') ??
    optionalEnv(env, 'AJNA_AGENT_LIFI_CANARY_API_KEY') ??
    optionalEnv(env, 'LIFI_API_KEY')
  );
}

function buildSkippedSummary(params: {
  chainId: number;
  apiBaseUrl: string;
  requireLive: boolean;
  error: string;
  takerAddress?: string;
}): LifiRouteCanarySummary {
  return {
    status: 'skipped',
    chainId: params.chainId,
    apiBaseUrl: params.apiBaseUrl,
    requireLive: params.requireLive,
    takerAddress: params.takerAddress,
    checks: [
      {
        label: 'canary-env',
        success: false,
        skipped: true,
        source: 'canary-env',
        error: params.error,
      },
    ],
    failureCount: 0,
  };
}

function skippedResult(
  summary: LifiRouteCanarySummary
): RunLifiRouteCanaryResult {
  return {
    summary,
    exitCode: summary.requireLive ? 1 : 0,
  };
}

function addObservedSelector(params: {
  targetMap: Record<string, string[]>;
  target: string;
  selector: string;
}): void {
  const selectors = (params.targetMap[params.target] ??= []);
  if (!selectors.includes(params.selector)) {
    selectors.push(params.selector);
    selectors.sort();
  }
}

function buildObservedSelectorTelemetry(
  checks: readonly LifiRouteCanaryCheck[]
): Pick<
  LifiRouteCanarySummary,
  'observedSelectorAllowlist' | 'observedSelectorsByTool'
> {
  const observedSelectorAllowlist: Record<
    string,
    Record<string, string[]>
  > = {};
  const observedSelectorsByTool: Record<
    string,
    Record<string, Record<string, string[]>>
  > = {};

  for (const check of checks) {
    if (
      !check.success ||
      check.source !== 'lifi-quote' ||
      check.chainId === undefined ||
      check.transactionTarget === undefined ||
      check.selector === undefined ||
      check.tool === undefined
    ) {
      continue;
    }
    const chainKey = String(check.chainId);
    const target = ethers.utils.getAddress(check.transactionTarget);
    const selector = check.selector.toLowerCase();
    const tool = check.tool.trim().toLowerCase();

    addObservedSelector({
      targetMap: (observedSelectorAllowlist[chainKey] ??= {}),
      target,
      selector,
    });
    const toolTargets = (observedSelectorsByTool[chainKey] ??= {});
    addObservedSelector({
      targetMap: (toolTargets[tool] ??= {}),
      target,
      selector,
    });
  }

  return Object.keys(observedSelectorAllowlist).length === 0
    ? {}
    : {
        observedSelectorAllowlist,
        observedSelectorsByTool,
      };
}

async function runLifiToolsCheck(params: {
  config: LifiDexConfig;
  apiKey?: string;
  deps?: LifiRouteCanaryDeps;
}): Promise<{ check: LifiRouteCanaryCheck; exchangeTools?: string[] }> {
  try {
    const filters = normalizeLifiExchangeFilters(params.config);
    const toolsResponse = await (params.deps?.fetchTools ?? fetchLifiTools)({
      config: params.config,
      apiKey: params.apiKey,
    });
    assertLifiToolsContainFilters({ filters, toolsResponse });
    return {
      check: {
        label: 'lifi-tools-filter-validation',
        success: true,
        source: 'lifi-tools',
      },
      exchangeTools: extractLifiExchangeToolKeys(toolsResponse),
    };
  } catch (error) {
    return {
      check: {
        label: 'lifi-tools-filter-validation',
        success: false,
        source: 'lifi-tools',
        error: getErrorMessage(error),
      },
    };
  }
}

function hasBroadExchangeFilter(config: LifiDexConfig): boolean {
  return [
    ...(config.allowExchanges ?? []),
    ...(config.denyExchanges ?? []),
    ...(config.preferExchanges ?? []),
  ].some((value) => isBroadLifiExchangeFilter(value));
}

async function runLifiQuoteCheck(params: {
  config: LifiDexConfig;
  apiKey?: string;
  chainId: number;
  route: LifiRouteCanaryRoute;
  takerAddress: string;
  callTargets: string[];
  approvalSpenders: string[];
  selectorAllowlist: Record<string, string[]>;
  validationExchangeTools?: string[];
  deps?: LifiRouteCanaryDeps;
}): Promise<LifiRouteCanaryCheck> {
  const routeTaker = params.route.takerAddress ?? params.takerAddress;
  try {
    if (params.callTargets.length === 0) {
      throw new Error('LI.FI call target allowlist is required');
    }
    if (params.approvalSpenders.length === 0) {
      throw new Error('LI.FI approval spender allowlist is required');
    }
    if (Object.keys(params.selectorAllowlist).length === 0) {
      throw new Error('LI.FI selector allowlist is required');
    }
    const result = await (params.deps?.fetchQuote ?? fetchLifiQuote)({
      config: params.config,
      apiKey: params.apiKey,
      request: {
        chainId: params.chainId,
        fromToken: params.route.fromToken,
        toToken: params.route.toToken,
        fromAmount: params.route.fromAmount,
        fromAddress: routeTaker,
        toAddress: routeTaker,
        slippage: params.config.defaultSlippage,
        maxPriceImpact: params.config.maxPriceImpact,
      },
    });
    const approved = validateLifiQuote({
      quote: result.data,
      chainId: params.chainId,
      fromToken: params.route.fromToken,
      toToken: params.route.toToken,
      fromAmount: BigNumber.from(params.route.fromAmount),
      takerAddress: routeTaker,
      allowedExchangeTools:
        params.validationExchangeTools ?? params.config.allowExchanges ?? [],
      callTargetAllowlist: params.callTargets,
      approvalSpenderAllowlist: params.approvalSpenders,
      selectorAllowlist: params.selectorAllowlist,
      feeCostPolicy: params.config.feeCostPolicy,
    });
    return {
      label: params.route.label,
      success: true,
      source: 'lifi-quote',
      chainId: params.chainId,
      fromToken: params.route.fromToken,
      toToken: params.route.toToken,
      fromAmount: params.route.fromAmount,
      toAmountRaw: approved.quoteAmountRaw.toString(),
      toAmountMinRaw: approved.routeMinOutRaw.toString(),
      tool: approved.tool,
      topLevelTool: approved.topLevelTool,
      transactionTarget: approved.transactionTarget,
      approvalSpender: approved.approvalSpender,
      selector: approved.selector,
    };
  } catch (error) {
    return {
      label: params.route.label,
      success: false,
      source: 'lifi-quote',
      chainId: params.chainId,
      fromToken: params.route.fromToken,
      toToken: params.route.toToken,
      fromAmount: params.route.fromAmount,
      error: getErrorMessage(error),
    };
  }
}

export async function runLifiRouteCanary(
  input: RunLifiRouteCanaryInput = {}
): Promise<RunLifiRouteCanaryResult> {
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
  if (requireLive && !isDefaultLifiApiBaseUrl(apiBaseUrl)) {
    return skippedResult(
      buildSkippedSummary({
        chainId,
        apiBaseUrl,
        requireLive,
        error:
          'AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE requires the default LI.FI API base URL; refusing custom or mocked API base URL',
      })
    );
  }
  const requiredLivePolicyError = requireLive
    ? getRequiredLivePolicySourceError(env, input.config)
    : undefined;
  if (requiredLivePolicyError !== undefined) {
    return skippedResult(
      buildSkippedSummary({
        chainId,
        apiBaseUrl,
        requireLive,
        error: requiredLivePolicyError,
      })
    );
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
    return skippedResult(
      buildSkippedSummary({
        chainId,
        apiBaseUrl,
        requireLive,
        error:
          'Missing AJNA_AGENT_LIFI_CANARY_TAKER_ADDRESS or config.takers.contracts.Lifi',
      })
    );
  }
  if (!lifiConfig.allowExchanges || lifiConfig.allowExchanges.length === 0) {
    return skippedResult(
      buildSkippedSummary({
        chainId,
        apiBaseUrl,
        requireLive,
        takerAddress,
        error:
          'Missing AJNA_AGENT_LIFI_CANARY_ALLOW_EXCHANGES or config.dex.lifi.allowExchanges; refusing broad LI.FI route discovery',
      })
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
    return skippedResult(
      buildSkippedSummary({
        chainId,
        apiBaseUrl,
        requireLive,
        takerAddress,
        error: requiredLiveRouteTakerOverrideError,
      })
    );
  }
  const apiKey = getApiKey(env, lifiConfig);
  const toolsResult = await runLifiToolsCheck({
    config: lifiConfig,
    apiKey,
    deps: input.deps,
  });
  const checks: LifiRouteCanaryCheck[] = [toolsResult.check];
  const validationExchangeTools =
    hasBroadExchangeFilter(lifiConfig) && toolsResult.exchangeTools
      ? toolsResult.exchangeTools
      : undefined;

  for (const route of routes) {
    checks.push(
      await runLifiQuoteCheck({
        config: lifiConfig,
        apiKey,
        chainId,
        route,
        takerAddress,
        callTargets,
        approvalSpenders,
        selectorAllowlist,
        validationExchangeTools,
        deps: input.deps,
      })
    );
  }

  const failureCount = checks.filter((check) => !check.success).length;
  const selectorTelemetry = buildObservedSelectorTelemetry(checks);
  const summary: LifiRouteCanarySummary = {
    status: failureCount === 0 ? 'passed' : 'failed',
    chainId,
    apiBaseUrl,
    requireLive,
    takerAddress,
    checks,
    ...selectorTelemetry,
    failureCount,
  };
  return {
    summary,
    exitCode: failureCount > 0 ? 1 : 0,
  };
}
