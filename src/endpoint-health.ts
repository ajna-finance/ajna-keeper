import { logger } from './logging';

export type EndpointKind = 'subgraph' | 'read-rpc';

interface EndpointHealthState {
  consecutiveFailures: number;
  cooldownUntil?: number;
  lastSuccessAt?: number;
  lastError?: string;
}

interface EndpointFailurePolicy {
  failureThreshold?: number;
  cooldownMs?: number;
}

const endpointHealth = new Map<string, EndpointHealthState>();

function endpointKey(kind: EndpointKind, endpoint: string): string {
  return `${kind}:${endpoint}`;
}

function getOrCreateState(
  kind: EndpointKind,
  endpoint: string
): EndpointHealthState {
  const key = endpointKey(kind, endpoint);
  const existing = endpointHealth.get(key);
  if (existing) {
    return existing;
  }
  const created: EndpointHealthState = {
    consecutiveFailures: 0,
  };
  endpointHealth.set(key, created);
  return created;
}

export function clearEndpointHealthState(): void {
  endpointHealth.clear();
}

export function formatEndpointForLogs(endpoint: string): string {
  try {
    const parsed = new URL(endpoint);
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length > 0) {
      segments[segments.length - 1] = '***';
    }
    const sanitizedPath = segments.length > 0 ? `/${segments.join('/')}` : '';
    return `${parsed.origin}${sanitizedPath}`;
  } catch {
    if (endpoint.length <= 24) {
      return endpoint;
    }
    return `${endpoint.slice(0, 12)}...${endpoint.slice(-4)}`;
  }
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function isEndpointInCooldown(
  kind: EndpointKind,
  endpoint: string,
  now: number = Date.now()
): boolean {
  const state = endpointHealth.get(endpointKey(kind, endpoint));
  return !!state?.cooldownUntil && state.cooldownUntil > now;
}

export function orderEndpointsByHealth(
  kind: EndpointKind,
  endpoints: string[],
  now: number = Date.now()
): string[] {
  const healthy: string[] = [];
  const coolingDown: string[] = [];

  for (const endpoint of endpoints) {
    if (isEndpointInCooldown(kind, endpoint, now)) {
      coolingDown.push(endpoint);
    } else {
      healthy.push(endpoint);
    }
  }

  if (healthy.length > 0) {
    return [...healthy, ...coolingDown];
  }

  if (coolingDown.length > 0) {
    logger.warn(
      `All ${kind} endpoints are in cooldown; retrying configured order`
    );
  }
  return [...endpoints];
}

export function recordEndpointSuccess(
  kind: EndpointKind,
  endpoint: string
): void {
  const state = getOrCreateState(kind, endpoint);
  const hadFailures = state.consecutiveFailures > 0;
  state.consecutiveFailures = 0;
  state.cooldownUntil = undefined;
  state.lastError = undefined;
  state.lastSuccessAt = Date.now();

  if (hadFailures) {
    logger.info(
      `${kind} endpoint recovered: endpoint=${formatEndpointForLogs(endpoint)}`
    );
  }
}

export function recordEndpointFailure(
  kind: EndpointKind,
  endpoint: string,
  error: unknown,
  policy: EndpointFailurePolicy = {}
): void {
  const threshold = policy.failureThreshold ?? 3;
  const cooldownMs = policy.cooldownMs ?? 30_000;
  const state = getOrCreateState(kind, endpoint);
  state.consecutiveFailures += 1;
  state.lastError = formatErrorMessage(error);

  const now = Date.now();
  if (state.consecutiveFailures >= threshold) {
    const enteringCooldown =
      state.cooldownUntil === undefined || state.cooldownUntil <= now;
    state.cooldownUntil = now + cooldownMs;
    if (enteringCooldown) {
      logger.warn(
        `${kind} endpoint entering cooldown: endpoint=${formatEndpointForLogs(endpoint)} cooldownMs=${cooldownMs} consecutiveFailures=${state.consecutiveFailures} error="${state.lastError}"`
      );
    }
    return;
  }

  logger.warn(
    `${kind} endpoint failure: endpoint=${formatEndpointForLogs(endpoint)} consecutiveFailures=${state.consecutiveFailures}/${threshold} error="${state.lastError}"`
  );
}

export function logEndpointFailover(params: {
  kind: EndpointKind;
  from: string;
  to: string;
  reason: string;
}): void {
  logger.warn(
    `${params.kind} failover: from=${formatEndpointForLogs(params.from)} to=${formatEndpointForLogs(params.to)} reason="${params.reason}"`
  );
}
