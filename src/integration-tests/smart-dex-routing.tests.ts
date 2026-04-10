// src/integration-tests/smart-dex-routing.test.ts
import { expect } from 'chai';
import { Wallet } from 'ethers';
import {
  LiquiditySource,
  validateTakeSettings,
} from '../config';
import { SmartDexManager } from '../smart-dex-manager';
import { USER1_MNEMONIC } from './test-config';
import { getProvider } from './test-utils';

describe('Smart DEX Routing Integration Tests', () => {
  let mockSigner: any;

  beforeEach(() => {
    const wallet = Wallet.fromMnemonic(USER1_MNEMONIC);
    mockSigner = wallet.connect(getProvider());
  });

  describe('Per-Pool Detection', () => {
    it('detects single deployment for 1inch pools', async () => {
      const manager = new SmartDexManager(mockSigner, {
        keeperTaker: '0x1234567890123456789012345678901234567890',
        oneInchRouters: {
          43114: '0x111111125421ca6dc452d289314280a0f8842a65',
        },
      });

      const deploymentType = await manager.detectDeploymentTypeForPool({
        name: '1inch Pool',
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.95,
        },
      } as any);

      expect(deploymentType).to.equal('single');
    });

    it('detects factory deployment for factory-backed pools', async () => {
      const manager = new SmartDexManager(mockSigner, {
        keeperTakerFactory: '0xB6006B9e9696a0A097D4990964D5bDa6E940ba0D',
        takerContracts: {
          UniswapV3: '0x81D39B4A2Be43e5655608fCcE18A0edd8906D7c7',
        },
      });

      const deploymentType = await manager.detectDeploymentTypeForPool({
        name: 'Factory Pool',
        take: {
          liquiditySource: LiquiditySource.UNISWAPV3,
          marketPriceFactor: 0.95,
        },
      } as any);

      expect(deploymentType).to.equal('factory');
    });

    it('routes mixed configs by pool source instead of preferring factory globally', async () => {
      const manager = new SmartDexManager(mockSigner, {
        keeperTaker: '0x1111111111111111111111111111111111111111',
        oneInchRouters: { 1: '0x1111111254EEB25477B68fb85Ed929f73A960582' },
        keeperTakerFactory: '0x2222222222222222222222222222222222222222',
        takerContracts: { UniswapV3: '0x3333333333333333333333333333333333333333' },
      });

      const oneInchDeployment = await manager.detectDeploymentTypeForPool({
        name: 'Legacy Pool',
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.95,
        },
      } as any);
      const factoryDeployment = await manager.detectDeploymentTypeForPool({
        name: 'Factory Pool',
        take: {
          liquiditySource: LiquiditySource.UNISWAPV3,
          marketPriceFactor: 0.95,
        },
      } as any);

      expect(oneInchDeployment).to.equal('single');
      expect(factoryDeployment).to.equal('factory');
    });
  });

  describe('Per-Pool Validation', () => {
    it('validates a complete 1inch pool config', async () => {
      const manager = new SmartDexManager(mockSigner, {
        keeperTaker: '0x1234567890123456789012345678901234567890',
        oneInchRouters: {
          43114: '0x111111125421ca6dc452d289314280a0f8842a65',
        },
      });

      const validation = await manager.validateDeploymentForPool({
        name: '1inch Pool',
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.95,
        },
      } as any);

      expect(validation.valid).to.be.true;
      expect(validation.errors).to.be.empty;
    });

    it('validates a complete factory-backed pool config', async () => {
      const manager = new SmartDexManager(mockSigner, {
        keeperTakerFactory: '0xB6006B9e9696a0A097D4990964D5bDa6E940ba0D',
        takerContracts: {
          UniswapV3: '0x81D39B4A2Be43e5655608fCcE18A0edd8906D7c7',
        },
      });

      const validation = await manager.validateDeploymentForPool({
        name: 'Factory Pool',
        take: {
          liquiditySource: LiquiditySource.UNISWAPV3,
          marketPriceFactor: 0.95,
        },
      } as any);

      expect(validation.valid).to.be.true;
      expect(validation.errors).to.be.empty;
    });

    it('falls back to arb-only validation when a requested external deployment is missing', async () => {
      const manager = new SmartDexManager(mockSigner, {
        keeperTakerFactory: '0x1234567890123456789012345678901234567890',
      });

      const validation = await manager.validateDeploymentForPool({
        name: 'Factory Pool',
        take: {
          liquiditySource: LiquiditySource.UNISWAPV3,
          marketPriceFactor: 0.95,
        },
      } as any);

      expect(validation.valid).to.be.true;
      expect(validation.errors).to.be.empty;
    });
  });

  describe('Take Settings Integration', () => {
    it('validates Uniswap V3 take settings with factory config', async () => {
      const factoryConfig = {
        keeperTakerFactory: '0x1234567890123456789012345678901234567890',
        takerContracts: {
          UniswapV3: '0x2234567890123456789012345678901234567890',
        },
        universalRouterOverrides: {
          universalRouterAddress: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD',
          quoterV2Address: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
          permit2Address: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
          poolFactoryAddress: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
          wethAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        },
      };

      expect(() => {
        validateTakeSettings(
          {
            minCollateral: 0.1,
            liquiditySource: LiquiditySource.UNISWAPV3,
            marketPriceFactor: 0.95,
            hpbPriceFactor: 0.98,
          },
          factoryConfig as any
        );
      }).to.not.throw();
    });

    it('validates 1inch take settings with legacy config', async () => {
      const singleConfig = {
        keeperTaker: '0x1234567890123456789012345678901234567890',
        oneInchRouters: {
          1: '0x1111111254EEB25477B68fb85Ed929f73A960582',
        },
      };

      expect(() => {
        validateTakeSettings(
          {
            minCollateral: 0.1,
            liquiditySource: LiquiditySource.ONEINCH,
            marketPriceFactor: 0.95,
            hpbPriceFactor: 0.98,
          },
          singleConfig as any
        );
      }).to.not.throw();
    });
  });
});
