import { expect } from 'chai';
import { EventEmitter } from 'events';
import { installProcessSafetyHandlers } from '../../src/process-safety';

// Reproducer for surfaced-defects #3: the keeper installed no process-level
// crash/shutdown guards, so an unhandled rejection could kill the daemon and
// there was no graceful shutdown on SIGTERM/SIGINT.
describe('installProcessSafetyHandlers (defect #3)', () => {
  it('registers unhandledRejection, uncaughtException, SIGTERM, and SIGINT handlers', () => {
    const target = new EventEmitter();
    installProcessSafetyHandlers(target);
    expect(target.listenerCount('unhandledRejection')).to.equal(1);
    expect(target.listenerCount('uncaughtException')).to.equal(1);
    expect(target.listenerCount('SIGTERM')).to.equal(1);
    expect(target.listenerCount('SIGINT')).to.equal(1);
  });
});
