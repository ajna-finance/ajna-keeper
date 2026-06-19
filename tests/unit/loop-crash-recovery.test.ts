import { expect } from 'chai';
import sinon from 'sinon';
import {
  runResilientLoop,
  runResilientLoopIteration,
  runTakeLoopIteration,
} from '../../src/run';
import { logger } from '../../src/logging';

// Reproducer for surfaced-defects #4: the Kick / Bond / LP loops lacked the
// crash-recovery wrapper that the Take/Settlement loops have, so an error
// escaping an iteration would silently kill that loop while the process and the
// other loops kept running. All five daemon loops are now crash-recoverable:
//   - Kick / Bond / LP  → runResilientLoopIteration (shared helper)
//   - Take              → runTakeLoopIteration (its own exported wrapper)
//   - Settlement        → an equivalent inline try/catch (covered end-to-end by
//                         the P1-3 persistent-daemon fork scenario)
// Both exported iteration wrappers are asserted here to recover rather than
// reject, and to surface the recovery delay so the loop re-enters.
const LOOP_CRASH_RECOVERY_DELAY_SECONDS = 30;

describe('runResilientLoopIteration — Kick/Bond/LP crash recovery (defect #4)', () => {
  it('recovers from a throwing iteration (does not reject) and returns the recovery delay', async () => {
    let calls = 0;
    const result = await runResilientLoopIteration(
      'Test',
      async () => {
        calls += 1;
        throw new Error('boom');
      },
      5
    );
    expect(calls).to.equal(1);
    expect(result.recovered).to.equal(true);
    expect(result.delaySeconds).to.equal(LOOP_CRASH_RECOVERY_DELAY_SECONDS);
  });

  it('returns the success delay (no recovery) when the iteration succeeds', async () => {
    const result = await runResilientLoopIteration('Test', async () => {}, 5);
    expect(result.recovered).to.equal(false);
    expect(result.delaySeconds).to.equal(5);
  });
});

describe('runTakeLoopIteration — Take loop crash recovery (defect #4)', () => {
  const paramsWithTakeCycle = (runTakeCycle: () => Promise<void>) =>
    ({
      config: { runtime: { delayBetweenRuns: 7 } },
      discoveryRuntime: { runTakeCycle },
    }) as never;

  it('recovers from a runTakeCycle that throws and returns the recovery delay', async () => {
    let calls = 0;
    const result = await runTakeLoopIteration(
      paramsWithTakeCycle(async () => {
        calls += 1;
        throw new Error('take cycle boom');
      })
    );
    expect(calls).to.equal(1);
    expect(result.recovered).to.equal(true);
    expect(result.delaySeconds).to.equal(LOOP_CRASH_RECOVERY_DELAY_SECONDS);
  });

  it('returns the configured delay (no recovery) when the take cycle succeeds', async () => {
    const result = await runTakeLoopIteration(
      paramsWithTakeCycle(async () => {})
    );
    expect(result.recovered).to.equal(false);
    expect(result.delaySeconds).to.equal(7);
  });
});

// P1-3: the iteration wrappers above recover; this drives the actual infinite
// loop (Kick/Bond/LP route through it) to prove the loop RE-ENTERS after a
// crashed iteration — it does not die on the first throw. Fake timers collapse
// the 30s recovery delay so the test is instant.
describe('runResilientLoop — re-enters the loop after a crashed iteration', () => {
  let clock: sinon.SinonFakeTimers;
  beforeEach(() => {
    clock = sinon.useFakeTimers();
  });
  afterEach(() => {
    clock.restore();
    sinon.restore();
  });

  it('catches a crashing iteration, waits the recovery delay, and re-enters', async () => {
    const iteration = sinon.stub();
    iteration.onCall(0).rejects(new Error('cycle exploded'));
    iteration.onCall(1).resolves();
    iteration.resolves();
    const infoLog = sinon.stub(logger, 'info');

    // Start the infinite loop (do NOT await it) with a 1s success delay.
    void runResilientLoop('TestKick', iteration, () => 1);

    // Advance past the 30s crash-recovery delay; the loop must re-enter and call
    // the iteration again rather than die on the first throw.
    await clock.tickAsync(LOOP_CRASH_RECOVERY_DELAY_SECONDS * 1000);

    expect(iteration.callCount).to.be.greaterThan(1);
    expect(
      infoLog
        .getCalls()
        .some((c) =>
          String(c.args[0]).includes(
            'Restarting TestKick loop after crash recovery delay'
          )
        )
    ).to.equal(true);
  });
});
