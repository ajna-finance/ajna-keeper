import { AutoDiscoverTakePolicy } from '../config';
import { logger } from '../logging';
import {
  DiscoveryRpcCache,
  OneInchQuoteCircuitPurpose,
  OneInchQuoteCircuitState,
} from './types';

export const DEFAULT_ONEINCH_QUOTE_TIMEOUT_MS = 2_000;
export const DEFAULT_ONEINCH_QUOTE_FAILURE_COOLDOWN_MS = 30_000;
export const DEFAULT_ONEINCH_QUOTE_FAILURE_THRESHOLD = 2;
export const MAX_ONEINCH_QUOTE_FAILURE_COOLDOWN_MS = 60 * 60 * 1000;
const ONEINCH_CIRCUIT_OPEN_HEARTBEAT_MS = 5 * 60 * 1000;

type OneInchCircuitPolicy =
  | Pick<
      AutoDiscoverTakePolicy,
      | 'oneInchQuoteTimeoutMs'
      | 'oneInchQuoteFailureCooldownMs'
      | 'oneInchQuoteFailureThreshold'
    >
  | undefined;

export function getOneInchQuoteTimeoutMs(
  takePolicy: OneInchCircuitPolicy
): number {
  return takePolicy?.oneInchQuoteTimeoutMs ?? DEFAULT_ONEINCH_QUOTE_TIMEOUT_MS;
}

function getOneInchQuoteFailureCooldownMs(
  takePolicy: OneInchCircuitPolicy
): number {
  const configuredCooldownMs =
    takePolicy?.oneInchQuoteFailureCooldownMs ??
    DEFAULT_ONEINCH_QUOTE_FAILURE_COOLDOWN_MS;
  return Math.min(
    configuredCooldownMs > 0
      ? configuredCooldownMs
      : DEFAULT_ONEINCH_QUOTE_FAILURE_COOLDOWN_MS,
    MAX_ONEINCH_QUOTE_FAILURE_COOLDOWN_MS
  );
}

function getOneInchQuoteFailureThreshold(
  takePolicy: OneInchCircuitPolicy
): number {
  return (
    takePolicy?.oneInchQuoteFailureThreshold ??
    DEFAULT_ONEINCH_QUOTE_FAILURE_THRESHOLD
  );
}

function getOneInchCircuitState(
  rpcCache?: DiscoveryRpcCache,
  purpose: OneInchQuoteCircuitPurpose = 'route_quote'
): OneInchQuoteCircuitState {
  if (!rpcCache) {
    return { failures: 0 };
  }
  if (purpose === 'route_quote') {
    rpcCache.oneInchQuoteCircuit ??= { failures: 0 };
    rpcCache.oneInchQuoteCircuits ??= {};
    rpcCache.oneInchQuoteCircuits.route_quote ??= rpcCache.oneInchQuoteCircuit;
    return rpcCache.oneInchQuoteCircuit;
  }
  rpcCache.oneInchQuoteCircuits ??= {};
  rpcCache.oneInchQuoteCircuits[purpose] ??= { failures: 0 };
  return rpcCache.oneInchQuoteCircuits[purpose]!;
}

function resetExpiredOneInchCircuit(
  state: OneInchQuoteCircuitState,
  nowMs: number
): void {
  if (state.cooldownUntilMs !== undefined && state.cooldownUntilMs <= nowMs) {
    state.failures = 0;
    state.cooldownUntilMs = undefined;
    state.lastOpenLogAtMs = undefined;
  }
}

export function getOneInchCircuitOpenReason(params: {
  rpcCache?: DiscoveryRpcCache;
  takePolicy: OneInchCircuitPolicy;
  purpose?: OneInchQuoteCircuitPurpose;
  nowMs?: number;
}): string | undefined {
  const purpose = params.purpose ?? 'route_quote';
  const state = getOneInchCircuitState(params.rpcCache, purpose);
  const nowMs = params.nowMs ?? Date.now();
  resetExpiredOneInchCircuit(state, nowMs);
  if (state.cooldownUntilMs !== undefined && state.cooldownUntilMs > nowMs) {
    if (
      state.lastOpenLogAtMs === undefined ||
      nowMs - state.lastOpenLogAtMs >= ONEINCH_CIRCUIT_OPEN_HEARTBEAT_MS
    ) {
      logger.info(
        `1inch quote circuit remains open for purpose=${purpose} until ${state.cooldownUntilMs}`
      );
      state.lastOpenLogAtMs = nowMs;
    }
    return `1inch quote circuit open for purpose=${purpose} until ${state.cooldownUntilMs}`;
  }
  return undefined;
}

export function recordOneInchQuoteSuccess(
  rpcCache?: DiscoveryRpcCache,
  purpose: OneInchQuoteCircuitPurpose = 'route_quote'
): void {
  const state =
    purpose === 'route_quote'
      ? rpcCache?.oneInchQuoteCircuit
      : rpcCache?.oneInchQuoteCircuits?.[purpose];
  if (!state) {
    return;
  }
  state.failures = 0;
  state.cooldownUntilMs = undefined;
  state.lastOpenLogAtMs = undefined;
}

export function recordOneInchQuoteFailure(params: {
  rpcCache?: DiscoveryRpcCache;
  takePolicy: OneInchCircuitPolicy;
  purpose?: OneInchQuoteCircuitPurpose;
  nowMs?: number;
}): void {
  const state = getOneInchCircuitState(
    params.rpcCache,
    params.purpose ?? 'route_quote'
  );
  const nowMs = params.nowMs ?? Date.now();
  resetExpiredOneInchCircuit(state, nowMs);
  state.failures += 1;
  const failureThreshold = getOneInchQuoteFailureThreshold(params.takePolicy);
  if (state.failures < failureThreshold) {
    return;
  }
  state.cooldownUntilMs =
    nowMs + getOneInchQuoteFailureCooldownMs(params.takePolicy);
}
