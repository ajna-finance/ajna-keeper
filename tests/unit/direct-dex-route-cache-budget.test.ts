import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, ethers } from 'ethers';
import { CurvePoolType, LiquiditySource } from '../../src/config';
import { logger } from '../../src/logging';
import * as takeDirectDex from '../../src/take/direct-dex';
import { UniswapV3QuoteProvider } from '../../src/dex/providers/uniswap-quote-provider';
import { CurveQuoteProvider } from '../../src/dex/providers/curve-quote-provider';
import * as erc20 from '../../src/erc20';
import { ceilDiv, getMarketPriceFactorUnits } from '../../src/take/direct-dex/route-amounts';
import { applyDirectDexRouteProfitabilityPolicy } from '../../src/take/direct-dex/route-profitability';
import { filterDirectDexRouteCandidatesByAvailability } from '../../src/take/direct-dex/availability';
import {
  getDirectDexRouteCandidates,
  recordDirectDexRouteSuccess,
} from '../../src/take/direct-dex/route-candidates';
import { selectBestDirectDexRouteEvaluation } from '../../src/take/direct-dex/route-ranking';
import { MARKET_FACTOR_SCALE } from '../../src/constants';
import { RouteProbeLimiter } from '../../src/utils';

const TEST_UNISWAP_SWAP_ROUTER_02_ADDRESS =
  '0x3333333333333333333333333333333333333333';

describe('Direct DEX route cache and budget selection', () => {
  afterEach(() => {
    sinon.restore();
  });

    it('prioritizes a recent successful route over the default route when budget is one', async () => {
      sinon.stub(UniswapV3QuoteProvider.prototype, 'isAvailable').returns(true);
      sinon
        .stub(UniswapV3QuoteProvider.prototype, 'getQuoterAddress')
        .returns('0x7777777777777777777777777777777777777777');
      sinon.stub(UniswapV3QuoteProvider.prototype, 'poolExists').resolves(true);
      const uniswapQuoteStub = sinon
        .stub(UniswapV3QuoteProvider.prototype, 'getQuote')
        .callsFake(
          async (_amountIn, _tokenIn, _tokenOut, feeTier?: number) =>
            ({
              success: true,
              dstAmount:
                feeTier === 500
                  ? ethers.utils.parseUnits('119', 6)
                  : ethers.utils.parseUnits('112', 6),
            }) as any
        );
      sinon.stub(erc20, 'getDecimalsErc20').resolves(6);

      const pool = {
        name: 'Budget One Recent Route Pool',
        collateralAddress: '0x1111111111111111111111111111111111111111',
        quoteAddress: '0x2222222222222222222222222222222222222222',
        contract: {
          quoteTokenScale: sinon
            .stub()
            .resolves(BigNumber.from('1000000000000')),
        },
      };
      const runtimeCache = takeDirectDex.createDirectDexQuoteProviderRuntimeCache();
      runtimeCache.recentRouteSuccesses = new Map([
        [
          `${LiquiditySource.UNISWAPV3}:500:${pool.collateralAddress.toLowerCase()}:${pool.quoteAddress.toLowerCase()}`,
          Date.now(),
        ],
      ]);

      const evaluation = await takeDirectDex.getDirectDexTakeQuoteEvaluation(
        pool as any,
        ethers.utils.parseEther('100'),
        ethers.utils.parseEther('1'),
        {
          name: 'Budget One Recent Route Pool',
          take: {
            liquiditySource: LiquiditySource.UNISWAPV3,
            marketPriceFactor: 0.99,
          },
        } as any,
        {
          uniswapV3RouterOverrides: {
            swapRouter02Address: TEST_UNISWAP_SWAP_ROUTER_02_ADDRESS,
            poolFactoryAddress: '0x4444444444444444444444444444444444444444',
            defaultFeeTier: 3000,
            candidateFeeTiers: [500],
            wethAddress: '0x5555555555555555555555555555555555555555',
            quoterV2Address: '0x6666666666666666666666666666666666666666',
          },
        } as any,
        ethers.Wallet.createRandom().connect(
          new ethers.providers.JsonRpcProvider()
        ) as any,
        runtimeCache,
        {
          routeQuoteBudgetPerCandidate: 1,
        }
      );

      expect(evaluation.isTakeable).to.be.true;
      expect(evaluation.selectedFeeTier).to.equal(500);
      expect(uniswapQuoteStub.calledOnce).to.be.true;
      expect(uniswapQuoteStub.firstCall.args[3]).to.equal(500);
    });

    it('refreshes recent route success insertion order before LRU pruning', () => {
      const pool = {
        collateralAddress: '0x1111111111111111111111111111111111111111',
        quoteAddress: '0x2222222222222222222222222222222222222222',
      };
      const runtimeCache = takeDirectDex.createDirectDexQuoteProviderRuntimeCache();
      const routeKey = `${LiquiditySource.UNISWAPV3}:500:${pool.collateralAddress.toLowerCase()}:${pool.quoteAddress.toLowerCase()}`;
      const otherKey = `${LiquiditySource.CURVE}:500:${pool.collateralAddress.toLowerCase()}:${pool.quoteAddress.toLowerCase()}`;
      runtimeCache.recentRouteSuccesses = new Map([
        [routeKey, Date.now() - 1000],
        [otherKey, Date.now()],
      ]);

      recordDirectDexRouteSuccess({
        route: { liquiditySource: LiquiditySource.UNISWAPV3, feeTier: 500 },
        pool,
        runtimeCache,
      });

      const keys = Array.from(runtimeCache.recentRouteSuccesses.keys());
      expect(keys[keys.length - 1]).to.equal(routeKey);
    });

    it('refuses cross-source route selection without profitability context', async () => {
      sinon.stub(UniswapV3QuoteProvider.prototype, 'isAvailable').returns(true);
      sinon
        .stub(UniswapV3QuoteProvider.prototype, 'getQuoterAddress')
        .returns('0x7777777777777777777777777777777777777777');
      sinon.stub(UniswapV3QuoteProvider.prototype, 'poolExists').resolves(true);
      const uniswapQuoteStub = sinon
        .stub(UniswapV3QuoteProvider.prototype, 'getQuote')
        .resolves({
          success: true,
          dstAmount: ethers.utils.parseUnits('120', 6).toString(),
        } as any);
      sinon.stub(CurveQuoteProvider.prototype, 'initialize').resolves(true);
      sinon.stub(CurveQuoteProvider.prototype, 'poolExists').resolves(true);
      const curveQuoteStub = sinon
        .stub(CurveQuoteProvider.prototype, 'getQuote')
        .resolves({
          success: true,
          dstAmount: ethers.utils.parseUnits('121', 6),
        } as any);
      sinon.stub(erc20, 'getDecimalsErc20').resolves(6);

      const pool = {
        name: 'Missing Context Route Pool',
        collateralAddress: '0x1111111111111111111111111111111111111111',
        quoteAddress: '0x2222222222222222222222222222222222222222',
        contract: {
          quoteTokenScale: sinon
            .stub()
            .resolves(BigNumber.from('1000000000000')),
        },
      };
      const poolConfig = {
        name: 'Missing Context Route Pool',
        take: {
          liquiditySource: LiquiditySource.UNISWAPV3,
          marketPriceFactor: 0.99,
        },
      };
      const config = {
        uniswapV3RouterOverrides: {
          swapRouter02Address: TEST_UNISWAP_SWAP_ROUTER_02_ADDRESS,
          poolFactoryAddress: '0x4444444444444444444444444444444444444444',
          defaultFeeTier: 3000,
          wethAddress: '0x5555555555555555555555555555555555555555',
          quoterV2Address: '0x6666666666666666666666666666666666666666',
        },
        curveRouterOverrides: {
          poolConfigs: {
            'COLL-QUOTE': {
              address: '0xcccccccccccccccccccccccccccccccccccccccc',
              poolType: CurvePoolType.STABLE,
            },
          },
          wethAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
      };

      const evaluation = await takeDirectDex.getDirectDexTakeQuoteEvaluation(
        pool as any,
        ethers.utils.parseEther('100'),
        ethers.utils.parseEther('1'),
        poolConfig as any,
        config as any,
        ethers.Wallet.createRandom().connect(
          new ethers.providers.JsonRpcProvider()
        ) as any,
        takeDirectDex.createDirectDexQuoteProviderRuntimeCache(),
        {
          allowedLiquiditySources: [
            LiquiditySource.UNISWAPV3,
            LiquiditySource.CURVE,
          ],
        }
      );

      expect(evaluation.isTakeable).to.be.false;
      expect(evaluation.reason).to.equal(
        'route profitability context required for dynamic liquidity source selection'
      );
      expect(uniswapQuoteStub.called).to.be.false;
      expect(curveQuoteStub.called).to.be.false;
    });

    it('applies route quote budget after skipping unavailable fee tiers', async () => {
      sinon.stub(UniswapV3QuoteProvider.prototype, 'isAvailable').returns(true);
      sinon
        .stub(UniswapV3QuoteProvider.prototype, 'getQuoterAddress')
        .returns('0x7777777777777777777777777777777777777777');
      const poolExistsStub = sinon
        .stub(UniswapV3QuoteProvider.prototype, 'poolExists')
        .callsFake(
          async (_tokenA, _tokenB, feeTier?: number) => feeTier === 500
        );
      const uniswapQuoteStub = sinon
        .stub(UniswapV3QuoteProvider.prototype, 'getQuote')
        .callsFake(
          async (_amountIn, _tokenIn, _tokenOut, feeTier?: number) =>
            ({
              success: feeTier === 500,
              dstAmount: ethers.utils.parseUnits('120', 6).toString(),
            }) as any
        );
      sinon.stub(erc20, 'getDecimalsErc20').resolves(6);

      const pool = {
        name: 'Unavailable Default Fee Pool',
        collateralAddress: '0x1111111111111111111111111111111111111111',
        quoteAddress: '0x2222222222222222222222222222222222222222',
        contract: {
          quoteTokenScale: sinon
            .stub()
            .resolves(BigNumber.from('1000000000000')),
        },
      };
      const poolConfig = {
        name: 'Unavailable Default Fee Pool',
        take: {
          liquiditySource: LiquiditySource.UNISWAPV3,
          marketPriceFactor: 0.99,
        },
      };
      const config = {
        uniswapV3RouterOverrides: {
          swapRouter02Address: TEST_UNISWAP_SWAP_ROUTER_02_ADDRESS,
          poolFactoryAddress: '0x4444444444444444444444444444444444444444',
          defaultFeeTier: 3000,
          candidateFeeTiers: [500],
          wethAddress: '0x5555555555555555555555555555555555555555',
          quoterV2Address: '0x6666666666666666666666666666666666666666',
        },
      };

      const evaluation = await takeDirectDex.getDirectDexTakeQuoteEvaluation(
        pool as any,
        ethers.utils.parseEther('100'),
        ethers.utils.parseEther('1'),
        poolConfig as any,
        config as any,
        ethers.Wallet.createRandom().connect(
          new ethers.providers.JsonRpcProvider()
        ) as any,
        takeDirectDex.createDirectDexQuoteProviderRuntimeCache(),
        {
          routeQuoteBudgetPerCandidate: 1,
        }
      );

      expect(evaluation.isTakeable).to.be.true;
      expect(evaluation.selectedFeeTier).to.equal(500);
      expect(poolExistsStub.calledTwice).to.be.true;
      expect(uniswapQuoteStub.calledOnce).to.be.true;
      expect(uniswapQuoteStub.firstCall.args[3]).to.equal(500);
    });

    it('allows configured Curve routes to participate in dynamic source selection', async () => {
      sinon.stub(UniswapV3QuoteProvider.prototype, 'isAvailable').returns(true);
      sinon
        .stub(UniswapV3QuoteProvider.prototype, 'getQuoterAddress')
        .returns('0x7777777777777777777777777777777777777777');
      sinon.stub(UniswapV3QuoteProvider.prototype, 'poolExists').resolves(true);
      sinon.stub(UniswapV3QuoteProvider.prototype, 'getQuote').resolves({
        success: true,
        dstAmount: ethers.utils.parseUnits('110', 6).toString(),
      } as any);
      sinon.stub(CurveQuoteProvider.prototype, 'initialize').resolves(true);
      sinon.stub(CurveQuoteProvider.prototype, 'poolExists').resolves(true);
      const selectedCurvePool = {
        address: '0xcccccccccccccccccccccccccccccccccccccccc',
        poolType: CurvePoolType.STABLE,
        tokenInIndex: 1,
        tokenOutIndex: 0,
      };
      const curveQuoteStub = sinon
        .stub(CurveQuoteProvider.prototype, 'getQuote')
        .resolves({
          success: true,
          dstAmount: ethers.utils.parseUnits('120', 6),
          selectedPool: selectedCurvePool,
        } as any);
      sinon.stub(erc20, 'getDecimalsErc20').resolves(6);

      const pool = {
        name: 'Dynamic Curve Route Pool',
        collateralAddress: '0x1111111111111111111111111111111111111111',
        quoteAddress: '0x2222222222222222222222222222222222222222',
        contract: {
          quoteTokenScale: sinon
            .stub()
            .resolves(BigNumber.from('1000000000000')),
        },
      };
      const poolConfig = {
        name: 'Dynamic Curve Route Pool',
        take: {
          liquiditySource: LiquiditySource.UNISWAPV3,
          marketPriceFactor: 0.99,
        },
      };
      const config = {
        uniswapV3RouterOverrides: {
          swapRouter02Address: TEST_UNISWAP_SWAP_ROUTER_02_ADDRESS,
          poolFactoryAddress: '0x4444444444444444444444444444444444444444',
          defaultFeeTier: 3000,
          wethAddress: '0x5555555555555555555555555555555555555555',
          quoterV2Address: '0x6666666666666666666666666666666666666666',
        },
        curveRouterOverrides: {
          poolConfigs: {
            'COLLATERAL-QUOTE': {
              address: selectedCurvePool.address,
              poolType: CurvePoolType.STABLE,
            },
          },
          defaultSlippage: 0.5,
          wethAddress: '0x8888888888888888888888888888888888888888',
        },
        tokenAddresses: {
          COLLATERAL: '0x1111111111111111111111111111111111111111',
          QUOTE: '0x2222222222222222222222222222222222222222',
        },
      };

      const evaluation = await takeDirectDex.getDirectDexTakeQuoteEvaluation(
        pool as any,
        ethers.utils.parseEther('100'),
        ethers.utils.parseEther('1'),
        poolConfig as any,
        config as any,
        ethers.Wallet.createRandom().connect(
          new ethers.providers.JsonRpcProvider()
        ) as any,
        takeDirectDex.createDirectDexQuoteProviderRuntimeCache(),
        {
          allowedLiquiditySources: [LiquiditySource.CURVE],
          routeProfitabilityContext: {
            routeExecutionCostQuoteRawBySource: {
              [LiquiditySource.UNISWAPV3]: ethers.utils.parseUnits('1', 6),
              [LiquiditySource.CURVE]: ethers.utils.parseUnits('3', 6),
            },
            configuredProfitFloorQuoteRaw: ethers.utils.parseUnits('2', 6),
          },
        }
      );

      expect(evaluation.isTakeable).to.be.true;
      expect(evaluation.selectedLiquiditySource).to.equal(
        LiquiditySource.CURVE
      );
      expect(evaluation.curvePool).to.deep.equal(selectedCurvePool);
      expect(curveQuoteStub.calledOnce).to.be.true;
      expect(
        evaluation.routeProfitability?.expectedNetProfitQuoteRaw?.eq(
          ethers.utils.parseUnits('17', 6)
        )
      ).to.be.true;
    });
});
