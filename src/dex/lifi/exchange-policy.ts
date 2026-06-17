import {
  normalizeLifiExchangeFilters,
  type LifiExchangeFilterConfig,
  type NormalizedLifiExchangeFilters,
} from './filters';

export type LifiProductionExchangePolicyKind =
  | 'concrete_allowlist'
  | 'reviewed_broad';

export interface LifiProductionExchangePolicyConfig
  extends LifiExchangeFilterConfig {
  mode: 'production';
  exchangePolicy?: LifiProductionExchangePolicyKind;
}

export type ConcreteAllowlistLifiExchangePolicy = {
  kind: 'concrete_allowlist';
  filters: NormalizedLifiExchangeFilters & { allowExchanges: string[] };
};

export type ReviewedBroadLifiExchangePolicy = {
  kind: 'reviewed_broad';
  filters: Omit<NormalizedLifiExchangeFilters, 'allowExchanges'>;
};

export type LifiExchangePolicy =
  | ConcreteAllowlistLifiExchangePolicy
  | ReviewedBroadLifiExchangePolicy;

function hasOwnField(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeProductionExchangePolicyKind(
  value: unknown,
  fieldName: string
): LifiProductionExchangePolicyKind {
  if (value === undefined || value === 'concrete_allowlist') {
    return 'concrete_allowlist';
  }
  if (value === 'reviewed_broad') {
    return 'reviewed_broad';
  }
  throw new Error(
    `${fieldName}.exchangePolicy must be concrete_allowlist or reviewed_broad`
  );
}

export function normalizeProductionLifiExchangePolicy(params: {
  config: LifiProductionExchangePolicyConfig;
  fieldName: string;
}): LifiExchangePolicy {
  const kind = normalizeProductionExchangePolicyKind(
    params.config.exchangePolicy,
    params.fieldName
  );
  if (
    kind === 'reviewed_broad' &&
    hasOwnField(params.config, 'allowExchanges')
  ) {
    throw new Error(
      `${params.fieldName}.allowExchanges must be omitted when exchangePolicy is reviewed_broad`
    );
  }
  const filters = normalizeLifiExchangeFilters(params.config, {
    fieldName: params.fieldName,
    mode: params.config.mode,
  });

  if (kind === 'reviewed_broad') {
    return {
      kind,
      filters: {
        ...(filters.denyExchanges !== undefined
          ? { denyExchanges: filters.denyExchanges }
          : {}),
        ...(filters.preferExchanges !== undefined
          ? { preferExchanges: filters.preferExchanges }
          : {}),
      },
    };
  }

  if ((filters.allowExchanges ?? []).length === 0) {
    throw new Error(
      `${params.fieldName}.allowExchanges must be non-empty in production`
    );
  }

  return {
    kind,
    filters: {
      ...filters,
      allowExchanges: filters.allowExchanges!,
    },
  };
}

