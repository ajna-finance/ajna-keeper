// src/integration-tests/take-integration.test.ts
import { expect } from 'chai';
import sinon from 'sinon';
import { KeeperConfig, LiquiditySource, PoolConfig } from '../config-types';
import subgraph from '../subgraph';
import { handleTakes } from '../take';
import * as takeFactory from '../take-factory';

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
    sinon
      .stub(subgraph, 'getLiquidations')
      .resolves({ pool: { hpb: 1, hpbIndex: 0, liquidationAuctions: [] } } as any);
    sinon.stub(takeFactory, 'handleFactoryTakes').resolves();
  });

  afterEach(() => {
    sinon.restore();
  });

  it('routes Uniswap V3 pools to the factory take handler', async () => {
    const config: Partial<KeeperConfig> = {
      dryRun: true,
      subgraphUrl: 'http://test-url',
      delayBetweenActions: 0,
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

    expect((takeFactory.handleFactoryTakes as sinon.SinonStub).calledOnce).to.be.true;
    expect((subgraph.getLiquidations as sinon.SinonStub).called).to.be.false;
  });

  it('routes 1inch pools through the legacy take path', async () => {
    const config: Partial<KeeperConfig> = {
      dryRun: true,
      subgraphUrl: 'http://test-url',
      delayBetweenActions: 0,
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

    expect((takeFactory.handleFactoryTakes as sinon.SinonStub).called).to.be.false;
    expect((subgraph.getLiquidations as sinon.SinonStub).calledOnceWithExactly(
      'http://test-url',
      basePool.poolAddress,
      0.1,
      { fallbackUrls: undefined }
    )).to.be.true;
  });

  it('routes arb-only pools through the legacy take path', async () => {
    const config: Partial<KeeperConfig> = {
      dryRun: true,
      subgraphUrl: 'http://test-url',
      delayBetweenActions: 0,
    };

    await handleTakes({
      signer,
      pool: basePool as any,
      poolConfig: basePoolConfig as any,
      config: config as any,
    });

    expect((takeFactory.handleFactoryTakes as sinon.SinonStub).called).to.be.false;
    expect((subgraph.getLiquidations as sinon.SinonStub).calledOnceWithExactly(
      'http://test-url',
      basePool.poolAddress,
      0.1,
      { fallbackUrls: undefined }
    )).to.be.true;
  });

  it('routes mixed configs by pool source instead of globally preferring factory', async () => {
    const config: Partial<KeeperConfig> = {
      dryRun: true,
      subgraphUrl: 'http://test-url',
      delayBetweenActions: 0,
      keeperTaker: '0x1111111111111111111111111111111111111111',
      oneInchRouters: { 1: '0x1111111254EEB25477B68fb85Ed929f73A960582' },
      keeperTakerFactory: '0x2222222222222222222222222222222222222222',
      takerContracts: { UniswapV3: '0x3333333333333333333333333333333333333333' },
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

    expect((takeFactory.handleFactoryTakes as sinon.SinonStub).calledOnce).to.be.true;
    expect((subgraph.getLiquidations as sinon.SinonStub).calledOnce).to.be.true;
  });

  it('falls back to arb-only when a pool requests factory liquidity without factory contracts', async () => {
    const config: Partial<KeeperConfig> = {
      dryRun: true,
      subgraphUrl: 'http://test-url',
      delayBetweenActions: 0,
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

    expect((takeFactory.handleFactoryTakes as sinon.SinonStub).called).to.be.false;
    expect((subgraph.getLiquidations as sinon.SinonStub).calledOnceWithExactly(
      'http://test-url',
      basePool.poolAddress,
      0.1,
      { fallbackUrls: undefined }
    )).to.be.true;
  });
});
