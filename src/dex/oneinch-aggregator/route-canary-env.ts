import { BigNumber, ethers } from 'ethers';

export type OneInchRouteCanaryEnv = Record<string, string | undefined>;

export const BASE_CHAIN_ID = 8453;
export const BASE_CADC = '0x043eb4b75d0805c43d7c834902e335621983cf03';
export const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const BASE_WETH = '0x4200000000000000000000000000000000000006';
// Canonical Base 1inch aggregation router. Lives in src so production canary
// code never reaches up into scripts/; the no-spend fixture-constants module
// re-exports it (scripts -> src is the correct dependency direction).
export const BASE_ONEINCH_ROUTER =
  '0x1111111254EEB25477B68fb85Ed929f73A960582';
export const BASE_UNISWAP_V3_QUOTER_V2 =
  '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a';

export const DEFAULT_CADC_QUOTE_AMOUNTS_WAD = [
  '6750734311152542852',
  '4283573040064348752',
];
export const DEFAULT_CADC_SWAP_AMOUNT_WAD = '4283573040064348752';
export const DEFAULT_WETH_GAS_QUOTE_AMOUNT_RAW = '1000000000000000';
export const DEFAULT_UNISWAP_V3_FEE_TIERS = [3000, 100, 500, 10000];
export const DEFAULT_FIXTURE_COLLATERAL_AMOUNT_WAD = '1000000000000000000';

export function optionalEnv(
  env: OneInchRouteCanaryEnv,
  name: string,
  fallback?: string
): string | undefined {
  const value = env[name];
  return value === undefined || value.length === 0 ? fallback : value;
}

export function usableSecretEnv(
  env: OneInchRouteCanaryEnv,
  name: string
): string | undefined {
  const value = optionalEnv(env, name);
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    /^\?+$/.test(trimmed) ||
    /^your[-_ ]?key[-_ ]?here$/i.test(trimmed) ||
    /^\[.*\]$/.test(trimmed)
  ) {
    return undefined;
  }
  return value;
}

export function normalizeAddressEnv(
  env: OneInchRouteCanaryEnv,
  name: string,
  fallback: string
): string {
  return ethers.utils.getAddress(optionalEnv(env, name, fallback)!);
}

export function parsePositiveIntegerEnv(
  env: OneInchRouteCanaryEnv,
  name: string,
  fallback: string
): number {
  const value = Number(optionalEnv(env, name, fallback));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function parseAmountListEnv(
  env: OneInchRouteCanaryEnv,
  name: string,
  fallback: string[]
): string[] {
  const raw = optionalEnv(env, name);
  if (raw === undefined) {
    return fallback;
  }
  const values = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (values.length === 0) {
    throw new Error(`${name} must contain at least one comma-separated amount`);
  }
  for (const value of values) {
    BigNumber.from(value);
  }
  return values;
}

export function parseFeeTierListEnv(
  env: OneInchRouteCanaryEnv,
  name: string,
  fallback: number[]
): number[] {
  const raw = optionalEnv(env, name);
  const values =
    raw === undefined
      ? fallback
      : raw
          .split(',')
          .map((part) => Number(part.trim()))
          .filter((value) => Number.isFinite(value));
  if (values.length === 0) {
    throw new Error(`${name} must contain at least one fee tier`);
  }
  for (const value of values) {
    if (!Number.isInteger(value) || value <= 0 || value > 1_000_000) {
      throw new Error(`${name} contains invalid fee tier ${value}`);
    }
  }
  return Array.from(new Set(values));
}

export function parseAddressListEnv(
  env: OneInchRouteCanaryEnv,
  name: string
): string[] | undefined {
  const raw = optionalEnv(env, name);
  if (raw === undefined) {
    return undefined;
  }
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((address) => ethers.utils.getAddress(address));
}

export function parseSlippageEnv(
  env: OneInchRouteCanaryEnv,
  name: string,
  fallback: string
): number {
  const slippage = Number(optionalEnv(env, name, fallback));
  if (!Number.isFinite(slippage) || slippage < 0 || slippage > 100) {
    throw new Error(`${name} must be 0..100`);
  }
  return slippage;
}

export function resolveBaseRpcUrl(
  env: OneInchRouteCanaryEnv
): string | undefined {
  const explicitRpcUrl =
    optionalEnv(env, 'AJNA_AGENT_RPC_URL') ??
    optionalEnv(env, 'AJNA_RPC_URL_BASE') ??
    optionalEnv(env, 'BASE_RPC_URL');
  if (explicitRpcUrl !== undefined) {
    return explicitRpcUrl;
  }
  const alchemyApiKey = usableSecretEnv(env, 'ALCHEMY_API_KEY');
  return alchemyApiKey === undefined
    ? undefined
    : `https://base-mainnet.g.alchemy.com/v2/${alchemyApiKey}`;
}
