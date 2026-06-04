import { ethers } from 'ethers';
import { normalizeLifiAddressAllowlist } from './address-allowlist';

export type LifiSelectorAllowlist = Record<string, readonly string[]>;

export function normalizeLifiSelectorAllowlist(
  selectorAllowlist: LifiSelectorAllowlist | undefined,
  params: {
    label?: string;
    requireNonEmpty?: boolean;
    callTargetAllowlist?: readonly string[];
    requireCallTargetCoverage?: boolean;
  } = {}
): Map<string, Set<string>> {
  const label = params.label ?? 'LI.FI selector allowlist';
  const callTargetAllowlist = params.callTargetAllowlist
    ? new Set(
        normalizeLifiAddressAllowlist(params.callTargetAllowlist, {
          label: `${label} callTargetAllowlist`,
          requireNonEmpty: true,
        }).map((target) => target.toLowerCase())
      )
    : undefined;
  const entries = Object.entries(selectorAllowlist ?? {});
  if (params.requireNonEmpty && entries.length === 0) {
    throw new Error(`${label} must be non-empty`);
  }

  const normalized = new Map<string, Set<string>>();
  for (const [target, selectors] of entries) {
    if (!ethers.utils.isAddress(target)) {
      throw new Error(`${label} target is invalid: ${target}`);
    }
    const targetKey = ethers.utils.getAddress(target).toLowerCase();
    if (
      callTargetAllowlist !== undefined &&
      !callTargetAllowlist.has(targetKey)
    ) {
      throw new Error(
        `${label}.${target} is not present in callTargetAllowlist`
      );
    }
    if (!Array.isArray(selectors) || selectors.length === 0) {
      throw new Error(`${label} for ${target} must be non-empty`);
    }

    const normalizedSelectors = new Set<string>();
    for (const selector of selectors) {
      if (
        typeof selector !== 'string' ||
        !/^0x[0-9a-fA-F]{8}$/.test(selector)
      ) {
        throw new Error(`${label} entry is invalid: ${String(selector)}`);
      }
      const normalizedSelector = selector.toLowerCase();
      if (normalizedSelectors.has(normalizedSelector)) {
        throw new Error(
          `${label} for ${target} cannot contain duplicate selector ${normalizedSelector}`
        );
      }
      normalizedSelectors.add(normalizedSelector);
    }
    normalized.set(targetKey, normalizedSelectors);
  }

  if (params.requireCallTargetCoverage && callTargetAllowlist !== undefined) {
    for (const callTarget of Array.from(callTargetAllowlist)) {
      if (!normalized.has(callTarget)) {
        throw new Error(
          `${label} must include selectors for every configured LI.FI call target`
        );
      }
    }
  }

  return normalized;
}

export function normalizeLifiSelectorAllowlistRecord(
  selectorAllowlist: LifiSelectorAllowlist | undefined,
  params: {
    label?: string;
    requireNonEmpty?: boolean;
    callTargetAllowlist?: readonly string[];
    requireCallTargetCoverage?: boolean;
  } = {}
): Record<string, string[]> {
  const normalized = normalizeLifiSelectorAllowlist(selectorAllowlist, params);
  const record: Record<string, string[]> = {};
  for (const [target, selectors] of Array.from(normalized.entries())) {
    record[target] = Array.from(selectors);
  }
  return record;
}
