import { BigNumber, ethers } from 'ethers';

export type LifiRouteCanaryRoute = {
  label: string;
  fromToken: string;
  toToken: string;
  fromAmount: string;
  takerAddress?: string;
};

export type LifiRouteCanaryEnv = Record<string, string | undefined>;

export const DEFAULT_LIFI_CANARY_CHAIN_ID = 8453;
const BASE_CADC = '0x043eb4b75d0805c43d7c834902e335621983cf03';
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const DEFAULT_BASE_CADC_AMOUNT_RAW = '4283573040064348752';

export function optionalEnv(
  env: LifiRouteCanaryEnv,
  name: string
): string | undefined {
  const value = env[name];
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

export function parseBooleanEnv(
  env: LifiRouteCanaryEnv,
  name: string
): boolean {
  const value = optionalEnv(env, name);
  if (value === undefined) {
    return false;
  }
  return ['1', 'true', 'yes'].includes(value.trim().toLowerCase());
}

export function parsePositiveIntegerEnv(
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

export function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

export function parseCsvEnv(
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

export function normalizeAddress(value: string, label: string): string {
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

export function parseSelectorAllowlistEnv(
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

export function parseRoutesEnv(
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

  if (chainId !== DEFAULT_LIFI_CANARY_CHAIN_ID) {
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
