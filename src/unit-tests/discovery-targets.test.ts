import { expect } from 'chai';
import sinon from 'sinon';
import {
  buildDiscoveredSettlementTargets,
  buildDiscoveredTakeTargets,
  clearSharedDiscoveryScans,
  ensurePoolLoaded,
  validateResolvedSettlementTarget,
  validateResolvedTakeTarget,
} from '../discovery/targets';
import { KeeperConfig, LiquiditySource, PriceOriginSource } from '../config';
import subgraph from '../subgraph';
import { logger } from '../logging';

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
  autoDiscover: {
    enabled: true,
    take: true,
    settlement: true,
    logSkips: true,
  },
  discoveredDefaults: {
    take: {
      minCollateral: 0.1,
      hpbPriceFactor: 0.98,
    },
    settlement: {
      enabled: true,
      minAuctionAge: 3600,
      maxBucketDepth: 50,
      maxIterations: 5,
      checkBotIncentive: true,
    },
  },
};

describe('Discovery Target Resolution', () => {
  afterEach(() => {
    sinon.restore();
    clearSharedDiscoveryScans();
  });

  it('dedupes duplicate discovered take candidates by pool and borrower', async () => {
    sinon.stub(subgraph, 'getChainwideLiquidationAuctions').resolves({
      liquidationAuctions: [
        {
          borrower: '0xBorrowerA',
          kickTime: '1',
          debtRemaining: '2',
          collateralRemaining: '3',
          neutralPrice: '4',
          debt: '2',
          collateral: '3',
          pool: { id: '0x1111111111111111111111111111111111111111' },
        },
        {
          borrower: '0xBorrowerA',
          kickTime: '1',
          debtRemaining: '2',
          collateralRemaining: '3',
          neutralPrice: '4',
          debt: '2',
          collateral: '3',
          pool: { id: '0x1111111111111111111111111111111111111111' },
        },
        {
          borrower: '0xBorrowerB',
          kickTime: '1',
          debtRemaining: '5',
          collateralRemaining: '6',
          neutralPrice: '7',
          debt: '5',
          collateral: '6',
          pool: { id: '0x1111111111111111111111111111111111111111' },
        },
      ],
    });

    const targets = await buildDiscoveredTakeTargets(BASE_CONFIG);

    expect(targets).to.have.length(1);
    expect(targets[0].candidates).to.have.length(2);
    expect(targets[0].candidates.map((candidate) => candidate.borrower)).to.deep.equal([
      '0xBorrowerB',
      '0xBorrowerA',
    ]);
  });

  it('respects per-action manual overrides while allowing missing actions to fall back to discovered defaults', async () => {
    const config: KeeperConfig = {
      ...BASE_CONFIG,
      pools: [
        {
          name: 'Manual Take Pool',
          address: '0x1111111111111111111111111111111111111111',
          price: { source: PriceOriginSource.FIXED, value: 1 },
          take: {
            minCollateral: 1,
            hpbPriceFactor: 0.9,
          },
        },
        {
          name: 'Kick Only Pool',
          address: '0x2222222222222222222222222222222222222222',
          price: { source: PriceOriginSource.FIXED, value: 1 },
          kick: {
            minDebt: 1,
            priceFactor: 0.9,
          },
        },
        {
          name: 'Manual Settlement Pool',
          address: '0x3333333333333333333333333333333333333333',
          price: { source: PriceOriginSource.FIXED, value: 1 },
          settlement: {
            enabled: true,
            minAuctionAge: 60,
          },
        },
      ],
    };

    sinon.stub(subgraph, 'getChainwideLiquidationAuctions').resolves({
      liquidationAuctions: [
        {
          borrower: '0xBorrowerA',
          kickTime: '1',
          debtRemaining: '2',
          collateralRemaining: '3',
          neutralPrice: '4',
          debt: '2',
          collateral: '3',
          pool: { id: '0x1111111111111111111111111111111111111111' },
        },
        {
          borrower: '0xBorrowerB',
          kickTime: '1',
          debtRemaining: '2',
          collateralRemaining: '3',
          neutralPrice: '4',
          debt: '2',
          collateral: '3',
          pool: { id: '0x2222222222222222222222222222222222222222' },
        },
        {
          borrower: '0xBorrowerC',
          kickTime: '1',
          debtRemaining: '2',
          collateralRemaining: '0',
          neutralPrice: '4',
          debt: '2',
          collateral: '0',
          pool: { id: '0x3333333333333333333333333333333333333333' },
        },
      ],
    });

    const takeTargets = await buildDiscoveredTakeTargets(config);
    const settlementTargets = await buildDiscoveredSettlementTargets(config);

    expect(takeTargets).to.have.length(1);
    expect(takeTargets[0].poolAddress).to.equal(
      '0x2222222222222222222222222222222222222222'
    );
    expect(takeTargets[0].name).to.equal('Kick Only Pool');

    expect(settlementTargets).to.have.length(2);
    expect(
      settlementTargets.some(
        (target) =>
          target.poolAddress === '0x2222222222222222222222222222222222222222'
      )
    ).to.be.true;
    expect(
      settlementTargets.some(
        (target) =>
          target.poolAddress === '0x3333333333333333333333333333333333333333'
      )
    ).to.be.false;
  });

  it('applies dryRunNewPools only to pools with no manual config entry', async () => {
    const config: KeeperConfig = {
      ...BASE_CONFIG,
      dryRun: false,
      autoDiscover: {
        ...BASE_CONFIG.autoDiscover,
        enabled: true,
        dryRunNewPools: true,
      },
      pools: [
        {
          name: 'Kick Only Pool',
          address: '0x2222222222222222222222222222222222222222',
          price: { source: PriceOriginSource.FIXED, value: 1 },
          kick: {
            minDebt: 1,
            priceFactor: 0.9,
          },
        },
      ],
    };

    sinon.stub(subgraph, 'getChainwideLiquidationAuctions').resolves({
      liquidationAuctions: [
        {
          borrower: '0xBorrowerA',
          kickTime: '1',
          debtRemaining: '2',
          collateralRemaining: '3',
          neutralPrice: '4',
          debt: '2',
          collateral: '3',
          pool: { id: '0x2222222222222222222222222222222222222222' },
        },
        {
          borrower: '0xBorrowerB',
          kickTime: '1',
          debtRemaining: '2',
          collateralRemaining: '3',
          neutralPrice: '4',
          debt: '2',
          collateral: '3',
          pool: { id: '0x4444444444444444444444444444444444444444' },
        },
      ],
    });

    const takeTargets = await buildDiscoveredTakeTargets(config);
    const settlementTargets = await buildDiscoveredSettlementTargets(config);

    const configuredTakeTarget = takeTargets.find(
      (target) => target.poolAddress === '0x2222222222222222222222222222222222222222'
    );
    const newTakeTarget = takeTargets.find(
      (target) => target.poolAddress === '0x4444444444444444444444444444444444444444'
    );
    const configuredSettlementTarget = settlementTargets.find(
      (target) => target.poolAddress === '0x2222222222222222222222222222222222222222'
    );
    const newSettlementTarget = settlementTargets.find(
      (target) => target.poolAddress === '0x4444444444444444444444444444444444444444'
    );

    expect(configuredTakeTarget?.dryRun).to.equal(false);
    expect(newTakeTarget?.dryRun).to.equal(true);
    expect(configuredSettlementTarget?.dryRun).to.equal(false);
    expect(newSettlementTarget?.dryRun).to.equal(true);
  });

  it('refuses to cache a discovered pool that is not deployed by the configured Ajna factory', async () => {
    const hydrationCooldowns = new Map<string, number>();
    const poolMap = new Map();
    const loggerErrorStub = sinon.stub(logger, 'error');

    const pool = await ensurePoolLoaded({
      ajna: {
        fungiblePoolFactory: {
          getPoolByAddress: sinon.stub().resolves({
            name: 'Compromised Pool',
            poolAddress: '0x1111111111111111111111111111111111111111',
            collateralAddress: '0x2222222222222222222222222222222222222222',
            quoteAddress: '0x3333333333333333333333333333333333333333',
          }),
          getPoolAddress: sinon
            .stub()
            .resolves('0x9999999999999999999999999999999999999999'),
        },
      } as any,
      poolMap: poolMap as any,
      poolAddress: '0x1111111111111111111111111111111111111111',
      config: BASE_CONFIG,
      hydrationCooldowns,
    });

    expect(pool).to.equal(undefined);
    expect(poolMap.size).to.equal(0);
    expect(
      hydrationCooldowns.has('0x1111111111111111111111111111111111111111')
    ).to.equal(true);
    expect(
      loggerErrorStub.firstCall.args[0]
    ).to.include('Failed to hydrate discovered pool 0x1111111111111111111111111111111111111111');
  });

  it('returns no discovered targets when the chain-wide query is empty', async () => {
    sinon.stub(subgraph, 'getChainwideLiquidationAuctions').resolves({
      liquidationAuctions: [],
    });

    const takeTargets = await buildDiscoveredTakeTargets(BASE_CONFIG);
    const settlementTargets = await buildDiscoveredSettlementTargets(BASE_CONFIG);

    expect(takeTargets).to.deep.equal([]);
    expect(settlementTargets).to.deep.equal([]);
  });

  it('reuses the same chain-wide discovery scan across take and settlement builders', async () => {
    const discoveryStub = sinon
      .stub(subgraph, 'getChainwideLiquidationAuctions')
      .resolves({
        liquidationAuctions: [
          {
            borrower: '0xBorrowerA',
            kickTime: '1',
            debtRemaining: '2',
            collateralRemaining: '3',
            neutralPrice: '4',
            debt: '2',
            collateral: '3',
            pool: { id: '0x1111111111111111111111111111111111111111' },
          },
        ],
      });

    const [takeTargets, settlementTargets] = await Promise.all([
      buildDiscoveredTakeTargets(BASE_CONFIG),
      buildDiscoveredSettlementTargets(BASE_CONFIG),
    ]);

    expect(discoveryStub.calledOnce).to.be.true;
    expect(takeTargets).to.have.length(1);
    expect(settlementTargets).to.have.length(1);
  });

  it('does not reuse shared discovery scans across different subgraph fallback endpoint sets', async () => {
    const discoveryStub = sinon
      .stub(subgraph, 'getChainwideLiquidationAuctions')
      .resolves({
        liquidationAuctions: [
          {
            borrower: '0xBorrowerA',
            kickTime: '1',
            debtRemaining: '2',
            collateralRemaining: '3',
            neutralPrice: '4',
            debt: '2',
            collateral: '3',
            pool: { id: '0x1111111111111111111111111111111111111111' },
          },
        ],
      });

    await buildDiscoveredTakeTargets({
      ...BASE_CONFIG,
      subgraphFallbackUrls: ['http://fallback-a'],
    });
    await buildDiscoveredTakeTargets({
      ...BASE_CONFIG,
      subgraphFallbackUrls: ['http://fallback-b'],
    });

    expect(discoveryStub.calledTwice).to.be.true;
  });

  it('does not apply take quote budget to arb-only discovered take defaults', async () => {
    const config: KeeperConfig = {
      ...BASE_CONFIG,
      autoDiscover: {
        ...BASE_CONFIG.autoDiscover!,
        take: {
          enabled: true,
          takeQuoteBudgetPerRun: 1,
        },
      },
    };

    sinon.stub(subgraph, 'getChainwideLiquidationAuctions').resolves({
      liquidationAuctions: [
        {
          borrower: '0xBorrowerA',
          kickTime: '1',
          debtRemaining: '2',
          collateralRemaining: '3',
          neutralPrice: '4',
          debt: '2',
          collateral: '3',
          pool: { id: '0x1111111111111111111111111111111111111111' },
        },
        {
          borrower: '0xBorrowerB',
          kickTime: '1',
          debtRemaining: '5',
          collateralRemaining: '6',
          neutralPrice: '7',
          debt: '5',
          collateral: '6',
          pool: { id: '0x2222222222222222222222222222222222222222' },
        },
      ],
    });

    const targets = await buildDiscoveredTakeTargets(config);

    expect(targets).to.have.length(2);
  });

  it('skips discovered candidates with malformed numeric fields without aborting the take build', async () => {
    sinon.stub(subgraph, 'getChainwideLiquidationAuctions').resolves({
      liquidationAuctions: [
        {
          borrower: '0xBorrowerInvalid',
          kickTime: '1',
          debtRemaining: '2',
          collateralRemaining: '3',
          neutralPrice: '1e18',
          debt: '2',
          collateral: '3',
          pool: { id: '0x2222222222222222222222222222222222222222' },
        },
        {
          borrower: '0xBorrowerValid',
          kickTime: '2',
          debtRemaining: '5',
          collateralRemaining: '6',
          neutralPrice: '7',
          debt: '5',
          collateral: '6',
          pool: { id: '0x1111111111111111111111111111111111111111' },
        },
      ],
    });

    const targets = await buildDiscoveredTakeTargets(BASE_CONFIG);

    expect(targets).to.have.length(1);
    expect(targets[0].poolAddress).to.equal(
      '0x1111111111111111111111111111111111111111'
    );
    expect(targets[0].candidates.map((candidate) => candidate.borrower)).to.deep.equal([
      '0xBorrowerValid',
    ]);
  });

  it('preserves negative signs when ranking discovered take candidates', async () => {
    const config: KeeperConfig = {
      ...BASE_CONFIG,
      autoDiscover: {
        ...BASE_CONFIG.autoDiscover!,
        take: {
          enabled: true,
          takeQuoteBudgetPerRun: 1,
          maxPoolsPerRun: 1,
        },
        settlement: false,
      },
    };

    sinon.stub(subgraph, 'getChainwideLiquidationAuctions').resolves({
      liquidationAuctions: [
        {
          borrower: '0xBorrowerNegative',
          kickTime: '1',
          debtRemaining: '1',
          collateralRemaining: '5',
          neutralPrice: '-2',
          debt: '1',
          collateral: '5',
          pool: { id: '0x1111111111111111111111111111111111111111' },
        },
        {
          borrower: '0xBorrowerPositive',
          kickTime: '2',
          debtRemaining: '3',
          collateralRemaining: '4',
          neutralPrice: '1',
          debt: '3',
          collateral: '4',
          pool: { id: '0x2222222222222222222222222222222222222222' },
        },
      ],
    });

    const targets = await buildDiscoveredTakeTargets(config);

    expect(targets).to.have.length(1);
    expect(targets[0].poolAddress).to.equal(
      '0x2222222222222222222222222222222222222222'
    );
  });

  it('treats zero kickTime as too new to bypass settlement age filtering', async () => {
    const config: KeeperConfig = {
      ...BASE_CONFIG,
      autoDiscover: {
        ...BASE_CONFIG.autoDiscover!,
        take: false,
        settlement: {
          enabled: true,
          maxPoolsPerRun: 1,
        },
      },
    };

    sinon.stub(subgraph, 'getChainwideLiquidationAuctions').resolves({
      liquidationAuctions: [
        {
          borrower: '0xBorrowerZeroKick',
          kickTime: '0',
          debtRemaining: '10',
          collateralRemaining: '0',
          neutralPrice: '1',
          debt: '10',
          collateral: '0',
          pool: { id: '0x1111111111111111111111111111111111111111' },
        },
        {
          borrower: '0xBorrowerOldKick',
          kickTime: '1',
          debtRemaining: '10',
          collateralRemaining: '0',
          neutralPrice: '1',
          debt: '10',
          collateral: '0',
          pool: { id: '0x2222222222222222222222222222222222222222' },
        },
      ],
    });

    const targets = await buildDiscoveredSettlementTargets(config);

    expect(targets).to.have.length(1);
    expect(targets[0].poolAddress).to.equal(
      '0x2222222222222222222222222222222222222222'
    );
  });

  it('uses a deterministic fallback ordering for invalid discovered kickTime values', async () => {
    const config: KeeperConfig = {
      ...BASE_CONFIG,
      autoDiscover: {
        ...BASE_CONFIG.autoDiscover!,
        take: false,
        settlement: {
          enabled: true,
          maxPoolsPerRun: 1,
        },
      },
    };

    sinon.stub(subgraph, 'getChainwideLiquidationAuctions').resolves({
      liquidationAuctions: [
        {
          borrower: '0xBorrowerB',
          kickTime: 'not-a-number',
          debtRemaining: '10',
          collateralRemaining: '0',
          neutralPrice: '1',
          debt: '10',
          collateral: '0',
          pool: { id: '0x1111111111111111111111111111111111111111' },
        },
        {
          borrower: '0xBorrowerA',
          kickTime: '',
          debtRemaining: '10',
          collateralRemaining: '0',
          neutralPrice: '1',
          debt: '10',
          collateral: '0',
          pool: { id: '0x1111111111111111111111111111111111111111' },
        },
      ],
    });

    const firstTargets = await buildDiscoveredSettlementTargets(config);
    clearSharedDiscoveryScans();
    const secondTargets = await buildDiscoveredSettlementTargets(config);

    expect(firstTargets).to.have.length(1);
    expect(secondTargets).to.have.length(1);
    expect(
      firstTargets[0].candidates.map((candidate) => candidate.borrower)
    ).to.deep.equal(['0xBorrowerA', '0xBorrowerB']);
    expect(
      secondTargets[0].candidates.map((candidate) => candidate.borrower)
    ).to.deep.equal(['0xBorrowerA', '0xBorrowerB']);
  });

  it('uses precise decimal ranking when enforcing discovered take quote budgets', async () => {
    const config: KeeperConfig = {
      ...BASE_CONFIG,
      keeperTaker: '0x1234567890123456789012345678901234567890',
      oneInchRouters: {
        1: '0x1111111111111111111111111111111111111111',
      },
      autoDiscover: {
        ...BASE_CONFIG.autoDiscover!,
        take: {
          enabled: true,
          takeQuoteBudgetPerRun: 1,
          maxPoolsPerRun: 1,
        },
        settlement: false,
      },
      discoveredDefaults: {
        ...BASE_CONFIG.discoveredDefaults!,
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
      },
    };

    sinon.stub(subgraph, 'getChainwideLiquidationAuctions').resolves({
      liquidationAuctions: [
        {
          borrower: '0xBorrowerLower',
          kickTime: '2',
          debtRemaining: '1',
          collateralRemaining: '900719925474099300000000000000000000',
          neutralPrice: '1',
          debt: '1',
          collateral: '900719925474099300000000000000000000',
          pool: { id: '0x2222222222222222222222222222222222222222' },
        },
        {
          borrower: '0xBorrowerHigher',
          kickTime: '1',
          debtRemaining: '1',
          collateralRemaining: '900719925474099300000000000000000001',
          neutralPrice: '1',
          debt: '1',
          collateral: '900719925474099300000000000000000001',
          pool: { id: '0x1111111111111111111111111111111111111111' },
        },
      ],
    });

    const targets = await buildDiscoveredTakeTargets(config);

    expect(targets).to.have.length(1);
    expect(targets[0].poolAddress).to.equal(
      '0x1111111111111111111111111111111111111111'
    );
    expect(targets[0].candidates[0].borrower).to.equal('0xBorrowerHigher');
  });

  it('prioritizes larger discovered settlement debt before auction age', async () => {
    const config: KeeperConfig = {
      ...BASE_CONFIG,
      autoDiscover: {
        ...BASE_CONFIG.autoDiscover!,
        take: false,
        settlement: {
          enabled: true,
          maxPoolsPerRun: 1,
        },
      },
    };

    sinon.stub(subgraph, 'getChainwideLiquidationAuctions').resolves({
      liquidationAuctions: [
        {
          borrower: '0xBorrowerOlderSmallerDebt',
          kickTime: '1',
          debtRemaining: '9',
          collateralRemaining: '0',
          neutralPrice: '1',
          debt: '9',
          collateral: '0',
          pool: { id: '0x1111111111111111111111111111111111111111' },
        },
        {
          borrower: '0xBorrowerNewerLargerDebt',
          kickTime: '1000',
          debtRemaining: '10',
          collateralRemaining: '0',
          neutralPrice: '1',
          debt: '10',
          collateral: '0',
          pool: { id: '0x2222222222222222222222222222222222222222' },
        },
      ],
    });

    const targets = await buildDiscoveredSettlementTargets(config);

    expect(targets).to.have.length(1);
    expect(targets[0].poolAddress).to.equal(
      '0x2222222222222222222222222222222222222222'
    );
  });

  it('uses older kickTime as the settlement tiebreaker when debt is equal', async () => {
    const config: KeeperConfig = {
      ...BASE_CONFIG,
      autoDiscover: {
        ...BASE_CONFIG.autoDiscover!,
        take: false,
        settlement: {
          enabled: true,
          maxPoolsPerRun: 1,
        },
      },
    };

    sinon.stub(subgraph, 'getChainwideLiquidationAuctions').resolves({
      liquidationAuctions: [
        {
          borrower: '0xBorrowerNewer',
          kickTime: '1000',
          debtRemaining: '10',
          collateralRemaining: '0',
          neutralPrice: '1',
          debt: '10',
          collateral: '0',
          pool: { id: '0x2222222222222222222222222222222222222222' },
        },
        {
          borrower: '0xBorrowerOlder',
          kickTime: '1',
          debtRemaining: '10',
          collateralRemaining: '0',
          neutralPrice: '1',
          debt: '10',
          collateral: '0',
          pool: { id: '0x1111111111111111111111111111111111111111' },
        },
      ],
    });

    const targets = await buildDiscoveredSettlementTargets(config);

    expect(targets).to.have.length(1);
    expect(targets[0].poolAddress).to.equal(
      '0x1111111111111111111111111111111111111111'
    );
  });

  it('skips an invalid discovered take target without aborting the whole build', async () => {
    const warnStub = sinon.stub(logger, 'warn');

    sinon.stub(subgraph, 'getChainwideLiquidationAuctions').resolves({
      liquidationAuctions: [
        {
          borrower: '0xBorrowerInvalid',
          kickTime: '1',
          debtRemaining: '2',
          collateralRemaining: '3',
          neutralPrice: '4',
          debt: '2',
          collateral: '3',
          pool: { id: 'not-an-address' },
        },
        {
          borrower: '0xBorrowerValid',
          kickTime: '2',
          debtRemaining: '5',
          collateralRemaining: '6',
          neutralPrice: '7',
          debt: '5',
          collateral: '6',
          pool: { id: '0x1111111111111111111111111111111111111111' },
        },
      ],
    });

    const targets = await buildDiscoveredTakeTargets(BASE_CONFIG);

    expect(targets).to.have.length(1);
    expect(targets[0].poolAddress).to.equal(
      '0x1111111111111111111111111111111111111111'
    );
    expect(warnStub.called).to.equal(true);
  });

  it('skips an invalid discovered settlement target without aborting the whole build', async () => {
    const warnStub = sinon.stub(logger, 'warn');

    sinon.stub(subgraph, 'getChainwideLiquidationAuctions').resolves({
      liquidationAuctions: [
        {
          borrower: '0xBorrowerInvalid',
          kickTime: '1',
          debtRemaining: '2',
          collateralRemaining: '0',
          neutralPrice: '4',
          debt: '2',
          collateral: '0',
          pool: { id: 'not-an-address' },
        },
        {
          borrower: '0xBorrowerValid',
          kickTime: '2',
          debtRemaining: '5',
          collateralRemaining: '0',
          neutralPrice: '7',
          debt: '5',
          collateral: '0',
          pool: { id: '0x1111111111111111111111111111111111111111' },
        },
      ],
    });

    const targets = await buildDiscoveredSettlementTargets({
      ...BASE_CONFIG,
      autoDiscover: {
        ...BASE_CONFIG.autoDiscover!,
        take: false,
        settlement: true,
      },
    });

    expect(targets).to.have.length(1);
    expect(targets[0].poolAddress).to.equal(
      '0x1111111111111111111111111111111111111111'
    );
    expect(warnStub.called).to.equal(true);
  });

  it('validates resolved runtime targets separately from config-file validation', () => {
    expect(() =>
      validateResolvedTakeTarget(
        {
          source: 'discovered',
          poolAddress: '0x1111111111111111111111111111111111111111',
          name: 'Broken Take Target',
          dryRun: true,
          take: {
            minCollateral: 0.1,
            hpbPriceFactor: 0.98,
          },
          candidates: [],
        },
        BASE_CONFIG
      )
    ).to.throw('ResolvedTakeTarget: no candidates');

    expect(() =>
      validateResolvedSettlementTarget({
        source: 'discovered',
        poolAddress: '0x1111111111111111111111111111111111111111',
        name: 'Broken Settlement Target',
        dryRun: true,
        settlement: {
          enabled: true,
        },
        candidates: [],
      })
    ).to.throw('ResolvedSettlementTarget: no candidates');
  });
});
