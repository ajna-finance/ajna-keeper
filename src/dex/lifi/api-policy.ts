import { DEFAULT_LIFI_API_BASE_URL } from './schema';

export const MAX_LIFI_INTEGRATOR_LENGTH = 23;

const LIFI_INTEGRATOR_PATTERN = /^[A-Za-z0-9_.-]+$/;

export type LifiPolicyEnvReader<TEnv> = (
  env: TEnv,
  name: string
) => string | undefined;

export function normalizeLifiApiBaseUrl(
  value: unknown,
  fieldName: string,
  options: { requireHttps?: boolean } = {}
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    throw new Error(
      `${fieldName} must be an http(s) URL without credentials, query, or fragment`
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      `${fieldName} must be an http(s) URL without credentials, query, or fragment`
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `${fieldName} must be an http(s) URL without credentials, query, or fragment`
    );
  }
  if (options.requireHttps === true && parsed.protocol !== 'https:') {
    throw new Error(`${fieldName} must be HTTPS in production`);
  }
  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error(
      `${fieldName} must be an http(s) URL without credentials, query, or fragment`
    );
  }

  const pathname = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.protocol}//${parsed.host}${pathname}`;
}

function normalizeApiBaseUrlForGate(value: string): string {
  return normalizeLifiApiBaseUrl(value, 'LI.FI API base URL');
}

export function isDefaultLifiApiBaseUrl(value: string): boolean {
  return (
    normalizeApiBaseUrlForGate(value) ===
    normalizeApiBaseUrlForGate(DEFAULT_LIFI_API_BASE_URL)
  );
}

export function requireDefaultLifiApiBaseUrl(params: {
  apiBaseUrl: string | undefined;
  errorMessage: string;
}): void {
  if (
    params.apiBaseUrl !== undefined &&
    !isDefaultLifiApiBaseUrl(params.apiBaseUrl)
  ) {
    throw new Error(params.errorMessage);
  }
}

export function getSetLifiPolicyEnvNames<TEnv>(params: {
  env: TEnv;
  names: readonly string[];
  readEnv: LifiPolicyEnvReader<TEnv>;
}): string[] {
  return params.names.filter(
    (name) => params.readEnv(params.env, name) !== undefined
  );
}

export function getLifiPolicyApiKey<TEnv>(params: {
  config: { apiKeyEnvVar?: string };
  env: TEnv;
  fallbackEnvNames: readonly string[];
  readEnv: LifiPolicyEnvReader<TEnv>;
}): string | undefined {
  if (params.config.apiKeyEnvVar) {
    return params.readEnv(params.env, params.config.apiKeyEnvVar);
  }
  for (const name of params.fallbackEnvNames) {
    const value = params.readEnv(params.env, name);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

export function validateLifiIntegrator(
  value: unknown,
  fieldName: string
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_LIFI_INTEGRATOR_LENGTH ||
    !LIFI_INTEGRATOR_PATTERN.test(value)
  ) {
    throw new Error(
      `${fieldName} must be 1-${MAX_LIFI_INTEGRATOR_LENGTH} characters and contain only letters, numbers, hyphens, underscores, or dots`
    );
  }
  return value;
}

export function requirePositiveIntegerPolicy(params: {
  value: number | undefined;
  fallback: number;
  max: number;
  label: string;
}): number {
  const value = params.value ?? params.fallback;
  if (!Number.isInteger(value) || value <= 0 || value > params.max) {
    throw new Error(
      `${params.label} must be an integer between 1 and ${params.max}`
    );
  }
  return value;
}

export function requireBoundedDecimalPolicy(params: {
  value: number | undefined;
  fallback: number;
  max: number;
  label: string;
}): number {
  const value = params.value ?? params.fallback;
  if (!Number.isFinite(value) || value <= 0 || value > params.max) {
    throw new Error(
      `${params.label} must be greater than 0 and at most ${params.max}`
    );
  }
  return value;
}

export function requireOptionalBoundedDecimalPolicy(params: {
  value: number | undefined;
  max: number;
  label: string;
}): number | undefined {
  if (params.value === undefined) {
    return undefined;
  }
  const value = params.value;
  if (!Number.isFinite(value) || value <= 0 || value > params.max) {
    throw new Error(
      `${params.label} must be greater than 0 and at most ${params.max}`
    );
  }
  return value;
}
