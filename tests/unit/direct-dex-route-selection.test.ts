import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, ethers } from 'ethers';
import { CurvePoolType, LiquiditySource } from '../../src/config';
import { logger } from '../../src/logging';
import * as takeDirectDex from '../../src/take/direct-dex';
import { UniswapV3QuoteProvider } from '../../src/dex/providers/uniswap-quote-provider';
import { CurveQuoteProvider } from '../../src/dex/providers/curve-quote-provider';
import * as erc20 from '../../src/erc20';
import {
  applyDirectDexRouteProfitabilityPolicy,
  ceilDiv,
  filterDirectDexRouteCandidatesByAvailability,
  getDirectDexRouteCandidates,
  getMarketPriceFactorUnits,
  recordDirectDexRouteSuccess,
  selectBestDirectDexRouteEvaluation,
  MARKET_FACTOR_SCALE,
} from '../../src/take/direct-dex/route-selection';
import { RouteProbeLimiter } from '../../src/utils';

const TEST_UNISWAP_SWAP_ROUTER_02_ADDRESS =
  '0x3333333333333333333333333333333333333333';

describe('Direct DEX route selection orchestration', () => {
  afterEach(() => {
    sinon.restore();
  });

    it('ranks viable Uni/Curve routes by gas-adjusted net profit and keeps the selected fee tier', async () => {
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
      sinon.stub(CurveQuoteProvider.prototype, 'initialize').resolves(true);
      sinon.stub(CurveQuoteProvider.prototype, 'poolExists').resolves(true);
      const curveQuoteStub = sinon
        .stub(CurveQuoteProvider.prototype, 'getQuote')
        .resolves({
          success: true,
          dstAmount: ethers.utils.parseUnits('120', 6),
        } as any);
      const decimalsStub = sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
      const quoteTokenScaleStub = sinon
        .stub()
        .resolves(BigNumber.from('1000000000000'));

      const pool = {
        name: 'Dynamic Route Pool',
        collateralAddress: '0x1111111111111111111111111111111111111111',
        quoteAddress: '0x2222222222222222222222222222222222222222',
        contract: {
          quoteTokenScale: quoteTokenScaleStub,
        },
      };
      const poolConfig = {
        name: 'Dynamic Route Pool',
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
      const runtimeCache = takeDirectDex.createDirectDexQuoteProviderRuntimeCache();
      runtimeCache.chainId = 8453;

      const evaluation = await takeDirectDex.getDirectDexTakeQuoteEvaluation(
        pool as any,
        ethers.utils.parseEther('100'),
        ethers.utils.parseEther('1'),
        poolConfig as any,
        config as any,
        ethers.Wallet.createRandom().connect(
          new ethers.providers.JsonRpcProvider()
        ) as any,
        runtimeCache,
        {
          allowedLiquiditySources: [
            LiquiditySource.UNISWAPV3,
            LiquiditySource.CURVE,
          ],
          routeProfitabilityContext: {
            routeExecutionCostQuoteRawBySource: {
              [LiquiditySource.UNISWAPV3]: ethers.utils.parseUnits('1', 6),
              [LiquiditySource.CURVE]: ethers.utils.parseUnits('5', 6),
            },
            configuredProfitFloorQuoteRaw: ethers.utils.parseUnits('2', 6),
          },
        }
      );

      expect(evaluation.isTakeable).to.be.true;
      expect(evaluation.selectedLiquiditySource).to.equal(
        LiquiditySource.UNISWAPV3
      );
      expect(evaluation.selectedFeeTier).to.equal(500);
      expect(
        evaluation.approvedMinOutRaw?.eq(ethers.utils.parseUnits('117.81', 6))
      ).to.be.true;
      expect(
        evaluation.routeProfitability?.surplusOverFloorQuoteRaw?.eq(
          ethers.utils.parseUnits('16', 6)
        )
      ).to.be.true;
      expect(uniswapQuoteStub.calledTwice).to.be.true;
      expect(curveQuoteStub.calledOnce).to.be.true;
      expect(decimalsStub.calledTwice).to.be.true;
      expect(quoteTokenScaleStub.calledOnce).to.be.true;
      expect(runtimeCache.recentRouteSuccesses).to.equal(undefined);
    });

    it('rejects routes with gas conversion failures instead of ranking them with zero gas', async () => {
      sinon.stub(UniswapV3QuoteProvider.prototype, 'isAvailable').returns(true);
      sinon
        .stub(UniswapV3QuoteProvider.prototype, 'getQuoterAddress')
        .returns('0x7777777777777777777777777777777777777777');
      const uniswapPoolExistsStub = sinon
        .stub(UniswapV3QuoteProvider.prototype, 'poolExists')
        .resolves(true);
      const uniswapQuoteStub = sinon
        .stub(UniswapV3QuoteProvider.prototype, 'getQuote')
        .resolves({
          success: true,
          dstAmount: ethers.utils.parseUnits('500', 6),
        } as any);
      sinon.stub(CurveQuoteProvider.prototype, 'initialize').resolves(true);
      sinon.stub(CurveQuoteProvider.prototype, 'poolExists').resolves(true);
      const curveQuoteStub = sinon
        .stub(CurveQuoteProvider.prototype, 'getQuote')
        .resolves({
          success: true,
          dstAmount: ethers.utils.parseUnits('115', 6),
        } as any);
      sinon.stub(erc20, 'getDecimalsErc20').resolves(6);

      const pool = {
        name: 'Gas Conversion Rejection Pool',
        collateralAddress: '0x1111111111111111111111111111111111111111',
        quoteAddress: '0x2222222222222222222222222222222222222222',
        contract: {
          quoteTokenScale: sinon
            .stub()
            .resolves(BigNumber.from('1000000000000')),
        },
      };
      const poolConfig = {
        name: 'Gas Conversion Rejection Pool',
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
      const runtimeCache = takeDirectDex.createDirectDexQuoteProviderRuntimeCache();
      runtimeCache.chainId = 8453;

      const evaluation = await takeDirectDex.getDirectDexTakeQuoteEvaluation(
        pool as any,
        ethers.utils.parseEther('100'),
        ethers.utils.parseEther('1'),
        poolConfig as any,
        config as any,
        ethers.Wallet.createRandom().connect(
          new ethers.providers.JsonRpcProvider()
        ) as any,
        runtimeCache,
        {
          allowedLiquiditySources: [
            LiquiditySource.UNISWAPV3,
            LiquiditySource.CURVE,
          ],
          routeProfitabilityContext: {
            routeRejectionReasonsBySource: {
              [LiquiditySource.UNISWAPV3]:
                'failed to quote gas cost into quote token',
            },
            routeExecutionCostQuoteRawBySource: {
              [LiquiditySource.CURVE]: ethers.utils.parseUnits('1', 6),
            },
          },
        }
      );

      expect(evaluation.isTakeable).to.be.true;
      expect(evaluation.selectedLiquiditySource).to.equal(
        LiquiditySource.CURVE
      );
      // Curve routes carry no fee tier.
      expect(evaluation.selectedFeeTier).to.equal(undefined);
      expect(
        evaluation.routeProfitability?.routeExecutionCostQuoteRaw?.eq(
          ethers.utils.parseUnits('1', 6)
        )
      ).to.be.true;
      expect(uniswapPoolExistsStub.called).to.be.false;
      expect(uniswapQuoteStub.called).to.be.false;
      expect(curveQuoteStub.calledOnce).to.be.true;
    });

    it('propagates structured gas-conversion rejection metadata when every direct DEX route is gas-rejected', async () => {
      sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
      const pool = {
        name: 'All Gas Rejected Pool',
        collateralAddress: '0x1111111111111111111111111111111111111111',
        quoteAddress: '0x2222222222222222222222222222222222222222',
        contract: {
          quoteTokenScale: sinon
            .stub()
            .resolves(BigNumber.from('1000000000000')),
        },
      };
      const poolConfig = {
        name: 'All Gas Rejected Pool',
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
      };
      const gasQuoteAttempts = [
        {
          source: LiquiditySource.UNISWAPV3,
          tokenIn: '0x5555555555555555555555555555555555555555',
          tokenOut: pool.quoteAddress,
          amountIn: '123',
          feeTiers: [3000, 100, 500, 10000],
          success: false,
          reason: 'no direct DEX pool at configured fee tiers',
        },
      ];

      const runtimeCache = takeDirectDex.createDirectDexQuoteProviderRuntimeCache();
      runtimeCache.chainId = 8453;

      const evaluation = await takeDirectDex.getDirectDexTakeQuoteEvaluation(
        pool as any,
        ethers.utils.parseEther('100'),
        ethers.utils.parseEther('1'),
        poolConfig as any,
        config as any,
        {
          provider: {},
          getChainId: sinon.stub().resolves(8453),
        } as any,
        runtimeCache,
        {
          allowedLiquiditySources: [LiquiditySource.UNISWAPV3],
          routeProfitabilityContext: {
            routeRejectionReasonsBySource: {
              [LiquiditySource.UNISWAPV3]:
                'failed to quote gas cost into quote token',
            },
            gasPolicyRejectCodeBySource: {
              [LiquiditySource.UNISWAPV3]:
                'native_to_quote_conversion_unavailable',
            },
            gasQuoteAttemptsBySource: {
              [LiquiditySource.UNISWAPV3]: gasQuoteAttempts,
            },
          },
        }
      );

      expect(evaluation.isTakeable).to.equal(false);
      expect(evaluation.reason).to.include(
        'failed to quote gas cost into quote token'
      );
      expect(evaluation.routeProfitability?.gasPolicyRejectCode).to.equal(
        'native_to_quote_conversion_unavailable'
      );
      expect(evaluation.routeProfitability?.gasQuoteAttempts).to.deep.equal(
        gasQuoteAttempts
      );
    });

    it('builds lazy route profitability only for available direct DEX sources', async () => {
      sinon.stub(UniswapV3QuoteProvider.prototype, 'isAvailable').returns(true);
      sinon
        .stub(UniswapV3QuoteProvider.prototype, 'getQuoterAddress')
        .returns('0x7777777777777777777777777777777777777777');
      sinon.stub(UniswapV3QuoteProvider.prototype, 'poolExists').resolves(true);
      sinon.stub(UniswapV3QuoteProvider.prototype, 'getQuote').resolves({
        success: true,
        dstAmount: ethers.utils.parseUnits('120', 6),
      } as any);
      sinon.stub(CurveQuoteProvider.prototype, 'initialize').resolves(true);
      sinon.stub(CurveQuoteProvider.prototype, 'poolExists').resolves(false);
      const curveQuoteStub = sinon.stub(
        CurveQuoteProvider.prototype,
        'getQuote'
      );
      sinon.stub(erc20, 'getDecimalsErc20').resolves(6);

      const contextBuilder = sinon.stub().resolves({
        routeExecutionCostQuoteRawBySource: {
          [LiquiditySource.UNISWAPV3]: ethers.utils.parseUnits('1', 6),
        },
        configuredProfitFloorQuoteRaw: ethers.utils.parseUnits('0', 6),
      });

      const evaluation = await takeDirectDex.getDirectDexTakeQuoteEvaluation(
        {
          name: 'Lazy Context Pool',
          collateralAddress: '0x1111111111111111111111111111111111111111',
          quoteAddress: '0x2222222222222222222222222222222222222222',
          contract: {
            quoteTokenScale: sinon
              .stub()
              .resolves(BigNumber.from('1000000000000')),
          },
        } as any,
        ethers.utils.parseEther('100'),
        ethers.utils.parseEther('1'),
        {
          name: 'Lazy Context Pool',
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
        } as any,
        ethers.Wallet.createRandom().connect(
          new ethers.providers.JsonRpcProvider()
        ) as any,
        takeDirectDex.createDirectDexQuoteProviderRuntimeCache(),
        {
          allowedLiquiditySources: [
            LiquiditySource.UNISWAPV3,
            LiquiditySource.CURVE,
          ],
          routeProfitabilityContextBuilder: contextBuilder,
        }
      );

      expect(evaluation.isTakeable).to.be.true;
      expect(evaluation.selectedLiquiditySource).to.equal(
        LiquiditySource.UNISWAPV3
      );
      expect(contextBuilder.calledOnceWithExactly([LiquiditySource.UNISWAPV3]))
        .to.be.true;
      expect(curveQuoteStub.called).to.be.false;
    });

    it('checks route availability with bounded parallelism while preserving route order', async () => {
      sinon.stub(UniswapV3QuoteProvider.prototype, 'isAvailable').returns(true);
      let inFlight = 0;
      let maxInFlight = 0;
      const poolExistsStub = sinon
        .stub(UniswapV3QuoteProvider.prototype, 'poolExists')
        .callsFake(async (_tokenA, _tokenB, feeTier?: number) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          const delayMs =
            feeTier === 3000
              ? 20
              : feeTier === 500
                ? 5
                : feeTier === 100
                  ? 1
                  : 2;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          inFlight -= 1;
          return feeTier !== 3000;
        });

      const routes = [
        { liquiditySource: LiquiditySource.UNISWAPV3, feeTier: 3000 },
        { liquiditySource: LiquiditySource.UNISWAPV3, feeTier: 500 },
        { liquiditySource: LiquiditySource.UNISWAPV3, feeTier: 100 },
        { liquiditySource: LiquiditySource.UNISWAPV3, feeTier: 10_000 },
      ];

      const { availableRoutes, unavailableRoutes } =
        await filterDirectDexRouteCandidatesByAvailability({
          routes,
          pool: {
            name: 'Parallel Availability Pool',
            collateralAddress: '0x1111111111111111111111111111111111111111',
            quoteAddress: '0x2222222222222222222222222222222222222222',
          } as any,
          signer: ethers.Wallet.createRandom().connect(
            new ethers.providers.JsonRpcProvider()
          ) as any,
          config: {
            uniswapV3RouterOverrides: {
              swapRouter02Address: TEST_UNISWAP_SWAP_ROUTER_02_ADDRESS,
              poolFactoryAddress: '0x4444444444444444444444444444444444444444',
              defaultFeeTier: 3000,
              wethAddress: '0x5555555555555555555555555555555555555555',
              quoterV2Address: '0x6666666666666666666666666666666666666666',
            },
          } as any,
        });

      expect(poolExistsStub.callCount).to.equal(4);
      expect(maxInFlight).to.be.greaterThan(1);
      expect(maxInFlight).to.be.at.most(3);
      expect(availableRoutes).to.deep.equal(routes.slice(1));
      expect(unavailableRoutes).to.deep.equal([
        {
          route: routes[0],
          reason: 'Uniswap V3 pool not found',
        },
      ]);
    });

    it('quotes budget-approved direct DEX routes with bounded parallelism', async () => {
      sinon.stub(UniswapV3QuoteProvider.prototype, 'isAvailable').returns(true);
      sinon
        .stub(UniswapV3QuoteProvider.prototype, 'getQuoterAddress')
        .returns('0x7777777777777777777777777777777777777777');
      sinon.stub(UniswapV3QuoteProvider.prototype, 'poolExists').resolves(true);
      let inFlight = 0;
      let maxInFlight = 0;
      const uniswapQuoteStub = sinon
        .stub(UniswapV3QuoteProvider.prototype, 'getQuote')
        .callsFake(async (_amountIn, _tokenIn, _tokenOut, feeTier?: number) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          const delayMs =
            feeTier === 3000
              ? 20
              : feeTier === 500
                ? 5
                : feeTier === 100
                  ? 1
                  : 2;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          inFlight -= 1;
          return {
            success: true,
            dstAmount: ethers.utils.parseUnits(
              feeTier === 10_000 ? '125' : feeTier === 500 ? '119' : '112',
              6
            ),
          } as any;
        });
      sinon.stub(erc20, 'getDecimalsErc20').resolves(6);

      const pool = {
        name: 'Parallel Quote Pool',
        collateralAddress: '0x1111111111111111111111111111111111111111',
        quoteAddress: '0x2222222222222222222222222222222222222222',
        contract: {
          quoteTokenScale: sinon
            .stub()
            .resolves(BigNumber.from('1000000000000')),
        },
      };

      const evaluation = await takeDirectDex.getDirectDexTakeQuoteEvaluation(
        pool as any,
        ethers.utils.parseEther('100'),
        ethers.utils.parseEther('1'),
        {
          name: 'Parallel Quote Pool',
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
            candidateFeeTiers: [500, 100, 10_000],
            wethAddress: '0x5555555555555555555555555555555555555555',
            quoterV2Address: '0x6666666666666666666666666666666666666666',
          },
        } as any,
        ethers.Wallet.createRandom().connect(
          new ethers.providers.JsonRpcProvider()
        ) as any,
        takeDirectDex.createDirectDexQuoteProviderRuntimeCache()
      );

      expect(evaluation.isTakeable).to.be.true;
      expect(evaluation.selectedFeeTier).to.equal(10_000);
      expect(uniswapQuoteStub.callCount).to.equal(4);
      expect(maxInFlight).to.be.greaterThan(1);
      expect(maxInFlight).to.be.at.most(3);
    });

    it('applies a shared route probe limiter to direct DEX quote probes', async () => {
      sinon.stub(UniswapV3QuoteProvider.prototype, 'isAvailable').returns(true);
      sinon
        .stub(UniswapV3QuoteProvider.prototype, 'getQuoterAddress')
        .returns('0x7777777777777777777777777777777777777777');
      sinon.stub(UniswapV3QuoteProvider.prototype, 'poolExists').resolves(true);
      let inFlight = 0;
      let maxInFlight = 0;
      const uniswapQuoteStub = sinon
        .stub(UniswapV3QuoteProvider.prototype, 'getQuote')
        .callsFake(async (_amountIn, _tokenIn, _tokenOut, feeTier?: number) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          return {
            success: true,
            dstAmount: ethers.utils.parseUnits(
              feeTier === 10_000 ? '125' : '112',
              6
            ),
          } as any;
        });
      sinon.stub(erc20, 'getDecimalsErc20').resolves(6);

      const evaluation = await takeDirectDex.getDirectDexTakeQuoteEvaluation(
        {
          name: 'Limited Quote Pool',
          collateralAddress: '0x1111111111111111111111111111111111111111',
          quoteAddress: '0x2222222222222222222222222222222222222222',
          contract: {
            quoteTokenScale: sinon
              .stub()
              .resolves(BigNumber.from('1000000000000')),
          },
        } as any,
        ethers.utils.parseEther('100'),
        ethers.utils.parseEther('1'),
        {
          name: 'Limited Quote Pool',
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
            candidateFeeTiers: [500, 100, 10_000],
            wethAddress: '0x5555555555555555555555555555555555555555',
            quoterV2Address: '0x6666666666666666666666666666666666666666',
          },
        } as any,
        ethers.Wallet.createRandom().connect(
          new ethers.providers.JsonRpcProvider()
        ) as any,
        takeDirectDex.createDirectDexQuoteProviderRuntimeCache(),
        {
          routeProbeLimiter: new RouteProbeLimiter({
            maxConcurrent: 1,
            maxAbandoned: 1,
            hardPermitHoldMs: 1000,
          }),
        }
      );

      expect(evaluation.isTakeable).to.be.true;
      expect(evaluation.selectedFeeTier).to.equal(10_000);
      expect(uniswapQuoteStub.callCount).to.equal(4);
      expect(maxInFlight).to.equal(1);
    });

    it('does not start direct DEX route work when the route probe signal is already aborted', async () => {
      const poolExistsStub = sinon.stub(
        UniswapV3QuoteProvider.prototype,
        'poolExists'
      );
      const uniswapQuoteStub = sinon.stub(
        UniswapV3QuoteProvider.prototype,
        'getQuote'
      );
      const decimalsStub = sinon
        .stub(erc20, 'getDecimalsErc20')
        .throws(new Error('decimals should not be read after route abort'));
      const controller = new AbortController();
      controller.abort(new Error('candidate probe timed out'));

      const evaluation = await takeDirectDex.getDirectDexTakeQuoteEvaluation(
        {
          name: 'Aborted Route Pool',
          collateralAddress: '0x1111111111111111111111111111111111111111',
          quoteAddress: '0x2222222222222222222222222222222222222222',
          contract: {
            quoteTokenScale: sinon.stub(),
          },
        } as any,
        ethers.utils.parseEther('100'),
        ethers.utils.parseEther('1'),
        {
          name: 'Aborted Route Pool',
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
            wethAddress: '0x5555555555555555555555555555555555555555',
            quoterV2Address: '0x6666666666666666666666666666666666666666',
          },
        } as any,
        {} as any,
        takeDirectDex.createDirectDexQuoteProviderRuntimeCache(),
        {
          routeProbeAbortSignal: controller.signal,
        }
      );

      expect(evaluation.isTakeable).to.equal(false);
      expect(evaluation.reason).to.equal('candidate probe timed out');
      expect(decimalsStub.called).to.equal(false);
      expect(poolExistsStub.called).to.equal(false);
      expect(uniswapQuoteStub.called).to.equal(false);
    });

    it('uses recent successful routes to improve budget-limited probing', async () => {
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
      sinon.stub(CurveQuoteProvider.prototype, 'initialize').resolves(true);
      sinon.stub(CurveQuoteProvider.prototype, 'poolExists').resolves(true);
      const curveQuoteStub = sinon
        .stub(CurveQuoteProvider.prototype, 'getQuote')
        .resolves({
          success: true,
          dstAmount: ethers.utils.parseUnits('130', 6),
        } as any);
      sinon.stub(erc20, 'getDecimalsErc20').resolves(6);

      const pool = {
        name: 'Recent Route Pool',
        collateralAddress: '0x1111111111111111111111111111111111111111',
        quoteAddress: '0x2222222222222222222222222222222222222222',
        contract: {
          quoteTokenScale: sinon
            .stub()
            .resolves(BigNumber.from('1000000000000')),
        },
      };
      const poolConfig = {
        name: 'Recent Route Pool',
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
        poolConfig as any,
        config as any,
        ethers.Wallet.createRandom().connect(
          new ethers.providers.JsonRpcProvider()
        ) as any,
        runtimeCache,
        {
          allowedLiquiditySources: [
            LiquiditySource.UNISWAPV3,
            LiquiditySource.CURVE,
          ],
          routeQuoteBudgetPerCandidate: 2,
          routeProfitabilityContext: {
            routeExecutionCostQuoteRawBySource: {
              [LiquiditySource.UNISWAPV3]: BigNumber.from(0),
              [LiquiditySource.CURVE]: BigNumber.from(0),
            },
          },
        }
      );

      expect(evaluation.isTakeable).to.be.true;
      expect(evaluation.selectedLiquiditySource).to.equal(
        LiquiditySource.UNISWAPV3
      );
      expect(evaluation.selectedFeeTier).to.equal(500);
      expect(uniswapQuoteStub.calledTwice).to.be.true;
      expect(curveQuoteStub.called).to.be.false;
    });
});
