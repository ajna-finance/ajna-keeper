import { expect } from 'chai';
import sinon from 'sinon';
import { KeeperConfig, PriceOriginSource, TakeWriteTransportMode } from '../config';
import { initializeTakeLoop, shouldRunTakeLoop } from '../run';

import * as takeWriteTransportModule from '../take/write-transport';

const BASE_CONFIG: KeeperConfig = {
  ethRpcUrl: 'http://localhost:8545',
  logLevel: 'debug',
  subgraphUrl: 'http://example-subgraph',
  keeperKeystore: '/tmp/keeper.json',
  ajna: {
    erc20PoolFactory: '0x0000000000000000000000000000000000000001',
    erc721PoolFactory: '0x0000000000000000000000000000000000000002',
    poolUtils: '0x0000000000000000000000000000000000000003',
    positionManager: '0x0000000000000000000000000000000000000004',
    ajnaToken: '0x0000000000000000000000000000000000000005',
  },
  delayBetweenActions: 0,
  delayBetweenRuns: 1,
  pools: [],
};

describe('run startup gating', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('detects when take work is configured', () => {
    expect(shouldRunTakeLoop(BASE_CONFIG)).to.equal(false);
    expect(
      shouldRunTakeLoop({
        ...BASE_CONFIG,
        takeWrite: {
          mode: TakeWriteTransportMode.PRIVATE_RPC,
          rpcUrl: 'http://127.0.0.1:1',
        },
      })
    ).to.equal(false);
    expect(
      shouldRunTakeLoop({
        ...BASE_CONFIG,
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
      })
    ).to.equal(true);
    expect(
      shouldRunTakeLoop({
        ...BASE_CONFIG,
        autoDiscover: {
          enabled: true,
          take: true,
        },
      })
    ).to.equal(true);
  });

  it('disables the take loop when take write transport initialization fails', async () => {
    const createTakeWriteTransportStub = sinon
      .stub(takeWriteTransportModule, 'createTakeWriteTransport')
      .rejects(new Error('transport unavailable'));

    const result = await initializeTakeLoop({
      config: {
        ...BASE_CONFIG,
        takeWrite: {
          mode: TakeWriteTransportMode.PRIVATE_RPC,
          rpcUrl: 'http://127.0.0.1:1',
        },
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
      signer: {} as any,
      chainId: 1,
    });

    expect(createTakeWriteTransportStub.calledOnce).to.equal(true);
    expect(result.takeLoopEnabled).to.equal(false);
    expect(result.takeWriteTransport).to.equal(undefined);
  });
});
