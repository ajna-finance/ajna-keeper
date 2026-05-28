export const MAX_LIFI_INTEGRATOR_LENGTH = 23;

const LIFI_INTEGRATOR_PATTERN = /^[A-Za-z0-9_.-]+$/;

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
