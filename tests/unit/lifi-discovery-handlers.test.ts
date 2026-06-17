import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, ethers } from 'ethers';
import { LiquiditySource } from '../../src/config';
import * as erc20 from '../../src/erc20';
import { handleDiscoveredTakeTarget } from '../../src/discovery/handlers';
import type { DiscoveryRpcCache } from '../../src/discovery/handlers';
import { logger } from '../../src/logging';
import { getExternalTakeExecutionPlanPrimaryEvaluation } from '../../src/take/external-take/execution-plan';
import * as lifiExecutionModule from '../../src/take/lifi/execution';
import * as lifiQuoteEvaluationModule from '../../src/take/lifi/quote-evaluation';
import * as directDexModule from '../../src/take/direct-dex';
import { createDiscoveryTransports } from '../helpers/discovery';
import {
  createHybridGasFallbackDirectDexQuote,
  createHybridLifiFallbackScenario,
  createNativeToQuoteGasConversionReject,
  getDiscoveredTakeSummary,
  makeDiscoveredTakeParams,
  makeTestCalldataAggregatorQuote,
  runLifiHybridGasFallbackScenario,
} from './helpers/lifi-discovery-scenarios';

type LifiTakeParams = Parameters<
  typeof lifiExecutionModule.takeLiquidationLifi
>[0];
type DirectDexTakeParams = Parameters<
  typeof directDexModule.takeLiquidationDirectDex
>[0];

describe('LI.FI discovery handlers', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('uses a gas-quote direct DEX fallback candidate when selected LI.FI fails before submission', async () => {
    const warnStub = sinon.stub(logger, 'warn');
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const wethAddress = '0x4200000000000000000000000000000000000006';
    const takeLiquidationLifiStub = sinon
      .stub(lifiExecutionModule, 'takeLiquidationLifi')
      .callsFake(async (params: LifiTakeParams) => {
        params.config.onCalldataAggregatorExecutionFailure?.({
          preBroadcast: true,
          error: 'LI.FI refresh unavailable',
        });
        return false;
      });
    const takeLiquidationDirectDexStub = sinon
      .stub(directDexModule, 'takeLiquidationDirectDex')
      .resolves(true);
    sinon
      .stub(lifiQuoteEvaluationModule, 'getLifiPathQuoteEvaluation')
      .resolves({
        isTakeable: true,
        externalTakePath: 'calldata_aggregator',
        selectedLiquiditySource: LiquiditySource.LIFI,
        quoteAmount: 130,
        quoteAmountRaw: ethers.utils.parseUnits('130', 6),
        collateralAmount: 1,
        marketPrice: 130,
        takeablePrice: 128.7,
        approvedMinOutRaw: ethers.utils.parseUnits('100', 6),
        quotedAuctionPriceWad: ethers.utils.parseEther('100'),
        quotedCollateralWad: ethers.utils.parseEther('1'),
        calldataQuote: makeTestCalldataAggregatorQuote({
          quoteAmountRaw: ethers.utils.parseUnits('130', 6),
        }),
      });
    const directDexQuoteStub = sinon
      .stub(directDexModule, 'getDirectDexTakeQuoteEvaluation')
      .onFirstCall()
      .resolves(createNativeToQuoteGasConversionReject())
      .onSecondCall()
      .resolves(createHybridGasFallbackDirectDexQuote());

    const pool = {
      name: 'Hybrid LI.FI Fallback Candidate Pool',
      poolAddress: '0x77777777777777777777777777777777777777b1',
      quoteAddress: wethAddress,
      collateralAddress: '0x3333333333333333333333333333333333333333',
      getLiquidation: sinon.stub().returns({
        getStatus: sinon.stub().resolves({
          collateral: ethers.utils.parseEther('1'),
          price: ethers.utils.parseEther('100'),
        }),
      }),
    };

    await handleDiscoveredTakeTarget(
      makeDiscoveredTakeParams({
        pool,
        signer: {
          provider: {
            getGasPrice: sinon
              .stub()
              .resolves(ethers.utils.parseUnits('1', 'gwei')),
          },
          getChainId: sinon.stub().resolves(1),
        },
        target: {
          source: 'discovered',
          poolAddress: pool.poolAddress,
          name: pool.name,
          dryRun: false,
          take: {
            liquiditySource: LiquiditySource.LIFI,
            marketPriceFactor: 0.99,
          },
          candidates: [
            {
              poolAddress: pool.poolAddress,
              borrower: '0xBorrowerHybridLifiThenDirectDexFallback',
              kickTime: Date.now(),
              debtRemaining: '1',
              collateralRemaining: '1',
              neutralPrice: '1',
              debt: '1',
              collateral: '1',
              heuristicScore: 1,
            },
          ],
        },
        config: {
          autoDiscover: {
            enabled: true,
            take: {
              enabled: true,
              allowedExternalTakePaths: ['calldata_aggregator', 'direct_dex'],
              allowedCalldataAggregatorProviders: ['lifi'],
              externalTakeRouteSelectionMode: 'maximize_profit',
              defaultDirectDexLiquiditySource: LiquiditySource.UNISWAPV3,
              hybridGasQuoteFailureFallbackMode: 'direct_dex_first',
              maxGasCostNative: 1,
            },
          },
          tokenAddresses: {
            weth: wethAddress,
          },
        },
        transports: createDiscoveryTransports(
          ethers.utils.parseUnits('1', 'gwei')
        ),
        rpcCache: {
          chainId: 1,
          gasPrice: ethers.utils.parseUnits('1', 'gwei'),
          gasPriceFetchedAt: Date.now(),
          directDexQuoteProviders:
            directDexModule.createDirectDexQuoteProviderRuntimeCache(),
        },
      })
    );

    expect(takeLiquidationLifiStub.calledOnce).to.equal(true);
    expect(takeLiquidationDirectDexStub.calledOnce).to.equal(true);
    expect(directDexQuoteStub.callCount).to.be.greaterThan(1);
    expect(
      warnStub
        .getCalls()
        .some((call) =>
          String(call.args[0]).includes(
            'Hybrid LI.FI path failed before submission'
          )
        )
    ).to.equal(true);
  });

  it('executes direct DEX-only hybrid gas quote fallback for LI.FI plus direct DEX routes', async () => {
    const {
      directDexQuoteStub,
      lifiQuoteStub,
      takeLiquidationLifiStub,
      takeLiquidationDirectDexStub,
    } = await runLifiHybridGasFallbackScenario();

    expect(lifiQuoteStub.calledOnce).to.equal(true);
    expect(takeLiquidationLifiStub.called).to.equal(false);
    expect(takeLiquidationDirectDexStub.calledOnce).to.equal(true);
    expect(directDexQuoteStub.callCount).to.be.greaterThan(1);
  });

  it('executes a default LI.FI discovered take path and records LI.FI route stats', async () => {
    const lifiQuoteStub = sinon
      .stub(lifiQuoteEvaluationModule, 'getLifiPathQuoteEvaluation')
      .resolves({
        isTakeable: true,
        externalTakePath: 'calldata_aggregator',
        selectedLiquiditySource: LiquiditySource.LIFI,
        quoteAmount: 125,
        quoteAmountRaw: ethers.utils.parseUnits('125', 6),
        collateralAmount: 1,
        marketPrice: 125,
        takeablePrice: 123.75,
        routeMinOutRaw: ethers.utils.parseUnits('120', 6),
        quotedCollateralWad: ethers.utils.parseEther('1'),
        quotedAuctionPriceWad: ethers.utils.parseEther('100'),
        calldataQuote: makeTestCalldataAggregatorQuote({
          quoteAmountRaw: ethers.utils.parseUnits('125', 6),
        }),
      });
    const takeLiquidationLifiStub = sinon
      .stub(lifiExecutionModule, 'takeLiquidationLifi')
      .resolves(true);
    const loggerInfoStub = sinon.stub(logger, 'info');
    const pool = {
      name: 'Discovered LI.FI Pool',
      poolAddress: '0x1111111111111111111111111111111111190001',
      quoteAddress: '0x2222222222222222222222222222222222222222',
      collateralAddress: '0x3333333333333333333333333333333333333333',
      getLiquidation: sinon.stub().returns({
        getStatus: sinon.stub().resolves({
          collateral: ethers.utils.parseEther('1'),
          price: ethers.utils.parseEther('100'),
        }),
      }),
    };

    const stats = await handleDiscoveredTakeTarget(
      makeDiscoveredTakeParams({
        pool,
        signer: {
          provider: {
            getGasPrice: sinon.stub().resolves(BigNumber.from(1)),
          },
          getChainId: sinon.stub().resolves(8453),
        },
        target: {
          source: 'discovered',
          poolAddress: pool.poolAddress,
          name: pool.name,
          dryRun: true,
          take: {
            liquiditySource: LiquiditySource.LIFI,
            marketPriceFactor: 0.99,
          },
          candidates: [
            {
              poolAddress: pool.poolAddress,
              borrower: '0xBorrowerLifi',
              kickTime: Date.now(),
              debtRemaining: '100',
              collateralRemaining: '1',
              neutralPrice: '100',
              debt: '100',
              collateral: '1',
              heuristicScore: 1,
            },
          ],
        },
        config: {
          autoDiscover: {
            enabled: true,
            take: true,
          },
          lifi: {
            mode: 'production',
            allowExchanges: ['uniswap'],
            callTargetAllowlist: {},
            approvalSpenderAllowlist: {},
            selectorAllowlist: {},
          },
          lifiTaker: '0x4444444444444444444444444444444444444444',
        },
        transports: createDiscoveryTransports(),
      })
    );

    expect(lifiQuoteStub.calledOnce).to.equal(true);
    expect(takeLiquidationLifiStub.calledOnce).to.equal(true);
    expect(stats.externalTakeByPath.calldata_aggregator?.approved).to.equal(1);
    expect(stats.externalTakeByPath.calldata_aggregator?.dryRun).to.equal(1);
    expect(stats.externalTakeByPath.calldata_aggregator?.executed).to.equal(0);
    const summaryLog = getDiscoveredTakeSummary(loggerInfoStub);
    expect(summaryLog).to.include('approvedRoutes=calldata_aggregator:1');
    expect(summaryLog).to.include('approvedCalldataAggregatorProviders=lifi:1');
    expect(summaryLog).to.include('dryRunRoutes=calldata_aggregator:1');
    expect(summaryLog).to.include('dryRunCalldataAggregatorProviders=lifi:1');
  });

  it('passes refreshed auction context into a reapproved direct LI.FI take', async () => {
    const refreshedAuctionPrice = ethers.utils.parseEther('99');
    sinon
      .stub(lifiQuoteEvaluationModule, 'getLifiPathQuoteEvaluation')
      .resolves({
        isTakeable: true,
        externalTakePath: 'calldata_aggregator',
        selectedLiquiditySource: LiquiditySource.LIFI,
        quoteAmount: 125,
        quoteAmountRaw: ethers.utils.parseUnits('125', 6),
        routeMinOutRaw: ethers.utils.parseUnits('120', 6),
        collateralAmount: 1,
        marketPrice: 125,
        takeablePrice: 123.75,
        quotedCollateralWad: ethers.utils.parseEther('1'),
        quotedAuctionPriceWad: ethers.utils.parseEther('100'),
        calldataQuote: makeTestCalldataAggregatorQuote({
          quoteAmountRaw: ethers.utils.parseUnits('125', 6),
          routeMinOutRaw: ethers.utils.parseUnits('120', 6),
        }),
      });
    const takeLiquidationLifiStub = sinon
      .stub(lifiExecutionModule, 'takeLiquidationLifi')
      .resolves(true);
    const pool = {
      name: 'Direct LI.FI Reapproval Context Pool',
      poolAddress: '0x1111111111111111111111111111111111190005',
      quoteAddress: '0x2222222222222222222222222222222222222222',
      collateralAddress: '0x3333333333333333333333333333333333333333',
      getLiquidation: sinon.stub().returns({
        getStatus: sinon.stub().resolves({
          collateral: ethers.utils.parseEther('1'),
          price: refreshedAuctionPrice,
        }),
      }),
    };

    await handleDiscoveredTakeTarget(
      makeDiscoveredTakeParams({
        pool,
        signer: {
          provider: {
            getGasPrice: sinon.stub().resolves(BigNumber.from(1)),
          },
          getChainId: sinon.stub().resolves(8453),
        },
        target: {
          source: 'discovered',
          poolAddress: pool.poolAddress,
          name: pool.name,
          dryRun: false,
          take: {
            liquiditySource: LiquiditySource.LIFI,
            marketPriceFactor: 0.99,
          },
          candidates: [
            {
              poolAddress: pool.poolAddress,
              borrower: '0xBorrowerDirectLifiReapproval',
              kickTime: Date.now(),
              debtRemaining: '100',
              collateralRemaining: '1',
              neutralPrice: '100',
              debt: '100',
              collateral: '1',
              heuristicScore: 1,
            },
          ],
        },
        config: {
          autoDiscover: {
            enabled: true,
            take: true,
          },
          lifi: {
            mode: 'production',
            allowExchanges: ['uniswap'],
            callTargetAllowlist: {},
            approvalSpenderAllowlist: {},
            selectorAllowlist: {},
          },
          lifiTaker: '0x4444444444444444444444444444444444444444',
        },
        transports: createDiscoveryTransports(),
      })
    );

    expect(takeLiquidationLifiStub.calledOnce).to.equal(true);
    const lifiLiquidation =
      takeLiquidationLifiStub.firstCall.args[0].liquidation;
    const lifiQuoteEvaluation = getExternalTakeExecutionPlanPrimaryEvaluation(
      lifiLiquidation.externalTakeExecutionPlan
    )!;
    expect(lifiLiquidation.auctionPrice.eq(refreshedAuctionPrice)).to.equal(
      true
    );
    expect(
      lifiQuoteEvaluation.quotedAuctionPriceWad!.eq(refreshedAuctionPrice)
    ).to.equal(true);
    expect(
      lifiQuoteEvaluation.quotedCollateralWad!.eq(ethers.utils.parseEther('1'))
    ).to.equal(true);
  });

  it('applies configured gas and profit floors to a direct LI.FI discovered take approval', async () => {
    const wethAddress = '0x4200000000000000000000000000000000000006';
    const gasPrice = ethers.utils.parseUnits('1', 'gwei');
    const expectedApprovedMinOutRaw = ethers.utils.parseEther('101.0013');
    sinon.stub(erc20, 'getDecimalsErc20').resolves(18);
    sinon
      .stub(lifiQuoteEvaluationModule, 'getLifiPathQuoteEvaluation')
      .resolves({
        isTakeable: true,
        externalTakePath: 'calldata_aggregator',
        selectedLiquiditySource: LiquiditySource.LIFI,
        quoteAmount: 125,
        quoteAmountRaw: ethers.utils.parseEther('125'),
        routeMinOutRaw: ethers.utils.parseEther('100'),
        collateralAmount: 1,
        marketPrice: 125,
        takeablePrice: 125,
        quotedCollateralWad: ethers.utils.parseEther('1'),
        quotedAuctionPriceWad: ethers.utils.parseEther('100'),
        calldataQuote: makeTestCalldataAggregatorQuote({
          quoteAmountRaw: ethers.utils.parseEther('125'),
          routeMinOutRaw: ethers.utils.parseEther('100'),
        }),
      });
    const takeLiquidationLifiStub = sinon
      .stub(lifiExecutionModule, 'takeLiquidationLifi')
      .resolves(true);
    const loggerDebug = sinon.stub(logger, 'debug');
    const pool = {
      name: 'Direct LI.FI Gas Profit Floor Pool',
      poolAddress: '0x1111111111111111111111111111111111190004',
      quoteAddress: wethAddress,
      collateralAddress: '0x3333333333333333333333333333333333333333',
      getLiquidation: sinon.stub().returns({
        getStatus: sinon.stub().resolves({
          collateral: ethers.utils.parseEther('1'),
          price: ethers.utils.parseEther('100'),
        }),
      }),
    };

    await handleDiscoveredTakeTarget(
      makeDiscoveredTakeParams({
        pool,
        signer: {
          provider: {
            getGasPrice: sinon.stub().resolves(gasPrice),
          },
          getChainId: sinon.stub().resolves(8453),
        },
        target: {
          source: 'discovered',
          poolAddress: pool.poolAddress,
          name: pool.name,
          dryRun: true,
          take: {
            liquiditySource: LiquiditySource.LIFI,
            marketPriceFactor: 1,
          },
          candidates: [
            {
              poolAddress: pool.poolAddress,
              borrower: '0xBorrowerDirectLifiProfitFloor',
              kickTime: Date.now(),
              debtRemaining: '100',
              collateralRemaining: '1',
              neutralPrice: '100',
              debt: '100',
              collateral: '1',
              heuristicScore: 1,
            },
          ],
        },
        config: {
          autoDiscover: {
            enabled: true,
            take: {
              enabled: true,
              dexGasOverrides: {
                [LiquiditySource.LIFI]: '1000000',
              },
              minExpectedProfitQuote: 1,
            },
          },
          tokenAddresses: {
            weth: wethAddress,
          },
          lifi: {
            mode: 'production',
            allowExchanges: ['uniswap'],
            callTargetAllowlist: {},
            approvalSpenderAllowlist: {},
            selectorAllowlist: {},
          },
          lifiTaker: '0x4444444444444444444444444444444444444444',
        },
        transports: createDiscoveryTransports(gasPrice),
        rpcCache: {
          chainId: 8453,
          gasPrice,
          gasPriceFetchedAt: Date.now(),
        },
      })
    );

    expect(takeLiquidationLifiStub.calledOnce).to.equal(true);
    const approvedEvaluation = getExternalTakeExecutionPlanPrimaryEvaluation(
      takeLiquidationLifiStub.firstCall.args[0].liquidation
        .externalTakeExecutionPlan
    )!;
    expect(
      approvedEvaluation.approvedMinOutRaw!.eq(expectedApprovedMinOutRaw)
    ).to.equal(true);
    expect(
      approvedEvaluation.profitMinOutRaw!.eq(expectedApprovedMinOutRaw)
    ).to.equal(true);
    expect(
      approvedEvaluation.routeProfitability!.routeExecutionCostQuoteRaw!.eq(
        ethers.utils.parseEther('0.0013')
      )
    ).to.equal(true);
    expect(
      approvedEvaluation.routeProfitability!.configuredProfitFloorQuoteRaw!.eq(
        ethers.utils.parseEther('1')
      )
    ).to.equal(true);
    const gasTelemetry = loggerDebug
      .getCalls()
      .map((call) => String(call.args[0]))
      .find((message) =>
        message.includes(
          'Discovered external take approved after gas/profit policy:'
        )
      );
    expect(gasTelemetry).to.include('path=calldata_aggregator');
    expect(gasTelemetry).to.include('source=LIFI');
    expect(gasTelemetry).to.include('routeGasModel=dexGasOverrides');
    expect(gasTelemetry).to.include('configuredDexGasOverrideRaw=1000000');
    expect(gasTelemetry).to.include('routeGasLimit=1000000');
  });

  it('skips a direct LI.FI discovered take when the execution refresh circuit is open', async () => {
    const lifiQuoteStub = sinon
      .stub(lifiQuoteEvaluationModule, 'getLifiPathQuoteEvaluation')
      .resolves({
        isTakeable: true,
        externalTakePath: 'calldata_aggregator',
        selectedLiquiditySource: LiquiditySource.LIFI,
        quoteAmount: 125,
        quoteAmountRaw: ethers.utils.parseUnits('125', 6),
        collateralAmount: 1,
        marketPrice: 125,
        takeablePrice: 123.75,
        routeMinOutRaw: ethers.utils.parseUnits('120', 6),
        quotedCollateralWad: ethers.utils.parseEther('1'),
        quotedAuctionPriceWad: ethers.utils.parseEther('100'),
        calldataQuote: makeTestCalldataAggregatorQuote({
          quoteAmountRaw: ethers.utils.parseUnits('125', 6),
        }),
      });
    const takeLiquidationLifiStub = sinon
      .stub(lifiExecutionModule, 'takeLiquidationLifi')
      .resolves(true);
    const warnStub = sinon.stub(logger, 'warn');
    const pool = {
      name: 'Direct LI.FI Circuit Pool',
      poolAddress: '0x1111111111111111111111111111111111190003',
      quoteAddress: '0x2222222222222222222222222222222222222222',
      collateralAddress: '0x3333333333333333333333333333333333333333',
      getLiquidation: sinon.stub().returns({
        getStatus: sinon.stub().resolves({
          collateral: ethers.utils.parseEther('1'),
          price: ethers.utils.parseEther('100'),
        }),
      }),
    };

    const stats = await handleDiscoveredTakeTarget(
      makeDiscoveredTakeParams({
        pool,
        signer: {
          provider: {
            getGasPrice: sinon.stub().resolves(BigNumber.from(1)),
          },
          getChainId: sinon.stub().resolves(8453),
        },
        target: {
          source: 'discovered',
          poolAddress: pool.poolAddress,
          name: pool.name,
          dryRun: false,
          take: {
            liquiditySource: LiquiditySource.LIFI,
            marketPriceFactor: 0.99,
          },
          candidates: [
            {
              poolAddress: pool.poolAddress,
              borrower: '0xBorrowerDirectLifiCircuit',
              kickTime: Date.now(),
              debtRemaining: '100',
              collateralRemaining: '1',
              neutralPrice: '100',
              debt: '100',
              collateral: '1',
              heuristicScore: 1,
            },
          ],
        },
        config: {
          autoDiscover: {
            enabled: true,
            take: true,
          },
          lifi: {
            mode: 'production',
            allowExchanges: ['uniswap'],
            callTargetAllowlist: {},
            approvalSpenderAllowlist: {},
            selectorAllowlist: {},
          },
          lifiTaker: '0x4444444444444444444444444444444444444444',
        },
        transports: createDiscoveryTransports(),
        rpcCache: {
          chainId: 8453,
          gasPrice: BigNumber.from(1),
          gasPriceFetchedAt: Date.now(),
          providerCircuits: {
            lifi: {
              execution_refresh: {
                failures: 1,
                cooldownUntilMs: Date.now() + 30_000,
              },
            },
          },
        },
      })
    );

    expect(lifiQuoteStub.calledOnce).to.equal(true);
    expect(takeLiquidationLifiStub.called).to.equal(false);
    expect(
      stats.externalTakeByPath.calldata_aggregator?.preBroadcastFailures
    ).to.equal(1);
    expect(stats.externalTakeByPath.calldata_aggregator?.executed).to.equal(0);
    expect(
      warnStub
        .getCalls()
        .some((call) =>
          String(call.args[0]).includes(
            'LI.FI execution refresh circuit is open'
          )
        )
    ).to.equal(true);
  });

  it('opens the LI.FI route quote circuit without touching the 1inch circuit', async () => {
    const lifiQuoteStub = sinon
      .stub(lifiQuoteEvaluationModule, 'getLifiPathQuoteEvaluation')
      .resolves({
        isTakeable: false,
        externalTakePath: 'calldata_aggregator',
        selectedLiquiditySource: LiquiditySource.LIFI,
        quoteFailureRetryable: true,
        quoteFailureCode: 429,
        reason: 'LI.FI quote request failed status=429',
      });
    const takeLiquidationLifiStub = sinon
      .stub(lifiExecutionModule, 'takeLiquidationLifi')
      .resolves(true);
    const pool = {
      name: 'Discovered LI.FI Circuit Pool',
      poolAddress: '0x1111111111111111111111111111111111190002',
      quoteAddress: '0x2222222222222222222222222222222222222222',
      collateralAddress: '0x3333333333333333333333333333333333333333',
      getLiquidation: sinon.stub().returns({
        getStatus: sinon.stub().resolves({
          collateral: ethers.utils.parseEther('1'),
          price: ethers.utils.parseEther('100'),
        }),
      }),
    };
    const rpcCache: DiscoveryRpcCache = {
      chainId: 8453,
      providerCircuits: {
        oneinch: { route_quote: { failures: 1 } },
      },
    };
    const params = makeDiscoveredTakeParams({
      pool,
      signer: {
        provider: {
          getGasPrice: sinon.stub().resolves(BigNumber.from(1)),
        },
        getChainId: sinon.stub().resolves(8453),
      },
      target: {
        source: 'discovered',
        poolAddress: pool.poolAddress,
        name: pool.name,
        dryRun: true,
        take: {
          liquiditySource: LiquiditySource.LIFI,
          marketPriceFactor: 0.99,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerLifiCircuit',
            kickTime: Date.now(),
            debtRemaining: '100',
            collateralRemaining: '1',
            neutralPrice: '100',
            debt: '100',
            collateral: '1',
            heuristicScore: 1,
          },
        ],
      },
      config: {
        autoDiscover: {
          enabled: true,
          take: true,
        },
        lifi: {
          mode: 'production',
          allowExchanges: ['uniswap'],
          callTargetAllowlist: {},
          approvalSpenderAllowlist: {},
          selectorAllowlist: {},
          quoteFailureThreshold: 1,
          quoteFailureCooldownMs: 30_000,
        },
        lifiTaker: '0x4444444444444444444444444444444444444444',
      },
      transports: createDiscoveryTransports(),
      rpcCache,
    });

    await handleDiscoveredTakeTarget(params);
    expect(lifiQuoteStub.calledOnce).to.equal(true);
    expect(takeLiquidationLifiStub.called).to.equal(false);
    expect(rpcCache.providerCircuits!.lifi!.route_quote!.failures).to.equal(1);
    expect(
      rpcCache.providerCircuits!.lifi!.route_quote!.cooldownUntilMs
    ).to.be.a('number');
    expect(
      rpcCache.providerCircuits!.oneinch!.route_quote!.failures
    ).to.equal(1);

    lifiQuoteStub.resetHistory();
    await handleDiscoveredTakeTarget(params);
    expect(lifiQuoteStub.called).to.equal(false);
  });

  it('tries the next approved hybrid route when LI.FI fails before submission', async () => {
    const warnStub = sinon.stub(logger, 'warn');
    const scenario = createHybridLifiFallbackScenario();
    const takeLiquidationLifiStub = sinon
      .stub(lifiExecutionModule, 'takeLiquidationLifi')
      .callsFake(async (params: LifiTakeParams) => {
        params.config.onCalldataAggregatorExecutionFailure?.({
          preBroadcast: true,
          error: 'LI.FI fresh quote min output below execution floor',
        });
        return false;
      });

    const stats = await handleDiscoveredTakeTarget(scenario.params);

    expect(scenario.lifiQuoteStub.calledOnce).to.equal(true);
    expect(scenario.directDexQuoteStub.calledOnce).to.equal(true);
    expect(takeLiquidationLifiStub.calledOnce).to.equal(true);
    expect(scenario.takeLiquidationDirectDexStub.calledOnce).to.equal(true);
    expect(stats.hybridFallbackAttempts).to.equal(1);
    expect(stats.hybridFallbackSuccesses).to.equal(1);
    expect(
      warnStub
        .getCalls()
        .some((call) =>
          String(call.args[0]).includes(
            'Hybrid LI.FI path failed before submission'
          )
        )
    ).to.equal(true);
  });

  it('tries the next approved hybrid route when the LI.FI execution refresh circuit is open', async () => {
    const warnStub = sinon.stub(logger, 'warn');
    const scenario = createHybridLifiFallbackScenario();
    const takeLiquidationLifiStub = sinon
      .stub(lifiExecutionModule, 'takeLiquidationLifi')
      .resolves(true);
    scenario.params.rpcCache!.providerCircuits = {
      lifi: {
        execution_refresh: {
          failures: 1,
          cooldownUntilMs: Date.now() + 30_000,
        },
      },
    };

    const stats = await handleDiscoveredTakeTarget(scenario.params);

    expect(scenario.lifiQuoteStub.calledOnce).to.equal(true);
    expect(scenario.directDexQuoteStub.calledOnce).to.equal(true);
    expect(takeLiquidationLifiStub.called).to.equal(false);
    expect(scenario.takeLiquidationDirectDexStub.calledOnce).to.equal(true);
    expect(
      stats.externalTakeByPath.calldata_aggregator?.preBroadcastFailures
    ).to.equal(1);
    expect(stats.hybridFallbackAttempts).to.equal(1);
    expect(stats.hybridFallbackSuccesses).to.equal(1);
    expect(
      warnStub
        .getCalls()
        .some((call) =>
          String(call.args[0]).includes(
            'Hybrid LI.FI path failed before submission'
          )
        )
    ).to.equal(true);
  });

  it('passes refreshed auction context into a reapproved LI.FI hybrid fallback', async () => {
    const refreshedCollateral = ethers.utils.parseEther('1');
    const refreshedAuctionPrice = ethers.utils.parseEther('99');
    const scenario = createHybridLifiFallbackScenario({
      lifiExpectedNetProfitRaw: ethers.utils.parseEther('19'),
      directDexExpectedNetProfitRaw: ethers.utils.parseEther('29'),
      refreshedCollateral,
      refreshedAuctionPrice,
    });
    scenario.takeLiquidationDirectDexStub.callsFake(
      async (params: DirectDexTakeParams) => {
        params.config.onDirectDexExecutionFailure?.({
          preBroadcast: true,
          error: 'direct DEX gas estimate failed',
        });
        return false;
      }
    );
    const takeLiquidationLifiStub = sinon
      .stub(lifiExecutionModule, 'takeLiquidationLifi')
      .resolves(true);

    const stats = await handleDiscoveredTakeTarget(scenario.params);

    expect(scenario.directDexQuoteStub.calledOnce).to.equal(true);
    expect(scenario.lifiQuoteStub.calledOnce).to.equal(true);
    expect(scenario.takeLiquidationDirectDexStub.calledOnce).to.equal(true);
    expect(takeLiquidationLifiStub.calledOnce).to.equal(true);
    expect(stats.hybridFallbackAttempts).to.equal(1);
    expect(stats.hybridFallbackSuccesses).to.equal(1);

    const lifiLiquidation =
      takeLiquidationLifiStub.firstCall.args[0].liquidation;
    const lifiQuoteEvaluation = getExternalTakeExecutionPlanPrimaryEvaluation(
      lifiLiquidation.externalTakeExecutionPlan
    )!;
    expect(lifiLiquidation.collateral.eq(refreshedCollateral)).to.equal(true);
    expect(lifiLiquidation.auctionPrice.eq(refreshedAuctionPrice)).to.equal(
      true
    );
    expect(
      lifiQuoteEvaluation.quotedCollateralWad!.eq(refreshedCollateral)
    ).to.equal(true);
    expect(
      lifiQuoteEvaluation.quotedAuctionPriceWad!.eq(refreshedAuctionPrice)
    ).to.equal(true);
  });

  it('does not try fallback routes after LI.FI may have submitted a transaction', async () => {
    const scenario = createHybridLifiFallbackScenario();
    const takeLiquidationLifiStub = sinon
      .stub(lifiExecutionModule, 'takeLiquidationLifi')
      .callsFake(async (params: LifiTakeParams) => {
        params.config.onCalldataAggregatorExecutionFailure?.({
          preBroadcast: false,
          error: 'relay accepted LI.FI take before timeout',
        });
        return false;
      });

    const stats = await handleDiscoveredTakeTarget(scenario.params);

    expect(takeLiquidationLifiStub.calledOnce).to.equal(true);
    expect(scenario.takeLiquidationDirectDexStub.called).to.equal(false);
    expect(stats.hybridFallbackAttempts).to.equal(0);
    expect(stats.hybridFallbackSuccesses).to.equal(0);
  });
});
