import { expect } from 'chai';
import sinon from 'sinon';
import { clearSharedDiscoveryScans } from '../../src/discovery/targets';
import { clearSharedSettlementScannerCache } from '../../src/settlement/scanner';
import { KeeperConfig, PriceOriginSource } from '../../src/config';
import * as takeModule from '../../src/take';
import * as discoveryHandlers from '../../src/discovery/handlers';
import subgraph from '../../src/subgraph';
import { logger } from '../../src/logging';
import {
  BASE_CONFIG,
  createTestDiscoveryRuntime,
} from './helpers/discovery-runtime-fixture';

describe('Run Loop Discovery Take Snapshot Cache', () => {
  afterEach(() => {
    sinon.restore();
    clearSharedDiscoveryScans();
    clearSharedSettlementScannerCache();
  });

  it('continues manual take targets when snapshot refresh fails', async () => {
    const handleTakesStub = sinon.stub(takeModule, 'handleTakes').resolves();
    const loggerWarnStub = sinon.stub(logger, 'warn');
    sinon
      .stub(subgraph, 'getChainwideLiquidationAuctions')
      .rejects(new Error('subgraph unavailable'));

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

    await createTestDiscoveryRuntime({
      config,
      poolMap: new Map([
        [
          config.manual.pools[0].address,
          {
            name: 'Manual Take Pool',
            poolAddress: config.manual.pools[0].address,
          } as any,
        ],
      ]),
      discoverySnapshotState: {},
    }).runTakeCycle();

    expect(handleTakesStub.calledOnce).to.be.true;
    expect(
      loggerWarnStub.calledWithMatch(
        sinon.match('Failed to refresh take discovery snapshot')
      )
    ).to.be.true;
  });

  it('rethrows malformed cached take discovery data during target resolution', async () => {
    const nowMs = 1_000;
    sinon.stub(Date, 'now').callsFake(() => nowMs);
    const loggerWarnStub = sinon.stub(logger, 'warn');
    const loggerErrorStub = sinon.stub(logger, 'error');
    sinon
      .stub(subgraph, 'getChainwideLiquidationAuctions')
      .rejects(new Error('subgraph unavailable'));

    const runtime = createTestDiscoveryRuntime({
      config: {
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
      },
      discoverySnapshotState: {
        fetchedAt: 0,
        latestLiquidationAuctions: [
          {
            borrower: '0xBorrowerMalformed',
            kickTime: '1',
            debtRemaining: '3',
            collateralRemaining: '2',
            neutralPrice: '4',
            debt: '3',
            collateral: '2',
          } as any,
        ],
      },
    });

    let thrown: unknown;
    try {
      await runtime.runTakeCycle();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.be.instanceOf(TypeError);
    expect(
      loggerWarnStub.calledWithMatch(
        sinon.match(
          'Failed to refresh take discovery snapshot; continuing with cached discovery data'
        )
      )
    ).to.be.true;
    expect(
      loggerErrorStub.calledWithMatch(
        sinon.match('Discovery take cycle failed: phase=targets')
      )
    ).to.be.true;
  });

  it('does not reuse an overly stale cached take snapshot after refresh failures', async () => {
    let nowMs = 300_000;
    sinon.stub(Date, 'now').callsFake(() => nowMs);
    const handleTakesStub = sinon.stub(takeModule, 'handleTakes').resolves();
    const handleDiscoveredTakeTargetStub = sinon
      .stub(discoveryHandlers, 'handleDiscoveredTakeTarget')
      .resolves();
    const loggerWarnStub = sinon.stub(logger, 'warn');
    sinon
      .stub(subgraph, 'getChainwideLiquidationAuctions')
      .rejects(new Error('subgraph unavailable'));

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

    await createTestDiscoveryRuntime({
      config,
      poolMap: new Map([
        [
          config.manual.pools[0].address,
          {
            name: 'Manual Take Pool',
            poolAddress: config.manual.pools[0].address,
          } as any,
        ],
      ]),
      discoverySnapshotState: {
        fetchedAt: 0,
        latestLiquidationAuctions: [
          {
            borrower: '0xBorrowerA',
            kickTime: '1',
            debtRemaining: '3',
            collateralRemaining: '2',
            neutralPrice: '4',
            debt: '3',
            collateral: '2',
            pool: { id: '0x4444444444444444444444444444444444444444' },
          },
        ],
      },
    }).runTakeCycle();

    expect(handleTakesStub.calledOnce).to.be.true;
    expect(handleDiscoveredTakeTargetStub.called).to.be.false;
    expect(
      loggerWarnStub.calledWithMatch(
        sinon.match('Cached take discovery snapshot is too stale')
      )
    ).to.be.true;
  });
});
