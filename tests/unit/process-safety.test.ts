import { expect } from 'chai';
import { EventEmitter } from 'events';
import sinon from 'sinon';
import { installProcessSafetyHandlers } from '../../src/process-safety';
import { logger } from '../../src/logging';

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

// Registration alone is not enough: the load-bearing contract is the asymmetry
// between the handlers. unhandledRejection MUST be non-fatal (a transient
// rejection escaping a fire-and-forget loop must not kill the daemon — the
// supervised loops self-recover), while uncaughtException is fatal and
// SIGTERM/SIGINT are a graceful exit(0). These drive the handlers and assert the
// exit behavior, so "tightening" unhandledRejection to exit() can no longer pass
// green on the registration-count test alone.
describe('installProcessSafetyHandlers behavior asymmetry', () => {
  let target: EventEmitter;
  let exitStub: sinon.SinonStub;
  let errorStub: sinon.SinonStub;
  let infoStub: sinon.SinonStub;

  beforeEach(() => {
    target = new EventEmitter();
    // Stub the real process.exit so the handlers can't kill the mocha runner.
    exitStub = sinon.stub(process, 'exit');
    errorStub = sinon.stub(logger, 'error');
    infoStub = sinon.stub(logger, 'info');
    installProcessSafetyHandlers(target);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('unhandledRejection is NON-fatal: logs an error and does NOT exit', () => {
    target.emit('unhandledRejection', new Error('transient loop rejection'));
    expect(exitStub.called).to.equal(false);
    expect(errorStub.calledOnce).to.equal(true);
  });

  it('uncaughtException is fatal: logs an error and exits(1)', () => {
    target.emit('uncaughtException', new Error('corrupt sync state'));
    expect(errorStub.calledOnce).to.equal(true);
    expect(exitStub.calledOnceWithExactly(1)).to.equal(true);
  });

  it('SIGTERM shuts down gracefully: logs and exits(0)', () => {
    target.emit('SIGTERM');
    expect(infoStub.calledOnce).to.equal(true);
    expect(exitStub.calledOnceWithExactly(0)).to.equal(true);
  });

  it('SIGINT shuts down gracefully: logs and exits(0)', () => {
    target.emit('SIGINT');
    expect(infoStub.calledOnce).to.equal(true);
    expect(exitStub.calledOnceWithExactly(0)).to.equal(true);
  });
});
