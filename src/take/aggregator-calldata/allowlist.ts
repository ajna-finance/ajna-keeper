// Provider-neutral taker allowlist primitives for calldata-aggregator
// deployments and preflight (SushiSwap aggregator roadmap, Packet 2B).
// Canonical home of the allowlist ABI fragments, on-chain snapshot reads,
// snapshot normalization, reconciliation-plan construction, and
// contains/exact assertion helpers promoted out of src/dex/lifi. Every
// calldata-aggregator provider keeps its own isolated per-deployment
// allowlists. The helper MECHANICS and their fallback diagnostic labels
// are provider-neutral (no provider branching, neutral 'aggregator ...'
// defaults); every provider threads its own diagnostic label through the
// `label`/`labelPrefix` params (e.g. LI.FI passes 'LI.FI selector
// allowlist'/'LI.FI taker', Sushi passes 'Sushi aggregator taker').
import { ethers } from 'ethers';

// Neutral expected-policy shape consumed by the assertion/reconciliation
// helpers. Provider chain-policy types (e.g. the LI.FI production chain
// policy) satisfy this structurally.
export interface NormalizedTakerAllowlistPolicy {
  callTargets: string[];
  approvalSpenders: string[];
  selectorAllowlist: Record<string, string[]>;
}

const ZERO_ADDRESS = ethers.constants.AddressZero.toLowerCase();

export function normalizeTakerAddressAllowlist(
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

export function normalizeTakerAddressAllowlistSet(
  addresses: readonly string[],
  label: string
): Set<string> {
  return new Set(
    normalizeTakerAddressAllowlist(addresses, {
      label,
      requireNonEmpty: true,
    }).map((address) => address.toLowerCase())
  );
}


export type TakerSelectorAllowlist = Record<string, readonly string[]>;

export function normalizeTakerSelectorAllowlist(
  selectorAllowlist: TakerSelectorAllowlist | undefined,
  params: {
    label?: string;
    requireNonEmpty?: boolean;
    callTargetAllowlist?: readonly string[];
    requireCallTargetCoverage?: boolean;
  } = {}
): Map<string, Set<string>> {
  const label = params.label ?? 'aggregator selector allowlist';
  const callTargetAllowlist = params.callTargetAllowlist
    ? new Set(
        normalizeTakerAddressAllowlist(params.callTargetAllowlist, {
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
          `${label} must include selectors for every configured call target`
        );
      }
    }
  }

  return normalized;
}

export function normalizeTakerSelectorAllowlistRecord(
  selectorAllowlist: TakerSelectorAllowlist | undefined,
  params: {
    label?: string;
    requireNonEmpty?: boolean;
    callTargetAllowlist?: readonly string[];
    requireCallTargetCoverage?: boolean;
  } = {}
): Record<string, string[]> {
  const normalized = normalizeTakerSelectorAllowlist(selectorAllowlist, params);
  const record: Record<string, string[]> = {};
  for (const [target, selectors] of Array.from(normalized.entries())) {
    record[target] = Array.from(selectors);
  }
  return record;
}


export const AGGREGATOR_TAKER_ALLOWLIST_ABI = [
  'function getAllowedCallTargets() view returns (address[])',
  'function getAllowedApprovalSpenders() view returns (address[])',
  'function getAllowedCallSelectors(address target) view returns (bytes4[])',
];

export type TakerAllowlistCompareMode = 'exact' | 'contains';

export type TakerSelectorEntry = { target: string; selector: string };

export interface TakerAllowlistSnapshot {
  callTargets: string[];
  approvalSpenders: string[];
  selectorAllowlist: Record<string, string[]>;
}

export interface TakerAllowlistReconciliationPlan {
  callTargetsToEnable: string[];
  callTargetsToDisable: string[];
  approvalSpendersToEnable: string[];
  approvalSpendersToDisable: string[];
  selectorsToEnable: TakerSelectorEntry[];
  selectorsToDisable: TakerSelectorEntry[];
  selectorTargets: string[];
}

export interface TakerAllowlistReader {
  getAllowedCallTargets(): Promise<string[]>;
  getAllowedApprovalSpenders(): Promise<string[]>;
  getAllowedCallSelectors(target: string): Promise<string[]>;
}

export type TakerAllowlistRead = <T>(params: {
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
      normalizeTakerAddressAllowlist(addresses, {
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
  const normalized = normalizeTakerSelectorAllowlistRecord(
    { [params.target]: params.selectors },
    { label: params.label, requireNonEmpty: params.requireNonEmpty }
  );
  return normalized[ethers.utils.getAddress(params.target).toLowerCase()] ?? [];
}

function getSelectorTargets(params: {
  expected?: Pick<NormalizedTakerAllowlistPolicy, 'callTargets' | 'selectorAllowlist'>;
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
  mode: TakerAllowlistCompareMode;
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

export function normalizeTakerAllowlistSnapshot(params: {
  callTargets: readonly string[];
  approvalSpenders: readonly string[];
  selectorAllowlist: Record<string, readonly string[]>;
  selectorTargets?: readonly string[];
  labelPrefix?: string;
}): TakerAllowlistSnapshot {
  const labelPrefix = params.labelPrefix ?? 'aggregator taker';
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
  };
}

export async function readTakerAllowlistSnapshot(params: {
  reader: TakerAllowlistReader;
  selectorTargets?: readonly string[];
  labelPrefix?: string;
  read?: TakerAllowlistRead;
}): Promise<TakerAllowlistSnapshot> {
  const labelPrefix = params.labelPrefix ?? 'aggregator taker';
  const read =
    params.read ??
    (async <T>(readParams: { operation: () => Promise<T> }): Promise<T> =>
      await readParams.operation());
  const [callTargets, approvalSpenders] = await Promise.all([
    read({
      label: `${labelPrefix} call target allowlist`,
      operation: () => params.reader.getAllowedCallTargets(),
    }),
    read({
      label: `${labelPrefix} approval spender allowlist`,
      operation: () => params.reader.getAllowedApprovalSpenders(),
    }),
  ]);
  const selectorTargets = getSelectorTargets({
    actual: { callTargets, selectorAllowlist: {} },
    extra: params.selectorTargets,
  });
  const selectorEntries = await Promise.all(
    selectorTargets.map(
      async (target): Promise<[string, string[]]> => [
        target.toLowerCase(),
        await read({
          label: `${labelPrefix} selector allowlist for ${target}`,
          operation: () => params.reader.getAllowedCallSelectors(target),
        }),
      ]
    )
  );
  const selectorAllowlist: Record<string, string[]> =
    Object.fromEntries(selectorEntries);
  return normalizeTakerAllowlistSnapshot({
    callTargets,
    approvalSpenders,
    selectorAllowlist,
    selectorTargets,
    labelPrefix,
  });
}

export function createTakerAllowlistReader(
  contract: ethers.Contract
): TakerAllowlistReader {
  return {
    getAllowedCallTargets: async () => await contract.getAllowedCallTargets(),
    getAllowedApprovalSpenders: async () =>
      await contract.getAllowedApprovalSpenders(),
    getAllowedCallSelectors: async (target: string) =>
      await contract.getAllowedCallSelectors(target),
  };
}

export function compareTakerAllowlistPolicy(params: {
  expected: NormalizedTakerAllowlistPolicy;
  actual: TakerAllowlistSnapshot;
  mode: TakerAllowlistCompareMode;
  labelPrefix?: string;
}): string[] {
  const labelPrefix = params.labelPrefix ?? 'aggregator taker';
  const errors: string[] = [];
  const callTargetMismatch = getSetMismatch({
    label: `${labelPrefix} call target allowlist`,
    expected: params.expected.callTargets,
    actual: params.actual.callTargets,
    mode: params.mode,
  });
  if (callTargetMismatch) {
    errors.push(callTargetMismatch);
  }

  const approvalSpenderMismatch = getSetMismatch({
    label: `${labelPrefix} approval spender allowlist`,
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
      label: `${labelPrefix} selector allowlist for ${target}`,
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

export function assertTakerAllowlistPolicy(params: {
  expected: NormalizedTakerAllowlistPolicy;
  actual: TakerAllowlistSnapshot;
  mode: TakerAllowlistCompareMode;
  labelPrefix?: string;
}): void {
  const errors = compareTakerAllowlistPolicy(params);
  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
}

export function buildTakerAllowlistReconciliationPlan(params: {
  desired: NormalizedTakerAllowlistPolicy;
  current: TakerAllowlistSnapshot;
}): TakerAllowlistReconciliationPlan {
  const desiredCallTargets = toLowerSet(params.desired.callTargets);
  const desiredApprovalSpenders = toLowerSet(params.desired.approvalSpenders);
  const currentCallTargets = toLowerSet(params.current.callTargets);
  const currentApprovalSpenders = toLowerSet(params.current.approvalSpenders);

  const selectorTargets = getSelectorTargets({
    expected: params.desired,
    actual: params.current,
  });

  const selectorsToEnable: TakerSelectorEntry[] = [];
  const selectorsToDisable: TakerSelectorEntry[] = [];
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
