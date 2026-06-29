import { expect } from 'chai';
import sinon from 'sinon';
import { sweepRedeemerWithReactiveSettlement } from '../../src/run';
import * as settlementModule from '../../src/settlement';
import { logger } from '../../src/logging';

// Branch coverage for the LP-rewards reactive-settlement retry, extracted from
// collectLpRewardsLoop. Every branch only LOGS (none rethrow), so one redeemer's
// jammed auction must never abort the sweep cycle. tryReactiveSettlement is
// stubbed on the settlement module (run.ts calls it through the module ref).
describe('sweepRedeemerWithReactiveSettlement (LP-rewards retry branches)', () => {
  let trySettle: sinon.SinonStub;
  let info: sinon.SinonStub;
  let warn: sinon.SinonStub;
  let error: sinon.SinonStub;

  beforeEach(() => {
    trySettle = sinon.stub(settlementModule, 'tryReactiveSettlement');
    info = sinon.stub(logger, 'info');
    warn = sinon.stub(logger, 'warn');
    error = sinon.stub(logger, 'error');
  });

  afterEach(() => {
    sinon.restore();
  });

  const ANC = () => new Error('execution reverted: AuctionNotCleared()');

  function makeRedeemer(sweep: sinon.SinonStub): any {
    return {
      pool: {
        name: 'TestPool',
        poolAddress: '0x1111111111111111111111111111111111111111',
      },
      sweep,
      lpMap: new Map(),
    };
  }

  const poolConfig: any = {
    name: 'TestPool',
    address: '0x1111111111111111111111111111111111111111',
    settlement: { enabled: true },
  };

  const run = (redeemer: any, cfg: any = poolConfig) =>
    sweepRedeemerWithReactiveSettlement({
      redeemer,
      poolConfig: cfg,
      signer: {} as any,
      dryRun: false,
      subgraph: {} as any,
    });

  const loggedSome = (stub: sinon.SinonStub, needle: string) =>
    stub.getCalls().some((c) => String(c.args[0]).includes(needle));

  it('a clean sweep does no settlement and logs no error', async () => {
    const sweep = sinon.stub().resolves();
    await run(makeRedeemer(sweep));
    expect(sweep.calledOnce).to.equal(true);
    expect(trySettle.called).to.equal(false);
    expect(error.called).to.equal(false);
  });

  it('skips settlement for an auto-discovered pool with no config entry', async () => {
    const sweep = sinon.stub().rejects(ANC());
    // Call directly with poolConfig undefined (the `run` helper's default
    // parameter would otherwise swallow an explicit undefined).
    await sweepRedeemerWithReactiveSettlement({
      redeemer: makeRedeemer(sweep),
      poolConfig: undefined,
      signer: {} as any,
      dryRun: false,
      subgraph: {} as any,
    });
    expect(sweep.calledOnce).to.equal(true);
    expect(trySettle.called).to.equal(false);
    expect(loggedSome(warn, 'Settlement skipped')).to.equal(true);
  });

  it('settles then re-sweeps successfully', async () => {
    const sweep = sinon.stub();
    sweep.onCall(0).rejects(ANC());
    sweep.onCall(1).resolves();
    trySettle.resolves(true);

    await run(makeRedeemer(sweep));

    expect(trySettle.calledOnce).to.equal(true);
    expect(sweep.calledTwice).to.equal(true);
    expect(loggedSome(info, 'Retrying LP collection after settlement')).to.equal(
      true
    );
    expect(error.called).to.equal(false);
  });

  it('warns (not errors) when a second auction is still jammed after settling the first', async () => {
    const sweep = sinon.stub().rejects(ANC()); // both attempts reject ANC
    trySettle.resolves(true);

    await run(makeRedeemer(sweep));

    expect(sweep.calledTwice).to.equal(true);
    expect(loggedSome(warn, 'second auction still jammed')).to.equal(true);
    expect(error.called).to.equal(false);
  });

  it('errors when the post-settlement re-sweep fails for a non-AuctionNotCleared reason', async () => {
    const sweep = sinon.stub();
    sweep.onCall(0).rejects(ANC());
    sweep.onCall(1).rejects(new Error('insufficient funds'));
    trySettle.resolves(true);

    await run(makeRedeemer(sweep));

    expect(loggedSome(error, 'LP sweep retry after settlement still failed')).to.equal(
      true
    );
    expect(warn.called).to.equal(false);
  });

  it('warns when settlement runs but bonds stay locked (not settled)', async () => {
    const sweep = sinon.stub().rejects(ANC());
    trySettle.resolves(false);

    await run(makeRedeemer(sweep));

    expect(sweep.calledOnce).to.equal(true); // no retry sweep
    expect(loggedSome(warn, 'bonds still locked')).to.equal(true);
    expect(error.called).to.equal(false);
  });

  it('errors (does not rethrow) when settlement itself throws', async () => {
    const sweep = sinon.stub().rejects(ANC());
    trySettle.rejects(new Error('settlement boom'));

    await run(makeRedeemer(sweep));

    expect(loggedSome(error, 'Settlement failed')).to.equal(true);
    expect(warn.called).to.equal(false);
  });

  it('errors on a non-AuctionNotCleared sweep failure without attempting settlement', async () => {
    const sweep = sinon.stub().rejects(new Error('RPC timeout'));
    await run(makeRedeemer(sweep));
    expect(trySettle.called).to.equal(false);
    expect(loggedSome(error, 'Failed to collect LP reward from pool')).to.equal(
      true
    );
  });

  it('never rethrows, so one redeemer failure cannot abort the cycle', async () => {
    const sweep = sinon.stub().rejects(new Error('RPC timeout'));
    // The await resolving (not rejecting) is the no-rethrow proof; the function
    // returns void and logs exactly one error for the failed sweep.
    const result = await run(makeRedeemer(sweep));
    expect(result).to.equal(undefined);
    expect(error.calledOnce).to.equal(true);
  });
});
