import { expect } from 'chai';
import sinon from 'sinon';
import { clearSharedDiscoveryScans } from '../../src/discovery/targets';
import { clearSharedSettlementScannerCache } from '../../src/settlement/scanner';
import * as discoveryHandlers from '../../src/discovery/handlers';
import subgraph from '../../src/subgraph';
import { logger } from '../../src/logging';
import {
  BASE_CONFIG,
  createTestDiscoveryRuntime,
  makeAjnaFactoryWithHydratedPools,
} from './helpers/discovery-runtime-fixture';

describe('Run Loop Discovery Hot Auction Cache', () => {
  afterEach(() => {
    sinon.restore();
    clearSharedDiscoveryScans();
    clearSharedSettlementScannerCache();
  });

  it('continues discovered take execution when hot-cache chain id lookup fails', async () => {
    const handleDiscoveredTakeTargetStub = sinon
      .stub(discoveryHandlers, 'handleDiscoveredTakeTarget')
      .resolves();
    const loggerWarnStub = sinon.stub(logger, 'warn');
    sinon.stub(subgraph, 'getChainwideLiquidationAuctions').resolves({
      liquidationAuctions: [
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
    });

    await createTestDiscoveryRuntime({
      ajna: makeAjnaFactoryWithHydratedPools([
        {
          name: 'Discovered Pool',
          poolAddress: '0x4444444444444444444444444444444444444444',
          quoteAddress: '0x5555555555555555555555555555555555555555',
          collateralAddress: '0x6666666666666666666666666666666666666666',
        },
      ]),
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
      signer: {
        getChainId: sinon.stub().rejects(new Error('chain id unavailable')),
      } as any,
      discoverySnapshotState: {},
    }).runTakeCycle();

    expect(handleDiscoveredTakeTargetStub.calledOnce).to.be.true;
    expect(
      loggerWarnStub.calledWithMatch(
        sinon.match(
          'Discovery runtime could not resolve chainId; hot auction cache will be skipped this cycle'
        )
      )
    ).to.be.true;
  });
});
