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
  allowExchanges?: readonly string[];
  denyExchanges?: readonly string[];
  preferExchanges?: readonly string[];
  allowBroadExchangeFilters?: boolean;
}

export function isUnsupportedLifiExchangeTool(tool: string): boolean {
  return UNSUPPORTED_EXCHANGE_FILTERS.has(tool.trim().toLowerCase());
}

export function isBroadLifiExchangeFilter(value: string): boolean {
  return BROAD_EXCHANGE_FILTERS.has(value.trim().toLowerCase());
}

function normalizeFilterList(params: {
  values: readonly string[] | undefined;
  fieldName: string;
  allowBroadExchangeFilters?: boolean;
}): string[] | undefined {
  if (params.values === undefined) {
    return undefined;
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of params.values) {
    const key = value.trim().toLowerCase();
    if (
      isBroadLifiExchangeFilter(key) &&
      params.allowBroadExchangeFilters !== true
    ) {
      throw new Error(
        `${params.fieldName} cannot use broad LI.FI filter keyword ${JSON.stringify(value)}`
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
  config: LifiExchangeFilterConfig
): NormalizedLifiExchangeFilters {
  const allowExchanges = normalizeFilterList({
    values: config.allowExchanges,
    fieldName: 'dex.lifi.allowExchanges',
    allowBroadExchangeFilters: config.allowBroadExchangeFilters,
  });
  const denyExchanges = normalizeFilterList({
    values: config.denyExchanges,
    fieldName: 'dex.lifi.denyExchanges',
    allowBroadExchangeFilters: config.allowBroadExchangeFilters,
  });
  const preferExchanges = normalizeFilterList({
    values: config.preferExchanges,
    fieldName: 'dex.lifi.preferExchanges',
    allowBroadExchangeFilters: config.allowBroadExchangeFilters,
  });

  const allow = new Set(allowExchanges ?? []);
  const deny = new Set(denyExchanges ?? []);
  const prefer = new Set(preferExchanges ?? []);
  for (const key of Array.from(allow)) {
    if (prefer.has(key)) {
      throw new Error(
        `LI.FI exchange filter ${key} cannot appear in both allowExchanges and preferExchanges`
      );
    }
    if (deny.has(key)) {
      throw new Error(
        `LI.FI exchange filter ${key} cannot appear in both allowExchanges and denyExchanges`
      );
    }
  }
  for (const key of Array.from(prefer)) {
    if (deny.has(key)) {
      throw new Error(
        `LI.FI exchange filter ${key} cannot appear in both preferExchanges and denyExchanges`
      );
    }
  }

  return {
    ...(allowExchanges !== undefined ? { allowExchanges } : {}),
    ...(denyExchanges !== undefined ? { denyExchanges } : {}),
    ...(preferExchanges !== undefined ? { preferExchanges } : {}),
  };
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
