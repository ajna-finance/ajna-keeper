import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber } from 'ethers';
import { clearSharedDiscoveryScans } from '../../src/discovery/targets';
import { clearSharedSettlementScannerCache } from '../../src/settlement/scanner';
import * as discoveryHandlers from '../../src/discovery/handlers';
import subgraph from '../../src/subgraph';
import { logger } from '../../src/logging';
import {
  BASE_CONFIG,
  createTestDiscoveryRuntime,
  makeAjnaFactoryWithHydratedPools,
  makeAjnaFactoryWithPoolLoader,
} from './helpers/discovery-runtime-fixture';

describe('Run Loop Discovery Take Target Dispatch', () => {
  afterEach(() => {
    sinon.restore();
    clearSharedDiscoveryScans();
    clearSharedSettlementScannerCache();
  });

  it('contains discovered take handler failures and reports them in the cycle summary', async () => {
    const handleDiscoveredTakeTargetStub = sinon
      .stub(discoveryHandlers, 'handleDiscoveredTakeTarget')
      .rejects(new Error('temporary take handler failure'));
    const loggerErrorStub = sinon.stub(logger, 'error');
    const loggerInfoStub = sinon.stub(logger, 'info');
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
        provider: {
          getGasPrice: sinon.stub().resolves(BigNumber.from(1)),
        },
      } as any,
      discoverySnapshotState: {},
    }).runTakeCycle();

    expect(handleDiscoveredTakeTargetStub.calledOnce).to.be.true;
    expect(
      loggerErrorStub.calledWithMatch(
        sinon.match('Failed to handle take for pool: Discovered Pool.')
      )
    ).to.be.true;
    const summaryLog = loggerInfoStub
      .getCalls()
      .map((call) => call.args[0])
      .find(
        (message: any) =>
          typeof message === 'string' &&
          message.includes('Discovery take cycle summary:')
      );
    expect(summaryLog).to.include('targetSuccesses=0');
    expect(summaryLog).to.include('targetFailures=1');
  });

  it('skips discovered take execution when pool hydration is unavailable', async () => {
    const handleDiscoveredTakeTargetStub = sinon
      .stub(discoveryHandlers, 'handleDiscoveredTakeTarget')
      .resolves();
    const loggerInfoStub = sinon.stub(logger, 'info');
    sinon.stub(logger, 'error');
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
      ajna: makeAjnaFactoryWithPoolLoader(
        sinon.stub().rejects(new Error('pool hydration unavailable')),
        []
      ),
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
        provider: {
          getGasPrice: sinon.stub().resolves(BigNumber.from(1)),
        },
      } as any,
      discoverySnapshotState: {},
    }).runTakeCycle();

    expect(handleDiscoveredTakeTargetStub.called).to.be.false;
    const summaryLog = loggerInfoStub
      .getCalls()
      .map((call) => call.args[0])
      .find(
        (message: any) =>
          typeof message === 'string' &&
          message.includes('Discovery take cycle summary:')
      );
    expect(summaryLog).to.include('poolsUnavailable=1');
    expect(summaryLog).to.include('targetSuccesses=0');
  });
});
