import { constants, utils } from 'ethers';
import {
  KeeperConfig,
  LifiDexConfig,
  readConfigFile,
} from '../../../src/config';
import {
  getLifiPolicyApiKey,
  getSetLifiPolicyEnvNames,
  hasBroadLifiPolicyExchangeFilter,
  requireBoundedDecimalPolicy as requireBoundedLifiDecimalPolicy,
  requireDefaultLifiApiBaseUrl,
  requireOptionalBoundedDecimalPolicy as requireOptionalBoundedLifiDecimalPolicy,
  requirePositiveIntegerPolicy as requirePositiveIntegerLifiPolicy,
} from '../../../src/dex/lifi';
import { requireConcreteProductionLifiChainPolicy } from '../../../src/config/lifi-policy';

export type LifiForkCanaryEnv = Record<string, string | undefined>;

export type ForkCanaryLifiConfig = LifiDexConfig & {
  mode: 'production';
  configuredFactoryAddress: string;
  configuredTakerAddress: string;
};

export const LIFI_FORK_CANARY_BASE_CHAIN_ID = 8453;
export const MAX_LIFI_FORK_CANARY_TIMEOUT_MS = 10_000;
export const MAX_LIFI_FORK_CANARY_SLIPPAGE = 0.5;
export const MAX_LIFI_FORK_CANARY_PRICE_IMPACT = 0.5;

export const LIFI_FORK_CANARY_CONFIG_ENVS = [
  'AJNA_AGENT_LIFI_FORK_CANARY_CONFIG',
  'AJNA_AGENT_LIFI_CANARY_CONFIG',
];

export const LIFI_FORK_CANARY_POLICY_OVERRIDE_ENVS = [
  'AJNA_AGENT_LIFI_FORK_CANARY_API_BASE_URL',
  'AJNA_AGENT_LIFI_CANARY_API_BASE_URL',
  'AJNA_AGENT_LIFI_FORK_CANARY_ALLOW_EXCHANGES',
  'AJNA_AGENT_LIFI_CANARY_ALLOW_EXCHANGES',
  'AJNA_AGENT_LIFI_FORK_CANARY_DENY_EXCHANGES',
  'AJNA_AGENT_LIFI_CANARY_DENY_EXCHANGES',
  'AJNA_AGENT_LIFI_FORK_CANARY_PREFER_EXCHANGES',
  'AJNA_AGENT_LIFI_CANARY_PREFER_EXCHANGES',
  'AJNA_AGENT_LIFI_FORK_CANARY_CALL_TARGET_ALLOWLIST',
  'AJNA_AGENT_LIFI_CANARY_CALL_TARGET_ALLOWLIST',
  'AJNA_AGENT_LIFI_FORK_CANARY_APPROVAL_SPENDER_ALLOWLIST',
  'AJNA_AGENT_LIFI_CANARY_APPROVAL_SPENDER_ALLOWLIST',
  'AJNA_AGENT_LIFI_FORK_CANARY_SELECTOR_ALLOWLIST_JSON',
  'AJNA_AGENT_LIFI_CANARY_SELECTOR_ALLOWLIST_JSON',
  'AJNA_AGENT_LIFI_FORK_CANARY_TIMEOUT_MS',
  'AJNA_AGENT_LIFI_CANARY_TIMEOUT_MS',
  'AJNA_AGENT_LIFI_FORK_CANARY_SLIPPAGE',
  'AJNA_AGENT_LIFI_CANARY_SLIPPAGE',
  'AJNA_AGENT_LIFI_FORK_CANARY_MAX_PRICE_IMPACT',
  'AJNA_AGENT_LIFI_CANARY_MAX_PRICE_IMPACT',
];

export function optionalForkCanaryEnv(
  env: LifiForkCanaryEnv,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

export function getSetForkCanaryEnvNames(
  env: LifiForkCanaryEnv,
  names: readonly string[]
): string[] {
  return getSetLifiPolicyEnvNames({
    env,
    names,
    readEnv: optionalForkCanaryEnv,
  });
}

export async function loadLifiForkCanaryKeeperConfig(
  env: LifiForkCanaryEnv = process.env
): Promise<KeeperConfig> {
  const configPath = optionalForkCanaryEnv(
    env,
    ...LIFI_FORK_CANARY_CONFIG_ENVS
  );
  if (!configPath) {
    throw new Error(
      `${LIFI_FORK_CANARY_CONFIG_ENVS.join(' or ')} is required for RUN_LIFI_FORK_CANARY=true`
    );
  }
  return readConfigFile(configPath);
}

export function requireDefaultLifiForkApiBaseUrl(
  apiBaseUrl: string | undefined
): void {
  requireDefaultLifiApiBaseUrl({
    apiBaseUrl,
    errorMessage:
      'LI.FI fork canary requires the default LI.FI API base URL; refusing custom or mocked API base URL',
  });
}

function requireConfiguredAddress(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`LI.FI fork canary requires ${label}`);
  }
  let normalized: string;
  try {
    normalized = utils.getAddress(value);
  } catch {
    throw new Error(`LI.FI fork canary ${label} must be an address`);
  }
  if (normalized === constants.AddressZero) {
    throw new Error(`LI.FI fork canary ${label} cannot be zero address`);
  }
  return normalized;
}

export function hasBroadForkExchangeFilter(config: LifiDexConfig): boolean {
  return hasBroadLifiPolicyExchangeFilter(config);
}

export function requirePositiveIntegerPolicy(params: {
  value: number | undefined;
  fallback: number;
  max: number;
  label: string;
}): number {
  return requirePositiveIntegerLifiPolicy(params);
}

export function requireBoundedDecimalPolicy(params: {
  value: number | undefined;
  fallback: number;
  max: number;
  label: string;
}): number {
  return requireBoundedLifiDecimalPolicy(params);
}

export function requireOptionalBoundedDecimalPolicy(params: {
  value: number | undefined;
  max: number;
  label: string;
}): number | undefined {
  return requireOptionalBoundedLifiDecimalPolicy(params);
}

export function getLifiForkCanaryApiKey(
  config: LifiDexConfig,
  env: LifiForkCanaryEnv = process.env
): string | undefined {
  return getLifiPolicyApiKey({
    config,
    env,
    fallbackEnvNames: [
      'AJNA_AGENT_LIFI_API_KEY',
      'AJNA_AGENT_LIFI_FORK_CANARY_API_KEY',
      'AJNA_AGENT_LIFI_CANARY_API_KEY',
      'LIFI_API_KEY',
    ],
    readEnv: optionalForkCanaryEnv,
  });
}

export function resolveLifiForkCanaryConfig(params: {
  keeperConfig: KeeperConfig;
  env?: LifiForkCanaryEnv;
  chainId?: number;
}): ForkCanaryLifiConfig {
  const env = params.env ?? process.env;
  const chainId = params.chainId ?? LIFI_FORK_CANARY_BASE_CHAIN_ID;
  const overrides = getSetForkCanaryEnvNames(
    env,
    LIFI_FORK_CANARY_POLICY_OVERRIDE_ENVS
  );
  if (overrides.length > 0) {
    throw new Error(
      `LI.FI fork canary requires reviewed production keeper config; refusing LI.FI policy env overrides: ${overrides.join(', ')}`
    );
  }

  const configured = params.keeperConfig.dex?.lifi;
  if (!configured || configured.mode !== 'production') {
    throw new Error(
      'LI.FI fork canary requires reviewed production keeper config with production dex.lifi'
    );
  }
  if (!params.keeperConfig.takers?.factory) {
    throw new Error('LI.FI fork canary requires config.takers.factory');
  }
  if (!params.keeperConfig.takers?.contracts?.Lifi) {
    throw new Error('LI.FI fork canary requires config.takers.contracts.Lifi');
  }

  const configuredFactoryAddress = requireConfiguredAddress(
    params.keeperConfig.takers.factory,
    'config.takers.factory'
  );
  const configuredTakerAddress = requireConfiguredAddress(
    params.keeperConfig.takers.contracts.Lifi,
    'config.takers.contracts.Lifi'
  );
  requireDefaultLifiForkApiBaseUrl(configured.apiBaseUrl);
  const chainPolicy = requireConcreteProductionLifiChainPolicy({
    config: configured,
    chainId,
    fieldName: 'config.dex.lifi',
    context: 'LI.FI fork canary',
  });

  return {
    mode: 'production',
    configuredFactoryAddress,
    configuredTakerAddress,
    apiBaseUrl: configured.apiBaseUrl,
    apiKeyEnvVar: configured.apiKeyEnvVar,
    quoteTimeoutMs: requirePositiveIntegerPolicy({
      value: configured.quoteTimeoutMs,
      fallback: 10000,
      max: MAX_LIFI_FORK_CANARY_TIMEOUT_MS,
      label: 'config.dex.lifi.quoteTimeoutMs',
    }),
    defaultSlippage: requireBoundedDecimalPolicy({
      value: configured.defaultSlippage,
      fallback: 0.005,
      max: MAX_LIFI_FORK_CANARY_SLIPPAGE,
      label: 'config.dex.lifi.defaultSlippage',
    }),
    maxPriceImpact: requireOptionalBoundedDecimalPolicy({
      value: configured.maxPriceImpact,
      max: MAX_LIFI_FORK_CANARY_PRICE_IMPACT,
      label: 'config.dex.lifi.maxPriceImpact',
    }),
    allowExchanges: configured.allowExchanges,
    denyExchanges: configured.denyExchanges,
    preferExchanges: configured.preferExchanges,
    feeCostPolicy: configured.feeCostPolicy,
    callTargetAllowlist: {
      [chainId]: chainPolicy.callTargets,
    },
    approvalSpenderAllowlist: {
      [chainId]: chainPolicy.approvalSpenders,
    },
    selectorAllowlist: {
      [chainId]: chainPolicy.selectorAllowlist,
    },
  };
}
