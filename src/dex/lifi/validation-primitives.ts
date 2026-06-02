import { BigNumber, ethers } from 'ethers';

const NATIVE_TOKEN_PLACEHOLDER = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

export const ZERO_ADDRESS = ethers.constants.AddressZero.toLowerCase();

export function requireObject<T extends object>(
  value: unknown,
  label: string
): T {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as T;
}

export function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export function requireAddress(value: unknown, label: string): string {
  const address = requireString(value, label);
  if (!ethers.utils.isAddress(address)) {
    throw new Error(`${label} must be an address`);
  }
  return ethers.utils.getAddress(address);
}

export function requirePositiveAmount(
  value: unknown,
  label: string
): BigNumber {
  const amount = requireString(value, label);
  if (!/^(0|[1-9]\d*)$/.test(amount)) {
    throw new Error(`${label} must be a decimal integer string`);
  }
  const parsed = BigNumber.from(amount);
  if (parsed.lte(0)) {
    throw new Error(`${label} must be greater than zero`);
  }
  return parsed;
}

export function requireOptionalChainId(
  value: unknown,
  label: string
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

export function assertAddressEq(params: {
  actual: string;
  expected: string;
  label: string;
}): void {
  if (
    ethers.utils.getAddress(params.actual).toLowerCase() !==
    ethers.utils.getAddress(params.expected).toLowerCase()
  ) {
    throw new Error(`${params.label} mismatch`);
  }
}

export function assertOptionalAddressEq(params: {
  actual: unknown;
  expected: string;
  label: string;
}): void {
  if (params.actual === undefined) {
    return;
  }
  assertAddressEq({
    actual: requireAddress(params.actual, params.label),
    expected: params.expected,
    label: params.label,
  });
}

function isNativeTokenPlaceholder(address: string): boolean {
  const normalized = address.toLowerCase();
  return normalized === ZERO_ADDRESS || normalized === NATIVE_TOKEN_PLACEHOLDER;
}

export function assertTokenAddress(params: {
  token: unknown;
  expected: string;
  label: string;
  chainId: number;
}): void {
  const token = requireObject<{ address?: unknown; chainId?: unknown }>(
    params.token,
    params.label
  );
  const address = requireAddress(token.address, `${params.label}.address`);
  if (isNativeTokenPlaceholder(address)) {
    throw new Error(
      `${params.label}.address cannot be native token placeholder`
    );
  }
  assertAddressEq({
    actual: address,
    expected: params.expected,
    label: `${params.label}.address`,
  });
  const tokenChainId = requireOptionalChainId(
    token.chainId,
    `${params.label}.chainId`
  );
  if (tokenChainId !== undefined && tokenChainId !== params.chainId) {
    throw new Error(`${params.label}.chainId mismatch`);
  }
}
