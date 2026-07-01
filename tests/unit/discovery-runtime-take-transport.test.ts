import { expect } from 'chai';
import sinon from 'sinon';
import { clearSharedDiscoveryScans } from '../../src/discovery/targets';
import { clearSharedSettlementScannerCache } from '../../src/settlement/scanner';
import {
  KeeperConfig,
  PriceOriginSource,
  TakeWriteTransportMode,
} from '../../src/config';
import * as takeModule from '../../src/take';
import * as takeWriteTransportModule from '../../src/take/write-transport';
import { logger } from '../../src/logging';
import {
  BASE_CONFIG,
  createTestDiscoveryRuntime,
} from './helpers/discovery-runtime-fixture';

describe('Run Loop Discovery Take Transport', () => {
  afterEach(() => {
    sinon.restore();
    clearSharedDiscoveryScans();
    clearSharedSettlementScannerCache();
  });

  it('skips take execution when a dedicated take write transport is configured with a non-wallet signer', async () => {
    const handleTakesStub = sinon.stub(takeModule, 'handleTakes').resolves();
    const createTakeWriteTransportStub = sinon.stub(
      takeWriteTransportModule,
      'createTakeWriteTransport'
    );
    const loggerErrorStub = sinon.stub(logger, 'error');

    const config: KeeperConfig = {
      ...BASE_CONFIG,
      writes: {
        take: {
          mode: TakeWriteTransportMode.PRIVATE_RPC,
          rpcUrl: 'http://127.0.0.1:1',
        },
      },
      manual: {
        pools: [
          {
            name: 'Manual Take Pool',
            address: '0x1111111111111111111111111111111111111111',
            price: { source: PriceOriginSource.FIXED, value: 1 },
            take: {
              minCollateral: 0.1,
              hpbPriceFactor: 0.98,
            },
          },
        ],
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
      signer: {
        getChainId: sinon.stub().resolves(1),
      } as any,
    }).runTakeCycle();

    expect(handleTakesStub.called).to.equal(false);
    expect(createTakeWriteTransportStub.called).to.equal(false);
    expect(
      loggerErrorStub.calledWithMatch(
        sinon.match('requires a wallet-capable signer')
      )
    ).to.equal(true);
  });
});
