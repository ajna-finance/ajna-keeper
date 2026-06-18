import { expect } from 'chai';
import { runResilientLoopIteration } from '../../src/run';

// Reproducer for surfaced-defects #4: the Kick / Bond / LP loops lacked the
// crash-recovery wrapper that the Take/Settlement loops have, so an error
// escaping an iteration would silently kill that loop. All five loops now route
// through this wrapper.
describe('runResilientLoopIteration — loop crash recovery (defect #4)', () => {
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
    expect(result.delaySeconds).to.equal(30); // LOOP_CRASH_RECOVERY_DELAY_SECONDS
  });

  it('returns the success delay (no recovery) when the iteration succeeds', async () => {
    const result = await runResilientLoopIteration('Test', async () => {}, 5);
    expect(result.recovered).to.equal(false);
    expect(result.delaySeconds).to.equal(5);
  });
});
