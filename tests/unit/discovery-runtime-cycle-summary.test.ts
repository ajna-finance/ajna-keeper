import { expect } from 'chai';
import sinon from 'sinon';
import { clearSharedDiscoveryScans } from '../../src/discovery/targets';
import { clearSharedSettlementScannerCache } from '../../src/settlement/scanner';
import { runResilientLoopIteration } from '../../src/run';
import { KeeperConfig, PriceOriginSource } from '../../src/config';
import * as takeModule from '../../src/take';
import subgraph from '../../src/subgraph';
import { logger } from '../../src/logging';
import {
  BASE_CONFIG,
  createTestDiscoveryRuntime,
} from './helpers/discovery-runtime-fixture';

describe('Run Loop Discovery Cycle Summary', () => {
  afterEach(() => {
    sinon.restore();
    clearSharedDiscoveryScans();
    clearSharedSettlementScannerCache();
  });

  it('logs a take cycle summary with target counts and snapshot status', async () => {
    const handleTakesStub = sinon.stub(takeModule, 'handleTakes').resolves();
    const loggerInfoStub = sinon.stub(logger, 'info');

    const config: KeeperConfig = {
      ...BASE_CONFIG,
      manual: {
        pools: [
          {
            name: 'Manual Take Pool',
            address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            price: { source: PriceOriginSource.FIXED, value: 1 },
            take: {
              minCollateral: 0.1,
              hpbPriceFactor: 0.98,
            },
          },
        ],
      },
    };
    const pool = {
      name: 'Manual Take Pool',
      poolAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    };

    await createTestDiscoveryRuntime({
      config,
      poolMap: new Map([[config.manual.pools[0].address, pool as any]]),
    }).runTakeCycle();

    expect(handleTakesStub.calledOnce).to.be.true;
    const summaryLog = loggerInfoStub
      .getCalls()
      .map((call) => call.args[0])
      .find(
        (message: any) =>
          typeof message === 'string' &&
          message.includes('Discovery take cycle summary:')
      );
    expect(summaryLog).to.be.a('string');
    expect(summaryLog).to.include('snapshotRefreshed=false');
    expect(summaryLog).to.include('targets=1');
    expect(summaryLog).to.include('manualTargets=1');
    expect(summaryLog).to.include('discoveredTargets=0');
    expect(summaryLog).to.include('targetSuccesses=1');
    expect(summaryLog).to.include('targetFailures=0');
  });

  it('does not treat snapshot refresh failures as take loop crashes', async () => {
    sinon
      .stub(subgraph, 'getChainwideLiquidationAuctions')
      .rejects(new Error('temporary discovery outage'));

    const config: KeeperConfig = {
      ...BASE_CONFIG,
      discovery: {
        enabled: true,
        take: true,
        defaults: {
          take: {
            minCollateral: 0.1,
            hpbPriceFactor: 0.98,
          },
        },
      },
    };
    // takePoolsLoop routes through runResilientLoop('Take', () => runTakeCycle(),
    // () => delayBetweenRuns); a snapshot refresh failure is swallowed inside
    // runTakeCycle, so the iteration succeeds (no crash recovery).
    const runtime = createTestDiscoveryRuntime({
      config,
      discoverySnapshotState: {},
    });
    const result = await runResilientLoopIteration(
      'Take',
      () => runtime.runTakeCycle(),
      config.runtime.delayBetweenRuns
    );

    expect(result).to.deep.equal({
      delaySeconds: config.runtime.delayBetweenRuns,
      recovered: false,
    });
  });
});
