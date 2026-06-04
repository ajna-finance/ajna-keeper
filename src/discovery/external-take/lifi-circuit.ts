import { LifiDexConfig } from '../../config';
import { logger } from '../../logging';
import {
  DiscoveryRpcCache,
  ExternalProviderCircuitState,
  LifiCircuitPurpose,
} from '../types';

export const DEFAULT_LIFI_QUOTE_FAILURE_COOLDOWN_MS = 30_000;
export const DEFAULT_LIFI_QUOTE_FAILURE_THRESHOLD = 2;
export const MAX_LIFI_QUOTE_FAILURE_COOLDOWN_MS = 60 * 60 * 1000;

const LIFI_CIRCUIT_OPEN_HEARTBEAT_MS = 5 * 60 * 1000;

type LifiCircuitPolicy =
  | Pick<LifiDexConfig, 'quoteFailureCooldownMs' | 'quoteFailureThreshold'>
  | undefined;

function getLifiQuoteFailureCooldownMs(lifiConfig: LifiCircuitPolicy): number {
  const configuredCooldownMs =
    lifiConfig?.quoteFailureCooldownMs ??
    DEFAULT_LIFI_QUOTE_FAILURE_COOLDOWN_MS;
  return Math.min(
    configuredCooldownMs > 0
      ? configuredCooldownMs
      : DEFAULT_LIFI_QUOTE_FAILURE_COOLDOWN_MS,
    MAX_LIFI_QUOTE_FAILURE_COOLDOWN_MS
  );
}

function getLifiQuoteFailureThreshold(lifiConfig: LifiCircuitPolicy): number {
  return (
    lifiConfig?.quoteFailureThreshold ?? DEFAULT_LIFI_QUOTE_FAILURE_THRESHOLD
  );
}

function getLifiCircuitState(
  rpcCache?: DiscoveryRpcCache,
  purpose: LifiCircuitPurpose = 'route_quote'
): ExternalProviderCircuitState {
  if (!rpcCache) {
    return { failures: 0 };
  }
  rpcCache.providerCircuits ??= {};
  rpcCache.providerCircuits.lifi ??= {};
  rpcCache.providerCircuits.lifi[purpose] ??= { failures: 0 };
  return rpcCache.providerCircuits.lifi[purpose]!;
}

function resetExpiredLifiCircuit(
  state: ExternalProviderCircuitState,
  nowMs: number
): void {
  if (state.cooldownUntilMs !== undefined && state.cooldownUntilMs <= nowMs) {
    state.failures = 0;
    state.cooldownUntilMs = undefined;
    state.lastOpenLogAtMs = undefined;
  }
}

export function getLifiCircuitOpenReason(params: {
  rpcCache?: DiscoveryRpcCache;
  lifiConfig: LifiCircuitPolicy;
  purpose?: LifiCircuitPurpose;
  nowMs?: number;
}): string | undefined {
  const purpose = params.purpose ?? 'route_quote';
  const state = getLifiCircuitState(params.rpcCache, purpose);
  const nowMs = params.nowMs ?? Date.now();
  resetExpiredLifiCircuit(state, nowMs);
  if (state.cooldownUntilMs !== undefined && state.cooldownUntilMs > nowMs) {
    if (
      state.lastOpenLogAtMs === undefined ||
      nowMs - state.lastOpenLogAtMs >= LIFI_CIRCUIT_OPEN_HEARTBEAT_MS
    ) {
      logger.info(
        `LI.FI quote circuit remains open for purpose=${purpose} until ${state.cooldownUntilMs}`
      );
      state.lastOpenLogAtMs = nowMs;
    }
    return `LI.FI quote circuit open for purpose=${purpose} until ${state.cooldownUntilMs}`;
  }
  return undefined;
}

export function recordLifiQuoteSuccess(
  rpcCache?: DiscoveryRpcCache,
  purpose: LifiCircuitPurpose = 'route_quote'
): void {
  const state = rpcCache?.providerCircuits?.lifi?.[purpose];
  if (!state) {
    return;
  }
  state.failures = 0;
  state.cooldownUntilMs = undefined;
  state.lastOpenLogAtMs = undefined;
}

export function recordLifiQuoteFailure(params: {
  rpcCache?: DiscoveryRpcCache;
  lifiConfig: LifiCircuitPolicy;
  purpose?: LifiCircuitPurpose;
  nowMs?: number;
}): void {
  const state = getLifiCircuitState(params.rpcCache, params.purpose);
  const nowMs = params.nowMs ?? Date.now();
  resetExpiredLifiCircuit(state, nowMs);
  state.failures += 1;
  const failureThreshold = getLifiQuoteFailureThreshold(params.lifiConfig);
  if (state.failures < failureThreshold) {
    return;
  }
  state.cooldownUntilMs =
    nowMs + getLifiQuoteFailureCooldownMs(params.lifiConfig);
}
