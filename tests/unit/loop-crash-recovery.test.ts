import { expect } from 'chai';
import { runResilientLoopIteration, runTakeLoopIteration } from '../../src/run';

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
