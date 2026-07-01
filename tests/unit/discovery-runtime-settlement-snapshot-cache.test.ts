import { expect } from 'chai';
import sinon from 'sinon';
import { clearSharedDiscoveryScans } from '../../src/discovery/targets';
import { clearSharedSettlementScannerCache } from '../../src/settlement/scanner';
import { KeeperConfig, PriceOriginSource } from '../../src/config';
import * as settlementModule from '../../src/settlement';
import * as discoveryHandlers from '../../src/discovery/handlers';
import subgraph from '../../src/subgraph';
import { logger } from '../../src/logging';
import {
  BASE_CONFIG,
  createTestDiscoveryRuntime,
  makeAjnaFactoryWithHydratedPools,
} from './helpers/discovery-runtime-fixture';

describe('Run Loop Discovery Settlement Snapshot Cache', () => {
  afterEach(() => {
    sinon.restore();
    clearSharedDiscoveryScans();
    clearSharedSettlementScannerCache();
  });

  it('rethrows malformed cached settlement discovery data during target resolution', async () => {
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
          take: false,
          settlement: true,
          defaults: {
            settlement: {
              enabled: true,
              minAuctionAge: 60,
              maxBucketDepth: 50,
              maxIterations: 5,
              checkBotIncentive: true,
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
            collateralRemaining: '0',
            neutralPrice: '4',
            debt: '3',
            collateral: '0',
          } as any,
        ],
      },
    });

    let thrown: unknown;
    try {
      await runtime.runSettlementCycle();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.be.instanceOf(TypeError);
    expect(
      loggerWarnStub.calledWithMatch(
        sinon.match(
          'Failed to refresh settlement discovery snapshot; continuing with cached discovery data'
        )
      )
    ).to.be.true;
    expect(
      loggerErrorStub.calledWithMatch(
        sinon.match('Discovery settlement cycle failed: phase=targets')
      )
    ).to.be.true;
  });

  it('continues manual settlement targets when discovery rpc cache creation fails', async () => {
    const handleSettlementsStub = sinon
      .stub(settlementModule, 'handleSettlements')
      .resolves();
    const handleDiscoveredSettlementTargetStub = sinon
      .stub(discoveryHandlers, 'handleDiscoveredSettlementTarget')
      .resolves();
    sinon.stub(subgraph, 'getChainwideLiquidationAuctions').resolves({
      liquidationAuctions: [
        {
          borrower: '0xBorrowerA',
          kickTime: '1',
          debtRemaining: '3',
          collateralRemaining: '0',
          neutralPrice: '4',
          debt: '3',
          collateral: '0',
          pool: { id: '0x4444444444444444444444444444444444444444' },
        },
      ],
    });
    const loggerErrorStub = sinon.stub(logger, 'error');

    const config: KeeperConfig = {
      ...BASE_CONFIG,
      manual: {
        pools: [
          {
            name: 'Manual Settlement Pool',
            address: '0x2222222222222222222222222222222222222222',
            price: { source: PriceOriginSource.FIXED, value: 1 },
            settlement: {
              enabled: true,
              minAuctionAge: 60,
            },
          },
        ],
      },
      discovery: {
        enabled: true,
        take: false,
        settlement: true,
        defaults: {
          settlement: {
            enabled: true,
            minAuctionAge: 60,
            maxBucketDepth: 50,
            maxIterations: 5,
            checkBotIncentive: true,
          },
        },
      },
    };

    await createTestDiscoveryRuntime({
      ajna: makeAjnaFactoryWithHydratedPools([
        {
          name: 'Discovered Settlement Pool',
          poolAddress: '0x4444444444444444444444444444444444444444',
          quoteAddress: '0x5555555555555555555555555555555555555555',
          collateralAddress: '0x6666666666666666666666666666666666666666',
        },
      ]),
      config,
      signer: {
        provider: {
          getGasPrice: sinon.stub().rejects(new Error('read rpc unavailable')),
        },
        getAddress: sinon
          .stub()
          .resolves('0x7777777777777777777777777777777777777777'),
      } as any,
      poolMap: new Map([
        [
          config.manual.pools[0].address,
          {
            name: 'Manual Settlement Pool',
            poolAddress: config.manual.pools[0].address,
          } as any,
        ],
      ]),
      discoverySnapshotState: {},
    }).runSettlementCycle();

    expect(handleSettlementsStub.calledOnce).to.be.true;
    expect(handleDiscoveredSettlementTargetStub.called).to.be.false;
    expect(
      loggerErrorStub
        .getCalls()
        .some((call) =>
          String(call.args[0]).includes(
            'Failed to handle settlements for pool: Discovered Settlement Pool'
          )
        )
    ).to.equal(true);
  });
});
