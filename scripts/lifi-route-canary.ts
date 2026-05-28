#!/usr/bin/env ts-node

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import yargs from 'yargs/yargs';
import { BigNumber, ethers } from 'ethers';
import { KeeperConfig, LifiDexConfig, readConfigFile } from '../src/config';
import { normalizeLifiApiBaseUrl } from '../src/config/lifi-policy';
import {
  DEFAULT_LIFI_API_BASE_URL,
  assertLifiToolsContainFilters,
  extractLifiExchangeToolKeys,
  fetchLifiQuote,
  fetchLifiTools,
  isBroadLifiExchangeFilter,
  normalizeLifiAddressAllowlist,
  normalizeLifiSelectorAllowlistRecord,
  normalizeLifiExchangeFilters,
  validateLifiQuote,
} from '../src/dex/lifi';
import { getErrorMessage } from '../src/utils';

type LifiRouteCanaryCheck = {
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

type LifiRouteCanarySummary = {
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

type LifiRouteCanaryRoute = {
  label: string;
  fromToken: string;
  toToken: string;
  fromAmount: string;
  takerAddress?: string;
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

dotenv.config();

const argv = yargs(process.argv.slice(2))
  .options({
    config: {
      type: 'string',
      describe:
        'Optional keeper config path. When provided, dex.lifi and takers.contracts.Lifi seed the canary policy.',
    },
  })
  .parseSync();

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

function parseBooleanEnv(name: string): boolean {
  const value = optionalEnv(name);
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

function getSetEnvNames(names: readonly string[]): string[] {
  return names.filter((name) => optionalEnv(name) !== undefined);
}

function getRequiredLivePolicySourceError(
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
  if (
    (config.dex.lifi as { allowBroadExchangeFilters?: unknown })
      .allowBroadExchangeFilters === true
  ) {
    return 'AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE requires concrete production LI.FI exchange filters; config.dex.lifi.allowBroadExchangeFilters is canary-only';
  }
  if (hasBroadExchangeFilter(config.dex.lifi)) {
    return 'AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE requires concrete production LI.FI exchange filters; broad filter keywords are not allowed';
  }
  const incompletePolicyError = getRequiredLiveProductionPolicyError(
    config.dex.lifi
  );
  if (incompletePolicyError !== undefined) {
    return incompletePolicyError;
  }

  const overrides = getSetEnvNames(REQUIRED_LIVE_POLICY_OVERRIDE_ENVS);
  if (overrides.length > 0) {
    return `AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE does not allow LI.FI policy env overrides: ${overrides.join(', ')}`;
  }
  return undefined;
}

function getRequiredLiveProductionPolicyError(
  lifi: Extract<LifiDexConfig, { mode: 'production' }>
): string | undefined {
  const chainKeys = new Set<string>();
  for (const { label, value } of [
    {
      label: 'config.dex.lifi.callTargetAllowlist',
      value: lifi.callTargetAllowlist,
    },
    {
      label: 'config.dex.lifi.approvalSpenderAllowlist',
      value: lifi.approvalSpenderAllowlist,
    },
    { label: 'config.dex.lifi.selectorAllowlist', value: lifi.selectorAllowlist },
  ]) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return `AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE requires complete production LI.FI policy for every configured chain: ${label} is required`;
    }
    for (const chainKey of Object.keys(value)) {
      chainKeys.add(chainKey);
    }
  }

  if (chainKeys.size === 0) {
    return 'AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE requires at least one complete production LI.FI chain policy';
  }

  for (const chainKey of Array.from(chainKeys).sort()) {
    try {
      const chainId = parsePositiveInteger(
        chainKey,
        `config.dex.lifi chain ${chainKey}`
      );
      const callTargets = normalizeLifiAddressAllowlist(
        lifi.callTargetAllowlist?.[chainId],
        {
          label: `config.dex.lifi.callTargetAllowlist.${chainId}`,
          requireNonEmpty: true,
        }
      );
      normalizeLifiAddressAllowlist(lifi.approvalSpenderAllowlist?.[chainId], {
        label: `config.dex.lifi.approvalSpenderAllowlist.${chainId}`,
        requireNonEmpty: true,
      });
      normalizeLifiSelectorAllowlistRecord(lifi.selectorAllowlist?.[chainId], {
        label: `config.dex.lifi.selectorAllowlist.${chainId}`,
        requireNonEmpty: true,
        callTargetAllowlist: callTargets,
        requireCallTargetCoverage: true,
      });
    } catch (error) {
      return `AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE requires complete production LI.FI policy for every configured chain: ${getErrorMessage(error)}`;
    }
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

function parsePositiveIntegerEnv(name: string, fallback: string): number {
  const value = Number(optionalEnv(name) ?? fallback);
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
  const lifi = config?.dex?.lifi;
  if (lifi?.mode !== 'production') {
    return [];
  }
  const getChainIds = (record: unknown): number[] => {
    if (typeof record !== 'object' || record === null || Array.isArray(record)) {
      return [];
    }
    return Object.keys(record)
      .map(Number)
      .filter((chainId) => Number.isInteger(chainId) && chainId > 0);
  };
  const chainSets = [
    new Set(getChainIds(lifi.callTargetAllowlist)),
    new Set(getChainIds(lifi.approvalSpenderAllowlist)),
    new Set(getChainIds(lifi.selectorAllowlist)),
  ];
  const [first, ...rest] = chainSets;
  return Array.from(first)
    .filter((chainId) => rest.every((chainSet) => chainSet.has(chainId)))
    .sort((a, b) => a - b);
}

function resolveCanaryChainId(config: KeeperConfig | undefined): number {
  const explicit = optionalEnv('AJNA_AGENT_LIFI_CANARY_CHAIN_ID');
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

function parseCsvEnv(name: string): string[] | undefined {
  const raw = optionalEnv(name);
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

function normalizeAddressList(values: string[] | undefined): string[] {
  return normalizeLifiAddressAllowlist(values, {
    label: 'LI.FI address allowlist',
  });
}

function parseSelectorAllowlistEnv(
  name: string
): Record<string, string[]> | undefined {
  const raw = optionalEnv(name);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object of target to selectors`);
  }
  return normalizeLifiSelectorAllowlistRecord(
    parsed as Record<string, readonly string[]>,
    { label: name, requireNonEmpty: true }
  );
}

function parseRoutesEnv(chainId: number): LifiRouteCanaryRoute[] {
  const routesJson = optionalEnv('AJNA_AGENT_LIFI_CANARY_ROUTES_JSON');
  if (routesJson !== undefined) {
    const parsed = JSON.parse(routesJson);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error(
        'AJNA_AGENT_LIFI_CANARY_ROUTES_JSON must be a non-empty JSON array'
      );
    }
    return parsed.map((route, index) => {
      if (typeof route !== 'object' || route === null || Array.isArray(route)) {
        throw new Error(
          `AJNA_AGENT_LIFI_CANARY_ROUTES_JSON[${index}] must be an object`
        );
      }
      const typed = route as Partial<LifiRouteCanaryRoute>;
      if (
        typed.fromToken === undefined ||
        typed.toToken === undefined ||
        typed.fromAmount === undefined
      ) {
        throw new Error(
          `AJNA_AGENT_LIFI_CANARY_ROUTES_JSON[${index}] requires fromToken, toToken, and fromAmount`
        );
      }
      const fromAmount = parsePositiveRawAmount(
        typed.fromAmount,
        `AJNA_AGENT_LIFI_CANARY_ROUTES_JSON[${index}].fromAmount`
      );
      return {
        label: typed.label ?? `route-${index}`,
        fromToken: normalizeAddress(
          typed.fromToken,
          `AJNA_AGENT_LIFI_CANARY_ROUTES_JSON[${index}].fromToken`
        ),
        toToken: normalizeAddress(
          typed.toToken,
          `AJNA_AGENT_LIFI_CANARY_ROUTES_JSON[${index}].toToken`
        ),
        fromAmount,
        ...(typed.takerAddress
          ? {
              takerAddress: normalizeAddress(
                typed.takerAddress,
                `AJNA_AGENT_LIFI_CANARY_ROUTES_JSON[${index}].takerAddress`
              ),
            }
          : {}),
      };
    });
  }

  if (chainId !== BASE_CHAIN_ID) {
    throw new Error(
      'AJNA_AGENT_LIFI_CANARY_ROUTES_JSON is required when chainId is not Base'
    );
  }
  const fromToken = normalizeAddress(
    optionalEnv('AJNA_AGENT_LIFI_CANARY_FROM_TOKEN') ?? BASE_CADC,
    'AJNA_AGENT_LIFI_CANARY_FROM_TOKEN'
  );
  const toToken = normalizeAddress(
    optionalEnv('AJNA_AGENT_LIFI_CANARY_TO_TOKEN') ?? BASE_USDC,
    'AJNA_AGENT_LIFI_CANARY_TO_TOKEN'
  );
  const fromAmount = parsePositiveRawAmount(
    optionalEnv('AJNA_AGENT_LIFI_CANARY_FROM_AMOUNT_RAW') ??
      DEFAULT_BASE_CADC_AMOUNT_RAW,
    'AJNA_AGENT_LIFI_CANARY_FROM_AMOUNT_RAW'
  );
  return [
    {
      label: optionalEnv('AJNA_AGENT_LIFI_CANARY_ROUTE_LABEL') ?? 'CADC-USDC',
      fromToken,
      toToken,
      fromAmount,
    },
  ];
}

function getChainAddressList(
  configValues: { [chainId: number]: string[] } | undefined,
  chainId: number,
  envName: string
): string[] {
  return normalizeAddressList(
    parseCsvEnv(envName) ?? configValues?.[chainId] ?? []
  );
}

function getSelectorAllowlist(params: {
  config: LifiDexConfig | undefined;
  chainId: number;
}): Record<string, string[]> {
  const fromEnv = parseSelectorAllowlistEnv(
    'AJNA_AGENT_LIFI_CANARY_SELECTOR_ALLOWLIST_JSON'
  );
  if (fromEnv !== undefined) {
    return fromEnv;
  }
  if (params.config?.mode === 'production') {
    return normalizeLifiSelectorAllowlistRecord(
      params.config.selectorAllowlist?.[params.chainId],
      {
        label: `config.dex.lifi.selectorAllowlist.${params.chainId}`,
        requireNonEmpty: true,
      }
    );
  }
  return normalizeLifiSelectorAllowlistRecord(undefined, {
    label: 'AJNA_AGENT_LIFI_CANARY_SELECTOR_ALLOWLIST_JSON',
    requireNonEmpty: true,
  });
}

function requireNonEmptyCanaryAllowlists(params: {
  callTargets: readonly string[];
  approvalSpenders: readonly string[];
  selectorAllowlist: Record<string, readonly string[]>;
}): void {
  if (params.callTargets.length === 0) {
    throw new Error('LI.FI call target allowlist is required');
  }
  if (params.approvalSpenders.length === 0) {
    throw new Error('LI.FI approval spender allowlist is required');
  }
  normalizeLifiSelectorAllowlistRecord(params.selectorAllowlist, {
    label: 'LI.FI selector allowlist',
    requireNonEmpty: true,
    callTargetAllowlist: params.callTargets,
    requireCallTargetCoverage: true,
  });
}

function buildLifiConfig(params: {
  config: KeeperConfig | undefined;
  chainId: number;
}): LifiDexConfig {
  const configured = params.config?.dex?.lifi;
  const allowExchanges =
    parseCsvEnv('AJNA_AGENT_LIFI_CANARY_ALLOW_EXCHANGES') ??
    configured?.allowExchanges;
  const denyExchanges =
    parseCsvEnv('AJNA_AGENT_LIFI_CANARY_DENY_EXCHANGES') ??
    configured?.denyExchanges;
  const preferExchanges =
    parseCsvEnv('AJNA_AGENT_LIFI_CANARY_PREFER_EXCHANGES') ??
    configured?.preferExchanges;
  const allowBroadExchangeFiltersEnv = optionalEnv(
    'AJNA_AGENT_LIFI_CANARY_ALLOW_BROAD_EXCHANGE_FILTERS'
  );
  const allowBroadExchangeFilters =
    allowBroadExchangeFiltersEnv !== undefined
      ? parseBooleanEnv('AJNA_AGENT_LIFI_CANARY_ALLOW_BROAD_EXCHANGE_FILTERS')
      : configured?.allowBroadExchangeFilters === true;

  return {
    ...(configured ?? { mode: 'canary' as const }),
    mode: configured?.mode ?? 'canary',
    apiBaseUrl:
      optionalEnv('AJNA_AGENT_LIFI_CANARY_API_BASE_URL') ??
      configured?.apiBaseUrl,
    apiKeyEnvVar:
      optionalEnv('AJNA_AGENT_LIFI_CANARY_API_KEY_ENV_VAR') ??
      configured?.apiKeyEnvVar,
    quoteTimeoutMs:
      optionalEnv('AJNA_AGENT_LIFI_CANARY_TIMEOUT_MS') !== undefined
        ? parsePositiveIntegerEnv('AJNA_AGENT_LIFI_CANARY_TIMEOUT_MS', '5000')
        : configured?.quoteTimeoutMs,
    allowExchanges,
    denyExchanges,
    preferExchanges,
    allowBroadExchangeFilters,
  } as LifiDexConfig;
}

function getApiKey(config: LifiDexConfig): string | undefined {
  if (config.apiKeyEnvVar) {
    return optionalEnv(config.apiKeyEnvVar);
  }
  return (
    optionalEnv('AJNA_AGENT_LIFI_API_KEY') ??
    optionalEnv('AJNA_AGENT_LIFI_CANARY_API_KEY') ??
    optionalEnv('LIFI_API_KEY')
  );
}

function writeSummaryIfRequested(summary: LifiRouteCanarySummary): void {
  const outputPath = optionalEnv('AJNA_AGENT_LIFI_CANARY_OUTPUT_PATH');
  if (!outputPath) {
    return;
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
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

function emitSummary(summary: LifiRouteCanarySummary): void {
  writeSummaryIfRequested(summary);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

function emitSkippedSummary(summary: LifiRouteCanarySummary): void {
  emitSummary(summary);
  if (summary.requireLive) {
    process.exitCode = 1;
  }
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
}): Promise<{ check: LifiRouteCanaryCheck; exchangeTools?: string[] }> {
  try {
    const filters = normalizeLifiExchangeFilters(params.config);
    const toolsResponse = await fetchLifiTools({
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
    const result = await fetchLifiQuote({
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

async function main(): Promise<void> {
  const config = argv.config ? await readConfigFile(argv.config) : undefined;
  const requireLive = parseBooleanEnv('AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE');
  const chainId = resolveCanaryChainId(config);
  const lifiConfig = buildLifiConfig({ config, chainId });
  const apiBaseUrl = lifiConfig.apiBaseUrl ?? DEFAULT_LIFI_API_BASE_URL;
  if (requireLive && !isDefaultLifiApiBaseUrl(apiBaseUrl)) {
    const skipped = buildSkippedSummary({
      chainId,
      apiBaseUrl,
      requireLive,
      error:
        'AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE requires the default LI.FI API base URL; refusing custom or mocked API base URL',
    });
    emitSkippedSummary(skipped);
    return;
  }
  const requiredLivePolicyError = requireLive
    ? getRequiredLivePolicySourceError(config)
    : undefined;
  if (requiredLivePolicyError !== undefined) {
    const skipped = buildSkippedSummary({
      chainId,
      apiBaseUrl,
      requireLive,
      error: requiredLivePolicyError,
    });
    emitSkippedSummary(skipped);
    return;
  }
  const takerAddressValue =
    optionalEnv('AJNA_AGENT_LIFI_CANARY_TAKER_ADDRESS') ??
    config?.takers?.contracts?.Lifi;
  const takerAddress = takerAddressValue
    ? normalizeAddress(
        takerAddressValue,
        'AJNA_AGENT_LIFI_CANARY_TAKER_ADDRESS'
      )
    : undefined;

  if (!takerAddress) {
    const skipped = buildSkippedSummary({
      chainId,
      apiBaseUrl,
      requireLive,
      error:
        'Missing AJNA_AGENT_LIFI_CANARY_TAKER_ADDRESS or config.takers.contracts.Lifi',
    });
    emitSkippedSummary(skipped);
    return;
  }
  if (!lifiConfig.allowExchanges || lifiConfig.allowExchanges.length === 0) {
    const skipped = buildSkippedSummary({
      chainId,
      apiBaseUrl,
      requireLive,
      takerAddress,
      error:
        'Missing AJNA_AGENT_LIFI_CANARY_ALLOW_EXCHANGES or config.dex.lifi.allowExchanges; refusing broad LI.FI route discovery',
    });
    emitSkippedSummary(skipped);
    return;
  }

  const callTargets = getChainAddressList(
    lifiConfig.callTargetAllowlist,
    chainId,
    'AJNA_AGENT_LIFI_CANARY_CALL_TARGET_ALLOWLIST'
  );
  const approvalSpenders = getChainAddressList(
    lifiConfig.approvalSpenderAllowlist,
    chainId,
    'AJNA_AGENT_LIFI_CANARY_APPROVAL_SPENDER_ALLOWLIST'
  );
  const selectorAllowlist = getSelectorAllowlist({
    config: lifiConfig,
    chainId,
  });
  const routes = parseRoutesEnv(chainId);
  const requiredLiveRouteTakerOverrideError = requireLive
    ? getRequiredLiveRouteTakerOverrideError(routes)
    : undefined;
  if (requiredLiveRouteTakerOverrideError !== undefined) {
    const skipped = buildSkippedSummary({
      chainId,
      apiBaseUrl,
      requireLive,
      takerAddress,
      error: requiredLiveRouteTakerOverrideError,
    });
    emitSkippedSummary(skipped);
    return;
  }
  requireNonEmptyCanaryAllowlists({
    callTargets,
    approvalSpenders,
    selectorAllowlist,
  });
  const apiKey = getApiKey(lifiConfig);
  const toolsResult = await runLifiToolsCheck({ config: lifiConfig, apiKey });
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
  emitSummary(summary);
  if (failureCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(
    `LI.FI canary failed: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
});
