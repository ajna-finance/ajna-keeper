import { expect } from 'chai';
import sinon from 'sinon';
import {
  KeeperConfig,
  PriceOriginSource,
  TakeWriteTransportMode,
} from '../../src/config';
import {
  initializeTakeLoop,
  shouldRunSettlementLoop,
  shouldRunTakeLoop,
} from '../../src/run';

import * as takeWriteTransportModule from '../../src/take/write-transport';

const BASE_CONFIG: KeeperConfig = {
  network: {
    rpcUrl: 'http://localhost:8545',
    subgraph: {
      url: 'http://example-subgraph',
    },
  },
  keeper: {
    keystore: '/tmp/keeper.json',
  },
  runtime: {
    logLevel: 'debug',
    delayBetweenActions: 0,
    delayBetweenRuns: 1,
  },
  ajna: {
    erc20PoolFactory: '0x0000000000000000000000000000000000000001',
    erc721PoolFactory: '0x0000000000000000000000000000000000000002',
    poolUtils: '0x0000000000000000000000000000000000000003',
    positionManager: '0x0000000000000000000000000000000000000004',
    ajnaToken: '0x0000000000000000000000000000000000000005',
  },
  manual: {
    pools: [],
  },
};

const withTakeWrite = (take: any): Pick<KeeperConfig, 'writes'> => ({
  writes: { take },
});

const withRuntime = (
  runtime: Partial<KeeperConfig['runtime']>
): Pick<KeeperConfig, 'runtime'> => ({
  runtime: {
    ...BASE_CONFIG.runtime,
    ...runtime,
  },
});

describe('run startup gating', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('detects when take and settlement work are configured', () => {
    expect(shouldRunTakeLoop(BASE_CONFIG)).to.equal(false);
    expect(shouldRunSettlementLoop(BASE_CONFIG)).to.equal(false);
    expect(
      shouldRunTakeLoop({
        ...BASE_CONFIG,
        ...withTakeWrite({
          mode: TakeWriteTransportMode.PRIVATE_RPC,
          rpcUrl: 'http://127.0.0.1:1',
        }),
      })
    ).to.equal(false);
    expect(
      shouldRunTakeLoop({
        ...BASE_CONFIG,
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
      })
    ).to.equal(true);
    expect(
      shouldRunTakeLoop({
        ...BASE_CONFIG,
        discovery: {
          enabled: true,
          take: true,
        },
      })
    ).to.equal(true);
    expect(
      shouldRunSettlementLoop({
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
      })
    ).to.equal(true);
    expect(
      shouldRunSettlementLoop({
        ...BASE_CONFIG,
        manual: {
          pools: [
            {
              name: 'Disabled Settlement Pool',
              address: '0x3333333333333333333333333333333333333333',
              price: { source: PriceOriginSource.FIXED, value: 1 },
              settlement: {
                enabled: false,
              },
            },
          ],
        },
      })
    ).to.equal(false);
    expect(
      shouldRunSettlementLoop({
        ...BASE_CONFIG,
        discovery: {
          enabled: true,
          settlement: true,
        },
      })
    ).to.equal(true);
  });

  it('keeps the take loop enabled when take write transport initialization fails', async () => {
    const createTakeWriteTransportStub = sinon
      .stub(takeWriteTransportModule, 'createTakeWriteTransport')
      .rejects(new Error('transport unavailable'));

    const result = await initializeTakeLoop({
      config: {
        ...BASE_CONFIG,
        ...withTakeWrite({
          mode: TakeWriteTransportMode.PRIVATE_RPC,
          rpcUrl: 'http://127.0.0.1:1',
        }),
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
      },
      signer: {} as any,
      chainId: 1,
    });

    expect(createTakeWriteTransportStub.calledOnce).to.equal(true);
    expect(result.takeLoopEnabled).to.equal(true);
    expect(result.takeWriteTransport).to.equal(undefined);
  });

  it('fails fast when take write transport initialization fails with a deterministic chain mismatch', async () => {
    const createTakeWriteTransportStub = sinon
      .stub(takeWriteTransportModule, 'createTakeWriteTransport')
      .rejects(
        new Error(
          'Configured take write rpc chainId 8453 does not match keeper chainId 1'
        )
      );

    try {
      await initializeTakeLoop({
        config: {
          ...BASE_CONFIG,
          ...withTakeWrite({
            mode: TakeWriteTransportMode.PRIVATE_RPC,
            rpcUrl: 'http://127.0.0.1:1',
          }),
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
        },
        signer: {} as any,
        chainId: 1,
      });
      expect.fail('Expected chain mismatch to throw');
    } catch (error) {
      expect((error as Error).message).to.include(
        'does not match keeper chainId'
      );
    }

    expect(createTakeWriteTransportStub.calledOnce).to.equal(true);
  });

  it('skips take write validation during dry run', async () => {
    const createTakeWriteTransportStub = sinon.stub(
      takeWriteTransportModule,
      'createTakeWriteTransport'
    );

    const result = await initializeTakeLoop({
      config: {
        ...BASE_CONFIG,
        ...withRuntime({ dryRun: true }),
        ...withTakeWrite({
          mode: TakeWriteTransportMode.RELAY,
          relay: {} as any,
        }),
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
      },
      signer: {} as any,
      chainId: 1,
    });

    expect(result.takeLoopEnabled).to.equal(true);
    expect(result.takeWriteTransport).to.equal(undefined);
    expect(createTakeWriteTransportStub.called).to.equal(false);
  });

  it('fails fast when take write configuration is invalid', async () => {
    const createTakeWriteTransportStub = sinon.stub(
      takeWriteTransportModule,
      'createTakeWriteTransport'
    );

    try {
      await initializeTakeLoop({
        config: {
          ...BASE_CONFIG,
          ...withTakeWrite({
            mode: TakeWriteTransportMode.RELAY,
            relay: {} as any,
          }),
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
        },
        signer: {} as any,
        chainId: 1,
      });
      expect.fail('Expected invalid take write config to throw');
    } catch (error) {
      expect((error as Error).message).to.include('relay.url');
    }

    expect(createTakeWriteTransportStub.called).to.equal(false);
  });

  it('fails fast when take write mode is unknown', async () => {
    const createTakeWriteTransportStub = sinon.stub(
      takeWriteTransportModule,
      'createTakeWriteTransport'
    );

    try {
      await initializeTakeLoop({
        config: {
          ...BASE_CONFIG,
          ...withTakeWrite({
            mode: 'private-rpc' as any,
            rpcUrl: 'http://127.0.0.1:1',
          }),
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
        },
        signer: {} as any,
        chainId: 1,
      });
      expect.fail('Expected unknown take write mode to throw');
    } catch (error) {
      expect((error as Error).message).to.include('unsupported mode');
    }

    expect(createTakeWriteTransportStub.called).to.equal(false);
  });
});
