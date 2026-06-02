import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, ethers } from 'ethers';
import { LiquiditySource } from '../../src/config';
import * as erc20 from '../../src/erc20';
import { handleDiscoveredTakeTarget } from '../../src/discovery/handlers';
import { logger } from '../../src/logging';
import * as lifiExecutionModule from '../../src/take/lifi-execution';
import * as takeFactoryModule from '../../src/take/factory';
import { createDiscoveryTransports } from '../helpers/discovery';

function getDiscoveredTakeSummary(loggerInfoStub: sinon.SinonStub): string {
  const isSummaryMessage = (message: unknown): message is string =>
    typeof message === 'string' &&
    message.includes('Discovered take target summary:');
  const summaryLog = loggerInfoStub
    .getCalls()
    .map((call) => call.args[0] as unknown)
    .find(isSummaryMessage);
  if (summaryLog === undefined) {
    expect.fail('Expected a discovered take target summary log');
  }
  return summaryLog;
}

function createHybridGasFallbackFactoryQuote(
  overrides: Record<string, unknown> = {}
) {
  return {
    isTakeable: true,
    externalTakePath: 'factory' as const,
    selectedLiquiditySource: LiquiditySource.UNISWAPV3,
    selectedFeeTier: 500,
    quoteAmount: 125,
    quoteAmountRaw: ethers.utils.parseUnits('125', 6),
    collateralAmount: 1,
    marketPrice: 125,
    takeablePrice: 123.75,
    approvedMinOutRaw: ethers.utils.parseUnits('100', 6),
    quotedAuctionPriceWad: ethers.utils.parseEther('100'),
    quotedCollateralWad: ethers.utils.parseEther('1'),
    ...overrides,
  };
}

function createNativeToQuoteGasConversionReject(
  overrides: Record<string, unknown> = {}
) {
  return {
    isTakeable: false,
    externalTakePath: 'factory' as const,
    selectedLiquiditySource: LiquiditySource.UNISWAPV3,
    reason: 'failed to quote gas cost into quote token',
    routeProfitability: {
      gasPolicyRejectCode: 'native_to_quote_conversion_unavailable' as const,
      gasQuoteAttempts: [
        {
          source: LiquiditySource.UNISWAPV3,
          tokenIn: '0x4200000000000000000000000000000000000006',
          tokenOut: '0x2222222222222222222222222222222222222222',
          amountIn: '900000000000000',
          feeTiers: [3000, 100, 500, 10000],
          success: false,
          reason: 'no factory pool at configured fee tiers',
        },
      ],
    },
    ...overrides,
  };
}

async function runLifiHybridGasFallbackScenario(
  options: {
    factoryEvaluations?: any[];
  } = {}
) {
  sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
  const takeLiquidationLifiStub = sinon
    .stub(lifiExecutionModule, 'takeLiquidationLifi')
    .resolves(true);
  const takeLiquidationFactoryStub = sinon
    .stub(takeFactoryModule, 'takeLiquidationFactory')
    .resolves(true);
  const lifiQuoteStub = sinon
    .stub(lifiExecutionModule, 'getLifiPathQuoteEvaluation')
    .resolves({
      isTakeable: false,
      externalTakePath: 'lifi',
      selectedLiquiditySource: LiquiditySource.LIFI,
      reason: 'LI.FI unavailable',
    });
  const factoryEvaluations = options.factoryEvaluations ?? [
    createNativeToQuoteGasConversionReject(),
    createHybridGasFallbackFactoryQuote(),
  ];
  let factoryCallIndex = 0;
  const factoryQuoteStub = sinon
    .stub(takeFactoryModule, 'getFactoryTakeQuoteEvaluation')
    .callsFake(async () => {
      const evaluation =
        factoryEvaluations[
          Math.min(factoryCallIndex, factoryEvaluations.length - 1)
        ];
      factoryCallIndex += 1;
      return evaluation;
    });
  const gasPrice = ethers.utils.parseUnits('1', 'gwei');
  const wethAddress = '0x4200000000000000000000000000000000000006';
  const pool = {
    name: 'LI.FI Hybrid Gas Fallback Pool',
    poolAddress: '0x7777777777777777777777777777777777777792',
    quoteAddress: wethAddress,
    collateralAddress: '0x3333333333333333333333333333333333333333',
    getLiquidation: sinon.stub().returns({
      getStatus: sinon.stub().resolves({
        collateral: ethers.utils.parseEther('1'),
        price: ethers.utils.parseEther('100'),
      }),
    }),
  };

  await handleDiscoveredTakeTarget({
    pool: pool as any,
    signer: {
      provider: {
        getGasPrice: sinon.stub().resolves(gasPrice),
      },
      getChainId: sinon.stub().resolves(1),
    } as any,
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
          borrower: '0xBorrowerHybridLifiGasFallback',
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
          allowedExternalTakePaths: ['lifi', 'factory'],
          externalTakeRouteSelectionMode: 'maximize_profit',
          defaultFactoryLiquiditySource: LiquiditySource.UNISWAPV3,
          hybridGasQuoteFailureFallbackMode: 'factory_first',
          maxGasCostNative: 1,
        },
      },
      tokenAddresses: {
        weth: wethAddress,
      },
      subgraphUrl: 'http://example-subgraph',
    } as any,
    transports: createDiscoveryTransports(gasPrice),
    rpcCache: {
      chainId: 1,
      gasPrice,
      gasPriceFetchedAt: Date.now(),
      factoryQuoteProviders:
        takeFactoryModule.createFactoryQuoteProviderRuntimeCache(),
    },
  });

  return {
    factoryQuoteStub,
    lifiQuoteStub,
    takeLiquidationLifiStub,
    takeLiquidationFactoryStub,
  };
}

function createHybridLifiFallbackScenario(
  options: {
    lifiExpectedNetProfitRaw?: BigNumber;
    factoryExpectedNetProfitRaw?: BigNumber;
    refreshedCollateral?: BigNumber;
    refreshedAuctionPrice?: BigNumber;
  } = {}
) {
  const wethAddress = '0x4200000000000000000000000000000000000006';
  const gasPrice = ethers.utils.parseUnits('1', 'gwei');
  const gasPolicyEvaluatedAt = Date.now();
  const refreshedCollateral =
    options.refreshedCollateral ?? ethers.utils.parseEther('1');
  const refreshedAuctionPrice =
    options.refreshedAuctionPrice ?? ethers.utils.parseEther('100');
  sinon.stub(erc20, 'getDecimalsErc20').resolves(18);

  const lifiQuoteStub = sinon
    .stub(lifiExecutionModule, 'getLifiPathQuoteEvaluation')
    .resolves({
      isTakeable: true,
      externalTakePath: 'lifi',
      selectedLiquiditySource: LiquiditySource.LIFI,
      quoteAmount: 130,
      quoteAmountRaw: ethers.utils.parseEther('130'),
      routeMinOutRaw: ethers.utils.parseEther('128'),
      collateralAmount: 1,
      marketPrice: 130,
      takeablePrice: 128.7,
      approvedMinOutRaw: ethers.utils.parseEther('100'),
      quotedAuctionPriceWad: ethers.utils.parseEther('100'),
      quotedCollateralWad: ethers.utils.parseEther('1'),
      routeProfitability: {
        expectedNetProfitQuoteRaw:
          options.lifiExpectedNetProfitRaw ?? ethers.utils.parseEther('29'),
        expectedSubsidyQuoteRaw: BigNumber.from(0),
        subsidyAllowed: false,
        gasPriceWei: gasPrice,
        gasPolicyEvaluatedAt,
      },
    } as any);
  const factoryQuoteStub = sinon
    .stub(takeFactoryModule, 'getFactoryTakeQuoteEvaluation')
    .resolves({
      isTakeable: true,
      externalTakePath: 'factory',
      selectedLiquiditySource: LiquiditySource.UNISWAPV3,
      selectedFeeTier: 500,
      quoteAmount: 120,
      quoteAmountRaw: ethers.utils.parseEther('120'),
      routeMinOutRaw: ethers.utils.parseEther('118'),
      collateralAmount: 1,
      marketPrice: 120,
      takeablePrice: 118.8,
      approvedMinOutRaw: ethers.utils.parseEther('100'),
      quotedAuctionPriceWad: ethers.utils.parseEther('100'),
      quotedCollateralWad: ethers.utils.parseEther('1'),
      routeProfitability: {
        expectedNetProfitQuoteRaw:
          options.factoryExpectedNetProfitRaw ?? ethers.utils.parseEther('19'),
        expectedSubsidyQuoteRaw: BigNumber.from(0),
        subsidyAllowed: false,
        gasPriceWei: gasPrice,
        gasPolicyEvaluatedAt,
      },
    } as any);
  const takeLiquidationFactoryStub = sinon
    .stub(takeFactoryModule, 'takeLiquidationFactory')
    .resolves(true);

  const pool = {
    name: 'Hybrid LI.FI Fallback Pool',
    poolAddress: '0x7777777777777777777777777777777777786',
    quoteAddress: wethAddress,
    collateralAddress: '0x3333333333333333333333333333333333333333',
    getLiquidation: sinon.stub().returns({
      getStatus: sinon.stub().resolves({
        collateral: refreshedCollateral,
        price: refreshedAuctionPrice,
      }),
    }),
  };

  return {
    lifiQuoteStub,
    factoryQuoteStub,
    takeLiquidationFactoryStub,
    params: {
      pool: pool as any,
      signer: {
        provider: {
          getGasPrice: sinon.stub().resolves(gasPrice),
        },
        getChainId: sinon.stub().resolves(8453),
      } as any,
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
            borrower: '0xBorrowerHybridLifiFallback',
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
            allowedExternalTakePaths: ['lifi', 'factory'],
            externalTakeRouteSelectionMode: 'maximize_profit',
            defaultFactoryLiquiditySource: LiquiditySource.UNISWAPV3,
            dexGasOverrides: {
              [LiquiditySource.LIFI]: '900000',
              [LiquiditySource.UNISWAPV3]: '900000',
            },
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
        subgraphUrl: 'http://example-subgraph',
      } as any,
      transports: createDiscoveryTransports(gasPrice),
      rpcCache: {
        chainId: 8453,
        gasPrice,
        gasPriceFetchedAt: Date.now(),
        factoryQuoteProviders:
          takeFactoryModule.createFactoryQuoteProviderRuntimeCache(),
      },
    },
  };
}

describe('LI.FI discovery handlers', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('uses a gas-quote fallback factory candidate when selected LI.FI fails before submission', async () => {
    const warnStub = sinon.stub(logger, 'warn');
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const wethAddress = '0x4200000000000000000000000000000000000006';
    const takeLiquidationLifiStub = sinon
      .stub(lifiExecutionModule, 'takeLiquidationLifi')
      .callsFake(async (params: any) => {
        params.config.onLifiExecutionFailure?.({
          preBroadcast: true,
          error: 'LI.FI refresh unavailable',
        });
        return false;
      });
    const takeLiquidationFactoryStub = sinon
      .stub(takeFactoryModule, 'takeLiquidationFactory')
      .resolves(true);
    sinon.stub(lifiExecutionModule, 'getLifiPathQuoteEvaluation').resolves({
      isTakeable: true,
      externalTakePath: 'lifi',
      selectedLiquiditySource: LiquiditySource.LIFI,
      quoteAmount: 130,
      quoteAmountRaw: ethers.utils.parseUnits('130', 6),
      collateralAmount: 1,
      marketPrice: 130,
      takeablePrice: 128.7,
      approvedMinOutRaw: ethers.utils.parseUnits('100', 6),
      quotedAuctionPriceWad: ethers.utils.parseEther('100'),
      quotedCollateralWad: ethers.utils.parseEther('1'),
    });
    const factoryQuoteStub = sinon
      .stub(takeFactoryModule, 'getFactoryTakeQuoteEvaluation')
      .onFirstCall()
      .resolves(createNativeToQuoteGasConversionReject())
      .onSecondCall()
      .resolves(createHybridGasFallbackFactoryQuote());

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

    await handleDiscoveredTakeTarget({
      pool: pool as any,
      signer: {
        provider: {
          getGasPrice: sinon
            .stub()
            .resolves(ethers.utils.parseUnits('1', 'gwei')),
        },
        getChainId: sinon.stub().resolves(1),
      } as any,
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
            borrower: '0xBorrowerHybridLifiThenFactoryFallback',
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
            allowedExternalTakePaths: ['lifi', 'factory'],
            externalTakeRouteSelectionMode: 'maximize_profit',
            defaultFactoryLiquiditySource: LiquiditySource.UNISWAPV3,
            hybridGasQuoteFailureFallbackMode: 'factory_first',
            maxGasCostNative: 1,
          },
        },
        tokenAddresses: {
          weth: wethAddress,
        },
        subgraphUrl: 'http://example-subgraph',
      } as any,
      transports: createDiscoveryTransports(
        ethers.utils.parseUnits('1', 'gwei')
      ),
      rpcCache: {
        chainId: 1,
        gasPrice: ethers.utils.parseUnits('1', 'gwei'),
        gasPriceFetchedAt: Date.now(),
        factoryQuoteProviders:
          takeFactoryModule.createFactoryQuoteProviderRuntimeCache(),
      },
    });

    expect(takeLiquidationLifiStub.calledOnce).to.equal(true);
    expect(takeLiquidationFactoryStub.calledOnce).to.equal(true);
    expect(factoryQuoteStub.callCount).to.be.greaterThan(1);
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

  it('executes factory-only hybrid gas quote fallback for LI.FI plus factory routes', async () => {
    const {
      factoryQuoteStub,
      lifiQuoteStub,
      takeLiquidationLifiStub,
      takeLiquidationFactoryStub,
    } = await runLifiHybridGasFallbackScenario();

    expect(lifiQuoteStub.calledOnce).to.equal(true);
    expect(takeLiquidationLifiStub.called).to.equal(false);
    expect(takeLiquidationFactoryStub.calledOnce).to.equal(true);
    expect(factoryQuoteStub.callCount).to.be.greaterThan(1);
  });

  it('executes a default LI.FI discovered take path and records LI.FI route stats', async () => {
    const lifiQuoteStub = sinon
      .stub(lifiExecutionModule, 'getLifiPathQuoteEvaluation')
      .resolves({
        isTakeable: true,
        externalTakePath: 'lifi',
        selectedLiquiditySource: LiquiditySource.LIFI,
        quoteAmount: 125,
        quoteAmountRaw: ethers.utils.parseUnits('125', 6),
        collateralAmount: 1,
        marketPrice: 125,
        takeablePrice: 123.75,
        quotedCollateralWad: ethers.utils.parseEther('1'),
        quotedAuctionPriceWad: ethers.utils.parseEther('100'),
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

    const stats = await handleDiscoveredTakeTarget({
      pool: pool as any,
      signer: {
        provider: {
          getGasPrice: sinon.stub().resolves(BigNumber.from(1)),
        },
        getChainId: sinon.stub().resolves(8453),
      } as any,
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
        subgraphUrl: 'http://example-subgraph',
      } as any,
      transports: createDiscoveryTransports(),
    });

    expect(lifiQuoteStub.calledOnce).to.equal(true);
    expect(takeLiquidationLifiStub.calledOnce).to.equal(true);
    expect(stats.externalTakeByPath.lifi?.approved).to.equal(1);
    expect(stats.externalTakeByPath.lifi?.dryRun).to.equal(1);
    expect(stats.externalTakeByPath.lifi?.executed).to.equal(0);
    const summaryLog = getDiscoveredTakeSummary(loggerInfoStub);
    expect(summaryLog).to.include('approvedRoutes=lifi:1');
    expect(summaryLog).to.include('dryRunRoutes=lifi:1');
  });

  it('passes refreshed auction context into a reapproved direct LI.FI take', async () => {
    const refreshedAuctionPrice = ethers.utils.parseEther('99');
    sinon.stub(lifiExecutionModule, 'getLifiPathQuoteEvaluation').resolves({
      isTakeable: true,
      externalTakePath: 'lifi',
      selectedLiquiditySource: LiquiditySource.LIFI,
      quoteAmount: 125,
      quoteAmountRaw: ethers.utils.parseUnits('125', 6),
      routeMinOutRaw: ethers.utils.parseUnits('120', 6),
      collateralAmount: 1,
      marketPrice: 125,
      takeablePrice: 123.75,
      quotedCollateralWad: ethers.utils.parseEther('1'),
      quotedAuctionPriceWad: ethers.utils.parseEther('100'),
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

    await handleDiscoveredTakeTarget({
      pool: pool as any,
      signer: {
        provider: {
          getGasPrice: sinon.stub().resolves(BigNumber.from(1)),
        },
        getChainId: sinon.stub().resolves(8453),
      } as any,
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
        subgraphUrl: 'http://example-subgraph',
      } as any,
      transports: createDiscoveryTransports(),
    });

    expect(takeLiquidationLifiStub.calledOnce).to.equal(true);
    const lifiLiquidation = takeLiquidationLifiStub.firstCall.args[0]
      .liquidation as any;
    expect(lifiLiquidation.auctionPrice.eq(refreshedAuctionPrice)).to.equal(
      true
    );
    expect(
      lifiLiquidation.externalTakeQuoteEvaluation.quotedAuctionPriceWad.eq(
        refreshedAuctionPrice
      )
    ).to.equal(true);
    expect(
      lifiLiquidation.externalTakeQuoteEvaluation.quotedCollateralWad.eq(
        ethers.utils.parseEther('1')
      )
    ).to.equal(true);
  });

  it('applies configured gas and profit floors to a direct LI.FI discovered take approval', async () => {
    const wethAddress = '0x4200000000000000000000000000000000000006';
    const gasPrice = ethers.utils.parseUnits('1', 'gwei');
    const expectedApprovedMinOutRaw = ethers.utils.parseEther('101.0013');
    sinon.stub(erc20, 'getDecimalsErc20').resolves(18);
    sinon.stub(lifiExecutionModule, 'getLifiPathQuoteEvaluation').resolves({
      isTakeable: true,
      externalTakePath: 'lifi',
      selectedLiquiditySource: LiquiditySource.LIFI,
      quoteAmount: 125,
      quoteAmountRaw: ethers.utils.parseEther('125'),
      routeMinOutRaw: ethers.utils.parseEther('100'),
      collateralAmount: 1,
      marketPrice: 125,
      takeablePrice: 125,
      quotedCollateralWad: ethers.utils.parseEther('1'),
      quotedAuctionPriceWad: ethers.utils.parseEther('100'),
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

    await handleDiscoveredTakeTarget({
      pool: pool as any,
      signer: {
        provider: {
          getGasPrice: sinon.stub().resolves(gasPrice),
        },
        getChainId: sinon.stub().resolves(8453),
      } as any,
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
        subgraphUrl: 'http://example-subgraph',
      } as any,
      transports: createDiscoveryTransports(gasPrice),
      rpcCache: {
        chainId: 8453,
        gasPrice,
        gasPriceFetchedAt: Date.now(),
      } as any,
    });

    expect(takeLiquidationLifiStub.calledOnce).to.equal(true);
    const approvedEvaluation: any =
      takeLiquidationLifiStub.firstCall.args[0].liquidation
        .externalTakeQuoteEvaluation;
    expect(
      approvedEvaluation.approvedMinOutRaw.eq(expectedApprovedMinOutRaw)
    ).to.equal(true);
    expect(
      approvedEvaluation.profitMinOutRaw.eq(expectedApprovedMinOutRaw)
    ).to.equal(true);
    expect(
      approvedEvaluation.routeProfitability.routeExecutionCostQuoteRaw.eq(
        ethers.utils.parseEther('0.0013')
      )
    ).to.equal(true);
    expect(
      approvedEvaluation.routeProfitability.configuredProfitFloorQuoteRaw.eq(
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
    expect(gasTelemetry).to.include('path=lifi');
    expect(gasTelemetry).to.include('source=LIFI');
    expect(gasTelemetry).to.include('routeGasModel=dexGasOverrides');
    expect(gasTelemetry).to.include('configuredDexGasOverrideRaw=1000000');
    expect(gasTelemetry).to.include('routeGasLimit=1000000');
  });

  it('skips a direct LI.FI discovered take when the execution refresh circuit is open', async () => {
    const lifiQuoteStub = sinon
      .stub(lifiExecutionModule, 'getLifiPathQuoteEvaluation')
      .resolves({
        isTakeable: true,
        externalTakePath: 'lifi',
        selectedLiquiditySource: LiquiditySource.LIFI,
        quoteAmount: 125,
        quoteAmountRaw: ethers.utils.parseUnits('125', 6),
        collateralAmount: 1,
        marketPrice: 125,
        takeablePrice: 123.75,
        quotedCollateralWad: ethers.utils.parseEther('1'),
        quotedAuctionPriceWad: ethers.utils.parseEther('100'),
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

    const stats = await handleDiscoveredTakeTarget({
      pool: pool as any,
      signer: {
        provider: {
          getGasPrice: sinon.stub().resolves(BigNumber.from(1)),
        },
        getChainId: sinon.stub().resolves(8453),
      } as any,
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
        subgraphUrl: 'http://example-subgraph',
      } as any,
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
      } as any,
    });

    expect(lifiQuoteStub.calledOnce).to.equal(true);
    expect(takeLiquidationLifiStub.called).to.equal(false);
    expect(stats.externalTakeByPath.lifi?.preBroadcastFailures).to.equal(1);
    expect(stats.externalTakeByPath.lifi?.executed).to.equal(0);
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
      .stub(lifiExecutionModule, 'getLifiPathQuoteEvaluation')
      .resolves({
        isTakeable: false,
        externalTakePath: 'lifi',
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
    const rpcCache: any = {
      chainId: 8453,
      oneInchQuoteCircuit: {
        failures: 1,
      },
    };
    const params = {
      pool: pool as any,
      signer: {
        provider: {
          getGasPrice: sinon.stub().resolves(BigNumber.from(1)),
        },
        getChainId: sinon.stub().resolves(8453),
      } as any,
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
        subgraphUrl: 'http://example-subgraph',
      } as any,
      transports: createDiscoveryTransports(),
      rpcCache,
    };

    await handleDiscoveredTakeTarget(params as any);
    expect(lifiQuoteStub.calledOnce).to.equal(true);
    expect(takeLiquidationLifiStub.called).to.equal(false);
    expect(rpcCache.providerCircuits.lifi.route_quote.failures).to.equal(1);
    expect(rpcCache.providerCircuits.lifi.route_quote.cooldownUntilMs).to.be.a(
      'number'
    );
    expect(rpcCache.oneInchQuoteCircuit.failures).to.equal(1);

    lifiQuoteStub.resetHistory();
    await handleDiscoveredTakeTarget(params as any);
    expect(lifiQuoteStub.called).to.equal(false);
  });

  it('tries the next approved hybrid route when LI.FI fails before submission', async () => {
    const warnStub = sinon.stub(logger, 'warn');
    const scenario = createHybridLifiFallbackScenario();
    const takeLiquidationLifiStub = sinon
      .stub(lifiExecutionModule, 'takeLiquidationLifi')
      .callsFake(async (params: any) => {
        params.config.onLifiExecutionFailure?.({
          preBroadcast: true,
          error: 'LI.FI fresh quote min output below execution floor',
        });
        return false;
      });

    const stats = await handleDiscoveredTakeTarget(scenario.params as any);

    expect(scenario.lifiQuoteStub.calledOnce).to.equal(true);
    expect(scenario.factoryQuoteStub.calledOnce).to.equal(true);
    expect(takeLiquidationLifiStub.calledOnce).to.equal(true);
    expect(scenario.takeLiquidationFactoryStub.calledOnce).to.equal(true);
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
    (scenario.params.rpcCache as any).providerCircuits = {
      lifi: {
        execution_refresh: {
          failures: 1,
          cooldownUntilMs: Date.now() + 30_000,
        },
      },
    };

    const stats = await handleDiscoveredTakeTarget(scenario.params as any);

    expect(scenario.lifiQuoteStub.calledOnce).to.equal(true);
    expect(scenario.factoryQuoteStub.calledOnce).to.equal(true);
    expect(takeLiquidationLifiStub.called).to.equal(false);
    expect(scenario.takeLiquidationFactoryStub.calledOnce).to.equal(true);
    expect(stats.externalTakeByPath.lifi?.preBroadcastFailures).to.equal(1);
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
      factoryExpectedNetProfitRaw: ethers.utils.parseEther('29'),
      refreshedCollateral,
      refreshedAuctionPrice,
    });
    scenario.takeLiquidationFactoryStub.callsFake(async (params: any) => {
      params.config.onFactoryExecutionFailure?.({
        preBroadcast: true,
        error: 'factory gas estimate failed',
      });
      return false;
    });
    const takeLiquidationLifiStub = sinon
      .stub(lifiExecutionModule, 'takeLiquidationLifi')
      .resolves(true);

    const stats = await handleDiscoveredTakeTarget(scenario.params as any);

    expect(scenario.factoryQuoteStub.calledOnce).to.equal(true);
    expect(scenario.lifiQuoteStub.calledOnce).to.equal(true);
    expect(scenario.takeLiquidationFactoryStub.calledOnce).to.equal(true);
    expect(takeLiquidationLifiStub.calledOnce).to.equal(true);
    expect(stats.hybridFallbackAttempts).to.equal(1);
    expect(stats.hybridFallbackSuccesses).to.equal(1);

    const lifiLiquidation = takeLiquidationLifiStub.firstCall.args[0]
      .liquidation as any;
    expect(lifiLiquidation.collateral.eq(refreshedCollateral)).to.equal(true);
    expect(lifiLiquidation.auctionPrice.eq(refreshedAuctionPrice)).to.equal(
      true
    );
    expect(
      lifiLiquidation.externalTakeQuoteEvaluation.quotedCollateralWad.eq(
        refreshedCollateral
      )
    ).to.equal(true);
    expect(
      lifiLiquidation.externalTakeQuoteEvaluation.quotedAuctionPriceWad.eq(
        refreshedAuctionPrice
      )
    ).to.equal(true);
  });

  it('does not try fallback routes after LI.FI may have submitted a transaction', async () => {
    const scenario = createHybridLifiFallbackScenario();
    const takeLiquidationLifiStub = sinon
      .stub(lifiExecutionModule, 'takeLiquidationLifi')
      .callsFake(async (params: any) => {
        params.config.onLifiExecutionFailure?.({
          preBroadcast: false,
          error: 'relay accepted LI.FI take before timeout',
        });
        return false;
      });

    const stats = await handleDiscoveredTakeTarget(scenario.params as any);

    expect(takeLiquidationLifiStub.calledOnce).to.equal(true);
    expect(scenario.takeLiquidationFactoryStub.called).to.equal(false);
    expect(stats.hybridFallbackAttempts).to.equal(0);
    expect(stats.hybridFallbackSuccesses).to.equal(0);
  });
});
