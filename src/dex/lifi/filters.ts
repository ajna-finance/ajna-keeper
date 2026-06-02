export type LifiDexMode = 'canary' | 'production';

const BROAD_EXCHANGE_FILTERS = new Set(['', 'all', 'default', 'none', '[]']);
const UNSUPPORTED_EXCHANGE_FILTERS = new Set([
  'feecollection',
  'fee_collection',
  'fee-collection',
]);

export interface NormalizedLifiExchangeFilters {
  allowExchanges?: string[];
  denyExchanges?: string[];
  preferExchanges?: string[];
}

export interface LifiExchangeFilterConfig {
  mode: LifiDexMode;
  allowExchanges?: readonly string[];
  denyExchanges?: readonly string[];
  preferExchanges?: readonly string[];
  allowBroadExchangeFilters?: boolean;
}

export interface NormalizeLifiExchangeFilterOptions {
  fieldName?: string;
  mode?: LifiDexMode;
  allowBroadExchangeFilters?: boolean;
}

export function isUnsupportedLifiExchangeTool(tool: string): boolean {
  return UNSUPPORTED_EXCHANGE_FILTERS.has(tool.trim().toLowerCase());
}

export function isBroadLifiExchangeFilter(value: string): boolean {
  return BROAD_EXCHANGE_FILTERS.has(value.trim().toLowerCase());
}

function normalizeFilterList(params: {
  values: readonly unknown[] | undefined;
  fieldName: string;
  mode: LifiDexMode;
  allowBroadExchangeFilters?: boolean;
}): string[] | undefined {
  if (params.values === undefined) {
    return undefined;
  }
  if (!Array.isArray(params.values)) {
    throw new Error(`${params.fieldName} must be an array of exchange keys`);
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of params.values) {
    if (typeof value !== 'string') {
      throw new Error(`${params.fieldName} entries must be exchange keys`);
    }
    const key = value.trim().toLowerCase();
    const broadFilterAllowed =
      params.allowBroadExchangeFilters === true && params.mode === 'canary';
    if (isBroadLifiExchangeFilter(key) && !broadFilterAllowed) {
      throw new Error(
        `${params.fieldName} cannot use broad LI.FI filter keyword ${JSON.stringify(value)} outside canary allowBroadExchangeFilters mode`
      );
    }
    if (isUnsupportedLifiExchangeTool(key)) {
      throw new Error(
        `${params.fieldName} cannot use unsupported LI.FI filter keyword ${JSON.stringify(value)}`
      );
    }
    if (seen.has(key)) {
      throw new Error(`${params.fieldName} cannot contain duplicate entries`);
    }
    seen.add(key);
    normalized.push(key);
  }

  return normalized;
}

export function normalizeLifiExchangeFilters(
  config: LifiExchangeFilterConfig,
  options: NormalizeLifiExchangeFilterOptions = {}
): NormalizedLifiExchangeFilters {
  const fieldName = options.fieldName ?? 'dex.lifi';
  const mode = options.mode ?? config.mode;
  const allowBroadExchangeFilters =
    options.allowBroadExchangeFilters ?? config.allowBroadExchangeFilters;
  const allowExchanges = normalizeFilterList({
    values: config.allowExchanges,
    fieldName: `${fieldName}.allowExchanges`,
    mode,
    allowBroadExchangeFilters,
  });
  const denyExchanges = normalizeFilterList({
    values: config.denyExchanges,
    fieldName: `${fieldName}.denyExchanges`,
    mode,
    allowBroadExchangeFilters,
  });
  const preferExchanges = normalizeFilterList({
    values: config.preferExchanges,
    fieldName: `${fieldName}.preferExchanges`,
    mode,
    allowBroadExchangeFilters,
  });

  const allow = new Set(allowExchanges ?? []);
  const deny = new Set(denyExchanges ?? []);
  const prefer = new Set(preferExchanges ?? []);
  const conflictPrefix = fieldName === 'dex.lifi' ? 'LI.FI' : fieldName;
  for (const key of Array.from(allow)) {
    if (prefer.has(key)) {
      throw new Error(
        `${conflictPrefix} exchange filter ${key} cannot appear in both allowExchanges and preferExchanges`
      );
    }
    if (deny.has(key)) {
      throw new Error(
        `${conflictPrefix} exchange filter ${key} cannot appear in both allowExchanges and denyExchanges`
      );
    }
  }
  for (const key of Array.from(prefer)) {
    if (deny.has(key)) {
      throw new Error(
        `${conflictPrefix} exchange filter ${key} cannot appear in both preferExchanges and denyExchanges`
      );
    }
  }

  return {
    ...(allowExchanges !== undefined ? { allowExchanges } : {}),
    ...(denyExchanges !== undefined ? { denyExchanges } : {}),
    ...(preferExchanges !== undefined ? { preferExchanges } : {}),
  };
}

export function hasBroadLifiPolicyExchangeFilter(
  config: LifiExchangeFilterConfig
): boolean {
  return [
    ...(config.allowExchanges ?? []),
    ...(config.denyExchanges ?? []),
    ...(config.preferExchanges ?? []),
  ].some((value) => isBroadLifiExchangeFilter(value));
}

export function getConcreteProductionLifiPolicyError(params: {
  config: LifiExchangeFilterConfig;
  context: string;
}): string | undefined {
  if (params.config.allowBroadExchangeFilters === true) {
    return `${params.context} requires concrete production LI.FI exchange filters; config.dex.lifi.allowBroadExchangeFilters is canary-only`;
  }
  if (hasBroadLifiPolicyExchangeFilter(params.config)) {
    return `${params.context} requires concrete production LI.FI exchange filters; broad filter keywords are not allowed`;
  }
  return undefined;
}

export function extractLifiExchangeToolKeys(toolsResponse: unknown): string[] {
  if (
    typeof toolsResponse !== 'object' ||
    toolsResponse === null ||
    !Array.isArray((toolsResponse as { exchanges?: unknown }).exchanges)
  ) {
    throw new Error('LI.FI tools response is missing exchanges');
  }

  return Array.from(
    new Set(
      (toolsResponse as { exchanges: Array<{ key?: unknown }> }).exchanges
        .map((exchange) =>
          typeof exchange.key === 'string'
            ? exchange.key.trim().toLowerCase()
            : undefined
        )
        .filter((key): key is string => !!key)
    )
  ).sort();
}

export function assertLifiToolsContainFilters(params: {
  filters: NormalizedLifiExchangeFilters;
  toolsResponse: unknown;
}): void {
  const exchangeKeys = new Set(extractLifiExchangeToolKeys(params.toolsResponse));

  for (const [fieldName, keys] of Object.entries(params.filters)) {
    for (const key of keys ?? []) {
      if (isBroadLifiExchangeFilter(key)) {
        continue;
      }
      if (!exchangeKeys.has(key)) {
        throw new Error(`LI.FI ${fieldName} contains unknown exchange ${key}`);
      }
    }
  }
}
