import { ethers } from 'ethers';

const ZERO_ADDRESS = ethers.constants.AddressZero.toLowerCase();

export function normalizeLifiAddressAllowlist(
  addresses: readonly string[] | undefined,
  params: {
    label: string;
    requireNonEmpty?: boolean;
  }
): string[] {
  if (addresses === undefined) {
    if (params.requireNonEmpty) {
      throw new Error(`${params.label} must be non-empty`);
    }
    return [];
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const address of addresses) {
    if (typeof address !== 'string' || !ethers.utils.isAddress(address)) {
      throw new Error(
        `${params.label} contains invalid address ${String(address)}`
      );
    }
    const normalizedAddress = ethers.utils.getAddress(address).toLowerCase();
    if (normalizedAddress === ZERO_ADDRESS) {
      throw new Error(`${params.label} cannot contain zero address`);
    }
    if (seen.has(normalizedAddress)) {
      throw new Error(`${params.label} cannot contain duplicate addresses`);
    }
    seen.add(normalizedAddress);
    normalized.push(ethers.utils.getAddress(address));
  }

  if (params.requireNonEmpty && normalized.length === 0) {
    throw new Error(`${params.label} must be non-empty`);
  }
  return normalized;
}

export function normalizeLifiAddressAllowlistSet(
  addresses: readonly string[],
  label: string
): Set<string> {
  return new Set(
    normalizeLifiAddressAllowlist(addresses, {
      label,
      requireNonEmpty: true,
    }).map((address) => address.toLowerCase())
  );
}
