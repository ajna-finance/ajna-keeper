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

describe('Direct DEX route policy', () => {
  afterEach(() => {
    sinon.restore();
  });

    it('treats allowedLiquiditySources as the complete direct DEX route allowlist', () => {
      const routes = getDirectDexRouteCandidates({
        defaultLiquiditySource: LiquiditySource.UNISWAPV3,
        config: {
          uniswapV3RouterOverrides: { defaultFeeTier: 3000 },
        },
        selection: {
          allowedLiquiditySources: [LiquiditySource.CURVE],
        },
      });

      expect(routes).to.deep.equal([
        { liquiditySource: LiquiditySource.CURVE },
      ]);
    });

    it('auto-probes standard Uniswap V3 fee tiers when candidates are not configured', () => {
      const routes = getDirectDexRouteCandidates({
        defaultLiquiditySource: LiquiditySource.UNISWAPV3,
        config: {
          uniswapV3RouterOverrides: { defaultFeeTier: 3000 },
        },
      });

      expect(routes).to.deep.equal([
        { liquiditySource: LiquiditySource.UNISWAPV3, feeTier: 3000 },
        { liquiditySource: LiquiditySource.UNISWAPV3, feeTier: 100 },
        { liquiditySource: LiquiditySource.UNISWAPV3, feeTier: 500 },
        { liquiditySource: LiquiditySource.UNISWAPV3, feeTier: 10000 },
      ]);
    });

    it('treats configured Uniswap V3 candidate fee tiers as an explicit override', () => {
      const routes = getDirectDexRouteCandidates({
        defaultLiquiditySource: LiquiditySource.UNISWAPV3,
        config: {
          uniswapV3RouterOverrides: {
            defaultFeeTier: 3000,
            candidateFeeTiers: [500],
          },
        },
      });

      expect(routes).to.deep.equal([
        { liquiditySource: LiquiditySource.UNISWAPV3, feeTier: 3000 },
        { liquiditySource: LiquiditySource.UNISWAPV3, feeTier: 500 },
      ]);
    });

    it('skips takeable route evaluations without net-profit metadata', () => {
      const loggerWarnStub = sinon.stub(logger, 'warn');
      const validRoute = {
        route: {
          liquiditySource: LiquiditySource.CURVE,
          feeTier: 500,
        },
        evaluation: {
          isTakeable: true,
          quoteAmountRaw: BigNumber.from(125),
          routeProfitability: {
            expectedNetProfitQuoteRaw: BigNumber.from(20),
            expectedSubsidyQuoteRaw: BigNumber.from(0),
            subsidyAllowed: false,
          },
        },
      };

      expect(
        selectBestDirectDexRouteEvaluation({
          evaluations: [
            {
              route: {
                liquiditySource: LiquiditySource.UNISWAPV3,
                feeTier: 3000,
              },
              evaluation: {
                isTakeable: true,
                quoteAmountRaw: ethers.utils.parseUnits('120', 6),
                selectedLiquiditySource: LiquiditySource.UNISWAPV3,
                selectedFeeTier: 3000,
                approvedMinOutRaw: ethers.utils.parseUnits('118', 6),
              },
            },
            validRoute,
          ],
          defaultLiquiditySource: LiquiditySource.UNISWAPV3,
          config: {
            uniswapV3RouterOverrides: { defaultFeeTier: 3000 },
          },
        })
      ).to.equal(validRoute);
      expect(loggerWarnStub.calledOnce).to.equal(true);
      expect(loggerWarnStub.firstCall.args[0]).to.equal(
        'Direct DEX: skipping takeable route missing expected net profit metadata'
      );
    });

    it('prefers non-subsidized direct DEX routes over higher-profit subsidized routes', () => {
      const nonSubsidizedRoute = {
        route: {
          liquiditySource: LiquiditySource.UNISWAPV3,
          feeTier: 3000,
        },
        evaluation: {
          isTakeable: true,
          quoteAmountRaw: BigNumber.from(125),
          routeProfitability: {
            expectedNetProfitQuoteRaw: BigNumber.from(20),
            expectedSubsidyQuoteRaw: BigNumber.from(0),
            subsidyAllowed: false,
          },
        },
      };
      const subsidizedRoute = {
        route: {
          liquiditySource: LiquiditySource.CURVE,
          feeTier: 500,
        },
        evaluation: {
          isTakeable: true,
          quoteAmountRaw: BigNumber.from(150),
          routeProfitability: {
            expectedNetProfitQuoteRaw: BigNumber.from(40),
            expectedSubsidyQuoteRaw: BigNumber.from(5),
            subsidyAllowed: true,
          },
        },
      };

      expect(
        selectBestDirectDexRouteEvaluation({
          evaluations: [subsidizedRoute, nonSubsidizedRoute],
          defaultLiquiditySource: LiquiditySource.UNISWAPV3,
          config: {
            uniswapV3RouterOverrides: { defaultFeeTier: 3000 },
          },
        })
      ).to.equal(nonSubsidizedRoute);
    });

    it('chooses the smallest subsidy among subsidized direct DEX routes before net profit', () => {
      const smallerSubsidyRoute = {
        route: {
          liquiditySource: LiquiditySource.UNISWAPV3,
          feeTier: 3000,
        },
        evaluation: {
          isTakeable: true,
          quoteAmountRaw: BigNumber.from(130),
          routeProfitability: {
            expectedNetProfitQuoteRaw: BigNumber.from(15),
            expectedSubsidyQuoteRaw: BigNumber.from(2),
            subsidyAllowed: true,
          },
        },
      };
      const largerSubsidyRoute = {
        route: {
          liquiditySource: LiquiditySource.CURVE,
          feeTier: 500,
        },
        evaluation: {
          isTakeable: true,
          quoteAmountRaw: BigNumber.from(150),
          routeProfitability: {
            expectedNetProfitQuoteRaw: BigNumber.from(40),
            expectedSubsidyQuoteRaw: BigNumber.from(8),
            subsidyAllowed: true,
          },
        },
      };

      expect(
        selectBestDirectDexRouteEvaluation({
          evaluations: [largerSubsidyRoute, smallerSubsidyRoute],
          defaultLiquiditySource: LiquiditySource.CURVE,
          config: {
            uniswapV3RouterOverrides: { defaultFeeTier: 3000 },
          },
        })
      ).to.equal(smallerSubsidyRoute);
    });

    it('recomputes approved min-out from split route and profit floors during reapproval', () => {
      const routeMinOutRaw = ethers.utils.parseUnits('120', 6);
      const staleProfitMinOutRaw = ethers.utils.parseUnits('140', 6);
      const refreshedProfitMinOutRaw = ethers.utils.parseUnits('106', 6);

      const evaluation = applyDirectDexRouteProfitabilityPolicy({
        evaluation: {
          isTakeable: true,
          marketPrice: 200,
          takeablePrice: 198,
          quoteAmountRaw: ethers.utils.parseUnits('150', 6),
          selectedLiquiditySource: LiquiditySource.UNISWAPV3,
          selectedFeeTier: 3000,
          routeMinOutRaw,
          profitMinOutRaw: staleProfitMinOutRaw,
          approvedMinOutRaw: staleProfitMinOutRaw,
          routeProfitability: {
            auctionRepayRequirementQuoteRaw: ethers.utils.parseUnits('100', 6),
            marketFactorFloorQuoteRaw: ethers.utils.parseUnits('100', 6),
            configuredMarketPriceFactor: 0.99,
          },
        },
        liquiditySource: LiquiditySource.UNISWAPV3,
        context: {
          routeExecutionCostQuoteRawBySource: {
            [LiquiditySource.UNISWAPV3]: ethers.utils.parseUnits('5', 6),
          },
          configuredProfitFloorQuoteRaw: ethers.utils.parseUnits('1', 6),
        },
      });

      expect(evaluation.routeMinOutRaw?.eq(routeMinOutRaw)).to.be.true;
      expect(evaluation.profitMinOutRaw?.eq(refreshedProfitMinOutRaw)).to.be
        .true;
      expect(evaluation.approvedMinOutRaw?.eq(routeMinOutRaw)).to.be.true;
      expect(evaluation.takeablePrice).to.be.closeTo(188.6792, 0.0001);
      expect(
        evaluation.routeProfitability?.requiredOutputFloorQuoteRaw?.eq(
          refreshedProfitMinOutRaw
        )
      ).to.be.true;
    });

    it('raises approved min-out when the refreshed profit floor is stricter than the route floor', () => {
      const routeMinOutRaw = ethers.utils.parseUnits('120', 6);
      const refreshedProfitMinOutRaw = ethers.utils.parseUnits('126', 6);

      const evaluation = applyDirectDexRouteProfitabilityPolicy({
        evaluation: {
          isTakeable: true,
          quoteAmountRaw: ethers.utils.parseUnits('150', 6),
          selectedLiquiditySource: LiquiditySource.UNISWAPV3,
          selectedFeeTier: 3000,
          routeMinOutRaw,
          profitMinOutRaw: ethers.utils.parseUnits('110', 6),
          approvedMinOutRaw: routeMinOutRaw,
          routeProfitability: {
            auctionRepayRequirementQuoteRaw: ethers.utils.parseUnits('100', 6),
            marketFactorFloorQuoteRaw: ethers.utils.parseUnits('100', 6),
            configuredMarketPriceFactor: 0.99,
          },
        },
        liquiditySource: LiquiditySource.UNISWAPV3,
        context: {
          routeExecutionCostQuoteRawBySource: {
            [LiquiditySource.UNISWAPV3]: ethers.utils.parseUnits('25', 6),
          },
          configuredProfitFloorQuoteRaw: ethers.utils.parseUnits('1', 6),
        },
      });

      expect(evaluation.routeMinOutRaw?.eq(routeMinOutRaw)).to.be.true;
      expect(evaluation.profitMinOutRaw?.eq(refreshedProfitMinOutRaw)).to.be
        .true;
      expect(evaluation.approvedMinOutRaw?.eq(refreshedProfitMinOutRaw)).to.be
        .true;
    });

    it('re-derives the market-factor floor when route metadata is incomplete', () => {
      const auctionRepayRequirementQuoteRaw = ethers.utils.parseUnits('100', 6);
      const configuredMarketPriceFactor = 0.99;
      const expectedMarketFactorFloorQuoteRaw = ceilDiv(
        auctionRepayRequirementQuoteRaw.mul(MARKET_FACTOR_SCALE),
        BigNumber.from(getMarketPriceFactorUnits(configuredMarketPriceFactor))
      );

      const evaluation = applyDirectDexRouteProfitabilityPolicy({
        evaluation: {
          isTakeable: true,
          quoteAmountRaw: ethers.utils.parseUnits('150', 6),
          selectedLiquiditySource: LiquiditySource.UNISWAPV3,
          selectedFeeTier: 3000,
          routeProfitability: {
            auctionRepayRequirementQuoteRaw,
            configuredMarketPriceFactor,
          },
        },
        liquiditySource: LiquiditySource.UNISWAPV3,
        context: {
          configuredProfitFloorQuoteRaw: ethers.utils.parseUnits('1', 6),
        },
      });

      expect(
        evaluation.routeProfitability?.marketFactorFloorQuoteRaw?.eq(
          expectedMarketFactorFloorQuoteRaw
        )
      ).to.be.true;
      expect(evaluation.isTakeable).to.be.true;
    });
});
