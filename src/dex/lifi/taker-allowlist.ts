import { ethers } from 'ethers';
import type { NormalizedLifiAllowlistPolicy } from './chain-policy';
import { normalizeLifiAddressAllowlist } from './address-allowlist';
import { normalizeLifiSelectorAllowlistRecord } from './selector-allowlist';

export const LIFI_TAKER_ALLOWLIST_ABI = [
  'function getAllowedCallTargets() view returns (address[])',
  'function getAllowedApprovalSpenders() view returns (address[])',
  'function getAllowedCallSelectors(address target) view returns (bytes4[])',
];

export type LifiTakerAllowlistCompareMode = 'exact' | 'contains';

export type LifiSelectorEntry = { target: string; selector: string };

export interface LifiTakerAllowlistSnapshot {
  callTargets: string[];
  approvalSpenders: string[];
  selectorAllowlist: Record<string, string[]>;
  selectorTargets: string[];
}

export interface LifiAllowlistReconciliationPlan {
  callTargetsToEnable: string[];
  callTargetsToDisable: string[];
  approvalSpendersToEnable: string[];
  approvalSpendersToDisable: string[];
  selectorsToEnable: LifiSelectorEntry[];
  selectorsToDisable: LifiSelectorEntry[];
  selectorTargets: string[];
}

export interface LifiTakerAllowlistReader {
  getAllowedCallTargets(): Promise<string[]>;
  getAllowedApprovalSpenders(): Promise<string[]>;
  getAllowedCallSelectors(target: string): Promise<string[]>;
}

export type LifiTakerAllowlistRead = <T>(params: {
  label: string;
  operation: () => Promise<T>;
}) => Promise<T>;

function sortLower(values: readonly string[]): string[] {
  return values.map((value) => value.toLowerCase()).sort();
}

function toLowerSet(values: readonly string[]): Set<string> {
  return new Set(values.map((value) => value.toLowerCase()));
}

function normalizeAddressList(
  addresses: readonly string[] | undefined,
  label: string,
  requireNonEmpty = false
): string[] {
  try {
    return sortLower(
      normalizeLifiAddressAllowlist(addresses, {
        label,
        requireNonEmpty,
      })
    );
  } catch (error) {
    throw new Error(
      `${label} is invalid: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function normalizeSelectorList(
  selectors: readonly string[] | undefined
): string[] {
  return Array.from(
    new Set((selectors ?? []).map((selector) => selector.toLowerCase()))
  ).sort();
}

function getSelectorsForTarget(
  selectorAllowlist: Record<string, readonly string[]>,
  target: string
): readonly string[] {
  return (
    selectorAllowlist[target] ??
    selectorAllowlist[target.toLowerCase()] ??
    selectorAllowlist[ethers.utils.getAddress(target)] ??
    []
  );
}

function normalizeSelectorsForTarget(params: {
  target: string;
  selectors: readonly string[];
  label: string;
  requireNonEmpty?: boolean;
}): string[] {
  if (!params.requireNonEmpty && params.selectors.length === 0) {
    return [];
  }
  const normalized = normalizeLifiSelectorAllowlistRecord(
    { [params.target]: params.selectors },
    { label: params.label, requireNonEmpty: params.requireNonEmpty }
  );
  return normalized[ethers.utils.getAddress(params.target).toLowerCase()] ?? [];
}

function getSelectorTargets(params: {
  expected?: Pick<NormalizedLifiAllowlistPolicy, 'callTargets' | 'selectorAllowlist'>;
  actual?: {
    callTargets: readonly string[];
    selectorAllowlist: Record<string, readonly string[]>;
  };
  extra?: readonly string[];
}): string[] {
  const selectorTargets = new Map<string, string>();
  for (const target of [
    ...(params.expected?.callTargets ?? []),
    ...Object.keys(params.expected?.selectorAllowlist ?? {}),
    ...(params.actual?.callTargets ?? []),
    ...Object.keys(params.actual?.selectorAllowlist ?? {}),
    ...(params.extra ?? []),
  ]) {
    selectorTargets.set(target.toLowerCase(), target);
  }
  return Array.from(selectorTargets.values());
}

function formatSet(values: readonly string[]): string {
  return values.join(', ');
}

function getSetMismatch(params: {
  label: string;
  expected: readonly string[];
  actual: readonly string[];
  mode: LifiTakerAllowlistCompareMode;
}): string | undefined {
  const expected = sortLower(params.expected);
  const actual = sortLower(params.actual);
  if (params.mode === 'contains') {
    const actualSet = toLowerSet(actual);
    const missing = expected.filter((value) => !actualSet.has(value));
    return missing.length > 0
      ? `${params.label} missing expected entries: [${formatSet(missing)}]`
      : undefined;
  }

  if (
    expected.length !== actual.length ||
    expected.some((value, index) => value !== actual[index])
  ) {
    return `${params.label} mismatch: expected [${formatSet(
      expected
    )}], got [${formatSet(actual)}]`;
  }
  return undefined;
}

export function normalizeLifiTakerAllowlistSnapshot(params: {
  callTargets: readonly string[];
  approvalSpenders: readonly string[];
  selectorAllowlist: Record<string, readonly string[]>;
  selectorTargets?: readonly string[];
  labelPrefix?: string;
}): LifiTakerAllowlistSnapshot {
  const labelPrefix = params.labelPrefix ?? 'LI.FI taker';
  const callTargets = normalizeAddressList(
    params.callTargets,
    `${labelPrefix} call target allowlist`
  );
  const approvalSpenders = normalizeAddressList(
    params.approvalSpenders,
    `${labelPrefix} approval spender allowlist`
  );
  const selectorTargets = getSelectorTargets({
    actual: {
      callTargets,
      selectorAllowlist: params.selectorAllowlist,
    },
    extra: params.selectorTargets,
  });
  const selectorAllowlist: Record<string, string[]> = {};
  for (const target of selectorTargets) {
    selectorAllowlist[target.toLowerCase()] = normalizeSelectorsForTarget({
      target,
      selectors: getSelectorsForTarget(params.selectorAllowlist, target),
      label: `${labelPrefix} selector allowlist for ${target}`,
      requireNonEmpty: false,
    });
  }
  return {
    callTargets,
    approvalSpenders,
    selectorAllowlist,
    selectorTargets,
  };
}

export async function readLifiTakerAllowlistSnapshot(params: {
  reader: LifiTakerAllowlistReader;
  selectorTargets?: readonly string[];
  labelPrefix?: string;
  read?: LifiTakerAllowlistRead;
}): Promise<LifiTakerAllowlistSnapshot> {
  const labelPrefix = params.labelPrefix ?? 'LI.FI taker';
  const read =
    params.read ??
    (async <T>(readParams: { operation: () => Promise<T> }): Promise<T> =>
      await readParams.operation());
  const callTargets = await read({
    label: `${labelPrefix} call target allowlist`,
    operation: () => params.reader.getAllowedCallTargets(),
  });
  const approvalSpenders = await read({
    label: `${labelPrefix} approval spender allowlist`,
    operation: () => params.reader.getAllowedApprovalSpenders(),
  });
  const selectorTargets = getSelectorTargets({
    actual: { callTargets, selectorAllowlist: {} },
    extra: params.selectorTargets,
  });
  const selectorAllowlist: Record<string, string[]> = {};
  for (const target of selectorTargets) {
    selectorAllowlist[target.toLowerCase()] = await read({
      label: `${labelPrefix} selector allowlist for ${target}`,
      operation: () => params.reader.getAllowedCallSelectors(target),
    });
  }
  return normalizeLifiTakerAllowlistSnapshot({
    callTargets,
    approvalSpenders,
    selectorAllowlist,
    selectorTargets,
    labelPrefix,
  });
}

export function createLifiTakerAllowlistReader(
  contract: ethers.Contract
): LifiTakerAllowlistReader {
  return {
    getAllowedCallTargets: async () => await contract.getAllowedCallTargets(),
    getAllowedApprovalSpenders: async () =>
      await contract.getAllowedApprovalSpenders(),
    getAllowedCallSelectors: async (target: string) =>
      await contract.getAllowedCallSelectors(target),
  };
}

export function compareLifiTakerAllowlistPolicy(params: {
  expected: NormalizedLifiAllowlistPolicy;
  actual: LifiTakerAllowlistSnapshot;
  mode: LifiTakerAllowlistCompareMode;
}): string[] {
  const errors: string[] = [];
  const callTargetMismatch = getSetMismatch({
    label: 'LI.FI taker call target allowlist',
    expected: params.expected.callTargets,
    actual: params.actual.callTargets,
    mode: params.mode,
  });
  if (callTargetMismatch) {
    errors.push(callTargetMismatch);
  }

  const approvalSpenderMismatch = getSetMismatch({
    label: 'LI.FI taker approval spender allowlist',
    expected: params.expected.approvalSpenders,
    actual: params.actual.approvalSpenders,
    mode: params.mode,
  });
  if (approvalSpenderMismatch) {
    errors.push(approvalSpenderMismatch);
  }

  for (const target of getSelectorTargets({
    expected: params.expected,
    actual: params.actual,
    extra: params.actual.selectorTargets,
  })) {
    const configuredSelectors = getSelectorsForTarget(
      params.expected.selectorAllowlist,
      target
    );
    const expectedSelectors = normalizeSelectorList(configuredSelectors);
    const actualSelectors = normalizeSelectorList(
      getSelectorsForTarget(params.actual.selectorAllowlist, target)
    );
    const selectorMismatch = getSetMismatch({
      label: `LI.FI taker selector allowlist for ${target}`,
      expected: expectedSelectors,
      actual: actualSelectors,
      mode: params.mode,
    });
    if (selectorMismatch) {
      errors.push(selectorMismatch);
    }
  }

  return errors;
}

export function assertLifiTakerAllowlistPolicy(params: {
  expected: NormalizedLifiAllowlistPolicy;
  actual: LifiTakerAllowlistSnapshot;
  mode: LifiTakerAllowlistCompareMode;
}): void {
  const errors = compareLifiTakerAllowlistPolicy(params);
  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
}

export function buildLifiTakerAllowlistReconciliationPlan(params: {
  desired: NormalizedLifiAllowlistPolicy;
  current: LifiTakerAllowlistSnapshot;
}): LifiAllowlistReconciliationPlan {
  const desiredCallTargets = toLowerSet(params.desired.callTargets);
  const desiredApprovalSpenders = toLowerSet(params.desired.approvalSpenders);
  const currentCallTargets = toLowerSet(params.current.callTargets);
  const currentApprovalSpenders = toLowerSet(params.current.approvalSpenders);

  const selectorTargets = getSelectorTargets({
    expected: params.desired,
    actual: params.current,
    extra: params.current.selectorTargets,
  });

  const selectorsToEnable: LifiSelectorEntry[] = [];
  const selectorsToDisable: LifiSelectorEntry[] = [];
  for (const target of selectorTargets) {
    const desiredSelectors = toLowerSet(
      getSelectorsForTarget(params.desired.selectorAllowlist, target)
    );
    const currentSelectors = toLowerSet(
      getSelectorsForTarget(params.current.selectorAllowlist, target)
    );
    for (const selector of getSelectorsForTarget(
      params.desired.selectorAllowlist,
      target
    )) {
      if (!currentSelectors.has(selector.toLowerCase())) {
        selectorsToEnable.push({ target, selector });
      }
    }
    for (const selector of getSelectorsForTarget(
      params.current.selectorAllowlist,
      target
    )) {
      if (!desiredSelectors.has(selector.toLowerCase())) {
        selectorsToDisable.push({ target, selector });
      }
    }
  }

  return {
    callTargetsToEnable: params.desired.callTargets.filter(
      (target) => !currentCallTargets.has(target.toLowerCase())
    ),
    callTargetsToDisable: params.current.callTargets.filter(
      (target) => !desiredCallTargets.has(target.toLowerCase())
    ),
    approvalSpendersToEnable: params.desired.approvalSpenders.filter(
      (spender) => !currentApprovalSpenders.has(spender.toLowerCase())
    ),
    approvalSpendersToDisable: params.current.approvalSpenders.filter(
      (spender) => !desiredApprovalSpenders.has(spender.toLowerCase())
    ),
    selectorsToEnable,
    selectorsToDisable,
    selectorTargets,
  };
}
