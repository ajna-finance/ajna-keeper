// tests/integration/smart-dex-routing.test.ts
import { expect } from 'chai';
import { LiquiditySource, validateTakeSettings } from '../../src/config';
import {
  resolveManualTakeDeployment,
  type ManualTakeDeploymentResolution,
} from '../../src/take/manual-context';

function expectManualDeploymentType<
  TDeploymentType extends ManualTakeDeploymentResolution['deploymentType'],
>(
  resolution: ManualTakeDeploymentResolution,
  deploymentType: TDeploymentType
): asserts resolution is ManualTakeDeploymentResolution & {
  deploymentType: TDeploymentType;
} {
  expect(resolution.deploymentType).to.equal(deploymentType);
}

describe('Manual External Take Routing Integration Tests', () => {
  describe('Per-Pool Resolution', () => {
    it('resolves a complete 1inch pool config', () => {
      const resolution = resolveManualTakeDeployment({
        poolConfig: {
          take: {
            liquiditySource: LiquiditySource.ONEINCH,
            marketPriceFactor: 0.95,
          },
        },
        config: {
          keeperTakerRouter: '0x1234567890123456789012345678901234567890',
          takerContracts: {
            OneInchAggregator: '0x1234567890123456789012345678901234567890',
          },
        },
      });

      expectManualDeploymentType(resolution, 'calldata_aggregator');
      expect(resolution.requestedLiquiditySource).to.equal(
        LiquiditySource.ONEINCH
      );
      expect(resolution.resolvedTakerAddress).to.equal(
        '0x1234567890123456789012345678901234567890'
      );
    });

    it('resolves a complete factory-backed pool config', () => {
      const resolution = resolveManualTakeDeployment({
        poolConfig: {
          take: {
            liquiditySource: LiquiditySource.UNISWAPV3,
            marketPriceFactor: 0.95,
          },
        },
        config: {
          keeperTakerRouter: '0xB6006B9e9696a0A097D4990964D5bDa6E940ba0D',
          takerContracts: {
            UniswapV3: '0x81D39B4A2Be43e5655608fCcE18A0edd8906D7c7',
          },
        },
      });

      expectManualDeploymentType(resolution, 'direct_dex');
      expect(resolution.requestedLiquiditySource).to.equal(
        LiquiditySource.UNISWAPV3
      );
      expect(resolution.resolvedTakerAddress).to.equal(
        '0x81D39B4A2Be43e5655608fCcE18A0edd8906D7c7'
      );
    });

    it('resolves a complete LI.FI pool config', () => {
      const resolution = resolveManualTakeDeployment({
        poolConfig: {
          take: {
            liquiditySource: LiquiditySource.LIFI,
            marketPriceFactor: 0.95,
          },
        },
        config: {
          keeperTakerRouter: '0xB6006B9e9696a0A097D4990964D5bDa6E940ba0D',
          takerContracts: {
            Lifi: '0x81D39B4A2Be43e5655608fCcE18A0edd8906D7c7',
          },
        },
      });

      expectManualDeploymentType(resolution, 'calldata_aggregator');
      expect(resolution.requestedLiquiditySource).to.equal(
        LiquiditySource.LIFI
      );
      expect(resolution.resolvedTakerAddress).to.equal(
        '0x81D39B4A2Be43e5655608fCcE18A0edd8906D7c7'
      );
    });

    it('routes mixed configs by pool source instead of preferring factory globally', () => {
      const config = {
        keeperTakerRouter: '0x2222222222222222222222222222222222222222',
        takerContracts: {
          OneInchAggregator: '0x1111111111111111111111111111111111111111',
          UniswapV3: '0x3333333333333333333333333333333333333333',
          Lifi: '0x4444444444444444444444444444444444444444',
        },
      };

      const oneInchDeployment = resolveManualTakeDeployment({
        poolConfig: {
          take: {
            liquiditySource: LiquiditySource.ONEINCH,
            marketPriceFactor: 0.95,
          },
        },
        config,
      });
      const factoryDeployment = resolveManualTakeDeployment({
        poolConfig: {
          take: {
            liquiditySource: LiquiditySource.UNISWAPV3,
            marketPriceFactor: 0.95,
          },
        },
        config,
      });
      const lifiDeployment = resolveManualTakeDeployment({
        poolConfig: {
          take: {
            liquiditySource: LiquiditySource.LIFI,
            marketPriceFactor: 0.95,
          },
        },
        config,
      });

      expect(oneInchDeployment.deploymentType).to.equal('calldata_aggregator');
      expect(factoryDeployment.deploymentType).to.equal('direct_dex');
      expect(lifiDeployment.deploymentType).to.equal('calldata_aggregator');
    });

    it('resolves missing requested external deployment as arb-only fallback', () => {
      const resolution = resolveManualTakeDeployment({
        poolConfig: {
          take: {
            liquiditySource: LiquiditySource.UNISWAPV3,
            marketPriceFactor: 0.95,
          },
        },
        config: {
          keeperTakerRouter: '0x1234567890123456789012345678901234567890',
        },
      });

      expectManualDeploymentType(resolution, 'none');
      expect(resolution.requestedLiquiditySource).to.equal(
        LiquiditySource.UNISWAPV3
      );
      expect(resolution.unavailableReason).to.equal(
        'takerContracts.UniswapV3 is not configured'
      );
    });
  });

  describe('Take Settings Integration', () => {
    it('validates Uniswap V3 take settings with factory config', async () => {
      const directDexConfig = {
        takers: {
          factory: '0x1234567890123456789012345678901234567890',
          contracts: {
            UniswapV3: '0x2234567890123456789012345678901234567890',
          },
        },
        dex: {
          uniswapV3: {
            router: {
              swapRouter02Address: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
              quoterV2Address: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
              poolFactoryAddress: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
              wethAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
            },
          },
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
          directDexConfig as any
        );
      }).to.not.throw();
    });

    it('validates 1inch take settings with calldata aggregator taker config', async () => {
      const oneInchConfig = {
        takers: {
          router: '0x1234567890123456789012345678901234567890',
          contracts: {
            OneInchAggregator: '0x1234567890123456789012345678901234567890',
          },
        },
        dex: {
          oneInch: {
            routers: {
              1: '0x1111111254EEB25477B68fb85Ed929f73A960582',
            },
          },
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
          oneInchConfig as any
        );
      }).to.not.throw();
    });

    it('validates LI.FI take settings with direct DEX taker config in dry run', async () => {
      const lifiConfig = {
        runtime: {
          dryRun: true,
        },
        takers: {
          factory: '0x1234567890123456789012345678901234567890',
          contracts: {
            Lifi: '0x2234567890123456789012345678901234567890',
          },
        },
        dex: {
          lifi: {
            mode: 'canary',
          },
        },
      };

      expect(() => {
        validateTakeSettings(
          {
            minCollateral: 0.1,
            liquiditySource: LiquiditySource.LIFI,
            marketPriceFactor: 0.95,
            hpbPriceFactor: 0.98,
          },
          lifiConfig as any
        );
      }).to.not.throw();
    });
  });
});
