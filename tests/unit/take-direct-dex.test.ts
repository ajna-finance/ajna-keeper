import { expect } from 'chai';
import sinon from 'sinon';
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
  });

  describe('Parameter Validation and Error Handling', () => {
    it('should validate Uniswap configuration completeness', () => {
      const missingConfig = makeUniswapTakeConfig();

      expect(() => validateTakeSettingsForChain(missingConfig, 8453)).to.throw(
        'TakeSettings: dex.uniswapV3.router required when liquiditySource is UNISWAPV3'
      );
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
});
