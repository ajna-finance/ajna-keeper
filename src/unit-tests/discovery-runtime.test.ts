import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber } from 'ethers';
import { clearSharedDiscoveryScans } from '../discovery/targets';
import { createDiscoveryRuntime } from '../discovery/runtime';
import { processKickCycle, runTakeLoopIteration } from '../run';
import { KeeperConfig, PriceOriginSource } from '../config';
import * as readRpc from '../read-rpc';
import * as takeModule from '../take';
import * as settlementModule from '../settlement';
import * as kickModule from '../kick';
import * as discoveryHandlers from '../discovery/handlers';
import subgraph from '../subgraph';
import { logger } from '../logging';
import { createSubgraphReader } from '../read-transports';

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

function createTestDiscoveryRuntime(params: {
  config: KeeperConfig;
  ajna?: any;
  poolMap?: Map<string, any>;
  signer?: any;
  takeWriteTransport?: any;
  hydrationCooldowns?: any;
  discoverySnapshotState?: any;
}) {
  return createDiscoveryRuntime({
    ajna: (params.ajna ?? {}) as any,
    poolMap: (params.poolMap ?? new Map()) as any,
    config: params.config,
    signer: (params.signer ?? {}) as any,
    takeWriteTransport: params.takeWriteTransport as any,
    hydrationCooldowns: params.hydrationCooldowns ?? new Map(),
    discoverySnapshotState: params.discoverySnapshotState,
  });
}

describe('Run Loop Discovery Integration', () => {
  afterEach(() => {
    sinon.restore();
    clearSharedDiscoveryScans();
  });

  it('keeps the manual-only take path unchanged when auto discovery is disabled', async () => {
    const handleTakesStub = sinon.stub(takeModule, 'handleTakes').resolves();
    const handleDiscoveredTakeTargetStub = sinon
      .stub(discoveryHandlers, 'handleDiscoveredTakeTarget')
      .resolves();

    const config: KeeperConfig = {
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
    };
    const pool = {
      name: 'Manual Take Pool',
      poolAddress: '0x1111111111111111111111111111111111111111',
    };

    await createTestDiscoveryRuntime({
      config,
      poolMap: new Map([[config.pools[0].address, pool as any]]),
    }).runTakeCycle();

    expect(handleTakesStub.calledOnce).to.be.true;
    expect(handleDiscoveredTakeTargetStub.called).to.be.false;
  });

  it('passes the take write transport through the manual take runtime path', async () => {
    const handleTakesStub = sinon.stub(takeModule, 'handleTakes').resolves();
    const takeWriteTransport = {
      mode: 'private_rpc',
      signer: {
        getAddress: sinon
          .stub()
          .resolves('0x9999999999999999999999999999999999999999'),
      },
      submitTransaction: sinon.stub(),
    };

    const config: KeeperConfig = {
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
    };
    const pool = {
      name: 'Manual Take Pool',
      poolAddress: '0x1111111111111111111111111111111111111111',
    };

    await createTestDiscoveryRuntime({
      config,
      poolMap: new Map([[config.pools[0].address, pool as any]]),
      takeWriteTransport: takeWriteTransport as any,
    }).runTakeCycle();

    expect(handleTakesStub.calledOnce).to.be.true;
    expect(handleTakesStub.firstCall.args[0].takeWriteTransport).to.equal(
      takeWriteTransport
    );
  });

  it('keeps the manual-only settlement path unchanged when auto discovery is disabled', async () => {
    const handleSettlementsStub = sinon
      .stub(settlementModule, 'handleSettlements')
      .resolves();
    const handleDiscoveredSettlementTargetStub = sinon
      .stub(discoveryHandlers, 'handleDiscoveredSettlementTarget')
      .resolves();

    const config: KeeperConfig = {
      ...BASE_CONFIG,
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
    };
    const pool = {
      name: 'Manual Settlement Pool',
      poolAddress: '0x2222222222222222222222222222222222222222',
    };

    await createTestDiscoveryRuntime({
      config,
      poolMap: new Map([[config.pools[0].address, pool as any]]),
    }).runSettlementCycle();

    expect(handleSettlementsStub.calledOnce).to.be.true;
    expect(handleDiscoveredSettlementTargetStub.called).to.be.false;
  });

  it('keeps kick processing manual-only and unaffected by discovery changes', async () => {
    const handleKicksStub = sinon.stub(kickModule, 'handleKicks').resolves();
    const config: KeeperConfig = {
      ...BASE_CONFIG,
      pools: [
        {
          name: 'Manual Kick Pool',
          address: '0x3333333333333333333333333333333333333333',
          price: { source: PriceOriginSource.FIXED, value: 1 },
          kick: {
            minDebt: 1,
            priceFactor: 0.9,
          },
        },
      ],
    };
    const pool = {
      name: 'Manual Kick Pool',
      poolAddress: '0x3333333333333333333333333333333333333333',
    };

    await processKickCycle({
      poolMap: new Map([[config.pools[0].address, pool as any]]),
      config,
      signer: {} as any,
      chainId: 1,
      subgraph: createSubgraphReader(config),
    });

    expect(handleKicksStub.calledOnce).to.be.true;
  });

  it('boots the merged discovery pipeline with zero manual take and settlement pools in dry run', async () => {
    const handleDiscoveredTakeTargetStub = sinon
      .stub(discoveryHandlers, 'handleDiscoveredTakeTarget')
      .resolves();
    const handleDiscoveredSettlementTargetStub = sinon
      .stub(discoveryHandlers, 'handleDiscoveredSettlementTarget')
      .resolves();
    const discoveryStub = sinon.stub(subgraph, 'getChainwideLiquidationAuctions').resolves({
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

    const discoveredPool = {
      name: 'Discovered Pool',
      poolAddress: '0x4444444444444444444444444444444444444444',
      quoteAddress: '0x5555555555555555555555555555555555555555',
      collateralAddress: '0x6666666666666666666666666666666666666666',
    };
    const getPoolByAddressStub = sinon.stub().resolves(discoveredPool);
    const ajna = {
      fungiblePoolFactory: {
        getPoolByAddress: getPoolByAddressStub,
      },
    };
    const signer = {
      provider: {
        getGasPrice: sinon.stub().resolves(BigNumber.from(1)),
      },
      getChainId: sinon.stub().resolves(1),
      getAddress: sinon
        .stub()
        .resolves('0x7777777777777777777777777777777777777777'),
    };
    const config: KeeperConfig = {
      ...BASE_CONFIG,
      autoDiscover: {
        enabled: true,
        take: true,
        settlement: true,
        dryRunNewPools: true,
        logSkips: true,
      },
      discoveredDefaults: {
        take: {
          minCollateral: 0.1,
          hpbPriceFactor: 0.98,
        },
        settlement: {
          enabled: true,
          minAuctionAge: 60,
          maxBucketDepth: 50,
          maxIterations: 5,
          checkBotIncentive: true,
        },
      },
    };
    const poolMap = new Map();
    const discoverySnapshotState = {};

    const discoveryRuntime = createTestDiscoveryRuntime({
      ajna: ajna as any,
      poolMap,
      config,
      signer: signer as any,
      discoverySnapshotState,
    });
    await discoveryRuntime.runTakeCycle();
    await discoveryRuntime.runSettlementCycle();

    expect(handleDiscoveredTakeTargetStub.calledOnce).to.be.true;
    expect(handleDiscoveredSettlementTargetStub.calledOnce).to.be.true;
    expect(handleDiscoveredTakeTargetStub.firstCall.args[0].target.dryRun).to.be.true;
    expect(
      handleDiscoveredTakeTargetStub.firstCall.args[0].target.candidates
    ).to.have.length(1);
    expect(
      handleDiscoveredSettlementTargetStub.firstCall.args[0].target.candidates
    ).to.have.length(1);
    expect(getPoolByAddressStub.calledOnce).to.be.true;
    expect(discoveryStub.calledOnce).to.be.true;
  });

  it('reuses one gas price read across multiple discovered take targets in the same cycle', async () => {
    const handleDiscoveredTakeTargetStub = sinon
      .stub(discoveryHandlers, 'handleDiscoveredTakeTarget')
      .resolves();
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
        {
          borrower: '0xBorrowerB',
          kickTime: '2',
          debtRemaining: '4',
          collateralRemaining: '3',
          neutralPrice: '5',
          debt: '4',
          collateral: '3',
          pool: { id: '0x5555555555555555555555555555555555555555' },
        },
      ],
    });

    const getPoolByAddressStub = sinon.stub();
    getPoolByAddressStub
      .withArgs('0x4444444444444444444444444444444444444444')
      .resolves({
        name: 'Discovered Pool A',
        poolAddress: '0x4444444444444444444444444444444444444444',
        quoteAddress: '0x6666666666666666666666666666666666666666',
        collateralAddress: '0x7777777777777777777777777777777777777777',
      })
      .withArgs('0x5555555555555555555555555555555555555555')
      .resolves({
        name: 'Discovered Pool B',
        poolAddress: '0x5555555555555555555555555555555555555555',
        quoteAddress: '0x8888888888888888888888888888888888888888',
        collateralAddress: '0x9999999999999999999999999999999999999999',
      });

    const gasPriceStub = sinon.stub().resolves(BigNumber.from(123));
    const signer = {
      provider: {
        getGasPrice: gasPriceStub,
      },
    };
    const ajna = {
      fungiblePoolFactory: {
        getPoolByAddress: getPoolByAddressStub,
      },
    };
    const config: KeeperConfig = {
      ...BASE_CONFIG,
      autoDiscover: {
        enabled: true,
        take: true,
      },
      discoveredDefaults: {
        take: {
          minCollateral: 0.1,
          hpbPriceFactor: 0.98,
        },
      },
    };

    await createTestDiscoveryRuntime({
      ajna: ajna as any,
      config,
      signer: signer as any,
      discoverySnapshotState: {},
    }).runTakeCycle();

    expect(handleDiscoveredTakeTargetStub.calledTwice).to.be.true;
    expect(gasPriceStub.calledOnce).to.be.true;
    const firstRpcCache = handleDiscoveredTakeTargetStub.firstCall.args[0].rpcCache!;
    const secondRpcCache = handleDiscoveredTakeTargetStub.secondCall.args[0].rpcCache!;
    expect(firstRpcCache.gasPrice!.toString()).to.equal('123');
    expect(secondRpcCache.gasPrice!.toString()).to.equal('123');
  });

  it('refreshes the discovered take gas price when the per-cycle cache becomes stale', async () => {
    let nowMs = 0;
    sinon.stub(Date, 'now').callsFake(() => nowMs);
    const observedGasPrices: string[] = [];
    const handleDiscoveredTakeTargetStub = sinon
      .stub(discoveryHandlers, 'handleDiscoveredTakeTarget');
    handleDiscoveredTakeTargetStub
      .onFirstCall()
      .callsFake(async (params: any) => {
        observedGasPrices.push(params.rpcCache.gasPrice.toString());
        nowMs = 31_000;
      });
    handleDiscoveredTakeTargetStub
      .onSecondCall()
      .callsFake(async (params: any) => {
        observedGasPrices.push(params.rpcCache.gasPrice.toString());
      });
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
        {
          borrower: '0xBorrowerB',
          kickTime: '2',
          debtRemaining: '4',
          collateralRemaining: '3',
          neutralPrice: '5',
          debt: '4',
          collateral: '3',
          pool: { id: '0x5555555555555555555555555555555555555555' },
        },
      ],
    });

    const getPoolByAddressStub = sinon.stub();
    getPoolByAddressStub
      .withArgs('0x4444444444444444444444444444444444444444')
      .resolves({
        name: 'Discovered Pool A',
        poolAddress: '0x4444444444444444444444444444444444444444',
        quoteAddress: '0x6666666666666666666666666666666666666666',
        collateralAddress: '0x7777777777777777777777777777777777777777',
      })
      .withArgs('0x5555555555555555555555555555555555555555')
      .resolves({
        name: 'Discovered Pool B',
        poolAddress: '0x5555555555555555555555555555555555555555',
        quoteAddress: '0x8888888888888888888888888888888888888888',
        collateralAddress: '0x9999999999999999999999999999999999999999',
      });

    const gasPriceStub = sinon.stub();
    gasPriceStub.onCall(0).resolves(BigNumber.from(123));
    gasPriceStub.onCall(1).resolves(BigNumber.from(456));
    const signer = {
      provider: {
        getGasPrice: gasPriceStub,
      },
    };
    const ajna = {
      fungiblePoolFactory: {
        getPoolByAddress: getPoolByAddressStub,
      },
    };
    const config: KeeperConfig = {
      ...BASE_CONFIG,
      autoDiscover: {
        enabled: true,
        take: true,
      },
      discoveredDefaults: {
        take: {
          minCollateral: 0.1,
          hpbPriceFactor: 0.98,
        },
      },
    };

    await createTestDiscoveryRuntime({
      ajna: ajna as any,
      config,
      signer: signer as any,
      discoverySnapshotState: {},
    }).runTakeCycle();

    expect(handleDiscoveredTakeTargetStub.calledTwice).to.be.true;
    expect(gasPriceStub.calledTwice).to.be.true;
    expect(observedGasPrices).to.deep.equal(['123', '456']);
  });

  it('retries discovered take gas price refreshes after a transient failure later in the same cycle', async () => {
    let nowMs = 0;
    sinon.stub(Date, 'now').callsFake(() => nowMs);
    const observedGasPrices: string[] = [];
    const handleDiscoveredTakeTargetStub = sinon
      .stub(discoveryHandlers, 'handleDiscoveredTakeTarget');
    handleDiscoveredTakeTargetStub
      .onFirstCall()
      .callsFake(async (params: any) => {
        observedGasPrices.push(params.rpcCache.gasPrice.toString());
        nowMs = 31_000;
      });
    handleDiscoveredTakeTargetStub
      .onSecondCall()
      .callsFake(async (params: any) => {
        observedGasPrices.push(params.rpcCache.gasPrice.toString());
      });
    sinon.stub(subgraph, 'getChainwideLiquidationAuctions').resolves({
      liquidationAuctions: [
        {
          borrower: '0xBorrowerA',
          kickTime: '1',
          debtRemaining: '3',
          collateralRemaining: '5',
          neutralPrice: '4',
          debt: '3',
          collateral: '5',
          pool: { id: '0x4444444444444444444444444444444444444444' },
        },
        {
          borrower: '0xBorrowerB',
          kickTime: '2',
          debtRemaining: '4',
          collateralRemaining: '4',
          neutralPrice: '5',
          debt: '4',
          collateral: '4',
          pool: { id: '0x5555555555555555555555555555555555555555' },
        },
        {
          borrower: '0xBorrowerC',
          kickTime: '3',
          debtRemaining: '5',
          collateralRemaining: '3',
          neutralPrice: '6',
          debt: '5',
          collateral: '3',
          pool: { id: '0x6666666666666666666666666666666666666666' },
        },
      ],
    });

    const getPoolByAddressStub = sinon.stub();
    getPoolByAddressStub
      .withArgs('0x4444444444444444444444444444444444444444')
      .resolves({
        name: 'Discovered Pool A',
        poolAddress: '0x4444444444444444444444444444444444444444',
        quoteAddress: '0x7777777777777777777777777777777777777777',
        collateralAddress: '0x8888888888888888888888888888888888888888',
      })
      .withArgs('0x5555555555555555555555555555555555555555')
      .resolves({
        name: 'Discovered Pool B',
        poolAddress: '0x5555555555555555555555555555555555555555',
        quoteAddress: '0x9999999999999999999999999999999999999999',
        collateralAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      })
      .withArgs('0x6666666666666666666666666666666666666666')
      .resolves({
        name: 'Discovered Pool C',
        poolAddress: '0x6666666666666666666666666666666666666666',
        quoteAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        collateralAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
      });

    const gasPriceStub = sinon.stub();
    gasPriceStub.onCall(0).resolves(BigNumber.from(123));
    gasPriceStub.onCall(1).rejects(new Error('transient read rpc error'));
    gasPriceStub.onCall(2).resolves(BigNumber.from(456));
    const loggerErrorStub = sinon.stub(logger, 'error');
    const signer = {
      provider: {
        getGasPrice: gasPriceStub,
      },
    };
    const ajna = {
      fungiblePoolFactory: {
        getPoolByAddress: getPoolByAddressStub,
      },
    };
    const config: KeeperConfig = {
      ...BASE_CONFIG,
      autoDiscover: {
        enabled: true,
        take: true,
      },
      discoveredDefaults: {
        take: {
          minCollateral: 0.1,
          hpbPriceFactor: 0.98,
        },
      },
    };

    await createTestDiscoveryRuntime({
      ajna: ajna as any,
      config,
      signer: signer as any,
      discoverySnapshotState: {},
    }).runTakeCycle();

    expect(handleDiscoveredTakeTargetStub.calledTwice).to.be.true;
    expect(gasPriceStub.calledThrice).to.be.true;
    expect(observedGasPrices).to.deep.equal(['123', '456']);
    expect(
      loggerErrorStub
        .getCalls()
        .some((call) => String(call.args[0]).includes('Failed to handle take for pool:'))
    ).to.equal(true);
  });

  it('uses the resilient read-rpc helper when readRpcUrls are configured for discovered take cycles', async () => {
    const handleDiscoveredTakeTargetStub = sinon
      .stub(discoveryHandlers, 'handleDiscoveredTakeTarget')
      .resolves();
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
    const resilientGasPriceStub = sinon
      .stub(readRpc, 'getResilientReadGasPrice')
      .resolves(BigNumber.from(789));

    const discoveredPool = {
      name: 'Discovered Pool',
      poolAddress: '0x4444444444444444444444444444444444444444',
      quoteAddress: '0x5555555555555555555555555555555555555555',
      collateralAddress: '0x6666666666666666666666666666666666666666',
    };
    const ajna = {
      fungiblePoolFactory: {
        getPoolByAddress: sinon.stub().resolves(discoveredPool),
      },
    };
    const signer = {
      provider: {
        getGasPrice: sinon.stub().rejects(new Error('should use read-rpc helper')),
      },
      getChainId: sinon.stub().resolves(1),
      getAddress: sinon
        .stub()
        .resolves('0x7777777777777777777777777777777777777777'),
    };

    const config: KeeperConfig = {
      ...BASE_CONFIG,
      readRpcUrls: ['http://read-rpc-a', 'http://read-rpc-b'],
      autoDiscover: {
        enabled: true,
        take: true,
      },
      discoveredDefaults: {
        take: {
          minCollateral: 0.1,
          hpbPriceFactor: 0.98,
        },
      },
    };

    await createTestDiscoveryRuntime({
      ajna: ajna as any,
      poolMap: new Map(),
      config,
      signer: signer as any,
      discoverySnapshotState: {},
    }).runTakeCycle();

    const firstCallParams = handleDiscoveredTakeTargetStub.firstCall.args[0] as any;
    expect(resilientGasPriceStub.calledOnce).to.be.true;
    expect(handleDiscoveredTakeTargetStub.calledOnce).to.be.true;
    expect(firstCallParams.rpcCache.gasPrice.toString()).to.equal('789');
  });

  it('continues manual take targets when discovery rpc cache creation fails', async () => {
    const handleTakesStub = sinon.stub(takeModule, 'handleTakes').resolves();
    const handleDiscoveredTakeTargetStub = sinon
      .stub(discoveryHandlers, 'handleDiscoveredTakeTarget')
      .resolves();
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
    const loggerErrorStub = sinon.stub(logger, 'error');

    const config: KeeperConfig = {
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
      autoDiscover: {
        enabled: true,
        take: true,
      },
      discoveredDefaults: {
        take: {
          minCollateral: 0.1,
          hpbPriceFactor: 0.98,
        },
      },
    };

    await createTestDiscoveryRuntime({
      ajna: {
        fungiblePoolFactory: {
          getPoolByAddress: sinon.stub().resolves({
            name: 'Discovered Pool',
            poolAddress: '0x4444444444444444444444444444444444444444',
            quoteAddress: '0x5555555555555555555555555555555555555555',
            collateralAddress: '0x6666666666666666666666666666666666666666',
          }),
        },
      } as any,
      config,
      signer: {
        provider: {
          getGasPrice: sinon.stub().rejects(new Error('read rpc unavailable')),
        },
      } as any,
      poolMap: new Map([
        [
          config.pools[0].address,
          {
            name: 'Manual Take Pool',
            poolAddress: config.pools[0].address,
          } as any,
        ],
      ]),
      discoverySnapshotState: {},
    }).runTakeCycle();

    expect(handleTakesStub.calledOnce).to.be.true;
    expect(handleDiscoveredTakeTargetStub.called).to.be.false;
    expect(
      loggerErrorStub
        .getCalls()
        .some((call) =>
          String(call.args[0]).includes(
            'Failed to handle take for pool: Discovered Pool.'
          )
        )
    ).to.equal(true);
  });

  it('refreshes the shared discovery snapshot from the settlement cadence when take discovery is disabled', async () => {
    const handleDiscoveredSettlementTargetStub = sinon
      .stub(discoveryHandlers, 'handleDiscoveredSettlementTarget')
      .resolves();
    const discoveryStub = sinon.stub(subgraph, 'getChainwideLiquidationAuctions').resolves({
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

    const getPoolByAddressStub = sinon.stub().resolves({
      name: 'Discovered Settlement Pool',
      poolAddress: '0x4444444444444444444444444444444444444444',
      quoteAddress: '0x5555555555555555555555555555555555555555',
      collateralAddress: '0x6666666666666666666666666666666666666666',
    });
    const ajna = {
      fungiblePoolFactory: {
        getPoolByAddress: getPoolByAddressStub,
      },
    };
    const signer = {
      provider: {
        getGasPrice: sinon.stub().resolves(BigNumber.from(1)),
      },
      getAddress: sinon
        .stub()
        .resolves('0x7777777777777777777777777777777777777777'),
    };
    const config: KeeperConfig = {
      ...BASE_CONFIG,
      autoDiscover: {
        enabled: true,
        take: false,
        settlement: true,
      },
      discoveredDefaults: {
        settlement: {
          enabled: true,
          minAuctionAge: 60,
          maxBucketDepth: 50,
          maxIterations: 5,
          checkBotIncentive: true,
        },
      },
    };
    const discoverySnapshotState = {};

    const discoveryRuntime = createTestDiscoveryRuntime({
      ajna: ajna as any,
      config,
      signer: signer as any,
      discoverySnapshotState,
    });
    await discoveryRuntime.runTakeCycle();

    expect(discoveryStub.called).to.be.false;

    await discoveryRuntime.runSettlementCycle();

    expect(discoveryStub.calledOnce).to.be.true;
    expect(handleDiscoveredSettlementTargetStub.calledOnce).to.be.true;
  });

  it('refreshes the settlement discovery snapshot when the take-owned snapshot is stale', async () => {
    const handleDiscoveredSettlementTargetStub = sinon
      .stub(discoveryHandlers, 'handleDiscoveredSettlementTarget')
      .resolves();
    const discoveryStub = sinon.stub(subgraph, 'getChainwideLiquidationAuctions').resolves({
      liquidationAuctions: [
        {
          borrower: '0xBorrowerFresh',
          kickTime: '2',
          debtRemaining: '3',
          collateralRemaining: '0',
          neutralPrice: '4',
          debt: '3',
          collateral: '0',
          pool: { id: '0x9999999999999999999999999999999999999999' },
        },
      ],
    });

    const ajna = {
      fungiblePoolFactory: {
        getPoolByAddress: sinon.stub().resolves({
          name: 'Fresh Settlement Pool',
          poolAddress: '0x9999999999999999999999999999999999999999',
          quoteAddress: '0x5555555555555555555555555555555555555555',
          collateralAddress: '0x6666666666666666666666666666666666666666',
        }),
      },
    };
    const signer = {
      provider: {
        getGasPrice: sinon.stub().resolves(BigNumber.from(1)),
      },
      getAddress: sinon
        .stub()
        .resolves('0x7777777777777777777777777777777777777777'),
    };
    const config: KeeperConfig = {
      ...BASE_CONFIG,
      autoDiscover: {
        enabled: true,
        take: true,
        settlement: true,
      },
      discoveredDefaults: {
        take: {
          minCollateral: 0.1,
          hpbPriceFactor: 0.98,
        },
        settlement: {
          enabled: true,
          minAuctionAge: 60,
          maxBucketDepth: 50,
          maxIterations: 5,
          checkBotIncentive: true,
        },
      },
    };

    await createTestDiscoveryRuntime({
      ajna: ajna as any,
      config,
      signer: signer as any,
      discoverySnapshotState: {
        latestLiquidationAuctions: [
          {
            borrower: '0xBorrowerStale',
            kickTime: '1',
            debtRemaining: '1',
            collateralRemaining: '0',
            neutralPrice: '1',
            debt: '1',
            collateral: '0',
            pool: { id: '0x4444444444444444444444444444444444444444' },
          },
        ],
        fetchedAt: Date.now() - 121_000,
      },
    }).runSettlementCycle();

    expect(discoveryStub.calledOnce).to.be.true;
    expect(handleDiscoveredSettlementTargetStub.calledOnce).to.be.true;
    expect(
      handleDiscoveredSettlementTargetStub.firstCall.args[0].target.candidates[0]
        .borrower
    ).to.equal('0xBorrowerFresh');
  });

  it('reuses one gas price read across multiple discovered settlement targets in the same cycle', async () => {
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
        {
          borrower: '0xBorrowerB',
          kickTime: '2',
          debtRemaining: '4',
          collateralRemaining: '0',
          neutralPrice: '5',
          debt: '4',
          collateral: '0',
          pool: { id: '0x5555555555555555555555555555555555555555' },
        },
      ],
    });

    const getPoolByAddressStub = sinon.stub();
    getPoolByAddressStub
      .withArgs('0x4444444444444444444444444444444444444444')
      .resolves({
        name: 'Discovered Settlement Pool A',
        poolAddress: '0x4444444444444444444444444444444444444444',
        quoteAddress: '0x6666666666666666666666666666666666666666',
        collateralAddress: '0x7777777777777777777777777777777777777777',
      })
      .withArgs('0x5555555555555555555555555555555555555555')
      .resolves({
        name: 'Discovered Settlement Pool B',
        poolAddress: '0x5555555555555555555555555555555555555555',
        quoteAddress: '0x8888888888888888888888888888888888888888',
        collateralAddress: '0x9999999999999999999999999999999999999999',
      });

    const gasPriceStub = sinon.stub().resolves(BigNumber.from(456));
    const signer = {
      provider: {
        getGasPrice: gasPriceStub,
      },
      getAddress: sinon
        .stub()
        .resolves('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    };
    const ajna = {
      fungiblePoolFactory: {
        getPoolByAddress: getPoolByAddressStub,
      },
    };
    const config: KeeperConfig = {
      ...BASE_CONFIG,
      autoDiscover: {
        enabled: true,
        take: false,
        settlement: true,
      },
      discoveredDefaults: {
        settlement: {
          enabled: true,
          minAuctionAge: 60,
          maxBucketDepth: 50,
          maxIterations: 5,
          checkBotIncentive: true,
        },
      },
    };

    await createTestDiscoveryRuntime({
      ajna: ajna as any,
      config,
      signer: signer as any,
      discoverySnapshotState: {},
    }).runSettlementCycle();

    expect(handleDiscoveredSettlementTargetStub.calledTwice).to.be.true;
    expect(gasPriceStub.calledOnce).to.be.true;
    const firstRpcCache =
      handleDiscoveredSettlementTargetStub.firstCall.args[0].rpcCache!;
    const secondRpcCache =
      handleDiscoveredSettlementTargetStub.secondCall.args[0].rpcCache!;
    expect(firstRpcCache.gasPrice!.toString()).to.equal('456');
    expect(secondRpcCache.gasPrice!.toString()).to.equal('456');
  });

  it('retries discovered settlement gas price refreshes after a transient failure later in the same cycle', async () => {
    let nowMs = 0;
    sinon.stub(Date, 'now').callsFake(() => nowMs);
    const observedGasPrices: string[] = [];
    const handleDiscoveredSettlementTargetStub = sinon
      .stub(discoveryHandlers, 'handleDiscoveredSettlementTarget');
    handleDiscoveredSettlementTargetStub
      .onFirstCall()
      .callsFake(async (params: any) => {
        observedGasPrices.push(params.rpcCache.gasPrice.toString());
        nowMs = 31_000;
      });
    handleDiscoveredSettlementTargetStub
      .onSecondCall()
      .callsFake(async (params: any) => {
        observedGasPrices.push(params.rpcCache.gasPrice.toString());
      });
    sinon.stub(subgraph, 'getChainwideLiquidationAuctions').resolves({
      liquidationAuctions: [
        {
          borrower: '0xBorrowerA',
          kickTime: '1',
          debtRemaining: '9',
          collateralRemaining: '0',
          neutralPrice: '4',
          debt: '9',
          collateral: '0',
          pool: { id: '0x4444444444444444444444444444444444444444' },
        },
        {
          borrower: '0xBorrowerB',
          kickTime: '2',
          debtRemaining: '8',
          collateralRemaining: '0',
          neutralPrice: '5',
          debt: '8',
          collateral: '0',
          pool: { id: '0x5555555555555555555555555555555555555555' },
        },
        {
          borrower: '0xBorrowerC',
          kickTime: '3',
          debtRemaining: '7',
          collateralRemaining: '0',
          neutralPrice: '6',
          debt: '7',
          collateral: '0',
          pool: { id: '0x6666666666666666666666666666666666666666' },
        },
      ],
    });

    const getPoolByAddressStub = sinon.stub();
    getPoolByAddressStub
      .withArgs('0x4444444444444444444444444444444444444444')
      .resolves({
        name: 'Discovered Settlement Pool A',
        poolAddress: '0x4444444444444444444444444444444444444444',
        quoteAddress: '0x7777777777777777777777777777777777777777',
        collateralAddress: '0x8888888888888888888888888888888888888888',
      })
      .withArgs('0x5555555555555555555555555555555555555555')
      .resolves({
        name: 'Discovered Settlement Pool B',
        poolAddress: '0x5555555555555555555555555555555555555555',
        quoteAddress: '0x9999999999999999999999999999999999999999',
        collateralAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      })
      .withArgs('0x6666666666666666666666666666666666666666')
      .resolves({
        name: 'Discovered Settlement Pool C',
        poolAddress: '0x6666666666666666666666666666666666666666',
        quoteAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        collateralAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
      });

    const gasPriceStub = sinon.stub();
    gasPriceStub.onCall(0).resolves(BigNumber.from(456));
    gasPriceStub.onCall(1).rejects(new Error('transient settlement read rpc error'));
    gasPriceStub.onCall(2).resolves(BigNumber.from(654));
    const loggerErrorStub = sinon.stub(logger, 'error');
    const signer = {
      provider: {
        getGasPrice: gasPriceStub,
      },
      getAddress: sinon
        .stub()
        .resolves('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    };
    const ajna = {
      fungiblePoolFactory: {
        getPoolByAddress: getPoolByAddressStub,
      },
    };
    const config: KeeperConfig = {
      ...BASE_CONFIG,
      autoDiscover: {
        enabled: true,
        take: false,
        settlement: true,
      },
      discoveredDefaults: {
        settlement: {
          enabled: true,
          minAuctionAge: 60,
          maxBucketDepth: 50,
          maxIterations: 5,
          checkBotIncentive: true,
        },
      },
    };

    await createTestDiscoveryRuntime({
      ajna: ajna as any,
      config,
      signer: signer as any,
      discoverySnapshotState: {},
    }).runSettlementCycle();

    expect(handleDiscoveredSettlementTargetStub.calledTwice).to.be.true;
    expect(gasPriceStub.calledThrice).to.be.true;
    expect(observedGasPrices).to.deep.equal(['456', '654']);
    expect(
      loggerErrorStub
        .getCalls()
        .some((call) =>
          String(call.args[0]).includes(
            'Failed to handle settlements for pool: Discovered Settlement Pool B'
          )
        )
    ).to.equal(true);
  });

  it('keeps manual settlement on the normal loop cadence while rate limiting discovered settlement execution', async () => {
    let nowMs = 0;
    sinon.stub(Date, 'now').callsFake(() => nowMs);
    const handleSettlementsStub = sinon
      .stub(settlementModule, 'handleSettlements')
      .resolves();
    const handleDiscoveredSettlementTargetStub = sinon
      .stub(discoveryHandlers, 'handleDiscoveredSettlementTarget')
      .resolves();
    const discoveryStub = sinon.stub(subgraph, 'getChainwideLiquidationAuctions').resolves({
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

    const config: KeeperConfig = {
      ...BASE_CONFIG,
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
      autoDiscover: {
        enabled: true,
        take: false,
        settlement: true,
      },
      discoveredDefaults: {
        settlement: {
          enabled: true,
          minAuctionAge: 60,
          maxBucketDepth: 50,
          maxIterations: 5,
          checkBotIncentive: true,
        },
      },
    };

    const discoveryRuntime = createTestDiscoveryRuntime({
      ajna: {
        fungiblePoolFactory: {
          getPoolByAddress: sinon.stub().resolves({
            name: 'Discovered Settlement Pool',
            poolAddress: '0x4444444444444444444444444444444444444444',
            quoteAddress: '0x5555555555555555555555555555555555555555',
            collateralAddress: '0x6666666666666666666666666666666666666666',
          }),
        },
      } as any,
      config,
      signer: {
        provider: {
          getGasPrice: sinon.stub().resolves(BigNumber.from(1)),
        },
        getAddress: sinon
          .stub()
          .resolves('0x7777777777777777777777777777777777777777'),
      } as any,
      poolMap: new Map([
        [
          config.pools[0].address,
          {
            name: 'Manual Settlement Pool',
            poolAddress: config.pools[0].address,
          } as any,
        ],
      ]),
      discoverySnapshotState: {},
    });

    expect(discoveryRuntime.getSettlementCheckIntervalSeconds()).to.equal(1);

    await discoveryRuntime.runSettlementCycle();
    nowMs = 1_000;
    await discoveryRuntime.runSettlementCycle();
    nowMs = 121_000;
    await discoveryRuntime.runSettlementCycle();

    expect(handleSettlementsStub.callCount).to.equal(3);
    expect(handleDiscoveredSettlementTargetStub.callCount).to.equal(2);
    expect(discoveryStub.callCount).to.equal(2);
  });

  it('retries discovered settlement refresh immediately after a transient discovery failure', async () => {
    let nowMs = 0;
    sinon.stub(Date, 'now').callsFake(() => nowMs);
    const handleSettlementsStub = sinon
      .stub(settlementModule, 'handleSettlements')
      .resolves();
    const handleDiscoveredSettlementTargetStub = sinon
      .stub(discoveryHandlers, 'handleDiscoveredSettlementTarget')
      .resolves();
    const discoveryStub = sinon.stub(subgraph, 'getChainwideLiquidationAuctions');
    discoveryStub.onFirstCall().rejects(new Error('temporary discovery outage'));
    discoveryStub.onSecondCall().resolves({
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

    const config: KeeperConfig = {
      ...BASE_CONFIG,
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
      autoDiscover: {
        enabled: true,
        take: false,
        settlement: true,
      },
      discoveredDefaults: {
        settlement: {
          enabled: true,
          minAuctionAge: 60,
          maxBucketDepth: 50,
          maxIterations: 5,
          checkBotIncentive: true,
        },
      },
    };

    const discoveryRuntime = createTestDiscoveryRuntime({
      ajna: {
        fungiblePoolFactory: {
          getPoolByAddress: sinon.stub().resolves({
            name: 'Discovered Settlement Pool',
            poolAddress: '0x4444444444444444444444444444444444444444',
            quoteAddress: '0x5555555555555555555555555555555555555555',
            collateralAddress: '0x6666666666666666666666666666666666666666',
          }),
        },
      } as any,
      config,
      signer: {
        provider: {
          getGasPrice: sinon.stub().resolves(BigNumber.from(1)),
        },
        getAddress: sinon
          .stub()
          .resolves('0x7777777777777777777777777777777777777777'),
      } as any,
      poolMap: new Map([
        [
          config.pools[0].address,
          {
            name: 'Manual Settlement Pool',
            poolAddress: config.pools[0].address,
          } as any,
        ],
      ]),
      discoverySnapshotState: {},
    });

    try {
      await discoveryRuntime.runSettlementCycle();
      expect.fail('Expected settlement discovery failure');
    } catch (error) {
      expect(String(error)).to.include('temporary discovery outage');
    }

    nowMs = 1_000;
    await discoveryRuntime.runSettlementCycle();

    expect(handleSettlementsStub.callCount).to.equal(1);
    expect(handleDiscoveredSettlementTargetStub.callCount).to.equal(1);
    expect(discoveryStub.callCount).to.equal(2);
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
      autoDiscover: {
        enabled: true,
        take: false,
        settlement: true,
      },
      discoveredDefaults: {
        settlement: {
          enabled: true,
          minAuctionAge: 60,
          maxBucketDepth: 50,
          maxIterations: 5,
          checkBotIncentive: true,
        },
      },
    };

    await createTestDiscoveryRuntime({
      ajna: {
        fungiblePoolFactory: {
          getPoolByAddress: sinon.stub().resolves({
            name: 'Discovered Settlement Pool',
            poolAddress: '0x4444444444444444444444444444444444444444',
            quoteAddress: '0x5555555555555555555555555555555555555555',
            collateralAddress: '0x6666666666666666666666666666666666666666',
          }),
        },
      } as any,
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
          config.pools[0].address,
          {
            name: 'Manual Settlement Pool',
            poolAddress: config.pools[0].address,
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

  it('logs a take cycle summary with target counts and snapshot status', async () => {
    const handleTakesStub = sinon.stub(takeModule, 'handleTakes').resolves();
    const loggerInfoStub = sinon.stub(logger, 'info');

    const config: KeeperConfig = {
      ...BASE_CONFIG,
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
    };
    const pool = {
      name: 'Manual Take Pool',
      poolAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    };

    await createTestDiscoveryRuntime({
      config,
      poolMap: new Map([[config.pools[0].address, pool as any]]),
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

  it('logs a take cycle failure summary when snapshot refresh fails', async () => {
    const loggerErrorStub = sinon.stub(logger, 'error');
    sinon
      .stub(subgraph, 'getChainwideLiquidationAuctions')
      .rejects(new Error('subgraph unavailable'));

    const config: KeeperConfig = {
      ...BASE_CONFIG,
      autoDiscover: {
        enabled: true,
        take: true,
      },
      discoveredDefaults: {
        take: {
          minCollateral: 0.1,
          hpbPriceFactor: 0.98,
        },
      },
    };

    await expect(
      createTestDiscoveryRuntime({
        config,
      }).runTakeCycle()
    ).to.be.rejectedWith('subgraph unavailable');

    const failureLog = loggerErrorStub
      .getCalls()
      .map((call) => call.args[0])
      .find(
        (message: any) =>
          typeof message === 'string' &&
          message.includes('Discovery take cycle failed:')
      );
    expect(failureLog).to.be.a('string');
    expect(failureLog).to.include('phase=snapshot');
    expect(failureLog).to.include('snapshotRefreshed=false');
  });

  it('recovers take loop iterations from pre-target discovery failures', async () => {
    const discoveryError = new Error('temporary discovery outage');
    sinon
      .stub(subgraph, 'getChainwideLiquidationAuctions')
      .rejects(discoveryError);

    const config: KeeperConfig = {
      ...BASE_CONFIG,
      autoDiscover: {
        enabled: true,
        take: true,
      },
    };
    const result = await runTakeLoopIteration({
      config,
      signer: {} as any,
      poolMap: new Map(),
      discoveryRuntime: createTestDiscoveryRuntime({
        config,
        discoverySnapshotState: {},
      }),
    });

    expect(result).to.deep.equal({
      delaySeconds: 30,
      recovered: true,
    });
  });
});
