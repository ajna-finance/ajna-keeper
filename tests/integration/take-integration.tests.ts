// tests/integration/take-integration.test.ts
import { expect } from 'chai';
import { BigNumber } from 'ethers';
import sinon from 'sinon';
import { LiquiditySource, PoolConfig } from '../../src/config';
import { logger } from '../../src/logging';
import subgraph from '../../src/subgraph';
import { getLiquidationsToTake, handleTakes } from '../../src/take';
import * as takeArb from '../../src/take/arb';
import { arrayFromAsync } from '../../src/utils';

describe('Take Integration Tests', () => {
  const basePool = {
    name: 'SOL / WETH',
    poolAddress: '0x1111111111111111111111111111111111111111',
    quoteAddress: '0x2222222222222222222222222222222222222222',
    collateralAddress: '0x3333333333333333333333333333333333333333',
  };

  const basePoolConfig: PoolConfig = {
    name: 'SOL / WETH',
    address: basePool.poolAddress,
    price: {
      source: 'fixed' as any,
      value: 0.075,
    },
    take: {
      minCollateral: 0.1,
      hpbPriceFactor: 0.98,
    },
  };

  const signer = {} as any;

  beforeEach(() => {
    sinon.stub(subgraph, 'getLiquidations').resolves({
      pool: { hpb: 1, hpbIndex: 0, liquidationAuctions: [] },
    } as any);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('routes Uniswap V3 pools through the manual factory take context', async () => {
    const debugSpy = sinon.spy(logger, 'debug');
    const config = {
      dryRun: true,
      subgraphUrl: 'http://test-url',
      keeperTakerFactory: '0x1234567890123456789012345678901234567890',
      takerContracts: {
        UniswapV3: '0x2234567890123456789012345678901234567890',
      },
    };

    const poolConfig: PoolConfig = {
      ...basePoolConfig,
      take: {
        minCollateral: 0.1,
        liquiditySource: LiquiditySource.UNISWAPV3,
        marketPriceFactor: 0.95,
        hpbPriceFactor: 0.98,
      },
    };

    await handleTakes({
      signer,
      pool: basePool as any,
      poolConfig: poolConfig as any,
      config: config as any,
    });

    expect(
      (subgraph.getLiquidations as sinon.SinonStub).calledOnceWithExactly(
        'http://test-url',
        basePool.poolAddress,
        0.1,
        { fallbackUrls: undefined }
      )
    ).to.be.true;
    expect(
      debugSpy.calledWithMatch(
        sinon.match('Manual factory external take context starting')
      )
    ).to.be.true;
    expect(
      debugSpy.calledWithMatch(
        sinon.match('Manual 1inch take context starting')
      )
    ).to.be.false;
  });

  it('routes 1inch pools through the manual 1inch take path', async () => {
    const debugSpy = sinon.spy(logger, 'debug');
    const config = {
      dryRun: true,
      subgraphUrl: 'http://test-url',
      keeperTaker: '0x1234567890123456789012345678901234567890',
      oneInchRouters: {
        1: '0x1111111254EEB25477B68fb85Ed929f73A960582',
      },
      connectorTokens: [],
    };

    const poolConfig: PoolConfig = {
      ...basePoolConfig,
      take: {
        minCollateral: 0.1,
        liquiditySource: LiquiditySource.ONEINCH,
        marketPriceFactor: 0.95,
        hpbPriceFactor: 0.98,
      },
    };

    await handleTakes({
      signer,
      pool: basePool as any,
      poolConfig: poolConfig as any,
      config: config as any,
    });

    expect(
      (subgraph.getLiquidations as sinon.SinonStub).calledOnceWithExactly(
        'http://test-url',
        basePool.poolAddress,
        0.1,
        { fallbackUrls: undefined }
      )
    ).to.be.true;
    expect(
      debugSpy.calledWithMatch(
        sinon.match('Manual 1inch take context starting')
      )
    ).to.be.true;
    expect(
      debugSpy.calledWithMatch(
        sinon.match('Manual factory external take context starting')
      )
    ).to.be.false;
  });

  it('routes LI.FI pools through the manual LI.FI take path', async () => {
    const debugSpy = sinon.spy(logger, 'debug');
    const config = {
      dryRun: true,
      subgraphUrl: 'http://test-url',
      keeperTakerFactory: '0x1234567890123456789012345678901234567890',
      takerContracts: {
        Lifi: '0x2234567890123456789012345678901234567890',
      },
      lifi: { mode: 'canary' },
    };

    const poolConfig: PoolConfig = {
      ...basePoolConfig,
      take: {
        minCollateral: 0.1,
        liquiditySource: LiquiditySource.LIFI,
        marketPriceFactor: 0.95,
        hpbPriceFactor: 0.98,
      },
    };

    await handleTakes({
      signer,
      pool: basePool as any,
      poolConfig: poolConfig as any,
      config: config as any,
    });

    expect(
      (subgraph.getLiquidations as sinon.SinonStub).calledOnceWithExactly(
        'http://test-url',
        basePool.poolAddress,
        0.1,
        { fallbackUrls: undefined }
      )
    ).to.be.true;
    expect(
      debugSpy.calledWithMatch(
        sinon.match('Manual LI.FI external take context starting')
      )
    ).to.be.true;
    expect(
      debugSpy.calledWithMatch(
        sinon.match('Manual factory external take context starting')
      )
    ).to.be.false;
    expect(
      debugSpy.calledWithMatch(
        sinon.match('Manual 1inch take context starting')
      )
    ).to.be.false;
  });

  it('routes arb-only pools through the shared take candidate path', async () => {
    const debugSpy = sinon.spy(logger, 'debug');
    const config = {
      dryRun: true,
      subgraphUrl: 'http://test-url',
    };

    await handleTakes({
      signer,
      pool: basePool as any,
      poolConfig: basePoolConfig as any,
      config: config as any,
    });

    expect(
      (subgraph.getLiquidations as sinon.SinonStub).calledOnceWithExactly(
        'http://test-url',
        basePool.poolAddress,
        0.1,
        { fallbackUrls: undefined }
      )
    ).to.be.true;
    expect(
      debugSpy.calledWithMatch(sinon.match('Manual arbTake context starting'))
    ).to.be.true;
    expect(
      debugSpy.calledWithMatch(
        sinon.match('Manual 1inch take context starting')
      )
    ).to.be.false;
  });

  it('routes mixed configs by pool source instead of globally preferring factory', async () => {
    const debugSpy = sinon.spy(logger, 'debug');
    const config = {
      dryRun: true,
      subgraphUrl: 'http://test-url',
      keeperTaker: '0x1111111111111111111111111111111111111111',
      oneInchRouters: { 1: '0x1111111254EEB25477B68fb85Ed929f73A960582' },
      keeperTakerFactory: '0x2222222222222222222222222222222222222222',
      takerContracts: {
        UniswapV3: '0x3333333333333333333333333333333333333333',
        Lifi: '0x4444444444444444444444444444444444444444',
      },
      lifi: { mode: 'canary' },
    };

    await handleTakes({
      signer,
      pool: basePool as any,
      poolConfig: {
        ...basePoolConfig,
        take: {
          minCollateral: 0.1,
          liquiditySource: LiquiditySource.UNISWAPV3,
          marketPriceFactor: 0.95,
        },
      } as any,
      config: config as any,
    });
    await handleTakes({
      signer,
      pool: basePool as any,
      poolConfig: {
        ...basePoolConfig,
        take: {
          minCollateral: 0.1,
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.95,
        },
      } as any,
      config: config as any,
    });
    await handleTakes({
      signer,
      pool: basePool as any,
      poolConfig: {
        ...basePoolConfig,
        take: {
          minCollateral: 0.1,
          liquiditySource: LiquiditySource.LIFI,
          marketPriceFactor: 0.95,
        },
      } as any,
      config: config as any,
    });

    expect((subgraph.getLiquidations as sinon.SinonStub).calledThrice).to.be
      .true;
    expect(
      debugSpy.calledWithMatch(
        sinon.match('Manual factory external take context starting')
      )
    ).to.be.true;
    expect(
      debugSpy.calledWithMatch(
        sinon.match('Manual 1inch take context starting')
      )
    ).to.be.true;
    expect(
      debugSpy.calledWithMatch(
        sinon.match('Manual LI.FI external take context starting')
      )
    ).to.be.true;
  });

  it('falls back to arb-only when a pool requests factory liquidity without factory contracts', async () => {
    const warnSpy = sinon.spy(logger, 'warn');
    const config = {
      dryRun: true,
      subgraphUrl: 'http://test-url',
      keeperTakerFactory: '0x1234567890123456789012345678901234567890',
    };

    const poolConfig: PoolConfig = {
      ...basePoolConfig,
      take: {
        minCollateral: 0.1,
        liquiditySource: LiquiditySource.UNISWAPV3,
        marketPriceFactor: 0.95,
        hpbPriceFactor: 0.98,
      },
    };

    await handleTakes({
      signer,
      pool: basePool as any,
      poolConfig: poolConfig as any,
      config: config as any,
    });

    expect(
      (subgraph.getLiquidations as sinon.SinonStub).calledOnceWithExactly(
        'http://test-url',
        basePool.poolAddress,
        0.1,
        { fallbackUrls: undefined }
      )
    ).to.be.true;
    expect(
      warnSpy.calledWithMatch(
        sinon.match(
          `External liquidity source UNISWAPV3 unavailable for pool ${basePool.name} - checking arbTake only`
        )
      )
    ).to.be.true;
  });

  it('uses the same deployment-aware arb fallback for getLiquidationsToTake', async () => {
    const borrower = '0x4444444444444444444444444444444444444444';
    (subgraph.getLiquidations as sinon.SinonStub).resolves({
      pool: {
        hpb: 1,
        hpbIndex: 42,
        liquidationAuctions: [{ borrower }],
      },
    } as any);
    const checkIfArbTakeableStub = sinon
      .stub(takeArb, 'checkIfArbTakeable')
      .callsFake(async (_pool, _price, _collateral, poolConfig) => {
        expect(poolConfig.take.liquiditySource).to.equal(undefined);
        expect(poolConfig.take.marketPriceFactor).to.equal(undefined);
        expect(poolConfig.take.hpbPriceFactor).to.equal(0.98);
        return {
          isArbTakeable: true,
          hpbIndex: 42,
          maxArbTakePrice: 1,
        };
      });
    const pool = {
      ...basePool,
      getPrices: sinon.stub().resolves({
        hpb: BigNumber.from('1000000000000000000'),
      }),
      poolInfoContractUtils: {
        auctionStatus: sinon.stub().resolves({
          collateral: BigNumber.from('1000000000000000000'),
          price: BigNumber.from('500000000000000000'),
        }),
      },
    };

    const liquidations = await arrayFromAsync(
      getLiquidationsToTake({
        signer,
        pool: pool as any,
        poolConfig: {
          ...basePoolConfig,
          take: {
            minCollateral: 0.1,
            liquiditySource: LiquiditySource.UNISWAPV3,
            marketPriceFactor: 0.95,
            hpbPriceFactor: 0.98,
          },
        } as any,
        config: {
          subgraphUrl: 'http://test-url',
          keeperTakerFactory: '0x1234567890123456789012345678901234567890',
        } as any,
      })
    );

    expect(checkIfArbTakeableStub.calledOnce).to.equal(true);
    expect(liquidations).to.have.length(1);
    expect(liquidations[0].borrower).to.equal(borrower);
    expect(liquidations[0].isTakeable).to.equal(false);
    expect(liquidations[0].isArbTakeable).to.equal(true);
    expect(liquidations[0].externalTakeExecutionPlan).to.equal(undefined);
  });
});
