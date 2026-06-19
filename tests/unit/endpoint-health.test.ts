import { expect } from 'chai';
import sinon from 'sinon';
import {
  clearEndpointHealthState,
  isEndpointInCooldown,
  orderEndpointsByHealth,
  recordEndpointFailure,
  recordEndpointSuccess,
} from '../../src/endpoint-health';

// P1-3 read-RPC resilience: single-failure failover is covered in read-rpc.test.ts.
// This pins the COOLDOWN state machine that drives multi-cycle failover + recovery:
// a read endpoint that fails READ_RPC_FAILURE_THRESHOLD (3) times in a row enters a
// READ_RPC_COOLDOWN_MS (30s) cooldown and is deprioritized, then is retried once the
// window closes. Deterministic via a fake clock — the health module reads Date.now()
// for the cooldown timestamps, with no module-level time bindings to leak.
describe('endpoint-health cooldown + recovery (read-RPC failover state machine)', () => {
  const KIND = 'read-rpc' as const;
  const A = 'http://rpc-a';
  const B = 'http://rpc-b';
  // Defaults in recordEndpointFailure match the READ_RPC_* constants.
  const THRESHOLD = 3;
  const COOLDOWN_MS = 30_000;
  let clock: sinon.SinonFakeTimers;

  beforeEach(() => {
    clearEndpointHealthState();
    // Fake ONLY Date (cooldown timestamps) — faking setTimeout/etc. would
    // interfere with unrelated async timers in the shared test process.
    clock = sinon.useFakeTimers({ now: 1_000_000, toFake: ['Date'] });
  });
  afterEach(() => {
    clock.restore();
    clearEndpointHealthState();
  });

  it('enters cooldown only at the failure threshold, deprioritizes the endpoint, then recovers after the window', () => {
    // Below threshold: not yet cooling down, stays in normal order.
    for (let i = 0; i < THRESHOLD - 1; i += 1) {
      recordEndpointFailure(KIND, A, new Error('boom'));
    }
    expect(isEndpointInCooldown(KIND, A)).to.equal(false);
    expect(orderEndpointsByHealth(KIND, [A, B])).to.deep.equal([A, B]);

    // The threshold-th consecutive failure trips the cooldown.
    recordEndpointFailure(KIND, A, new Error('boom'));
    expect(isEndpointInCooldown(KIND, A)).to.equal(true);
    // Failover: the cooling-down endpoint is moved behind the healthy one.
    expect(orderEndpointsByHealth(KIND, [A, B])).to.deep.equal([B, A]);

    // Still cooling down right up to the window boundary.
    clock.tick(COOLDOWN_MS - 1);
    expect(isEndpointInCooldown(KIND, A)).to.equal(true);

    // Once the window closes the endpoint is retryable again (recovery path).
    clock.tick(2);
    expect(isEndpointInCooldown(KIND, A)).to.equal(false);
    expect(orderEndpointsByHealth(KIND, [A, B])).to.deep.equal([A, B]);
  });

  it('a success resets the consecutive-failure count so the threshold is not reached', () => {
    recordEndpointFailure(KIND, A, new Error('boom'));
    recordEndpointFailure(KIND, A, new Error('boom'));
    recordEndpointSuccess(KIND, A); // reset
    recordEndpointFailure(KIND, A, new Error('boom'));
    recordEndpointFailure(KIND, A, new Error('boom'));
    // Only two failures since the reset (< threshold) — still healthy.
    expect(isEndpointInCooldown(KIND, A)).to.equal(false);
  });

  it('a success during cooldown clears it immediately (endpoint recovered)', () => {
    for (let i = 0; i < THRESHOLD; i += 1) {
      recordEndpointFailure(KIND, A, new Error('boom'));
    }
    expect(isEndpointInCooldown(KIND, A)).to.equal(true);
    recordEndpointSuccess(KIND, A);
    expect(isEndpointInCooldown(KIND, A)).to.equal(false);
  });

  it('when every endpoint is cooling down, falls back to the configured order instead of dropping any', () => {
    for (let i = 0; i < THRESHOLD; i += 1) {
      recordEndpointFailure(KIND, A, new Error('boom'));
      recordEndpointFailure(KIND, B, new Error('boom'));
    }
    expect(isEndpointInCooldown(KIND, A)).to.equal(true);
    expect(isEndpointInCooldown(KIND, B)).to.equal(true);
    expect(orderEndpointsByHealth(KIND, [A, B])).to.deep.equal([A, B]);
  });
});
