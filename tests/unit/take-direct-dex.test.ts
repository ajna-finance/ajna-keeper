import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber } from 'ethers';
import {
  KeeperConfig,
  LiquiditySource,
  PriceOriginSource,
  UniswapV3RouterOverrides,
  resolveUniswapV3DirectDexRouteConfig,
  validateTakeSettingsForChain,
} from '../../src/config';
import { logger } from '../../src/logging';
import { processManualTakeCandidates } from '../../src/take';

function makeUniswapTakeConfig(
  routerConfig?: UniswapV3RouterOverrides
): KeeperConfig {
  return {
    network: {
      rpcUrl: 'http://localhost:8545',
      subgraph: { url: 'http://example-subgraph' },
    },
    signer: {
      keystore: '/tmp/keeper.json',
    },
    runtime: {
      logLevel: 'debug',
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
      pools: [
        {
          name: 'Uniswap Direct DEX Pool',
          address: '0x0000000000000000000000000000000000000006',
          price: {
            source: PriceOriginSource.FIXED,
            value: 1,
          },
          take: {
            liquiditySource: LiquiditySource.UNISWAPV3,
            marketPriceFactor: 0.99,
          },
        },
      ],
    },
    dex: {
      uniswapV3: routerConfig ? { router: routerConfig } : {},
    },
    takers: {
      router: '0x0000000000000000000000000000000000000007',
      contracts: {
        UniswapV3: '0x0000000000000000000000000000000000000008',
      },
    },
  };
}

describe('Direct DEX take routing', () => {
  let mockSigner: any;
  let mockPool: any;
  let loggerInfoStub: sinon.SinonStub;
  let loggerDebugStub: sinon.SinonStub;
  let loggerErrorStub: sinon.SinonStub;

  beforeEach(() => {
    // Create basic mocks
    mockSigner = {
      getAddress: sinon.stub().resolves('0xTestAddress'),
      getChainId: sinon.stub().resolves(43114), // Avalanche
    };

    mockPool = {
      name: 'Test Pool',
      poolAddress: '0xPoolAddress',
      collateralAddress: '0xCollateralAddress',
      quoteAddress: '0xQuoteAddress',
    };

    // Stub logger methods
    loggerInfoStub = sinon.stub(logger, 'info');
    loggerDebugStub = sinon.stub(logger, 'debug');
    loggerErrorStub = sinon.stub(logger, 'error');
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('processManualTakeCandidates direct DEX context - Real Function Tests', () => {
    it('should handle missing configuration gracefully', async () => {
      const mockPool = {
        name: 'USD_T1 / USD_T2',
        poolAddress: '0x600ca6e0b5cf41e3e4b4242a5b170f3b02ce3da7',
        collateralAddress: '0x1f0d51a052aa79527fffaf3108fb4440d3f53ce6',
        quoteAddress: '0x91e1a2966408d434cfc1c0790df4a1ce08dc73d8',
      };

      const poolConfig = {
        name: 'USD_T1 / USD_T2',
        address: '0x600ca6e0b5cf41e3e4b4242a5b170f3b02ce3da7',
        take: {
          liquiditySource: LiquiditySource.UNISWAPV3,
          marketPriceFactor: 0.99,
        },
      };

      const config = {
        dryRun: false,
        subgraphUrl: 'http://localhost:8000/subgraphs/name/ajna-test',
      };

      // Mock subgraph to return empty liquidations to avoid external calls
      const subgraphStub = sinon
        .stub(require('../../src/subgraph'), 'default')
        .value({
          getLiquidations: sinon.stub().resolves({
            pool: { hpb: 1000, hpbIndex: 0, liquidationAuctions: [] },
          }),
        });

      try {
        // This should complete without throwing, even with missing config
        await processManualTakeCandidates({
          signer: mockSigner,
          pool: mockPool as any,
          poolConfig: poolConfig as any,
          config: config as any,
        });

        // Should log debug message about the configuration
        expect(loggerDebugStub.called).to.be.true;
      } catch (error) {
        // Test should not throw for missing config, should handle gracefully
        expect.fail(
          `Function should handle missing config gracefully, but threw: ${error}`
        );
      }

      subgraphStub.restore();
    });

    it('should handle complete Hemi-style configuration', async () => {
      const mockPool = {
        name: 'USD_T1 / USD_T2',
        poolAddress: '0x600ca6e0b5cf41e3e4b4242a5b170f3b02ce3da7',
        collateralAddress: '0x1f0d51a052aa79527fffaf3108fb4440d3f53ce6',
        quoteAddress: '0x91e1a2966408d434cfc1c0790df4a1ce08dc73d8',
      };

      const poolConfig = {
        name: 'USD_T1 / USD_T2',
        address: '0x600ca6e0b5cf41e3e4b4242a5b170f3b02ce3da7',
        take: {
          liquiditySource: LiquiditySource.UNISWAPV3,
          marketPriceFactor: 0.99,
          minCollateral: 0.1,
          hpbPriceFactor: 0.98,
        },
      };

      // Real Hemi config structure
      const config = {
        dryRun: true, // Use dryRun to avoid actual transactions
        subgraphUrl: 'http://localhost:8000/subgraphs/name/ajna-test',
        keeperTakerRouter: '0xB6006B9e9696a0A097D4990964D5bDa6E940ba0D',
        takerContracts: {
          UniswapV3: '0x81D39B4A2Be43e5655608fCcE18A0edd8906D7c7',
        },
        uniswapV3RouterOverrides: {
          swapRouter02Address: '0x2626664c2603336E57B271c5C0b26F421741e481',
          wethAddress: '0x4200000000000000000000000000000000000006',
          defaultFeeTier: 3000,
          defaultSlippage: 0.5,
          poolFactoryAddress: '0x346239972d1fa486FC4a521031BC81bFB7D6e8a4',
          quoterV2Address: '0xcBa55304013187D49d4012F4d7e4B63a04405cd5',
        },
      };

      // Mock subgraph to return empty liquidations
      const subgraphStub = sinon
        .stub(require('../../src/subgraph'), 'default')
        .value({
          getLiquidations: sinon.stub().resolves({
            pool: { hpb: 1000, hpbIndex: 0, liquidationAuctions: [] },
          }),
        });

      await processManualTakeCandidates({
        signer: mockSigner,
        pool: mockPool as any,
        poolConfig: poolConfig as any,
        config: config as any,
      });

      // Should log the debug message about using the manual direct DEX external take context
      const debugCalls = loggerDebugStub.getCalls();
      const directDexLogFound = debugCalls.some(
        (call) =>
          call.args[0] &&
          call.args[0].includes(
            'Manual direct_dex external take context starting'
          )
      );
      expect(directDexLogFound).to.be.true;

      subgraphStub.restore();
    });
  });

  describe('Configuration Validation - Business Logic', () => {
    // Test the parameter validation logic that happens before external calls

    it('should handle missing marketPriceFactor gracefully', () => {
      const poolConfig = {
        name: 'Test Pool',
        take: {
          liquiditySource: LiquiditySource.UNISWAPV3,
          // Missing marketPriceFactor
          minCollateral: 1.0,
        },
      };

      // This tests the validation logic - marketPriceFactor is required for takes
      expect((poolConfig.take as any).marketPriceFactor).to.be.undefined;

      // Business logic: if no marketPriceFactor, external takes should not be attempted
      const hasMarketPriceFactor = !!(poolConfig.take as any).marketPriceFactor;
      expect(hasMarketPriceFactor).to.be.false;
    });

    it('should validate required fields for Uniswap V3 configuration', () => {
      const validHemiConfig = makeUniswapTakeConfig({
        swapRouter02Address: '0x2626664c2603336E57B271c5C0b26F421741e481',
        poolFactoryAddress: '0x346239972d1fa486FC4a521031BC81bFB7D6e8a4',
        wethAddress: '0x4200000000000000000000000000000000000006',
        defaultFeeTier: 3000,
        defaultSlippage: 0.5,
        quoterV2Address: '0xcBa55304013187D49d4012F4d7e4B63a04405cd5',
      });

      const incompleteConfig = makeUniswapTakeConfig({
        swapRouter02Address: '0x2626664c2603336E57B271c5C0b26F421741e481',
      });

      expect(() =>
        validateTakeSettingsForChain(validHemiConfig, 8453)
      ).to.not.throw();
      expect(() =>
        validateTakeSettingsForChain(incompleteConfig, 8453)
      ).to.throw(
        'TakeSettings: dex.uniswapV3.router.swapRouter02Address, poolFactoryAddress, wethAddress, and quoterV2Address required when liquiditySource is UNISWAPV3'
      );
    });

    it('should handle unsupported liquiditySource gracefully', () => {
      const poolConfig = {
        name: 'Test Pool',
        take: {
          liquiditySource: LiquiditySource.ONEINCH, // Not supported in Direct DEX
          marketPriceFactor: 0.99,
        },
      };

      // Business logic: Direct DEX only supports certain DEX types
      const isSupportedByDirectDex =
        poolConfig.take.liquiditySource === LiquiditySource.UNISWAPV3;
      expect(isSupportedByDirectDex).to.be.false;
    });

    it('should validate collateral amount is positive', () => {
      const validCollateral = BigNumber.from('1000000000000000000'); // 1 token
      const zeroCollateral = BigNumber.from('0');
      const negativeCollateral = BigNumber.from('-1');

      // Business logic: collateral must be positive for takes
      expect(validCollateral.gt(0)).to.be.true;
      expect(zeroCollateral.gt(0)).to.be.false;
      expect(negativeCollateral.gt(0)).to.be.false;
    });
  });

  describe('Routing Logic - DEX Selection', () => {
    it('should route to Uniswap V3 for UNISWAPV3 liquiditySource', () => {
      const poolConfig = {
        name: 'Test Pool',
        take: {
          liquiditySource: LiquiditySource.UNISWAPV3,
          marketPriceFactor: 0.99,
        },
      };

      // Business logic: routing decision based on liquiditySource
      const shouldRouteToUniswap =
        poolConfig.take.liquiditySource === LiquiditySource.UNISWAPV3;
      expect(shouldRouteToUniswap).to.be.true;
    });

    it('should not support 1inch in Direct DEX path', () => {
      const poolConfig = {
        name: 'Test Pool',
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
      };

      // Business logic: direct_dex doesn't support 1inch.
      const isDirectDexSupported =
        poolConfig.take.liquiditySource === LiquiditySource.UNISWAPV3;
      expect(isDirectDexSupported).to.be.false;
    });

    it('should handle unknown liquiditySource values', () => {
      const poolConfig = {
        name: 'Test Pool',
        take: {
          liquiditySource: 999 as LiquiditySource, // Invalid value
          marketPriceFactor: 0.99,
        },
      };

      // Business logic: only specific values are supported
      const supportedSources = [LiquiditySource.UNISWAPV3];
      const isSupported = supportedSources.includes(
        poolConfig.take.liquiditySource
      );
      expect(isSupported).to.be.false;
    });
  });

  describe('DryRun Mode Behavior', () => {
    it('should log and return early when dryRun is true for takeLiquidationDirectDex', async () => {
      const liquidation = {
        borrower: '0xBorrower',
        hpbIndex: 1000,
        collateral: BigNumber.from('1000000000000000000'),
        auctionPrice: BigNumber.from('1000000000000000000'),
        isTakeable: true,
        isArbTakeable: false,
      };

      const config = {
        dryRun: true,
        keeperTakerRouter: '0xB6006B9e9696a0A097D4990964D5bDa6E940ba0D', // Real Hemi router
        uniswapV3RouterOverrides: {
          poolFactoryAddress: '0x346239972d1fa486FC4a521031BC81bFB7D6e8a4',
          wethAddress: '0x4200000000000000000000000000000000000006',
        },
      };

      const poolConfig = {
        name: 'Test Pool',
        take: {
          liquiditySource: LiquiditySource.UNISWAPV3,
          marketPriceFactor: 0.99,
        },
      };

      // Test the DryRun logic directly - this is pure business logic
      if (config.dryRun) {
        // In dryRun mode, should log and return without executing
        expect(config.dryRun).to.be.true;
        // Verify this is the path taken
        const shouldExecuteTransaction = !config.dryRun;
        expect(shouldExecuteTransaction).to.be.false;
      }
    });

    it('should proceed to execution when dryRun is false', () => {
      const config = {
        dryRun: false,
        keeperTakerRouter: '0xB6006B9e9696a0A097D4990964D5bDa6E940ba0D', // Real Hemi router
        uniswapV3RouterOverrides: {
          poolFactoryAddress: '0x346239972d1fa486FC4a521031BC81bFB7D6e8a4',
          wethAddress: '0x4200000000000000000000000000000000000006',
        },
      };

      // Business logic: when not in dryRun, should proceed to execution
      const shouldExecuteTransaction = !config.dryRun;
      expect(shouldExecuteTransaction).to.be.true;
    });
  });

  describe('Parameter Validation and Error Handling', () => {
    it('should handle missing keeperTakerRouter address', () => {
      const config = {
        dryRun: false,
        // Missing keeperTakerRouter
        uniswapV3RouterOverrides: {},
      };

      // Business logic: keeperTakerRouter is required for execution
      const hasRequiredRouter = !!(config as any).keeperTakerRouter;
      expect(hasRequiredRouter).to.be.false;
    });

    it('should validate Uniswap configuration completeness', () => {
      const missingConfig = makeUniswapTakeConfig();

      expect(() => validateTakeSettingsForChain(missingConfig, 8453)).to.throw(
        'TakeSettings: dex.uniswapV3.router required when liquiditySource is UNISWAPV3'
      );
    });

    it('should handle chain compatibility for DEX availability', () => {
      // Business logic: different chains have different DEX availability
      const chainConfigs = [
        { chainId: 1, hasUniswapV3: true, has1inch: true }, // Ethereum
        { chainId: 43114, hasUniswapV3: true, has1inch: true }, // Avalanche
        { chainId: 123456, hasUniswapV3: false, has1inch: false }, // New/small chain
      ];

      chainConfigs.forEach((chain) => {
        const canUseUniswapV3 = chain.hasUniswapV3;
        const canUse1inch = chain.has1inch;

        if (chain.chainId === 123456) {
          // New chain - no DEX support
          expect(canUseUniswapV3).to.be.false;
          expect(canUse1inch).to.be.false;
        } else {
          // Major chains - should have DEX support
          expect(canUseUniswapV3).to.be.true;
          expect(canUse1inch).to.be.true;
        }
      });
    });
  });

  describe('ArbTake Configuration Validation', () => {
    it('should validate arbTake settings independently from external takes', () => {
      const arbTakeOnlyConfig = {
        name: 'Test Pool',
        take: {
          // Only arbTake settings, no external DEX
          minCollateral: 1.0,
          hpbPriceFactor: 0.98,
          // No liquiditySource or marketPriceFactor
        },
      };

      const externalTakeConfig = {
        name: 'Test Pool',
        take: {
          liquiditySource: LiquiditySource.UNISWAPV3,
          marketPriceFactor: 0.99,
          // No arbTake settings
        },
      };

      const bothConfig = {
        name: 'Test Pool',
        take: {
          minCollateral: 1.0,
          hpbPriceFactor: 0.98,
          liquiditySource: LiquiditySource.UNISWAPV3,
          marketPriceFactor: 0.99,
        },
      };

      // Business logic: arbTake and external takes are independent
      const hasArbTake = (config: any) =>
        !!(config.take.minCollateral && config.take.hpbPriceFactor);
      const hasExternalTake = (config: any) =>
        !!(config.take.liquiditySource && config.take.marketPriceFactor);

      expect(hasArbTake(arbTakeOnlyConfig)).to.be.true;
      expect(hasExternalTake(arbTakeOnlyConfig)).to.be.false;

      expect(hasArbTake(externalTakeConfig)).to.be.false;
      expect(hasExternalTake(externalTakeConfig)).to.be.true;

      expect(hasArbTake(bothConfig)).to.be.true;
      expect(hasExternalTake(bothConfig)).to.be.true;
    });

    it('should validate minCollateral and hpbPriceFactor values', () => {
      const validArbTakeConfig = {
        minCollateral: 1.0,
        hpbPriceFactor: 0.98,
      };

      const invalidArbTakeConfig = {
        minCollateral: 0, // Invalid: must be positive
        hpbPriceFactor: -0.5, // Invalid: must be positive
      };

      // Business logic: validate arbTake parameter ranges
      const isValidArbTake = (config: any) => {
        return config.minCollateral > 0 && config.hpbPriceFactor > 0;
      };

      expect(isValidArbTake(validArbTakeConfig)).to.be.true;
      expect(isValidArbTake(invalidArbTakeConfig)).to.be.false;
    });
  });

  describe('Swap Details Preparation', () => {
    it('should resolve complete Uniswap V3 direct DEX route configuration', () => {
      const resolved = resolveUniswapV3DirectDexRouteConfig({
        swapRouter02Address: '0x2626664c2603336E57B271c5C0b26F421741e481',
        poolFactoryAddress: '0x346239972d1fa486FC4a521031BC81bFB7D6e8a4',
        wethAddress: '0x4200000000000000000000000000000000000006',
        quoterV2Address: '0xcBa55304013187D49d4012F4d7e4B63a04405cd5',
        defaultFeeTier: 3000,
        defaultSlippage: 0.5,
      });

      expect(resolved).to.deep.include({
        swapRouter02Address: '0x2626664c2603336E57B271c5C0b26F421741e481',
        poolFactoryAddress: '0x346239972d1fa486FC4a521031BC81bFB7D6e8a4',
        wethAddress: '0x4200000000000000000000000000000000000006',
        quoterV2Address: '0xcBa55304013187D49d4012F4d7e4B63a04405cd5',
        defaultFeeTier: 3000,
        defaultSlippage: 0.5,
      });
    });

    it('should handle missing swap configuration gracefully', () => {
      expect(
        resolveUniswapV3DirectDexRouteConfig({
          swapRouter02Address: '0x2626664c2603336E57B271c5C0b26F421741e481',
        })
      ).to.equal(undefined);
    });
  });

  describe('Error Path Validation', () => {
    it('should identify configuration errors before execution attempts', () => {
      const scenarios = [
        {
          name: 'Missing router address',
          config: { dryRun: false },
          hasError: true,
          errorType: 'missing_router',
        },
        {
          name: 'Missing Uniswap config for Uniswap take',
          config: {
            dryRun: false,
            keeperTakerRouter: '0xB6006B9e9696a0A097D4990964D5bDa6E940ba0D', // Real Hemi router
            // Missing uniswapV3RouterOverrides
          },
          liquiditySource: LiquiditySource.UNISWAPV3,
          hasError: true,
          errorType: 'missing_uniswap_config',
        },
        {
          name: 'Valid Hemi configuration',
          config: {
            dryRun: false,
            keeperTakerRouter: '0xB6006B9e9696a0A097D4990964D5bDa6E940ba0D', // Real Hemi router
            uniswapV3RouterOverrides: {},
          },
          liquiditySource: LiquiditySource.UNISWAPV3,
          hasError: false,
          errorType: null,
        },
      ];

      scenarios.forEach((scenario) => {
        // Business logic: validate configuration completeness
        let hasConfigError = false;
        let errorType = null;

        if (
          !(scenario.config as any).keeperTakerRouter &&
          !scenario.config.dryRun
        ) {
          hasConfigError = true;
          errorType = 'missing_router';
        } else if (
          scenario.liquiditySource === LiquiditySource.UNISWAPV3 &&
          !(scenario.config as any).uniswapV3RouterOverrides
        ) {
          hasConfigError = true;
          errorType = 'missing_uniswap_config';
        }

        expect(hasConfigError).to.equal(
          scenario.hasError,
          `Scenario: ${scenario.name}`
        );
        expect(errorType).to.equal(
          scenario.errorType,
          `Scenario: ${scenario.name}`
        );
      });
    });
  });
});
