import { expect } from 'chai';
import sinon from 'sinon';
import { LiquiditySource } from '../config';
import { SmartDexManager } from '../dex/manager';

describe('SmartDexManager', () => {
  let mockSigner: any;

  beforeEach(() => {
    mockSigner = {
      getChainId: sinon.stub().resolves(43114),
    };
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('detectDeploymentTypeForPool()', () => {
    it('returns single for a 1inch pool when the legacy taker is configured', async () => {
      const manager = new SmartDexManager(mockSigner, {
        keeperTaker: '0xTaker123',
        oneInchRouters: { 43114: '0xRouter123' },
      });

      const result = await manager.detectDeploymentTypeForPool({
        name: '1inch Pool',
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
      } as any);

      expect(result).to.equal('single');
    });

    it('returns factory for a factory-backed pool when factory contracts are configured', async () => {
      const manager = new SmartDexManager(mockSigner, {
        keeperTakerFactory: '0xFactory123',
        takerContracts: { UniswapV3: '0xTaker123' },
      });

      const result = await manager.detectDeploymentTypeForPool({
        name: 'Factory Pool',
        take: {
          liquiditySource: LiquiditySource.UNISWAPV3,
          marketPriceFactor: 0.99,
        },
      } as any);

      expect(result).to.equal('factory');
    });

    it('returns none for arb-only pools', async () => {
      const manager = new SmartDexManager(mockSigner, {});

      const result = await manager.detectDeploymentTypeForPool({
        name: 'Arb Pool',
        take: {
          minCollateral: 1,
          hpbPriceFactor: 0.9,
        },
      } as any);

      expect(result).to.equal('none');
    });

    it('routes mixed configs by pool liquidity source instead of globally', async () => {
      const manager = new SmartDexManager(mockSigner, {
        keeperTaker: '0xOldTaker123',
        keeperTakerFactory: '0xFactory123',
        takerContracts: { UniswapV3: '0xNewTaker123' },
        oneInchRouters: { 43114: '0xRouter123' },
      });

      const oneInchResult = await manager.detectDeploymentTypeForPool({
        name: 'Legacy Pool',
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
      } as any);
      const uniswapResult = await manager.detectDeploymentTypeForPool({
        name: 'Factory Pool',
        take: {
          liquiditySource: LiquiditySource.UNISWAPV3,
          marketPriceFactor: 0.99,
        },
      } as any);

      expect(oneInchResult).to.equal('single');
      expect(uniswapResult).to.equal('factory');
    });
  });

  describe('validateDeploymentForPool()', () => {
    it('validates a complete 1inch pool deployment', async () => {
      const manager = new SmartDexManager(mockSigner, {
        keeperTaker: '0xTaker123',
        oneInchRouters: { 43114: '0xRouter123' },
      });

      const result = await manager.validateDeploymentForPool({
        name: '1inch Pool',
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
      } as any);

      expect(result.valid).to.be.true;
      expect(result.errors).to.be.empty;
    });

    it('reports missing router config for 1inch pools', async () => {
      const manager = new SmartDexManager(mockSigner, {
        keeperTaker: '0xTaker123',
      });

      const result = await manager.validateDeploymentForPool({
        name: '1inch Pool',
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
      } as any);

      expect(result.valid).to.be.false;
      expect(result.errors).to.include('1inch deployment requires oneInchRouters configuration');
    });

    it('validates a complete factory-backed pool deployment', async () => {
      const manager = new SmartDexManager(mockSigner, {
        keeperTakerFactory: '0xFactory123',
        takerContracts: { UniswapV3: '0xTaker123' },
      });

      const result = await manager.validateDeploymentForPool({
        name: 'Factory Pool',
        take: {
          liquiditySource: LiquiditySource.UNISWAPV3,
          marketPriceFactor: 0.99,
        },
      } as any);

      expect(result.valid).to.be.true;
      expect(result.errors).to.be.empty;
    });

    it('treats missing factory config as arb-only fallback instead of a valid factory deployment', async () => {
      const manager = new SmartDexManager(mockSigner, {
        keeperTakerFactory: '0xFactory123',
      });

      const result = await manager.validateDeploymentForPool({
        name: 'Factory Pool',
        take: {
          liquiditySource: LiquiditySource.UNISWAPV3,
          marketPriceFactor: 0.99,
        },
      } as any);

      expect(result.valid).to.be.true;
      expect(result.errors).to.be.empty;
    });

    it('treats arb-only pools as valid without external contracts', async () => {
      const manager = new SmartDexManager(mockSigner, {});

      const result = await manager.validateDeploymentForPool({
        name: 'Arb Pool',
        take: {
          minCollateral: 1,
          hpbPriceFactor: 0.9,
        },
      } as any);

      expect(result.valid).to.be.true;
      expect(result.errors).to.be.empty;
    });
  });

  describe('canTakeLiquidation()', () => {
    it('returns true for 1inch external takes when the legacy deployment is available', async () => {
      const manager = new SmartDexManager(mockSigner, {
        keeperTaker: '0xTaker123',
        oneInchRouters: { 43114: '0xRouter123' },
      });

      const result = await manager.canTakeLiquidation({
        name: '1inch Pool',
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
      } as any);

      expect(result).to.be.true;
    });

    it('returns true for factory-backed external takes when factory contracts are available', async () => {
      const manager = new SmartDexManager(mockSigner, {
        keeperTakerFactory: '0xFactory123',
        takerContracts: { UniswapV3: '0xTaker123' },
      });

      const result = await manager.canTakeLiquidation({
        name: 'Factory Pool',
        take: {
          liquiditySource: LiquiditySource.UNISWAPV3,
          marketPriceFactor: 0.99,
        },
      } as any);

      expect(result).to.be.true;
    });

    it('returns false for arb-only pools because they do not use external liquidity', async () => {
      const manager = new SmartDexManager(mockSigner, {});

      const result = await manager.canTakeLiquidation({
        name: 'Arb Pool',
        take: {
          minCollateral: 1,
          hpbPriceFactor: 0.9,
        },
      } as any);

      expect(result).to.be.false;
    });

    it('returns false when a pool asks for a deployment type that is not configured', async () => {
      const manager = new SmartDexManager(mockSigner, {
        keeperTakerFactory: '0xFactory123',
        takerContracts: { UniswapV3: '0xTaker123' },
      });

      const result = await manager.canTakeLiquidation({
        name: '1inch Pool',
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
      } as any);

      expect(result).to.be.false;
    });
  });
});
