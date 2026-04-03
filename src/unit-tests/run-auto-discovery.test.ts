import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber } from 'ethers';
import { processKickCycle, processSettlementCycle, processTakeCycle } from '../run';
import { KeeperConfig, PriceOriginSource } from '../config-types';
import * as takeModule from '../take';
import * as settlementModule from '../settlement';
import * as kickModule from '../kick';
import * as discoveryHandlers from '../auto-discovery-handlers';
import subgraph from '../subgraph';

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

describe('Run Loop Discovery Integration', () => {
  afterEach(() => {
    sinon.restore();
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

    await processTakeCycle({
      ajna: {} as any,
      poolMap: new Map([[config.pools[0].address, pool as any]]),
      config,
      signer: {} as any,
      hydrationCooldowns: new Map(),
    });

    expect(handleTakesStub.calledOnce).to.be.true;
    expect(handleDiscoveredTakeTargetStub.called).to.be.false;
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

    await processSettlementCycle({
      ajna: {} as any,
      poolMap: new Map([[config.pools[0].address, pool as any]]),
      config,
      signer: {} as any,
      hydrationCooldowns: new Map(),
    });

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

    await processTakeCycle({
      ajna: ajna as any,
      poolMap,
      config,
      signer: signer as any,
      hydrationCooldowns: new Map(),
    });
    await processSettlementCycle({
      ajna: ajna as any,
      poolMap,
      config,
      signer: signer as any,
      hydrationCooldowns: new Map(),
    });

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
  });
});
