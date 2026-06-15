import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, ethers } from 'ethers';
import {
  handleDiscoveredSettlementTarget,
  handleDiscoveredTakeTarget,
} from '../../src/discovery/handlers';
import { refreshDiscoveryGasPriceIfStale } from '../../src/discovery/take-executor';
import * as oneInchAggregatorExecutionModule from '../../src/take/oneinch-aggregator/execution';
import * as oneInchAggregatorQuoteModule from '../../src/take/oneinch-aggregator/quote-evaluation';
import * as takeFactoryModule from '../../src/take/direct-dex';
import * as lifiExecutionModule from '../../src/take/lifi/execution';
import * as settlementModule from '../../src/settlement';
import * as arbModule from '../../src/take/arb';
import { LiquiditySource } from '../../src/config';
import { ExternalTakeQuoteEvaluation } from '../../src/take/types';
import * as erc20 from '../../src/erc20';
import { DexRouter } from '../../src/dex/router';
import { logger } from '../../src/logging';
import {
  createDeferred,
  createDiscoveryTransports,
} from '../helpers/discovery';

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

function buildTakeableOneInchQuote(
  overrides: Partial<ExternalTakeQuoteEvaluation> = {}
): ExternalTakeQuoteEvaluation {
  const quoteAmountRaw = overrides.quoteAmountRaw ?? BigNumber.from(10);
  const approvedMinOutRaw =
    overrides.approvedMinOutRaw ??
    overrides.routeMinOutRaw ??
    BigNumber.from(10);
  const routeMinOutRaw = overrides.routeMinOutRaw ?? approvedMinOutRaw;
  const routeExecutionFloorRaw =
    overrides.routeExecutionFloorRaw ?? routeMinOutRaw;
  const calldataQuote = {
    providerId: 'oneinch' as const,
    quotedAtMs: Date.now(),
    chainId: 1,
    srcToken: '0x3333333333333333333333333333333333333333',
    dstToken: '0x2222222222222222222222222222222222222222',
    dstReceiver: '0x4444444444444444444444444444444444444444',
    amountInTokenUnits: BigNumber.from(1),
    quoteAmountRaw,
    routeMinOutRaw,
    transactionTarget: '0x5555555555555555555555555555555555555555',
    approvalSpender: '0x6666666666666666666666666666666666666666',
    callData: '0x12345678',
    selector: '0x12345678',
    txValue: '0',
    routeSummary: {
      providerId: 'oneinch' as const,
      tool: '1inch',
      feeCosts: [],
    },
    ...(overrides.calldataQuote ?? {}),
  };
  return {
    isTakeable: true,
    externalTakePath: 'calldata_aggregator',
    providerId: 'oneinch',
    selectedLiquiditySource: LiquiditySource.ONEINCH,
    quoteAmount: 10,
    quoteAmountRaw,
    routeMinOutRaw,
    routeExecutionFloorRaw,
    approvedMinOutRaw,
    collateralAmount: 1,
    marketPrice: 10,
    takeablePrice: 12,
    ...overrides,
    calldataQuote,
  };
}

describe('Discovery Handlers', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('skips a discovered take when subgraph data is stale before onchain revalidation', async () => {
    const takeLiquidationStub = sinon
      .stub(oneInchAggregatorExecutionModule, 'takeLiquidationOneInchAggregator')
      .resolves();
    const onCandidateInactive = sinon.spy();
    sinon
      .stub(oneInchAggregatorQuoteModule, 'getOneInchAggregatorPathQuoteEvaluation')
      .resolves(buildTakeableOneInchQuote());

    const getStatusStub = sinon.stub();
    getStatusStub
      .onCall(0)
      .resolves({
        collateral: ethers.utils.parseEther('1'),
        price: ethers.utils.parseEther('1'),
      })
      .onCall(1)
      .resolves({
        collateral: BigNumber.from(0),
        price: ethers.utils.parseEther('1'),
      });

    const pool = {
      name: 'Discovered Pool',
      poolAddress: '0x1111111111111111111111111111111111111111',
      quoteAddress: '0x2222222222222222222222222222222222222222',
      collateralAddress: '0x3333333333333333333333333333333333333333',
      getLiquidation: sinon.stub().returns({
        getStatus: getStatusStub,
      }),
    };
    const signer = {
      provider: {
        getGasPrice: sinon.stub().resolves(BigNumber.from(1)),
      },
      getChainId: sinon.stub().resolves(1),
    };

    await handleDiscoveredTakeTarget({
      pool: pool as any,
      signer: signer as any,
      target: {
        source: 'discovered',
        poolAddress: pool.poolAddress,
        name: pool.name,
        dryRun: true,
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerA',
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
          take: true,
        },
        subgraphUrl: 'http://example-subgraph',
      } as any,
      transports: createDiscoveryTransports(),
      onCandidateInactive,
    });

    expect(takeLiquidationStub.called).to.be.false;
    expect(onCandidateInactive.calledOnce).to.be.true;
    expect(onCandidateInactive.firstCall.args[0]).to.deep.equal({
      poolAddress: pool.poolAddress,
      borrower: '0xBorrowerA',
    });
  });

  it('falls back to per-candidate take status reads when a preload status is missing', async () => {
    const takeLiquidationStub = sinon
      .stub(oneInchAggregatorExecutionModule, 'takeLiquidationOneInchAggregator')
      .resolves(true);
    sinon
      .stub(oneInchAggregatorQuoteModule, 'getOneInchAggregatorPathQuoteEvaluation')
      .resolves(buildTakeableOneInchQuote());
    const borrowers = ['0xBorrowerA', '0xBorrowerB'];
    const statusCalls: string[] = [];
    let preloadFailed = false;
    const pool = {
      name: 'Discovered Preload Fallback Pool',
      poolAddress: '0x1111111111111111111111111111111111111112',
      quoteAddress: '0x2222222222222222222222222222222222222222',
      collateralAddress: '0x3333333333333333333333333333333333333333',
      getLiquidation: sinon.stub().callsFake((borrower: string) => ({
        getStatus: sinon.stub().callsFake(async () => {
          statusCalls.push(borrower);
          if (borrower === borrowers[0] && !preloadFailed) {
            preloadFailed = true;
            throw new Error('preload status read failed');
          }
          return {
            collateral: ethers.utils.parseEther('1'),
            price: ethers.utils.parseEther('1'),
          };
        }),
      })),
    };

    await handleDiscoveredTakeTarget({
      pool: pool as any,
      signer: {
        provider: {
          getGasPrice: sinon.stub().resolves(BigNumber.from(1)),
        },
        getChainId: sinon.stub().resolves(1),
      } as any,
      target: {
        source: 'discovered',
        poolAddress: pool.poolAddress,
        name: pool.name,
        dryRun: false,
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
        candidates: borrowers.map((borrower) => ({
          poolAddress: pool.poolAddress,
          borrower,
          kickTime: Date.now(),
          debtRemaining: '1',
          collateralRemaining: '1',
          neutralPrice: '1',
          debt: '1',
          collateral: '1',
          heuristicScore: 1,
        })),
      },
      config: {
        autoDiscover: {
          enabled: true,
          take: {
            enabled: true,
            maxConcurrentCandidateEvaluations: 2,
          },
        },
        subgraphUrl: 'http://example-subgraph',
      } as any,
      transports: createDiscoveryTransports(),
    });

    expect(
      statusCalls.filter((borrower) => borrower === borrowers[0]).length
    ).to.be.greaterThan(1);
    expect(takeLiquidationStub.calledOnce).to.be.true;
    expect(takeLiquidationStub.firstCall.args[0].liquidation.borrower).to.equal(
      borrowers[0]
    );
  });

  it('can execute multiple discovered candidates in one same-pool cascade when configured', async () => {
    const takeLiquidationStub = sinon
      .stub(oneInchAggregatorExecutionModule, 'takeLiquidationOneInchAggregator')
      .resolves(true);
    sinon
      .stub(oneInchAggregatorQuoteModule, 'getOneInchAggregatorPathQuoteEvaluation')
      .resolves(buildTakeableOneInchQuote());
    const borrowers = ['0xBorrowerA', '0xBorrowerB', '0xBorrowerC'];
    const statusCalls: string[] = [];
    const pool = {
      name: 'Discovered Same Pool Cascade',
      poolAddress: '0x1111111111111111111111111111111111111113',
      quoteAddress: '0x2222222222222222222222222222222222222222',
      collateralAddress: '0x3333333333333333333333333333333333333333',
      getLiquidation: sinon.stub().callsFake((borrower: string) => ({
        getStatus: sinon.stub().callsFake(async () => {
          statusCalls.push(borrower);
          return {
            collateral: ethers.utils.parseEther('1'),
            price: ethers.utils.parseEther('1'),
          };
        }),
      })),
    };

    await handleDiscoveredTakeTarget({
      pool: pool as any,
      signer: {
        provider: {
          getGasPrice: sinon.stub().resolves(BigNumber.from(1)),
        },
        getChainId: sinon.stub().resolves(1),
      } as any,
      target: {
        source: 'discovered',
        poolAddress: pool.poolAddress,
        name: pool.name,
        dryRun: false,
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
        candidates: borrowers.map((borrower) => ({
          poolAddress: pool.poolAddress,
          borrower,
          kickTime: Date.now(),
          debtRemaining: '1',
          collateralRemaining: '1',
          neutralPrice: '1',
          debt: '1',
          collateral: '1',
          heuristicScore: 1,
        })),
      },
      config: {
        autoDiscover: {
          enabled: true,
          take: {
            enabled: true,
            maxConcurrentCandidateEvaluations: 2,
            maxExecutionsPerPoolPerRun: 2,
          },
        },
        subgraphUrl: 'http://example-subgraph',
      } as any,
      transports: createDiscoveryTransports(),
    });

    expect(takeLiquidationStub.callCount).to.equal(2);
    expect(
      takeLiquidationStub
        .getCalls()
        .map((call) => call.args[0].liquidation.borrower)
    ).to.deep.equal(borrowers.slice(0, 2));
    expect(statusCalls).to.deep.equal([
      borrowers[0],
      borrowers[0],
      borrowers[1],
      borrowers[1],
    ]);
  });

  it('removes hot-cache candidates when the approved quote is stale after auction price increases', async () => {
    const takeLiquidationStub = sinon
      .stub(oneInchAggregatorExecutionModule, 'takeLiquidationOneInchAggregator')
      .resolves();
    const onCandidateInactive = sinon.spy();
    sinon
      .stub(oneInchAggregatorQuoteModule, 'getOneInchAggregatorPathQuoteEvaluation')
      .resolves(
        buildTakeableOneInchQuote({
          quotedAuctionPriceWad: ethers.utils.parseEther('1'),
          quotedCollateralWad: ethers.utils.parseEther('1'),
        })
      );

    const getStatusStub = sinon.stub();
    getStatusStub
      .onCall(0)
      .resolves({
        collateral: ethers.utils.parseEther('1'),
        price: ethers.utils.parseEther('1'),
      })
      .onCall(1)
      .resolves({
        collateral: ethers.utils.parseEther('1'),
        price: ethers.utils.parseEther('2'),
      });

    const pool = {
      name: 'Stale Quote Pool',
      poolAddress: '0x1111111111111111111111111111111111111112',
      quoteAddress: '0x2222222222222222222222222222222222222222',
      collateralAddress: '0x3333333333333333333333333333333333333333',
      getLiquidation: sinon.stub().returns({
        getStatus: getStatusStub,
      }),
    };

    await handleDiscoveredTakeTarget({
      pool: pool as any,
      signer: {
        provider: {
          getGasPrice: sinon.stub().resolves(BigNumber.from(1)),
        },
        getChainId: sinon.stub().resolves(1),
      } as any,
      target: {
        source: 'discovered',
        poolAddress: pool.poolAddress,
        name: pool.name,
        dryRun: true,
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerStalePrice',
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
          take: true,
        },
        subgraphUrl: 'http://example-subgraph',
      } as any,
      transports: createDiscoveryTransports(),
      onCandidateInactive,
    });

    expect(takeLiquidationStub.called).to.be.false;
    expect(onCandidateInactive.calledOnce).to.be.true;
    expect(onCandidateInactive.firstCall.args[0]).to.deep.equal({
      poolAddress: pool.poolAddress,
      borrower: '0xBorrowerStalePrice',
    });
  });

  it('skips discovered external takes when private write transport is required but unavailable', async () => {
    const takeLiquidationStub = sinon
      .stub(oneInchAggregatorExecutionModule, 'takeLiquidationOneInchAggregator')
      .resolves();
    const quoteStub = sinon
      .stub(oneInchAggregatorQuoteModule, 'getOneInchAggregatorPathQuoteEvaluation')
      .resolves({
        isTakeable: true,
        quoteAmount: 10,
        collateralAmount: 1,
        marketPrice: 10,
        takeablePrice: 12,
        quoteAmountRaw: BigNumber.from(10),
      });
    const warnStub = sinon.stub(logger, 'warn');
    const pool = {
      name: 'Public Transport Pool',
      poolAddress: '0x1111111111111111111111111111111111111111',
      quoteAddress: '0x2222222222222222222222222222222222222222',
      collateralAddress: '0x3333333333333333333333333333333333333333',
      getLiquidation: sinon.stub().returns({
        getStatus: sinon.stub().resolves({
          collateral: ethers.utils.parseEther('1'),
          price: ethers.utils.parseEther('1'),
        }),
      }),
    };
    const signer = {
      provider: {
        getGasPrice: sinon.stub().resolves(BigNumber.from(1)),
      },
      getChainId: sinon.stub().resolves(1),
    };

    await handleDiscoveredTakeTarget({
      pool: pool as any,
      signer: signer as any,
      target: {
        source: 'discovered',
        poolAddress: pool.poolAddress,
        name: pool.name,
        dryRun: false,
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerTransport',
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
            externalTakeTransportPolicy: 'require_private_or_relay',
          },
        },
        subgraphUrl: 'http://example-subgraph',
      } as any,
      transports: createDiscoveryTransports(),
    });

    expect(quoteStub.called).to.be.false;
    expect(takeLiquidationStub.called).to.be.false;
    expect(
      warnStub.calledWithMatch(
        sinon.match(
          'externalTakeTransportPolicy=require_private_or_relay; skipping target'
        )
      )
    ).to.be.true;
  });

  it('bubbles a discovered external take failure and does not fall through to arbTake', async () => {
    const takeLiquidationStub = sinon
      .stub(oneInchAggregatorExecutionModule, 'takeLiquidationOneInchAggregator')
      .rejects(new Error('external take failed'));
    const arbTakeLiquidationStub = sinon
      .stub(arbModule, 'arbTakeLiquidation')
      .resolves();
    sinon
      .stub(oneInchAggregatorQuoteModule, 'getOneInchAggregatorPathQuoteEvaluation')
      .resolves(buildTakeableOneInchQuote());
    sinon.stub(arbModule, 'checkIfArbTakeable').resolves({
      isArbTakeable: true,
      hpbIndex: 7,
      maxArbTakePrice: 2,
    } as any);

    const pool = {
      name: 'Discovered Pool',
      poolAddress: '0x1111111111111111111111111111111111111111',
      quoteAddress: '0x2222222222222222222222222222222222222222',
      collateralAddress: '0x3333333333333333333333333333333333333333',
      getLiquidation: sinon.stub().returns({
        getStatus: sinon.stub().resolves({
          collateral: ethers.utils.parseEther('1'),
          price: ethers.utils.parseEther('1'),
        }),
      }),
      getPrices: sinon.stub().resolves({
        hpb: ethers.utils.parseEther('1'),
      }),
    };
    const signer = {
      provider: {
        getGasPrice: sinon.stub().resolves(BigNumber.from(1)),
      },
      getChainId: sinon.stub().resolves(1),
    };

    try {
      await handleDiscoveredTakeTarget({
        pool: pool as any,
        signer: signer as any,
        target: {
          source: 'discovered',
          poolAddress: pool.poolAddress,
          name: pool.name,
          dryRun: false,
          take: {
            liquiditySource: LiquiditySource.ONEINCH,
            marketPriceFactor: 0.99,
            minCollateral: 0.1,
            hpbPriceFactor: 0.98,
          },
          candidates: [
            {
              poolAddress: pool.poolAddress,
              borrower: '0xBorrowerA',
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
            take: true,
          },
          subgraphUrl: 'http://example-subgraph',
          oneInchAggregatorTaker: '0x4444444444444444444444444444444444444444',
          oneInchRouters: {
            1: '0x5555555555555555555555555555555555555555',
          },
        } as any,
        transports: createDiscoveryTransports(),
      });
    } catch (error) {
      expect.fail(
        `Did not expect discovered take handler to throw: ${String(error)}`
      );
    }

    expect(takeLiquidationStub.calledOnce).to.be.true;
    expect(arbTakeLiquidationStub.called).to.be.false;
  });

  it('records retryable 1inch swap-data execution failures in the swap-data circuit', async () => {
    const loggerInfoStub = sinon.stub(logger, 'info');
    const rpcCache: any = {
      chainId: 1,
      gasPrice: BigNumber.from(1),
      gasPriceFetchedAt: Date.now(),
      factoryQuoteProviders:
        takeFactoryModule.createFactoryQuoteProviderRuntimeCache(),
    };
    const takeLiquidationStub = sinon
      .stub(oneInchAggregatorExecutionModule, 'takeLiquidationOneInchAggregator')
      .callsFake(async ({ config }: any) => {
        config.onOneInchAggregatorQuoteResult?.({
          success: false,
          retryable: true,
          errorCode: 429,
          error: 'rate limited',
        });
        return false;
      });
    sinon
      .stub(oneInchAggregatorQuoteModule, 'getOneInchAggregatorPathQuoteEvaluation')
      .resolves(buildTakeableOneInchQuote());

    const pool = {
      name: 'Discovered 1inch Circuit Pool',
      poolAddress: '0x1111111111111111111111111111111111111121',
      quoteAddress: '0x2222222222222222222222222222222222222222',
      collateralAddress: '0x3333333333333333333333333333333333333333',
      getLiquidation: sinon.stub().returns({
        getStatus: sinon.stub().resolves({
          collateral: ethers.utils.parseEther('1'),
          price: ethers.utils.parseEther('1'),
        }),
      }),
    };

    await handleDiscoveredTakeTarget({
      pool: pool as any,
      signer: {
        provider: {
          getGasPrice: sinon.stub().resolves(BigNumber.from(1)),
        },
        getChainId: sinon.stub().resolves(1),
      } as any,
      target: {
        source: 'discovered',
        poolAddress: pool.poolAddress,
        name: pool.name,
        dryRun: false,
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerSwapDataFailure',
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
            oneInchQuoteFailureThreshold: 2,
          },
        },
        subgraphUrl: 'http://example-subgraph',
        oneInchAggregatorTaker: '0x4444444444444444444444444444444444444444',
        oneInchRouters: {
          1: '0x5555555555555555555555555555555555555555',
        },
      } as any,
      transports: createDiscoveryTransports(BigNumber.from(1)),
      rpcCache,
    });

    expect(takeLiquidationStub.calledOnce).to.be.true;
    expect(rpcCache.oneInchQuoteCircuits?.swap_data?.failures).to.equal(1);
    const summaryLog = getDiscoveredTakeSummary(loggerInfoStub);
    expect(summaryLog).to.include('oneInchFailures=swapData:1');
  });

  it('passes the take write transport into discovered take execution', async () => {
    const takeWriteTransport = {
      mode: 'private_rpc',
      signer: {
        getAddress: sinon
          .stub()
          .resolves('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      },
      submitTransaction: sinon.stub(),
    };
    const takeLiquidationStub = sinon
      .stub(oneInchAggregatorExecutionModule, 'takeLiquidationOneInchAggregator')
      .resolves();
    sinon
      .stub(oneInchAggregatorQuoteModule, 'getOneInchAggregatorPathQuoteEvaluation')
      .resolves(buildTakeableOneInchQuote());

    const pool = {
      name: 'Discovered Pool',
      poolAddress: '0x1111111111111111111111111111111111111111',
      quoteAddress: '0x2222222222222222222222222222222222222222',
      collateralAddress: '0x3333333333333333333333333333333333333333',
      getLiquidation: sinon.stub().returns({
        getStatus: sinon.stub().resolves({
          collateral: ethers.utils.parseEther('1'),
          price: ethers.utils.parseEther('1'),
        }),
      }),
      getPrices: sinon.stub().resolves({
        hpb: ethers.utils.parseEther('1'),
      }),
    };

    await handleDiscoveredTakeTarget({
      pool: pool as any,
      signer: {
        getChainId: sinon.stub().resolves(1),
        provider: {},
      } as any,
      takeWriteTransport: takeWriteTransport as any,
      target: {
        source: 'discovered',
        poolAddress: pool.poolAddress,
        name: pool.name,
        dryRun: false,
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerA',
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
          take: true,
        },
        subgraphUrl: 'http://example-subgraph',
        oneInchAggregatorTaker: '0x4444444444444444444444444444444444444444',
        oneInchRouters: {
          1: '0x5555555555555555555555555555555555555555',
        },
      } as any,
      transports: createDiscoveryTransports(),
    });

    expect(takeLiquidationStub.calledOnce).to.be.true;
    expect(
      takeLiquidationStub.firstCall.args[0].config.takeWriteTransport
    ).to.equal(takeWriteTransport);
  });

  it('passes the take write transport into discovered arbTake execution', async () => {
    const takeWriteTransport = {
      mode: 'private_rpc',
      signer: {
        getAddress: sinon
          .stub()
          .resolves('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      },
      submitTransaction: sinon.stub(),
    };
    const arbTakeLiquidationStub = sinon
      .stub(arbModule, 'arbTakeLiquidation')
      .resolves(true);
    sinon.stub(arbModule, 'checkIfArbTakeable').resolves({
      isArbTakeable: true,
      hpbIndex: 7,
      maxArbTakePrice: 2,
    } as any);

    const pool = {
      name: 'Discovered Pool',
      poolAddress: '0x1111111111111111111111111111111111111111',
      quoteAddress: '0x2222222222222222222222222222222222222222',
      collateralAddress: '0x3333333333333333333333333333333333333333',
      getLiquidation: sinon.stub().returns({
        getStatus: sinon.stub().resolves({
          collateral: ethers.utils.parseEther('1'),
          price: ethers.utils.parseEther('1'),
        }),
      }),
      getPrices: sinon.stub().resolves({
        hpb: ethers.utils.parseEther('1'),
      }),
    };

    await handleDiscoveredTakeTarget({
      pool: pool as any,
      signer: {
        getChainId: sinon.stub().resolves(1),
        provider: {},
      } as any,
      takeWriteTransport: takeWriteTransport as any,
      target: {
        source: 'discovered',
        poolAddress: pool.poolAddress,
        name: pool.name,
        dryRun: false,
        take: {
          minCollateral: 0.1,
          hpbPriceFactor: 0.98,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerA',
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
          take: true,
        },
        subgraphUrl: 'http://example-subgraph',
      } as any,
      transports: createDiscoveryTransports(),
    });

    expect(arbTakeLiquidationStub.calledOnce).to.be.true;
    expect(
      arbTakeLiquidationStub.firstCall.args[0].config.takeWriteTransport
    ).to.equal(takeWriteTransport);
  });

  it('probes 1inch and factory hybrid external take paths in parallel', async () => {
    const loggerInfoStub = sinon.stub(logger, 'info');
    const loggerWarnStub = sinon.stub(logger, 'warn');
    const takeLiquidationStub = sinon
      .stub(oneInchAggregatorExecutionModule, 'takeLiquidationOneInchAggregator')
      .resolves(true);
    const takeLiquidationDirectDexStub = sinon
      .stub(takeFactoryModule, 'takeLiquidationDirectDex')
      .resolves(true);
    const oneInchDeferred = createDeferred<any>();
    const factoryDeferred = createDeferred<any>();
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const startedPaths: string[] = [];
    let resolveBothStarted!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      resolveBothStarted = resolve;
    });
    const markStarted = (path: string) => {
      startedPaths.push(path);
      if (startedPaths.length === 2) {
        resolveBothStarted();
      }
    };

    sinon
      .stub(oneInchAggregatorQuoteModule, 'getOneInchAggregatorPathQuoteEvaluation')
      .callsFake(async () => {
        markStarted('oneinch');
        return await oneInchDeferred.promise;
      });
    sinon
      .stub(takeFactoryModule, 'getFactoryTakeQuoteEvaluation')
      .callsFake(async () => {
        markStarted('direct_dex');
        return await factoryDeferred.promise;
      });

    const pool = {
      name: 'Hybrid Parallel Pool',
      poolAddress: '0x7777777777777777777777777777777777777777',
      quoteAddress: '0x2222222222222222222222222222222222222222',
      collateralAddress: '0x3333333333333333333333333333333333333333',
      getLiquidation: sinon.stub().returns({
        getStatus: sinon.stub().resolves({
          collateral: ethers.utils.parseEther('1'),
          price: ethers.utils.parseEther('100'),
        }),
      }),
    };
    const signer = {
      provider: {
        getGasPrice: sinon
          .stub()
          .resolves(ethers.utils.parseUnits('1', 'gwei')),
      },
      getChainId: sinon.stub().resolves(1),
    };

    const handlerPromise = handleDiscoveredTakeTarget({
      pool: pool as any,
      signer: signer as any,
      target: {
        source: 'discovered',
        poolAddress: pool.poolAddress,
        name: pool.name,
        dryRun: true,
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerHybrid',
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
            allowedCalldataAggregatorProviders: ['oneinch'],
            defaultDirectDexLiquiditySource: LiquiditySource.UNISWAPV3,
          },
        },
        tokenAddresses: {
          weth: pool.quoteAddress,
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

    await bothStarted;
    expect(startedPaths).to.have.members(['oneinch', 'direct_dex']);

    oneInchDeferred.resolve(buildTakeableOneInchQuote({
      isTakeable: true,
      externalTakePath: 'calldata_aggregator',
      selectedLiquiditySource: LiquiditySource.ONEINCH,
      quoteAmount: 125,
      quoteAmountRaw: ethers.utils.parseUnits('125', 6),
      collateralAmount: 1,
      marketPrice: 125,
      takeablePrice: 123.75,
      approvedMinOutRaw: ethers.utils.parseUnits('123', 6),
      quotedAuctionPriceWad: ethers.utils.parseEther('100'),
      quotedCollateralWad: ethers.utils.parseEther('1'),
      routeProfitability: {
        expectedNetProfitQuoteRaw: ethers.utils.parseUnits('20', 6),
        gasPriceWei: ethers.utils.parseUnits('1', 'gwei'),
        gasPolicyEvaluatedAt: Date.now(),
      },
    }));
    factoryDeferred.resolve({
      isTakeable: true,
      externalTakePath: 'direct_dex',
      selectedLiquiditySource: LiquiditySource.UNISWAPV3,
      selectedFeeTier: 500,
      quoteAmount: 130,
      quoteAmountRaw: ethers.utils.parseUnits('130', 6),
      collateralAmount: 1,
      marketPrice: 130,
      takeablePrice: 128.7,
      approvedMinOutRaw: ethers.utils.parseUnits('128', 6),
      quotedAuctionPriceWad: ethers.utils.parseEther('100'),
      quotedCollateralWad: ethers.utils.parseEther('1'),
      routeProfitability: {
        expectedNetProfitQuoteRaw: ethers.utils.parseUnits('10', 6),
        gasPriceWei: ethers.utils.parseUnits('1', 'gwei'),
        gasPolicyEvaluatedAt: Date.now(),
      },
    });

    await handlerPromise;

    expect(takeLiquidationStub.calledOnce).to.be.true;
    expect(takeLiquidationDirectDexStub.called).to.be.false;
    expect(
      loggerWarnStub
        .getCalls()
        .some((call) =>
          String(call.args[0]).includes('Hybrid gas quote fallback')
        )
    ).to.equal(false);
    const summaryLog = getDiscoveredTakeSummary(loggerInfoStub);
    expect(summaryLog).not.to.include('hybridFallbackAttempts');
    expect(summaryLog).not.to.include('hybridFallbackSuccesses');
    expect(summaryLog).not.to.include('hybridGasQuoteFallbackAttempts');
    expect(summaryLog).not.to.include('hybridGasQuoteFallbackSuccesses');
  });

  it('ranks hybrid paths by normalized expected net profit instead of 1inch gross output', async () => {
    const takeLiquidationStub = sinon
      .stub(oneInchAggregatorExecutionModule, 'takeLiquidationOneInchAggregator')
      .resolves(true);
    const takeLiquidationDirectDexStub = sinon
      .stub(takeFactoryModule, 'takeLiquidationDirectDex')
      .resolves(true);
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    sinon
      .stub(oneInchAggregatorQuoteModule, 'getOneInchAggregatorPathQuoteEvaluation')
      .resolves(buildTakeableOneInchQuote({
        isTakeable: true,
        externalTakePath: 'calldata_aggregator',
        selectedLiquiditySource: LiquiditySource.ONEINCH,
        quoteAmount: 130,
        quoteAmountRaw: ethers.utils.parseUnits('130', 6),
        collateralAmount: 1,
        marketPrice: 130,
        takeablePrice: 128.7,
        approvedMinOutRaw: ethers.utils.parseUnits('128', 6),
        quotedAuctionPriceWad: ethers.utils.parseEther('100'),
        quotedCollateralWad: ethers.utils.parseEther('1'),
      }));
    sinon.stub(takeFactoryModule, 'getFactoryTakeQuoteEvaluation').resolves({
      isTakeable: true,
      externalTakePath: 'direct_dex',
      selectedLiquiditySource: LiquiditySource.UNISWAPV3,
      selectedFeeTier: 500,
      quoteAmount: 125,
      quoteAmountRaw: ethers.utils.parseUnits('125', 6),
      collateralAmount: 1,
      marketPrice: 125,
      takeablePrice: 123.75,
      approvedMinOutRaw: ethers.utils.parseUnits('123', 6),
      quotedAuctionPriceWad: ethers.utils.parseEther('100'),
      quotedCollateralWad: ethers.utils.parseEther('1'),
      routeProfitability: {
        expectedNetProfitQuoteRaw: ethers.utils.parseUnits('40', 6),
        gasPriceWei: ethers.utils.parseUnits('1', 'gwei'),
        gasPolicyEvaluatedAt: Date.now(),
      },
    });

    const pool = {
      name: 'Hybrid Net Ranking Pool',
      poolAddress: '0x7777777777777777777777777777777777777778',
      quoteAddress: '0x2222222222222222222222222222222222222222',
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
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerHybridNet',
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
            allowedCalldataAggregatorProviders: ['oneinch'],
            defaultDirectDexLiquiditySource: LiquiditySource.UNISWAPV3,
          },
        },
        tokenAddresses: {
          weth: pool.quoteAddress,
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

    expect(takeLiquidationStub.called).to.be.false;
    expect(takeLiquidationDirectDexStub.calledOnce).to.be.true;
  });

  it('falls back to factory after a hybrid 1inch pre-broadcast execution failure', async () => {
    const loggerInfoStub = sinon.stub(logger, 'info');
    const takeLiquidationStub = sinon
      .stub(oneInchAggregatorExecutionModule, 'takeLiquidationOneInchAggregator')
      .callsFake(async ({ config }: any) => {
        config.onOneInchAggregatorExecutionFailure?.({
          preBroadcast: true,
          error: 'gas estimation failed',
        });
        return false;
      });
    const takeLiquidationDirectDexStub = sinon
      .stub(takeFactoryModule, 'takeLiquidationDirectDex')
      .resolves(true);
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    sinon
      .stub(oneInchAggregatorQuoteModule, 'getOneInchAggregatorPathQuoteEvaluation')
      .resolves(buildTakeableOneInchQuote({
        isTakeable: true,
        externalTakePath: 'calldata_aggregator',
        selectedLiquiditySource: LiquiditySource.ONEINCH,
        quoteAmount: 130,
        quoteAmountRaw: ethers.utils.parseUnits('130', 6),
        collateralAmount: 1,
        marketPrice: 130,
        takeablePrice: 128.7,
        approvedMinOutRaw: ethers.utils.parseUnits('128', 6),
        quotedAuctionPriceWad: ethers.utils.parseEther('100'),
        quotedCollateralWad: ethers.utils.parseEther('1'),
        routeProfitability: {
          expectedNetProfitQuoteRaw: ethers.utils.parseUnits('40', 6),
          gasPriceWei: ethers.utils.parseUnits('1', 'gwei'),
          gasPolicyEvaluatedAt: Date.now(),
        },
      }));
    sinon.stub(takeFactoryModule, 'getFactoryTakeQuoteEvaluation').resolves({
      isTakeable: true,
      externalTakePath: 'direct_dex',
      selectedLiquiditySource: LiquiditySource.UNISWAPV3,
      selectedFeeTier: 500,
      quoteAmount: 126,
      quoteAmountRaw: ethers.utils.parseUnits('126', 6),
      collateralAmount: 1,
      marketPrice: 126,
      takeablePrice: 124.74,
      approvedMinOutRaw: ethers.utils.parseUnits('124', 6),
      quotedAuctionPriceWad: ethers.utils.parseEther('100'),
      quotedCollateralWad: ethers.utils.parseEther('1'),
      routeProfitability: {
        expectedNetProfitQuoteRaw: ethers.utils.parseUnits('20', 6),
        gasPriceWei: ethers.utils.parseUnits('1', 'gwei'),
        gasPolicyEvaluatedAt: Date.now(),
      },
    });

    const getStatusStub = sinon.stub().resolves({
      collateral: ethers.utils.parseEther('1'),
      price: ethers.utils.parseEther('100'),
    });
    getStatusStub.onCall(2).resolves({
      collateral: ethers.utils.parseEther('1'),
      price: ethers.utils.parseEther('95'),
    });
    const pool = {
      name: 'Hybrid Pre-Broadcast Fallback Pool',
      poolAddress: '0x7777777777777777777777777777777777777785',
      quoteAddress: '0x2222222222222222222222222222222222222222',
      collateralAddress: '0x3333333333333333333333333333333333333333',
      getLiquidation: sinon.stub().returns({
        getStatus: getStatusStub,
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
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerHybridPreBroadcastFallback',
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
            allowedCalldataAggregatorProviders: ['oneinch'],
            defaultDirectDexLiquiditySource: LiquiditySource.UNISWAPV3,
          },
        },
        tokenAddresses: {
          weth: pool.quoteAddress,
        },
        subgraphUrl: 'http://example-subgraph',
        oneInchAggregatorTaker: '0x4444444444444444444444444444444444444444',
        oneInchRouters: {
          1: '0x5555555555555555555555555555555555555555',
        },
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

    expect(takeLiquidationStub.calledOnce).to.be.true;
    expect(takeLiquidationDirectDexStub.calledOnce).to.be.true;
    expect(
      takeLiquidationDirectDexStub.firstCall.args[0].liquidation.auctionPrice.eq(
        ethers.utils.parseEther('95')
      )
    ).to.be.true;
    const summaryLog = getDiscoveredTakeSummary(loggerInfoStub);
    expect(summaryLog).to.include('approvedRoutes=calldata_aggregator:1');
    expect(summaryLog).to.include('executedRoutes=direct_dex:1');
    expect(summaryLog).to.include('executedFactorySources=uniswapV3:1');
    expect(summaryLog).to.include('oneInchFailures=preBroadcast:1');
    expect(summaryLog).to.include('hybridFallbackAttempts=1');
    expect(summaryLog).to.include('hybridFallbackSuccesses=1');
  });

  it('falls back to 1inch after a hybrid factory pre-broadcast execution failure', async () => {
    const loggerInfoStub = sinon.stub(logger, 'info');
    const takeLiquidationStub = sinon
      .stub(oneInchAggregatorExecutionModule, 'takeLiquidationOneInchAggregator')
      .resolves(true);
    const takeLiquidationDirectDexStub = sinon
      .stub(takeFactoryModule, 'takeLiquidationDirectDex')
      .callsFake(async ({ config }: any) => {
        config.onFactoryExecutionFailure?.({
          preBroadcast: true,
          error: 'gas estimation failed',
        });
        return false;
      });
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    sinon
      .stub(oneInchAggregatorQuoteModule, 'getOneInchAggregatorPathQuoteEvaluation')
      .resolves(buildTakeableOneInchQuote({
        isTakeable: true,
        externalTakePath: 'calldata_aggregator',
        selectedLiquiditySource: LiquiditySource.ONEINCH,
        quoteAmount: 126,
        quoteAmountRaw: ethers.utils.parseUnits('126', 6),
        collateralAmount: 1,
        marketPrice: 126,
        takeablePrice: 124.74,
        approvedMinOutRaw: ethers.utils.parseUnits('124', 6),
        quotedAuctionPriceWad: ethers.utils.parseEther('100'),
        quotedCollateralWad: ethers.utils.parseEther('1'),
        routeProfitability: {
          expectedNetProfitQuoteRaw: ethers.utils.parseUnits('20', 6),
          gasPriceWei: ethers.utils.parseUnits('1', 'gwei'),
          gasPolicyEvaluatedAt: Date.now(),
        },
      }));
    sinon.stub(takeFactoryModule, 'getFactoryTakeQuoteEvaluation').resolves({
      isTakeable: true,
      externalTakePath: 'direct_dex',
      selectedLiquiditySource: LiquiditySource.UNISWAPV3,
      selectedFeeTier: 500,
      quoteAmount: 130,
      quoteAmountRaw: ethers.utils.parseUnits('130', 6),
      collateralAmount: 1,
      marketPrice: 130,
      takeablePrice: 128.7,
      approvedMinOutRaw: ethers.utils.parseUnits('128', 6),
      quotedAuctionPriceWad: ethers.utils.parseEther('100'),
      quotedCollateralWad: ethers.utils.parseEther('1'),
      routeProfitability: {
        expectedNetProfitQuoteRaw: ethers.utils.parseUnits('40', 6),
        gasPriceWei: ethers.utils.parseUnits('1', 'gwei'),
        gasPolicyEvaluatedAt: Date.now(),
      },
    });

    const pool = {
      name: 'Hybrid Factory Pre-Broadcast Fallback Pool',
      poolAddress: '0x7777777777777777777777777777777777777786',
      quoteAddress: '0x2222222222222222222222222222222222222222',
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
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerHybridFactoryPreBroadcastFallback',
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
            allowedCalldataAggregatorProviders: ['oneinch'],
            defaultDirectDexLiquiditySource: LiquiditySource.UNISWAPV3,
          },
        },
        tokenAddresses: {
          weth: pool.quoteAddress,
        },
        subgraphUrl: 'http://example-subgraph',
        oneInchAggregatorTaker: '0x4444444444444444444444444444444444444444',
        oneInchRouters: {
          1: '0x5555555555555555555555555555555555555555',
        },
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

    expect(takeLiquidationDirectDexStub.calledOnce).to.be.true;
    expect(takeLiquidationStub.calledOnce).to.be.true;
    const summaryLog = getDiscoveredTakeSummary(loggerInfoStub);
    expect(summaryLog).to.include('approvedRoutes=direct_dex:1');
    expect(summaryLog).to.include('approvedFactorySources=uniswapV3:1');
    expect(summaryLog).to.include('executedRoutes=calldata_aggregator:1');
    expect(summaryLog).to.include('factoryFailures=preBroadcast:1');
    expect(summaryLog).to.include('hybridFallbackAttempts=1');
    expect(summaryLog).to.include('hybridFallbackSuccesses=1');
  });

  it('falls back to factory when the hybrid 1inch probe times out', async () => {
    const loggerInfoStub = sinon.stub(logger, 'info');
    const loggerWarnStub = sinon.stub(logger, 'warn');
    const takeLiquidationDirectDexStub = sinon
      .stub(takeFactoryModule, 'takeLiquidationDirectDex')
      .resolves(true);
    sinon.stub(oneInchAggregatorExecutionModule, 'takeLiquidationOneInchAggregator').resolves(true);
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    sinon
      .stub(oneInchAggregatorQuoteModule, 'getOneInchAggregatorPathQuoteEvaluation')
      .rejects(new Error('timeout of 5ms exceeded'));
    sinon.stub(takeFactoryModule, 'getFactoryTakeQuoteEvaluation').resolves({
      isTakeable: true,
      externalTakePath: 'direct_dex',
      selectedLiquiditySource: LiquiditySource.UNISWAPV3,
      selectedFeeTier: 500,
      quoteAmount: 125,
      quoteAmountRaw: ethers.utils.parseUnits('125', 6),
      collateralAmount: 1,
      marketPrice: 125,
      takeablePrice: 123.75,
      approvedMinOutRaw: ethers.utils.parseUnits('123', 6),
      quotedAuctionPriceWad: ethers.utils.parseEther('100'),
      quotedCollateralWad: ethers.utils.parseEther('1'),
      routeProfitability: {
        expectedNetProfitQuoteRaw: ethers.utils.parseUnits('25', 6),
        gasPriceWei: ethers.utils.parseUnits('1', 'gwei'),
        gasPolicyEvaluatedAt: Date.now(),
      },
    });

    const pool = {
      name: 'Hybrid Timeout Pool',
      poolAddress: '0x7777777777777777777777777777777777777779',
      quoteAddress: '0x2222222222222222222222222222222222222222',
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
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerHybridTimeout',
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
            allowedCalldataAggregatorProviders: ['oneinch'],
            defaultDirectDexLiquiditySource: LiquiditySource.UNISWAPV3,
            oneInchQuoteTimeoutMs: 5,
          },
        },
        tokenAddresses: {
          weth: pool.quoteAddress,
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

    expect(takeLiquidationDirectDexStub.calledOnce).to.be.true;
    expect(
      loggerWarnStub
        .getCalls()
        .some((call) =>
          String(call.args[0]).includes('Hybrid gas quote fallback')
        )
    ).to.equal(false);
    const summaryLog = getDiscoveredTakeSummary(loggerInfoStub);
    expect(summaryLog).not.to.include('hybridFallbackAttempts');
    expect(summaryLog).not.to.include('hybridFallbackSuccesses');
    expect(summaryLog).not.to.include('hybridGasQuoteFallbackAttempts');
    expect(summaryLog).not.to.include('hybridGasQuoteFallbackSuccesses');
  });

  it('does not let a slow factory hybrid probe block a valid 1inch path', async () => {
    const takeLiquidationStub = sinon
      .stub(oneInchAggregatorExecutionModule, 'takeLiquidationOneInchAggregator')
      .resolves(true);
    const takeLiquidationDirectDexStub = sinon
      .stub(takeFactoryModule, 'takeLiquidationDirectDex')
      .resolves(true);
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    sinon
      .stub(oneInchAggregatorQuoteModule, 'getOneInchAggregatorPathQuoteEvaluation')
      .resolves(buildTakeableOneInchQuote({
        isTakeable: true,
        externalTakePath: 'calldata_aggregator',
        selectedLiquiditySource: LiquiditySource.ONEINCH,
        quoteAmount: 125,
        quoteAmountRaw: ethers.utils.parseUnits('125', 6),
        collateralAmount: 1,
        marketPrice: 125,
        takeablePrice: 123.75,
        approvedMinOutRaw: ethers.utils.parseUnits('123', 6),
        quotedAuctionPriceWad: ethers.utils.parseEther('100'),
        quotedCollateralWad: ethers.utils.parseEther('1'),
        routeProfitability: {
          expectedNetProfitQuoteRaw: ethers.utils.parseUnits('20', 6),
          gasPriceWei: ethers.utils.parseUnits('1', 'gwei'),
          gasPolicyEvaluatedAt: Date.now(),
        },
      }));
    sinon
      .stub(takeFactoryModule, 'getFactoryTakeQuoteEvaluation')
      .returns(new Promise(() => undefined) as any);

    const pool = {
      name: 'Hybrid Probe Timeout Pool',
      poolAddress: '0x7777777777777777777777777777777777777781',
      quoteAddress: '0x2222222222222222222222222222222222222222',
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
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerHybridProbeTimeout',
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
            allowedCalldataAggregatorProviders: ['oneinch'],
            defaultDirectDexLiquiditySource: LiquiditySource.UNISWAPV3,
            externalTakeProbeTimeoutMs: 5,
          },
        },
        tokenAddresses: {
          weth: pool.quoteAddress,
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

    expect(takeLiquidationStub.calledOnce).to.be.true;
    expect(takeLiquidationDirectDexStub.called).to.be.false;
  });

  it('executes 1inch when the hybrid factory probe has no collateral quote route', async () => {
    const loggerInfoStub = sinon.stub(logger, 'info');
    const loggerWarnStub = sinon.stub(logger, 'warn');
    const takeLiquidationStub = sinon
      .stub(oneInchAggregatorExecutionModule, 'takeLiquidationOneInchAggregator')
      .resolves(true);
    const takeLiquidationDirectDexStub = sinon
      .stub(takeFactoryModule, 'takeLiquidationDirectDex')
      .resolves(true);
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    sinon
      .stub(oneInchAggregatorQuoteModule, 'getOneInchAggregatorPathQuoteEvaluation')
      .resolves(buildTakeableOneInchQuote({
        isTakeable: true,
        externalTakePath: 'calldata_aggregator',
        selectedLiquiditySource: LiquiditySource.ONEINCH,
        quoteAmount: 125,
        quoteAmountRaw: ethers.utils.parseUnits('125', 6),
        collateralAmount: 1,
        marketPrice: 125,
        takeablePrice: 123.75,
        approvedMinOutRaw: ethers.utils.parseUnits('123', 6),
        quotedAuctionPriceWad: ethers.utils.parseEther('100'),
        quotedCollateralWad: ethers.utils.parseEther('1'),
        routeProfitability: {
          expectedNetProfitQuoteRaw: ethers.utils.parseUnits('20', 6),
          gasPriceWei: ethers.utils.parseUnits('1', 'gwei'),
          gasPolicyEvaluatedAt: Date.now(),
        },
      }));
    const factoryQuoteStub = sinon
      .stub(takeFactoryModule, 'getFactoryTakeQuoteEvaluation')
      .resolves({
        isTakeable: false,
        externalTakePath: 'direct_dex',
        selectedLiquiditySource: LiquiditySource.UNISWAPV3,
        reason: 'no collateral/quote factory route',
      });

    const pool = {
      name: 'Hybrid Factory No Route Pool',
      poolAddress: '0x77777777777777777777777777777777777777b1',
      quoteAddress: '0x2222222222222222222222222222222222222222',
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
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerHybridFactoryNoRoute',
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
            allowedCalldataAggregatorProviders: ['oneinch'],
            defaultDirectDexLiquiditySource: LiquiditySource.UNISWAPV3,
          },
        },
        tokenAddresses: {
          weth: pool.quoteAddress,
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

    expect(factoryQuoteStub.calledOnce).to.be.true;
    expect(takeLiquidationStub.calledOnce).to.be.true;
    expect(takeLiquidationDirectDexStub.called).to.be.false;
    expect(
      loggerWarnStub
        .getCalls()
        .some((call) =>
          String(call.args[0]).includes('Hybrid gas quote fallback')
        )
    ).to.equal(false);
    const summaryLog = getDiscoveredTakeSummary(loggerInfoStub);
    expect(summaryLog).to.include('approvedRoutes=calldata_aggregator:1');
    expect(summaryLog).to.include('executedRoutes=calldata_aggregator:1');
    expect(summaryLog).not.to.include('hybridFallbackAttempts');
    expect(summaryLog).not.to.include('hybridFallbackSuccesses');
    expect(summaryLog).not.to.include('hybridGasQuoteFallbackAttempts');
    expect(summaryLog).not.to.include('hybridGasQuoteFallbackSuccesses');
  });

  it('uses factory-first hybrid mode to avoid 1inch calls when factory approves first', async () => {
    const takeLiquidationDirectDexStub = sinon
      .stub(takeFactoryModule, 'takeLiquidationDirectDex')
      .resolves(true);
    const oneInchQuoteStub = sinon.stub(
      oneInchAggregatorQuoteModule,
      'getOneInchAggregatorPathQuoteEvaluation'
    );
    const oneInchGasQuoteStub = sinon
      .stub(DexRouter.prototype, 'getQuoteFromOneInch')
      .rejects(
        new Error('factory-first mode should not require gas conversion')
      );
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    sinon.stub(oneInchAggregatorExecutionModule, 'takeLiquidationOneInchAggregator').resolves(true);
    sinon.stub(takeFactoryModule, 'getFactoryTakeQuoteEvaluation').resolves({
      isTakeable: true,
      externalTakePath: 'direct_dex',
      selectedLiquiditySource: LiquiditySource.UNISWAPV3,
      selectedFeeTier: 500,
      quoteAmount: 125,
      quoteAmountRaw: ethers.utils.parseUnits('125', 6),
      collateralAmount: 1,
      marketPrice: 125,
      takeablePrice: 123.75,
      approvedMinOutRaw: ethers.utils.parseUnits('123', 6),
      quotedAuctionPriceWad: ethers.utils.parseEther('100'),
      quotedCollateralWad: ethers.utils.parseEther('1'),
      routeProfitability: {
        expectedNetProfitQuoteRaw: ethers.utils.parseUnits('25', 6),
      },
    });

    const pool = {
      name: 'Hybrid Factory First Pool',
      poolAddress: '0x7777777777777777777777777777777777777782',
      quoteAddress: '0x2222222222222222222222222222222222222222',
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
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerHybridCostAware',
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
            allowedCalldataAggregatorProviders: ['oneinch'],
            defaultDirectDexLiquiditySource: LiquiditySource.UNISWAPV3,
            externalTakeRouteSelectionMode: 'direct_dex_first',
          },
        },
        tokenAddresses: {
          weth: '0x4200000000000000000000000000000000000006',
        },
        oneInchRouters: {
          1: '0x1111111111111111111111111111111111111111',
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

    expect(oneInchQuoteStub.called).to.be.false;
    expect(oneInchGasQuoteStub.called).to.be.false;
    expect(takeLiquidationDirectDexStub.calledOnce).to.be.true;
  });

  it('continues factory-first probing when the approved factory path is subsidized', async () => {
    const takeLiquidationStub = sinon
      .stub(oneInchAggregatorExecutionModule, 'takeLiquidationOneInchAggregator')
      .resolves(true);
    const takeLiquidationDirectDexStub = sinon
      .stub(takeFactoryModule, 'takeLiquidationDirectDex')
      .resolves(true);
    const oneInchQuoteStub = sinon
      .stub(oneInchAggregatorQuoteModule, 'getOneInchAggregatorPathQuoteEvaluation')
      .resolves(buildTakeableOneInchQuote({
        isTakeable: true,
        externalTakePath: 'calldata_aggregator',
        selectedLiquiditySource: LiquiditySource.ONEINCH,
        quoteAmount: 126,
        quoteAmountRaw: ethers.utils.parseUnits('126', 6),
        collateralAmount: 1,
        marketPrice: 126,
        takeablePrice: 124.74,
        approvedMinOutRaw: ethers.utils.parseUnits('124', 6),
        quotedAuctionPriceWad: ethers.utils.parseEther('100'),
        quotedCollateralWad: ethers.utils.parseEther('1'),
        routeProfitability: {
          expectedNetProfitQuoteRaw: ethers.utils.parseUnits('20', 6),
          expectedSubsidyQuoteRaw: BigNumber.from(0),
          subsidyAllowed: false,
        },
      }));
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    sinon.stub(takeFactoryModule, 'getFactoryTakeQuoteEvaluation').resolves({
      isTakeable: true,
      externalTakePath: 'direct_dex',
      selectedLiquiditySource: LiquiditySource.UNISWAPV3,
      selectedFeeTier: 500,
      quoteAmount: 121,
      quoteAmountRaw: ethers.utils.parseUnits('121', 6),
      collateralAmount: 1,
      marketPrice: 121,
      takeablePrice: 119.79,
      approvedMinOutRaw: ethers.utils.parseUnits('100', 6),
      quotedAuctionPriceWad: ethers.utils.parseEther('100'),
      quotedCollateralWad: ethers.utils.parseEther('1'),
      routeProfitability: {
        expectedNetProfitQuoteRaw: ethers.utils.parseUnits('1', 6),
        expectedSubsidyQuoteRaw: ethers.utils.parseUnits('5', 6),
        subsidyAllowed: true,
      },
    });

    const pool = {
      name: 'Hybrid Factory First Subsidy Pool',
      poolAddress: '0x7777777777777777777777777777777777777792',
      quoteAddress: '0x2222222222222222222222222222222222222222',
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
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
          allowSubsidy: true,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerHybridFactoryFirstSubsidy',
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
            allowedCalldataAggregatorProviders: ['oneinch'],
            defaultDirectDexLiquiditySource: LiquiditySource.UNISWAPV3,
            externalTakeRouteSelectionMode: 'direct_dex_first',
          },
        },
        tokenAddresses: {
          weth: '0x4200000000000000000000000000000000000006',
        },
        oneInchRouters: {
          1: '0x1111111111111111111111111111111111111111',
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

    expect(oneInchQuoteStub.calledOnce).to.be.true;
    expect(takeLiquidationStub.calledOnce).to.be.true;
    expect(takeLiquidationDirectDexStub.called).to.be.false;
  });

  it('does not execute when all hybrid external take paths are rejected', async () => {
    const debugStub = sinon.stub(logger, 'debug');
    const takeLiquidationStub = sinon
      .stub(oneInchAggregatorExecutionModule, 'takeLiquidationOneInchAggregator')
      .resolves(true);
    const takeLiquidationDirectDexStub = sinon
      .stub(takeFactoryModule, 'takeLiquidationDirectDex')
      .resolves(true);
    sinon
      .stub(oneInchAggregatorQuoteModule, 'getOneInchAggregatorPathQuoteEvaluation')
      .resolves({
        isTakeable: false,
        reason: '1inch rejected',
      });
    sinon.stub(takeFactoryModule, 'getFactoryTakeQuoteEvaluation').resolves({
      isTakeable: false,
      reason: 'factory rejected',
    });

    const pool = {
      name: 'Hybrid Reject Pool',
      poolAddress: '0x7777777777777777777777777777777777777780',
      quoteAddress: '0x2222222222222222222222222222222222222222',
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
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerHybridReject',
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
            allowedCalldataAggregatorProviders: ['oneinch'],
            defaultDirectDexLiquiditySource: LiquiditySource.UNISWAPV3,
          },
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

    expect(takeLiquidationStub.called).to.be.false;
    expect(takeLiquidationDirectDexStub.called).to.be.false;
    expect(
      debugStub
        .getCalls()
        .some((call) =>
          String(call.args[0]).includes('no viable external take path')
        )
    ).to.be.true;
  });

  it('executes factory-first hybrid gas quote fallback when strict gas conversion fails', async () => {
    const warnStub = sinon.stub(logger, 'warn');
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const takeLiquidationStub = sinon
      .stub(oneInchAggregatorExecutionModule, 'takeLiquidationOneInchAggregator')
      .resolves(true);
    const takeLiquidationDirectDexStub = sinon
      .stub(takeFactoryModule, 'takeLiquidationDirectDex')
      .resolves(true);
    sinon
      .stub(oneInchAggregatorQuoteModule, 'getOneInchAggregatorPathQuoteEvaluation')
      .resolves({
        isTakeable: false,
        externalTakePath: 'calldata_aggregator',
        selectedLiquiditySource: LiquiditySource.ONEINCH,
        reason: '1inch unavailable',
      });
    const factoryQuote = {
      isTakeable: true,
      externalTakePath: 'direct_dex' as const,
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
    };
    const factoryQuoteStub = sinon
      .stub(takeFactoryModule, 'getFactoryTakeQuoteEvaluation')
      .resolves(factoryQuote);

    const pool = {
      name: 'Hybrid Gas Fallback Pool',
      poolAddress: '0x7777777777777777777777777777777777777781',
      quoteAddress: '0x2222222222222222222222222222222222222222',
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
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerHybridGasFallback',
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
            allowedCalldataAggregatorProviders: ['oneinch'],
            externalTakeRouteSelectionMode: 'maximize_profit',
            defaultDirectDexLiquiditySource: LiquiditySource.UNISWAPV3,
            hybridGasQuoteFailureFallbackMode: 'direct_dex_first',
            maxGasCostNative: 1,
          },
        },
        tokenAddresses: {
          weth: '0x4200000000000000000000000000000000000006',
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

    expect(takeLiquidationStub.called).to.be.false;
    expect(takeLiquidationDirectDexStub.calledOnce).to.be.true;
    expect(factoryQuoteStub.callCount).to.be.greaterThan(1);
    expect(
      warnStub
        .getCalls()
        .some((call) =>
          String(call.args[0]).includes('Hybrid gas quote fallback activated')
        )
    ).to.equal(true);
  });

  it('does not execute hybrid gas quote fallback when quote-denominated policy is configured', async () => {
    const debugStub = sinon.stub(logger, 'debug');
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    sinon.stub(oneInchAggregatorExecutionModule, 'takeLiquidationOneInchAggregator').resolves(true);
    const takeLiquidationDirectDexStub = sinon
      .stub(takeFactoryModule, 'takeLiquidationDirectDex')
      .resolves(true);
    sinon
      .stub(oneInchAggregatorQuoteModule, 'getOneInchAggregatorPathQuoteEvaluation')
      .resolves({
        isTakeable: false,
        externalTakePath: 'calldata_aggregator',
        selectedLiquiditySource: LiquiditySource.ONEINCH,
        reason: '1inch unavailable',
      });
    const factoryQuoteStub = sinon
      .stub(takeFactoryModule, 'getFactoryTakeQuoteEvaluation')
      .resolves({
        isTakeable: true,
        externalTakePath: 'direct_dex',
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
      });
    const pool = {
      name: 'Hybrid Gas Fallback Ineligible Pool',
      poolAddress: '0x7777777777777777777777777777777777777782',
      quoteAddress: '0x2222222222222222222222222222222222222222',
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
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerHybridGasFallbackIneligible',
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
            allowedCalldataAggregatorProviders: ['oneinch'],
            externalTakeRouteSelectionMode: 'maximize_profit',
            defaultDirectDexLiquiditySource: LiquiditySource.UNISWAPV3,
            hybridGasQuoteFailureFallbackMode: 'direct_dex_first',
            maxGasCostNative: 1,
            minExpectedProfitQuote: 0,
          },
        },
        tokenAddresses: {
          weth: '0x4200000000000000000000000000000000000006',
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

    expect(takeLiquidationDirectDexStub.called).to.equal(false);
    expect(factoryQuoteStub.calledOnce).to.equal(true);
    expect(
      debugStub
        .getCalls()
        .some((call) =>
          String(call.args[0]).includes('minExpectedProfitQuote is configured')
        )
    ).to.equal(true);
  });

  const createHybridGasFallbackFactoryQuote = (
    overrides: Record<string, unknown> = {}
  ) => ({
    isTakeable: true,
    externalTakePath: 'direct_dex' as const,
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
  });

  const createNativeToQuoteGasConversionReject = (
    overrides: Record<string, unknown> = {}
  ) => ({
    isTakeable: false,
    externalTakePath: 'direct_dex' as const,
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
  });

  it('uses a gas-quote fallback factory candidate when selected 1inch fails before submission', async () => {
    const warnStub = sinon.stub(logger, 'warn');
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const wethAddress = '0x4200000000000000000000000000000000000006';
    const takeLiquidationStub = sinon
      .stub(oneInchAggregatorExecutionModule, 'takeLiquidationOneInchAggregator')
      .callsFake(async (params: any) => {
        params.config.onOneInchAggregatorQuoteResult?.({
          success: false,
          retryable: true,
          error: '1inch swap-data unavailable',
        });
        params.config.onOneInchAggregatorExecutionFailure?.({
          preBroadcast: true,
          error: '1inch swap-data unavailable',
        });
        return false;
      });
    const takeLiquidationDirectDexStub = sinon
      .stub(takeFactoryModule, 'takeLiquidationDirectDex')
      .resolves(true);
    sinon
      .stub(oneInchAggregatorQuoteModule, 'getOneInchAggregatorPathQuoteEvaluation')
      .resolves(buildTakeableOneInchQuote({
        isTakeable: true,
        externalTakePath: 'calldata_aggregator',
        selectedLiquiditySource: LiquiditySource.ONEINCH,
        quoteAmount: 130,
        quoteAmountRaw: ethers.utils.parseUnits('130', 6),
        collateralAmount: 1,
        marketPrice: 130,
        takeablePrice: 128.7,
        approvedMinOutRaw: ethers.utils.parseUnits('100', 6),
        quotedAuctionPriceWad: ethers.utils.parseEther('100'),
        quotedCollateralWad: ethers.utils.parseEther('1'),
      }));
    const gasQuoteAttempts = [
      {
        source: LiquiditySource.UNISWAPV3,
        tokenIn: wethAddress,
        tokenOut: '0x2222222222222222222222222222222222222222',
        amountIn: '900000000000000',
        feeTiers: [3000, 100, 500, 10000],
        success: false,
        reason: 'no factory pool at configured fee tiers',
      },
    ];
    const factoryQuoteStub = sinon
      .stub(takeFactoryModule, 'getFactoryTakeQuoteEvaluation')
      .onFirstCall()
      .resolves({
        isTakeable: false,
        externalTakePath: 'direct_dex',
        selectedLiquiditySource: LiquiditySource.UNISWAPV3,
        reason: 'failed to quote gas cost into quote token',
        routeProfitability: {
          gasPolicyRejectCode: 'native_to_quote_conversion_unavailable',
          gasQuoteAttempts,
        },
      })
      .onSecondCall()
      .resolves(createHybridGasFallbackFactoryQuote());

    const pool = {
      name: 'Hybrid 1inch Fallback Candidate Pool',
      poolAddress: '0x77777777777777777777777777777777777777a1',
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
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerHybridOneInchThenFactoryFallback',
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
            allowedCalldataAggregatorProviders: ['oneinch'],
            externalTakeRouteSelectionMode: 'maximize_profit',
            defaultDirectDexLiquiditySource: LiquiditySource.UNISWAPV3,
            hybridGasQuoteFailureFallbackMode: 'direct_dex_first',
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

    expect(takeLiquidationStub.calledOnce).to.equal(true);
    expect(takeLiquidationDirectDexStub.calledOnce).to.equal(true);
    expect(factoryQuoteStub.callCount).to.be.greaterThan(1);
    expect(
      warnStub
        .getCalls()
        .some((call) =>
          String(call.args[0]).includes(
            'Hybrid 1inch path failed before submission'
          )
        )
    ).to.equal(true);
  });

  it('rechecks fallback factory repayment floors against refreshed auction state before execution', async () => {
    const debugStub = sinon.stub(logger, 'debug');
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const wethAddress = '0x4200000000000000000000000000000000000006';
    let oneInchAttempted = false;
    sinon
      .stub(oneInchAggregatorExecutionModule, 'takeLiquidationOneInchAggregator')
      .callsFake(async (params: any) => {
        oneInchAttempted = true;
        params.config.onOneInchAggregatorQuoteResult?.({
          success: false,
          retryable: true,
          error: '1inch swap-data unavailable',
        });
        params.config.onOneInchAggregatorExecutionFailure?.({
          preBroadcast: true,
          error: '1inch swap-data unavailable',
        });
        return false;
      });
    const takeLiquidationDirectDexStub = sinon
      .stub(takeFactoryModule, 'takeLiquidationDirectDex')
      .resolves(true);
    sinon
      .stub(oneInchAggregatorQuoteModule, 'getOneInchAggregatorPathQuoteEvaluation')
      .resolves(buildTakeableOneInchQuote({
        isTakeable: true,
        externalTakePath: 'calldata_aggregator',
        selectedLiquiditySource: LiquiditySource.ONEINCH,
        quoteAmount: 130,
        quoteAmountRaw: ethers.utils.parseUnits('130', 6),
        collateralAmount: 1,
        marketPrice: 130,
        takeablePrice: 128.7,
        approvedMinOutRaw: ethers.utils.parseUnits('100', 6),
        quotedAuctionPriceWad: ethers.utils.parseEther('100'),
        quotedCollateralWad: ethers.utils.parseEther('1'),
      }));
    sinon
      .stub(takeFactoryModule, 'getFactoryTakeQuoteEvaluation')
      .onFirstCall()
      .resolves({
        isTakeable: false,
        externalTakePath: 'direct_dex',
        selectedLiquiditySource: LiquiditySource.UNISWAPV3,
        reason: 'failed to quote gas cost into quote token',
        routeProfitability: {
          gasPolicyRejectCode: 'native_to_quote_conversion_unavailable',
          gasQuoteAttempts: [
            {
              source: LiquiditySource.UNISWAPV3,
              tokenIn: wethAddress,
              tokenOut: wethAddress,
              amountIn: '900000000000000',
              feeTiers: [3000, 100, 500, 10000],
              success: false,
              reason: 'no factory pool at configured fee tiers',
            },
          ],
        },
      })
      .onSecondCall()
      .resolves(
        createHybridGasFallbackFactoryQuote({
          quoteAmount: 125,
          quoteAmountRaw: ethers.utils.parseUnits('125', 6),
          approvedMinOutRaw: ethers.utils.parseUnits('100', 6),
        })
      );

    const getStatusStub = sinon.stub().callsFake(async () => ({
      collateral: ethers.utils.parseEther('1'),
      price: ethers.utils.parseEther(oneInchAttempted ? '126' : '100'),
    }));

    const pool = {
      name: 'Hybrid Fallback Reapproval Pool',
      poolAddress: '0x77777777777777777777777777777777777777a2',
      quoteAddress: wethAddress,
      collateralAddress: '0x3333333333333333333333333333333333333333',
      getLiquidation: sinon.stub().returns({
        getStatus: getStatusStub,
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
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerHybridFallbackReapproval',
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
            allowedCalldataAggregatorProviders: ['oneinch'],
            externalTakeRouteSelectionMode: 'maximize_profit',
            defaultDirectDexLiquiditySource: LiquiditySource.UNISWAPV3,
            hybridGasQuoteFailureFallbackMode: 'direct_dex_first',
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

    expect(takeLiquidationDirectDexStub.called).to.equal(false);
    expect(
      debugStub
        .getCalls()
        .some((call) =>
          String(call.args[0]).includes(
            'Hybrid fallback path rejected during final approval'
          )
        )
    ).to.equal(true);
  });

  async function runHybridGasFallbackScenario(
    options: {
      takePolicyOverrides?: Record<string, unknown>;
      targetTakeOverrides?: Record<string, unknown>;
      factoryEvaluations?: any[];
      gasPrice?: BigNumber;
      poolName?: string;
      borrower?: string;
    } = {}
  ) {
    const debugStub = sinon.stub(logger, 'debug');
    const warnStub = sinon.stub(logger, 'warn');
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const takeLiquidationStub = sinon
      .stub(oneInchAggregatorExecutionModule, 'takeLiquidationOneInchAggregator')
      .resolves(true);
    const takeLiquidationDirectDexStub = sinon
      .stub(takeFactoryModule, 'takeLiquidationDirectDex')
      .resolves(true);
    const lifiQuoteStub = sinon
      .stub(lifiExecutionModule, 'getLifiPathQuoteEvaluation')
      .resolves({
        isTakeable: false,
        externalTakePath: 'calldata_aggregator',
        selectedLiquiditySource: LiquiditySource.LIFI,
        reason: 'LI.FI unavailable',
      });
    sinon
      .stub(oneInchAggregatorQuoteModule, 'getOneInchAggregatorPathQuoteEvaluation')
      .resolves({
        isTakeable: false,
        externalTakePath: 'calldata_aggregator',
        selectedLiquiditySource: LiquiditySource.ONEINCH,
        reason: '1inch unavailable',
      });
    const factoryEvaluations = options.factoryEvaluations ?? [
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

    const pool = {
      name: options.poolName ?? 'Hybrid Gas Fallback Matrix Pool',
      poolAddress: '0x7777777777777777777777777777777777777791',
      quoteAddress: '0x2222222222222222222222222222222222222222',
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
            .resolves(options.gasPrice ?? ethers.utils.parseUnits('1', 'gwei')),
        },
        getChainId: sinon.stub().resolves(1),
      } as any,
      target: {
        source: 'discovered',
        poolAddress: pool.poolAddress,
        name: pool.name,
        dryRun: false,
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
          ...options.targetTakeOverrides,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: options.borrower ?? '0xBorrowerHybridGasFallbackMatrix',
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
            allowedCalldataAggregatorProviders: ['oneinch'],
            externalTakeRouteSelectionMode: 'maximize_profit',
            defaultDirectDexLiquiditySource: LiquiditySource.UNISWAPV3,
            hybridGasQuoteFailureFallbackMode: 'direct_dex_first',
            maxGasCostNative: 1,
            ...options.takePolicyOverrides,
          },
        },
        tokenAddresses: {
          weth: '0x4200000000000000000000000000000000000006',
        },
        subgraphUrl: 'http://example-subgraph',
      } as any,
      transports: createDiscoveryTransports(
        options.gasPrice ?? ethers.utils.parseUnits('1', 'gwei')
      ),
      rpcCache: {
        chainId: 1,
        gasPrice: options.gasPrice ?? ethers.utils.parseUnits('1', 'gwei'),
        gasPriceFetchedAt: Date.now(),
        factoryQuoteProviders:
          takeFactoryModule.createFactoryQuoteProviderRuntimeCache(),
      },
    });

    return {
      debugStub,
      warnStub,
      factoryQuoteStub,
      lifiQuoteStub,
      takeLiquidationStub,
      takeLiquidationDirectDexStub,
    };
  }

  it('does not execute hybrid gas quote fallback when fallback mode is disabled', async () => {
    const { debugStub, factoryQuoteStub, takeLiquidationDirectDexStub } =
      await runHybridGasFallbackScenario({
        takePolicyOverrides: {
          hybridGasQuoteFailureFallbackMode: 'disabled',
        },
      });

    expect(takeLiquidationDirectDexStub.called).to.equal(false);
    expect(factoryQuoteStub.calledOnce).to.equal(true);
    expect(
      debugStub
        .getCalls()
        .some((call) => String(call.args[0]).includes('fallback disabled'))
    ).to.equal(true);
  });

  for (const { name, takePolicyOverrides, expectedLog } of [
    {
      name: 'route selection mode is not maximize_profit',
      takePolicyOverrides: {
        externalTakeRouteSelectionMode: 'direct_dex_first',
      },
      expectedLog: 'route selection mode is not maximize_profit',
    },
    {
      name: 'hybrid paths do not include direct_dex and at least one aggregator path',
      takePolicyOverrides: {
        allowedExternalTakePaths: ['direct_dex'],
        allowedCalldataAggregatorProviders: undefined,
      },
      expectedLog:
        'hybrid paths do not include direct_dex and at least one aggregator path',
    },
  ]) {
    it(`does not execute hybrid gas quote fallback when ${name}`, async () => {
      const { debugStub, factoryQuoteStub, takeLiquidationDirectDexStub } =
        await runHybridGasFallbackScenario({
          takePolicyOverrides,
          factoryEvaluations: [createNativeToQuoteGasConversionReject()],
        });

      expect(takeLiquidationDirectDexStub.called).to.equal(false);
      expect(factoryQuoteStub.calledOnce).to.equal(true);
      expect(
        debugStub
          .getCalls()
          .some((call) => String(call.args[0]).includes(expectedLog))
      ).to.equal(true);
    });
  }

  it('does not execute hybrid gas quote fallback when the fallback factory rerun has no takeable route', async () => {
    const { debugStub, factoryQuoteStub, takeLiquidationDirectDexStub } =
      await runHybridGasFallbackScenario({
        factoryEvaluations: [
          createNativeToQuoteGasConversionReject(),
          {
            isTakeable: false,
            externalTakePath: 'direct_dex',
            selectedLiquiditySource: LiquiditySource.UNISWAPV3,
            reason: 'route quote below repayment floor',
          },
        ],
      });

    expect(takeLiquidationDirectDexStub.called).to.equal(false);
    expect(factoryQuoteStub.callCount).to.equal(2);
    expect(
      debugStub
        .getCalls()
        .some((call) =>
          String(call.args[0]).includes(
            'Hybrid gas quote fallback direct_dex quote rejected'
          )
        )
    ).to.equal(true);
  });

  for (const { field, value, expectedLog } of [
    {
      field: 'maxGasCostQuote',
      value: 1,
      expectedLog: 'maxGasCostQuote is configured',
    },
    {
      field: 'minProfitNative',
      value: '1',
      expectedLog: 'minProfitNative is configured',
    },
  ]) {
    it(`does not execute hybrid gas quote fallback when ${field} is configured`, async () => {
      const { debugStub, factoryQuoteStub, takeLiquidationDirectDexStub } =
        await runHybridGasFallbackScenario({
          takePolicyOverrides: {
            [field]: value,
          },
        });

      expect(takeLiquidationDirectDexStub.called).to.equal(false);
      expect(factoryQuoteStub.calledOnce).to.equal(true);
      expect(
        debugStub
          .getCalls()
          .some((call) => String(call.args[0]).includes(expectedLog))
      ).to.equal(true);
    });
  }

  it('does not execute hybrid gas quote fallback when maxGasPriceGwei rejects', async () => {
    const { factoryQuoteStub, takeLiquidationDirectDexStub } =
      await runHybridGasFallbackScenario({
        takePolicyOverrides: {
          maxGasPriceGwei: 0.5,
        },
      });

    expect(takeLiquidationDirectDexStub.called).to.equal(false);
    expect(factoryQuoteStub.calledOnce).to.equal(true);
  });

  it('does not execute hybrid gas quote fallback when maxGasCostNative rejects', async () => {
    const { factoryQuoteStub, takeLiquidationDirectDexStub } =
      await runHybridGasFallbackScenario({
        takePolicyOverrides: {
          maxGasCostNative: 0,
        },
      });

    expect(takeLiquidationDirectDexStub.called).to.equal(false);
    expect(factoryQuoteStub.calledOnce).to.equal(true);
  });

  it('does not execute hybrid gas quote fallback for subsidized factory routes', async () => {
    const { debugStub, takeLiquidationDirectDexStub } =
      await runHybridGasFallbackScenario({
        targetTakeOverrides: {
          allowSubsidy: true,
        },
        factoryEvaluations: [
          createHybridGasFallbackFactoryQuote(),
          createHybridGasFallbackFactoryQuote({
            routeProfitability: {
              subsidyAllowed: true,
              expectedSubsidyQuoteRaw: ethers.utils.parseUnits('1', 6),
            },
          }),
        ],
      });

    expect(takeLiquidationDirectDexStub.called).to.equal(false);
    expect(
      debugStub
        .getCalls()
        .some((call) =>
          String(call.args[0]).includes('rejected subsidized factory route')
        )
    ).to.equal(true);
  });

  it('executes hybrid gas quote fallback when factory route context rejects only native-to-quote gas conversion', async () => {
    const loggerInfoStub = sinon.stub(logger, 'info');
    const gasQuoteAttempts = [
      {
        source: LiquiditySource.UNISWAPV3,
        tokenIn: '0x4200000000000000000000000000000000000006',
        tokenOut: '0x2222222222222222222222222222222222222222',
        amountIn: '900000000000000',
        feeTiers: [3000, 100, 500, 10000],
        success: false,
        reason: 'no factory pool at configured fee tiers',
      },
    ];
    const { warnStub, factoryQuoteStub, takeLiquidationDirectDexStub } =
      await runHybridGasFallbackScenario({
        factoryEvaluations: [
          {
            isTakeable: false,
            externalTakePath: 'direct_dex',
            selectedLiquiditySource: LiquiditySource.UNISWAPV3,
            reason: 'failed to quote gas cost into quote token',
            routeProfitability: {
              gasPolicyRejectCode: 'native_to_quote_conversion_unavailable',
              gasQuoteAttempts,
            },
          },
          createHybridGasFallbackFactoryQuote(),
        ],
      });

    expect(takeLiquidationDirectDexStub.calledOnce).to.equal(true);
    expect(factoryQuoteStub.callCount).to.be.greaterThan(1);
    expect(
      warnStub
        .getCalls()
        .some(
          (call) =>
            String(call.args[0]).includes(
              'Hybrid gas quote fallback activated'
            ) && String(call.args[0]).includes('UNISWAPV3')
        )
    ).to.equal(true);
    const summaryLog = getDiscoveredTakeSummary(loggerInfoStub);
    expect(summaryLog).not.to.include('hybridFallbackAttempts');
    expect(summaryLog).not.to.include('hybridFallbackSuccesses');
    expect(summaryLog).to.include('hybridGasQuoteFallbackAttempts=1');
    expect(summaryLog).to.include('hybridGasQuoteFallbackSuccesses=1');
  });

  it('preserves configured factory liquidity source allowlists during hybrid gas quote fallback reruns', async () => {
    const { factoryQuoteStub, takeLiquidationDirectDexStub } =
      await runHybridGasFallbackScenario({
        takePolicyOverrides: {
          allowedLiquiditySources: [LiquiditySource.UNISWAPV3],
        },
        factoryEvaluations: [
          createNativeToQuoteGasConversionReject(),
          createHybridGasFallbackFactoryQuote(),
        ],
      });

    expect(takeLiquidationDirectDexStub.calledOnce).to.equal(true);
    expect(factoryQuoteStub.callCount).to.be.greaterThan(1);
    expect(
      factoryQuoteStub.firstCall.args[7]!.allowedLiquiditySources
    ).to.deep.equal([LiquiditySource.UNISWAPV3]);
    expect(
      factoryQuoteStub.secondCall.args[7]!.allowedLiquiditySources
    ).to.deep.equal([LiquiditySource.UNISWAPV3]);
  });

  it('does not clear 1inch circuit failures for local policy quote rejects', async () => {
    sinon.stub(oneInchAggregatorExecutionModule, 'takeLiquidationOneInchAggregator').resolves(true);
    const oneInchQuoteStub = sinon
      .stub(oneInchAggregatorQuoteModule, 'getOneInchAggregatorPathQuoteEvaluation')
      .resolves({
        isTakeable: false,
        externalTakePath: 'calldata_aggregator',
        selectedLiquiditySource: LiquiditySource.ONEINCH,
        reason: 'missing 1inch router for chain 8453',
      });
    const rpcCache = {
      chainId: 8453,
      gasPrice: ethers.utils.parseUnits('1', 'gwei'),
      gasPriceFetchedAt: Date.now(),
      oneInchQuoteCircuit: {
        failures: 1,
      },
    };
    const pool = {
      name: 'Local 1inch Reject Pool',
      poolAddress: '0x7777777777777777777777777777777777783',
      quoteAddress: '0x2222222222222222222222222222222222222222',
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
        getChainId: sinon.stub().resolves(8453),
      } as any,
      target: {
        source: 'discovered',
        poolAddress: pool.poolAddress,
        name: pool.name,
        dryRun: false,
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerLocalReject',
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
          },
        },
        subgraphUrl: 'http://example-subgraph',
      } as any,
      transports: createDiscoveryTransports(
        ethers.utils.parseUnits('1', 'gwei')
      ),
      rpcCache,
    });

    expect(oneInchQuoteStub.calledOnce).to.be.true;
    expect(rpcCache.oneInchQuoteCircuit.failures).to.equal(1);
  });

  it('refuses execution when a hybrid quote resolves to an inconsistent path and source', async () => {
    const debugStub = sinon.stub(logger, 'debug');
    const takeLiquidationStub = sinon
      .stub(oneInchAggregatorExecutionModule, 'takeLiquidationOneInchAggregator')
      .resolves(true);
    const takeLiquidationDirectDexStub = sinon
      .stub(takeFactoryModule, 'takeLiquidationDirectDex')
      .resolves(true);
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    sinon.stub(takeFactoryModule, 'getFactoryTakeQuoteEvaluation').resolves({
      isTakeable: true,
      externalTakePath: 'direct_dex',
      selectedLiquiditySource: LiquiditySource.ONEINCH,
      quoteAmount: 125,
      quoteAmountRaw: ethers.utils.parseUnits('125', 6),
      collateralAmount: 1,
      marketPrice: 125,
      takeablePrice: 123.75,
      approvedMinOutRaw: ethers.utils.parseUnits('123', 6),
      quotedAuctionPriceWad: ethers.utils.parseEther('100'),
      quotedCollateralWad: ethers.utils.parseEther('1'),
      routeProfitability: {
        gasPolicyEvaluatedAt: Date.now(),
      },
    });

    const pool = {
      name: 'Hybrid Disabled Path Pool',
      poolAddress: '0x7777777777777777777777777777777777781',
      quoteAddress: '0x2222222222222222222222222222222222222222',
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
          liquiditySource: LiquiditySource.UNISWAPV3,
          marketPriceFactor: 0.99,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerHybridDisabledPath',
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
            allowedExternalTakePaths: ['direct_dex'],
            defaultDirectDexLiquiditySource: LiquiditySource.UNISWAPV3,
          },
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

    expect(takeLiquidationStub.called).to.be.false;
    expect(takeLiquidationDirectDexStub.called).to.be.false;
    expect(
      debugStub
        .getCalls()
        .some((call) =>
          String(call.args[0]).includes(
            'selected inconsistent path=direct_dex source=ONEINCH'
          )
        )
    ).to.be.true;
  });

  it('refuses execution when a factory hybrid quote has no selected factory source', async () => {
    const debugStub = sinon.stub(logger, 'debug');
    const takeLiquidationDirectDexStub = sinon
      .stub(takeFactoryModule, 'takeLiquidationDirectDex')
      .resolves(true);
    sinon.stub(oneInchAggregatorExecutionModule, 'takeLiquidationOneInchAggregator').resolves(true);
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    sinon.stub(takeFactoryModule, 'getFactoryTakeQuoteEvaluation').resolves({
      isTakeable: true,
      externalTakePath: 'direct_dex',
      quoteAmount: 125,
      quoteAmountRaw: ethers.utils.parseUnits('125', 6),
      collateralAmount: 1,
      marketPrice: 125,
      takeablePrice: 123.75,
      approvedMinOutRaw: ethers.utils.parseUnits('123', 6),
      quotedAuctionPriceWad: ethers.utils.parseEther('100'),
      quotedCollateralWad: ethers.utils.parseEther('1'),
      routeProfitability: {
        gasPolicyEvaluatedAt: Date.now(),
      },
    });

    const pool = {
      name: 'Hybrid Missing Source Pool',
      poolAddress: '0x7777777777777777777777777777777777782',
      quoteAddress: '0x2222222222222222222222222222222222222222',
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
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerHybridMissingSource',
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
            allowedExternalTakePaths: ['direct_dex'],
            defaultDirectDexLiquiditySource: LiquiditySource.UNISWAPV3,
          },
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

    expect(takeLiquidationDirectDexStub.called).to.be.false;
    expect(
      debugStub
        .getCalls()
        .some((call) =>
          String(call.args[0]).includes(
            'selected direct_dex path without a concrete direct DEX source'
          )
        )
    ).to.be.true;
  });

  it('shares and logs a failing in-flight gas price refresh', async () => {
    const warnStub = sinon.stub(logger, 'warn');
    const gasPriceDeferred = createDeferred<BigNumber>();
    const getGasPriceStub = sinon.stub().returns(gasPriceDeferred.promise);
    const rpcCache: any = { chainId: 1 };
    const transports = {
      readRpc: {
        getGasPrice: getGasPriceStub,
      },
    } as any;
    const firstRefresh = refreshDiscoveryGasPriceIfStale({
      rpcCache,
      transports,
    });
    const secondRefresh = refreshDiscoveryGasPriceIfStale({
      rpcCache,
      transports,
    });
    await Promise.resolve();

    expect(getGasPriceStub.calledOnce).to.be.true;
    gasPriceDeferred.reject(new Error('rpc gas price down'));
    const results = await Promise.allSettled([firstRefresh, secondRefresh]);

    expect(results.map((result) => result.status)).to.deep.equal([
      'rejected',
      'rejected',
    ]);
    expect(rpcCache.gasPriceInflight).to.be.undefined;
    expect(
      warnStub
        .getCalls()
        .some((call) =>
          String(call.args[0])
            .toLowerCase()
            .includes('discovery gas price fetch failed')
        )
    ).to.be.true;
  });

  it('does not let an abandoned 1inch probe overwrite circuit state after timeout', async () => {
    const clock = sinon.useFakeTimers();
    try {
      const oneInchDeferred = createDeferred<any>();
      sinon
        .stub(oneInchAggregatorQuoteModule, 'getOneInchAggregatorPathQuoteEvaluation')
        .returns(oneInchDeferred.promise);
      const takeLiquidationStub = sinon
        .stub(oneInchAggregatorExecutionModule, 'takeLiquidationOneInchAggregator')
        .resolves(true);
      const rpcCache: any = {
        chainId: 1,
        factoryQuoteProviders:
          takeFactoryModule.createFactoryQuoteProviderRuntimeCache(),
      };
      const transports = createDiscoveryTransports(
        ethers.utils.parseUnits('1', 'gwei')
      );
      const pool = {
        name: 'Hybrid Timeout Pool',
        poolAddress: '0x7777777777777777777777777777777777783',
        quoteAddress: '0x2222222222222222222222222222222222222222',
        collateralAddress: '0x3333333333333333333333333333333333333333',
        getLiquidation: sinon.stub().returns({
          getStatus: sinon.stub().resolves({
            collateral: ethers.utils.parseEther('1'),
            price: ethers.utils.parseEther('100'),
          }),
        }),
      };

      const handlePromise = handleDiscoveredTakeTarget({
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
            liquiditySource: LiquiditySource.ONEINCH,
            marketPriceFactor: 0.99,
          },
          candidates: [
            {
              poolAddress: pool.poolAddress,
              borrower: '0xBorrowerHybridTimeout',
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
              allowedExternalTakePaths: ['calldata_aggregator'],
              externalTakeRouteSelectionMode: 'direct_dex_first',
              externalTakeProbeTimeoutMs: 50,
              oneInchQuoteFailureThreshold: 2,
            },
          },
          subgraphUrl: 'http://example-subgraph',
        } as any,
        transports,
        rpcCache,
      });

      await clock.tickAsync(50);
      await handlePromise;
      expect(rpcCache.oneInchQuoteCircuit?.failures).to.equal(1);
      expect(takeLiquidationStub.called).to.be.false;

      oneInchDeferred.resolve(buildTakeableOneInchQuote({
        isTakeable: true,
        externalTakePath: 'calldata_aggregator',
        selectedLiquiditySource: LiquiditySource.ONEINCH,
        quoteAmount: 125,
        quoteAmountRaw: ethers.utils.parseUnits('125', 6),
        collateralAmount: 1,
        marketPrice: 125,
        takeablePrice: 123.75,
        approvedMinOutRaw: ethers.utils.parseUnits('123', 6),
        quotedAuctionPriceWad: ethers.utils.parseEther('100'),
        quotedCollateralWad: ethers.utils.parseEther('1'),
      }));
      await clock.tickAsync(0);
      expect(rpcCache.oneInchQuoteCircuit?.failures).to.equal(1);
      expect(transports.readRpc.getGasPrice.called).to.be.false;
    } finally {
      clock.restore();
    }
  });

  it('does not let an abandoned LI.FI probe overwrite circuit state after timeout', async () => {
    const clock = sinon.useFakeTimers();
    try {
      const lifiDeferred = createDeferred<any>();
      sinon
        .stub(lifiExecutionModule, 'getLifiPathQuoteEvaluation')
        .returns(lifiDeferred.promise);
      const takeLiquidationLifiStub = sinon
        .stub(lifiExecutionModule, 'takeLiquidationLifi')
        .resolves(true);
      const rpcCache: any = {
        chainId: 8453,
      };
      const transports = createDiscoveryTransports(
        ethers.utils.parseUnits('1', 'gwei')
      );
      const pool = {
        name: 'Hybrid LI.FI Timeout Pool',
        poolAddress: '0x7777777777777777777777777777777777785',
        quoteAddress: '0x2222222222222222222222222222222222222222',
        collateralAddress: '0x3333333333333333333333333333333333333333',
        getLiquidation: sinon.stub().returns({
          getStatus: sinon.stub().resolves({
            collateral: ethers.utils.parseEther('1'),
            price: ethers.utils.parseEther('100'),
          }),
        }),
      };

      const handlePromise = handleDiscoveredTakeTarget({
        pool: pool as any,
        signer: {
          provider: {
            getGasPrice: sinon
              .stub()
              .resolves(ethers.utils.parseUnits('1', 'gwei')),
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
              borrower: '0xBorrowerHybridLifiTimeout',
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
              allowedExternalTakePaths: ['calldata_aggregator'],
              allowedCalldataAggregatorProviders: ['lifi'],
              externalTakeRouteSelectionMode: 'direct_dex_first',
              externalTakeProbeTimeoutMs: 50,
            },
          },
          lifi: {
            mode: 'production',
            allowExchanges: ['uniswap'],
            callTargetAllowlist: {},
            approvalSpenderAllowlist: {},
            selectorAllowlist: {},
            quoteFailureThreshold: 2,
          },
          lifiTaker: '0x4444444444444444444444444444444444444444',
          subgraphUrl: 'http://example-subgraph',
        } as any,
        transports,
        rpcCache,
      });

      await clock.tickAsync(50);
      await handlePromise;
      expect(rpcCache.providerCircuits?.lifi?.route_quote?.failures).to.equal(
        1
      );
      expect(takeLiquidationLifiStub.called).to.be.false;

      lifiDeferred.resolve({
        isTakeable: true,
        externalTakePath: 'calldata_aggregator',
        selectedLiquiditySource: LiquiditySource.LIFI,
        quoteAmount: 125,
        quoteAmountRaw: ethers.utils.parseUnits('125', 6),
        collateralAmount: 1,
        marketPrice: 125,
        takeablePrice: 123.75,
        approvedMinOutRaw: ethers.utils.parseUnits('123', 6),
        quotedAuctionPriceWad: ethers.utils.parseEther('100'),
        quotedCollateralWad: ethers.utils.parseEther('1'),
      });
      await clock.tickAsync(0);
      expect(rpcCache.providerCircuits?.lifi?.route_quote?.failures).to.equal(
        1
      );
    } finally {
      clock.restore();
    }
  });

  it('does not let an abandoned factory-first probe run approval after timeout', async () => {
    const clock = sinon.useFakeTimers();
    try {
      const factoryDeferred = createDeferred<any>();
      sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
      sinon
        .stub(takeFactoryModule, 'getFactoryTakeQuoteEvaluation')
        .returns(factoryDeferred.promise as any);
      sinon
        .stub(oneInchAggregatorQuoteModule, 'getOneInchAggregatorPathQuoteEvaluation')
        .resolves({
          isTakeable: false,
          reason: '1inch rejected',
        });
      sinon.stub(oneInchAggregatorExecutionModule, 'takeLiquidationOneInchAggregator').resolves(true);
      sinon.stub(takeFactoryModule, 'takeLiquidationDirectDex').resolves(true);

      const transports = createDiscoveryTransports(
        ethers.utils.parseUnits('1', 'gwei')
      );
      const pool = {
        name: 'Hybrid Factory Timeout Pool',
        poolAddress: '0x7777777777777777777777777777777777784',
        quoteAddress: '0x2222222222222222222222222222222222222222',
        collateralAddress: '0x3333333333333333333333333333333333333333',
        getLiquidation: sinon.stub().returns({
          getStatus: sinon.stub().resolves({
            collateral: ethers.utils.parseEther('1'),
            price: ethers.utils.parseEther('100'),
          }),
        }),
      };

      const handlePromise = handleDiscoveredTakeTarget({
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
            liquiditySource: LiquiditySource.ONEINCH,
            marketPriceFactor: 0.99,
          },
          candidates: [
            {
              poolAddress: pool.poolAddress,
              borrower: '0xBorrowerHybridFactoryTimeout',
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
              allowedExternalTakePaths: ['direct_dex', 'calldata_aggregator'],
              defaultDirectDexLiquiditySource: LiquiditySource.UNISWAPV3,
              externalTakeRouteSelectionMode: 'direct_dex_first',
              externalTakeProbeTimeoutMs: 50,
            },
          },
          subgraphUrl: 'http://example-subgraph',
        } as any,
        transports,
        rpcCache: {
          chainId: 1,
          factoryQuoteProviders:
            takeFactoryModule.createFactoryQuoteProviderRuntimeCache(),
        },
      });

      await clock.tickAsync(50);
      await handlePromise;
      expect(transports.readRpc.getGasPrice.called).to.be.false;

      factoryDeferred.resolve({
        isTakeable: true,
        externalTakePath: 'direct_dex',
        selectedLiquiditySource: LiquiditySource.UNISWAPV3,
        quoteAmount: 125,
        quoteAmountRaw: ethers.utils.parseUnits('125', 6),
        collateralAmount: 1,
        marketPrice: 125,
        takeablePrice: 123.75,
        approvedMinOutRaw: ethers.utils.parseUnits('123', 6),
        quotedAuctionPriceWad: ethers.utils.parseEther('100'),
        quotedCollateralWad: ethers.utils.parseEther('1'),
      });
      await clock.tickAsync(0);
      expect(transports.readRpc.getGasPrice.called).to.be.false;
    } finally {
      clock.restore();
    }
  });

  it('rechecks gas before discovered external take submission and skips when drift breaches policy', async () => {
    const takeLiquidationStub = sinon
      .stub(oneInchAggregatorExecutionModule, 'takeLiquidationOneInchAggregator')
      .resolves(true);
    sinon
      .stub(oneInchAggregatorQuoteModule, 'getOneInchAggregatorPathQuoteEvaluation')
      .resolves(buildTakeableOneInchQuote({
        isTakeable: true,
        selectedLiquiditySource: LiquiditySource.ONEINCH,
        quoteAmount: 125,
        quoteAmountRaw: ethers.utils.parseUnits('125', 6),
        collateralAmount: 1,
        marketPrice: 125,
        takeablePrice: 123.75,
        approvedMinOutRaw: ethers.utils.parseUnits('123', 6),
        quotedAuctionPriceWad: ethers.utils.parseEther('100'),
        quotedCollateralWad: ethers.utils.parseEther('1'),
        routeProfitability: {
          expectedNetProfitQuoteRaw: ethers.utils.parseUnits('20', 6),
          gasPriceWei: ethers.utils.parseUnits('1', 'gwei'),
          gasPolicyEvaluatedAt: Date.now(),
        },
      }));

    const getStatusStub = sinon.stub().resolves({
      collateral: ethers.utils.parseEther('1'),
      price: ethers.utils.parseEther('100'),
    });
    const pool = {
      name: 'Gas Drift Pool',
      poolAddress: '0x7878787878787878787878787878787878787878',
      quoteAddress: '0x2222222222222222222222222222222222222222',
      collateralAddress: '0x3333333333333333333333333333333333333333',
      getLiquidation: sinon.stub().returns({
        getStatus: getStatusStub,
      }),
    };
    const transports = createDiscoveryTransports(
      ethers.utils.parseUnits('2', 'gwei')
    );

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
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerGasDrift',
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
            gasPriceDriftToleranceBasisPoints: 1_000,
            maxGasPriceGwei: 1.5,
          },
        },
        subgraphUrl: 'http://example-subgraph',
      } as any,
      transports,
      rpcCache: {
        chainId: 1,
        gasPrice: ethers.utils.parseUnits('1', 'gwei'),
        gasPriceFetchedAt: Date.now(),
      },
    });

    expect(transports.readRpc.getGasPrice.calledOnce).to.be.true;
    expect(takeLiquidationStub.called).to.be.false;
  });

  it('recomputes final gas policy after forced gas refresh even without drift tolerance', async () => {
    const takeLiquidationStub = sinon
      .stub(oneInchAggregatorExecutionModule, 'takeLiquidationOneInchAggregator')
      .resolves(true);
    sinon
      .stub(oneInchAggregatorQuoteModule, 'getOneInchAggregatorPathQuoteEvaluation')
      .resolves(buildTakeableOneInchQuote({
        isTakeable: true,
        selectedLiquiditySource: LiquiditySource.ONEINCH,
        quoteAmount: 125,
        quoteAmountRaw: ethers.utils.parseUnits('125', 6),
        collateralAmount: 1,
        marketPrice: 125,
        takeablePrice: 123.75,
        approvedMinOutRaw: ethers.utils.parseUnits('123', 6),
        quotedAuctionPriceWad: ethers.utils.parseEther('100'),
        quotedCollateralWad: ethers.utils.parseEther('1'),
        routeProfitability: {
          expectedNetProfitQuoteRaw: ethers.utils.parseUnits('20', 6),
          gasPriceWei: ethers.utils.parseUnits('1', 'gwei'),
          gasPolicyEvaluatedAt: Date.now(),
        },
      }));

    const pool = {
      name: 'Forced Gas Refresh Pool',
      poolAddress: '0x7878787878787878787878787878787878787880',
      quoteAddress: '0x2222222222222222222222222222222222222222',
      collateralAddress: '0x3333333333333333333333333333333333333333',
      getLiquidation: sinon.stub().returns({
        getStatus: sinon.stub().resolves({
          collateral: ethers.utils.parseEther('1'),
          price: ethers.utils.parseEther('100'),
        }),
      }),
    };
    const transports = createDiscoveryTransports(
      ethers.utils.parseUnits('2', 'gwei')
    );

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
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerForcedGasRefresh',
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
            maxGasPriceGwei: 1.5,
          },
        },
        subgraphUrl: 'http://example-subgraph',
      } as any,
      transports,
      rpcCache: {
        chainId: 1,
        gasPrice: ethers.utils.parseUnits('1', 'gwei'),
        gasPriceFetchedAt: Date.now(),
      },
    });

    expect(transports.readRpc.getGasPrice.calledOnce).to.be.true;
    expect(takeLiquidationStub.called).to.be.false;
  });

  it('accepts discovered external take submission when gas price drifts down', async () => {
    const takeLiquidationStub = sinon
      .stub(oneInchAggregatorExecutionModule, 'takeLiquidationOneInchAggregator')
      .resolves(true);
    sinon
      .stub(oneInchAggregatorQuoteModule, 'getOneInchAggregatorPathQuoteEvaluation')
      .resolves(buildTakeableOneInchQuote({
        isTakeable: true,
        selectedLiquiditySource: LiquiditySource.ONEINCH,
        quoteAmount: 125,
        quoteAmountRaw: ethers.utils.parseUnits('125', 6),
        collateralAmount: 1,
        marketPrice: 125,
        takeablePrice: 123.75,
        approvedMinOutRaw: ethers.utils.parseUnits('123', 6),
        quotedAuctionPriceWad: ethers.utils.parseEther('100'),
        quotedCollateralWad: ethers.utils.parseEther('1'),
        routeProfitability: {
          expectedNetProfitQuoteRaw: ethers.utils.parseUnits('20', 6),
          gasPriceWei: ethers.utils.parseUnits('2', 'gwei'),
          gasPolicyEvaluatedAt: Date.now(),
        },
      }));

    const pool = {
      name: 'Gas Drift Down Pool',
      poolAddress: '0x7878787878787878787878787878787878787879',
      quoteAddress: '0x2222222222222222222222222222222222222222',
      collateralAddress: '0x3333333333333333333333333333333333333333',
      getLiquidation: sinon.stub().returns({
        getStatus: sinon.stub().resolves({
          collateral: ethers.utils.parseEther('1'),
          price: ethers.utils.parseEther('100'),
        }),
      }),
    };
    const transports = createDiscoveryTransports(
      ethers.utils.parseUnits('1', 'gwei')
    );

    await handleDiscoveredTakeTarget({
      pool: pool as any,
      signer: {
        provider: {
          getGasPrice: sinon
            .stub()
            .resolves(ethers.utils.parseUnits('2', 'gwei')),
        },
        getChainId: sinon.stub().resolves(1),
      } as any,
      target: {
        source: 'discovered',
        poolAddress: pool.poolAddress,
        name: pool.name,
        dryRun: false,
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerGasDriftDown',
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
            gasPriceDriftToleranceBasisPoints: 1_000,
            maxGasPriceGwei: 3,
          },
        },
        subgraphUrl: 'http://example-subgraph',
      } as any,
      transports,
      rpcCache: {
        chainId: 1,
        gasPrice: ethers.utils.parseUnits('2', 'gwei'),
        gasPriceFetchedAt: Date.now(),
      },
    });

    expect(transports.readRpc.getGasPrice.calledOnce).to.be.true;
    expect(takeLiquidationStub.calledOnce).to.be.true;
  });

  it('rejects a discovered settlement target before onchain settlement reads when gas policy fails', async () => {
    const handleCandidateAuctionsStub = sinon
      .stub(
        settlementModule.SettlementHandler.prototype,
        'handleCandidateAuctions'
      )
      .resolves();
    const needsSettlementStub = sinon
      .stub(settlementModule.SettlementHandler.prototype, 'needsSettlement')
      .resolves({ needs: true, reason: 'Bad debt detected' });

    const pool = {
      name: 'Settlement Pool',
      poolAddress: '0x4444444444444444444444444444444444444444',
      quoteAddress: '0x5555555555555555555555555555555555555555',
      contract: {
        kickerInfo: sinon.stub().resolves({ claimable_: BigNumber.from(0) }),
      },
    };
    const signer = {
      provider: {
        getGasPrice: sinon
          .stub()
          .resolves(ethers.utils.parseUnits('100', 'gwei')),
      },
      getAddress: sinon
        .stub()
        .resolves('0x6666666666666666666666666666666666666666'),
    };

    await handleDiscoveredSettlementTarget({
      pool: pool as any,
      signer: signer as any,
      target: {
        source: 'discovered',
        poolAddress: pool.poolAddress,
        name: pool.name,
        dryRun: true,
        settlement: {
          enabled: true,
          minAuctionAge: 60,
          maxBucketDepth: 50,
          maxIterations: 5,
          checkBotIncentive: false,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerGas',
            kickTime: Date.now(),
            debtRemaining: '1',
            collateralRemaining: '0',
            neutralPrice: '1',
            debt: '1',
            collateral: '0',
            heuristicScore: 1,
          },
        ],
      },
      config: {
        autoDiscover: {
          enabled: true,
          settlement: {
            enabled: true,
            maxGasPriceGwei: 5,
          },
        },
        subgraphUrl: 'http://example-subgraph',
      } as any,
      transports: createDiscoveryTransports(
        ethers.utils.parseUnits('100', 'gwei')
      ),
    });

    expect(needsSettlementStub.called).to.be.false;
    expect(handleCandidateAuctionsStub.called).to.be.false;
  });

  it('skips a discovered settlement when onchain revalidation says the auction no longer needs settlement', async () => {
    const handleCandidateAuctionsStub = sinon
      .stub(
        settlementModule.SettlementHandler.prototype,
        'handleCandidateAuctions'
      )
      .resolves();
    sinon
      .stub(settlementModule.SettlementHandler.prototype, 'needsSettlement')
      .resolves({ needs: false, reason: 'No active auction (kickTime = 0)' });

    const pool = {
      name: 'Settlement Pool',
      poolAddress: '0x4444444444444444444444444444444444444444',
      quoteAddress: '0x5555555555555555555555555555555555555555',
      contract: {
        kickerInfo: sinon.stub().resolves({ claimable_: BigNumber.from(0) }),
      },
    };
    const signer = {
      provider: {
        getGasPrice: sinon.stub().resolves(BigNumber.from(1)),
      },
      getAddress: sinon
        .stub()
        .resolves('0x6666666666666666666666666666666666666666'),
    };

    await handleDiscoveredSettlementTarget({
      pool: pool as any,
      signer: signer as any,
      target: {
        source: 'discovered',
        poolAddress: pool.poolAddress,
        name: pool.name,
        dryRun: true,
        settlement: {
          enabled: true,
          minAuctionAge: 60,
          maxBucketDepth: 50,
          maxIterations: 5,
          checkBotIncentive: false,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerB',
            kickTime: Date.now(),
            debtRemaining: '1',
            collateralRemaining: '0',
            neutralPrice: '1',
            debt: '1',
            collateral: '0',
            heuristicScore: 1,
          },
        ],
      },
      config: {
        autoDiscover: {
          enabled: true,
          settlement: true,
        },
        subgraphUrl: 'http://example-subgraph',
      } as any,
      transports: createDiscoveryTransports(),
    });

    expect(handleCandidateAuctionsStub.called).to.be.false;
  });

  it('uses the onchain kickTime when hydrating prevalidated discovered settlements', async () => {
    const handleCandidateAuctionsStub = sinon
      .stub(
        settlementModule.SettlementHandler.prototype,
        'handleCandidateAuctions'
      )
      .resolves();
    sinon
      .stub(settlementModule.SettlementHandler.prototype, 'needsSettlement')
      .resolves({
        needs: true,
        reason: 'Bad debt detected',
        details: {
          debtRemaining: BigNumber.from(1),
          collateralRemaining: BigNumber.from(0),
          auctionPrice: BigNumber.from(1),
          kickTime: 1,
        },
      });

    const pool = {
      name: 'Settlement Pool',
      poolAddress: '0x4444444444444444444444444444444444444444',
      quoteAddress: '0x5555555555555555555555555555555555555555',
      contract: {
        kickerInfo: sinon.stub().resolves({ claimable_: BigNumber.from(0) }),
      },
    };

    await handleDiscoveredSettlementTarget({
      pool: pool as any,
      signer: {
        provider: {
          getGasPrice: sinon.stub().resolves(BigNumber.from(1)),
        },
      } as any,
      target: {
        source: 'discovered',
        poolAddress: pool.poolAddress,
        name: pool.name,
        dryRun: true,
        settlement: {
          enabled: true,
          minAuctionAge: 60,
          maxBucketDepth: 50,
          maxIterations: 5,
          checkBotIncentive: false,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerKickTime',
            kickTime: Date.now(),
            debtRemaining: '1',
            collateralRemaining: '0',
            neutralPrice: '1',
            debt: '1',
            collateral: '0',
            heuristicScore: 1,
          },
        ],
      },
      config: {
        autoDiscover: {
          enabled: true,
          settlement: true,
        },
        subgraphUrl: 'http://example-subgraph',
      } as any,
      transports: createDiscoveryTransports(),
    });

    expect(handleCandidateAuctionsStub.calledOnce).to.be.true;
    expect(handleCandidateAuctionsStub.firstCall.args[0][0].kickTime).to.equal(
      1000
    );
  });

  it('does not require take profit-floor gas quoting for discovered settlement candidates', async () => {
    const handleCandidateAuctionsStub = sinon
      .stub(
        settlementModule.SettlementHandler.prototype,
        'handleCandidateAuctions'
      )
      .resolves();
    sinon
      .stub(settlementModule.SettlementHandler.prototype, 'needsSettlement')
      .resolves({ needs: true, reason: 'Bad debt detected' });

    const pool = {
      name: 'Settlement Pool',
      poolAddress: '0x7777777777777777777777777777777777777777',
      quoteAddress: '0x8888888888888888888888888888888888888888',
      contract: {},
    };
    const signer = {
      provider: {
        getGasPrice: sinon.stub().resolves(BigNumber.from(1)),
      },
    };

    await handleDiscoveredSettlementTarget({
      pool: pool as any,
      signer: signer as any,
      target: {
        source: 'discovered',
        poolAddress: pool.poolAddress,
        name: pool.name,
        dryRun: true,
        settlement: {
          enabled: true,
          minAuctionAge: 60,
          maxBucketDepth: 50,
          maxIterations: 5,
          checkBotIncentive: false,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerC',
            kickTime: Date.now(),
            debtRemaining: '1',
            collateralRemaining: '0',
            neutralPrice: '1',
            debt: '1',
            collateral: '0',
            heuristicScore: 1,
          },
        ],
      },
      config: {
        autoDiscover: {
          enabled: true,
          settlement: true,
          take: {
            enabled: true,
            minExpectedProfitQuote: 9999,
          },
        },
        subgraphUrl: 'http://example-subgraph',
      } as any,
      transports: createDiscoveryTransports(),
    });

    expect(handleCandidateAuctionsStub.calledOnce).to.be.true;
    expect(handleCandidateAuctionsStub.firstCall.args[0]).to.have.length(1);
    expect(handleCandidateAuctionsStub.firstCall.args[0][0].borrower).to.equal(
      '0xBorrowerC'
    );
  });

  it('allows discovered settlement to use a native gas cap without quote conversion config', async () => {
    const handleCandidateAuctionsStub = sinon
      .stub(
        settlementModule.SettlementHandler.prototype,
        'handleCandidateAuctions'
      )
      .resolves();
    sinon
      .stub(settlementModule.SettlementHandler.prototype, 'needsSettlement')
      .resolves({ needs: true, reason: 'Bad debt detected' });

    const pool = {
      name: 'Settlement Pool',
      poolAddress: '0x9999999999999999999999999999999999999999',
      quoteAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      contract: {},
    };
    const signer = {
      provider: {
        getGasPrice: sinon
          .stub()
          .resolves(ethers.utils.parseUnits('1', 'gwei')),
      },
    };

    await handleDiscoveredSettlementTarget({
      pool: pool as any,
      signer: signer as any,
      target: {
        source: 'discovered',
        poolAddress: pool.poolAddress,
        name: pool.name,
        dryRun: true,
        settlement: {
          enabled: true,
          minAuctionAge: 60,
          maxBucketDepth: 50,
          maxIterations: 5,
          checkBotIncentive: false,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerD',
            kickTime: Date.now(),
            debtRemaining: '1',
            collateralRemaining: '0',
            neutralPrice: '1',
            debt: '1',
            collateral: '0',
            heuristicScore: 1,
          },
        ],
      },
      config: {
        autoDiscover: {
          enabled: true,
          settlement: {
            enabled: true,
            maxGasCostNative: 0.01,
          },
        },
        subgraphUrl: 'http://example-subgraph',
      } as any,
      transports: createDiscoveryTransports(
        ethers.utils.parseUnits('1', 'gwei')
      ),
    });

    expect(handleCandidateAuctionsStub.calledOnce).to.be.true;
  });

  it('quotes exact native gas cost instead of reusing the discovered take quote', async () => {
    const takeLiquidationStub = sinon
      .stub(oneInchAggregatorExecutionModule, 'takeLiquidationOneInchAggregator')
      .resolves();
    sinon
      .stub(oneInchAggregatorQuoteModule, 'getOneInchAggregatorPathQuoteEvaluation')
      .resolves(buildTakeableOneInchQuote({
        isTakeable: true,
        quoteAmount: 2100,
        quoteAmountRaw: ethers.utils.parseUnits('2100', 6),
        collateralAmount: 1,
        marketPrice: 2100,
        takeablePrice: 2200,
      }));
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const oneInchQuoteStub = sinon
      .stub(DexRouter.prototype, 'getQuoteFromOneInch')
      .resolves({
        success: true,
        dstAmount: ethers.utils.parseUnits('1', 6).toString(),
      });

    const pool = {
      name: 'WETH / USDC',
      poolAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      quoteAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
      collateralAddress: '0x4200000000000000000000000000000000000006',
      getLiquidation: sinon.stub().returns({
        getStatus: sinon.stub().resolves({
          collateral: ethers.utils.parseEther('1'),
          price: ethers.utils.parseEther('1'),
        }),
      }),
    };
    const signer = {
      provider: {
        getGasPrice: sinon
          .stub()
          .resolves(ethers.utils.parseUnits('1', 'gwei')),
      },
      getChainId: sinon.stub().resolves(8453),
    };

    await handleDiscoveredTakeTarget({
      pool: pool as any,
      signer: signer as any,
      target: {
        source: 'discovered',
        poolAddress: pool.poolAddress,
        name: pool.name,
        dryRun: true,
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerE',
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
            maxGasCostQuote: 5,
            minExpectedProfitQuote: 1,
          },
        },
        tokenAddresses: {
          weth: '0x4200000000000000000000000000000000000006',
        },
        oneInchRouters: {
          8453: '0x1111111111111111111111111111111111111111',
        },
        subgraphUrl: 'http://example-subgraph',
      } as any,
      transports: createDiscoveryTransports(
        ethers.utils.parseUnits('1', 'gwei')
      ),
    });

    expect(takeLiquidationStub.calledOnce).to.be.true;
    expect(oneInchQuoteStub.calledOnce).to.be.true;
    expect(
      BigNumber.from(oneInchQuoteStub.firstCall.args[1]).eq(
        ethers.utils.parseEther('0.00117')
      )
    ).to.be.true;
  });

  it('uses raw quote units for discovered take profit-floor checks', async () => {
    const takeLiquidationStub = sinon
      .stub(oneInchAggregatorExecutionModule, 'takeLiquidationOneInchAggregator')
      .resolves();
    sinon
      .stub(oneInchAggregatorQuoteModule, 'getOneInchAggregatorPathQuoteEvaluation')
      .resolves(buildTakeableOneInchQuote({
        isTakeable: true,
        quoteAmount: Number('9100000000000000'),
        quoteAmountRaw: ethers.utils.parseUnits('9100000000000000', 6),
        collateralAmount: 1,
        marketPrice: Number('9100000000000000'),
        takeablePrice: Number('9100000000000000'),
      }));
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);

    const pool = {
      name: 'Large WETH / USDC',
      poolAddress: '0xbebebebebebebebebebebebebebebebebebebebe',
      quoteAddress: '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd',
      collateralAddress: '0x4200000000000000000000000000000000000006',
      getLiquidation: sinon.stub().returns({
        getStatus: sinon.stub().resolves({
          collateral: ethers.utils.parseEther('1'),
          price: ethers.utils.parseUnits('9007199254740992', 18),
        }),
      }),
    };
    const signer = {
      provider: {
        getGasPrice: sinon.stub().resolves(BigNumber.from(0)),
      },
      getChainId: sinon.stub().resolves(8453),
    };

    await handleDiscoveredTakeTarget({
      pool: pool as any,
      signer: signer as any,
      target: {
        source: 'discovered',
        poolAddress: pool.poolAddress,
        name: pool.name,
        dryRun: true,
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerRawProfit',
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
            minExpectedProfitQuote: 1,
          },
        },
        tokenAddresses: {
          weth: '0x4200000000000000000000000000000000000006',
        },
        subgraphUrl: 'http://example-subgraph',
      } as any,
      transports: createDiscoveryTransports(BigNumber.from(0)),
    });

    expect(takeLiquidationStub.calledOnce).to.be.true;
  });

  it('reuses fresh factory route gas policy during discovered take approval', async () => {
    const takeLiquidationDirectDexStub = sinon
      .stub(takeFactoryModule, 'takeLiquidationDirectDex')
      .resolves(true);
    sinon.stub(takeFactoryModule, 'getFactoryTakeQuoteEvaluation').resolves({
      isTakeable: true,
      quoteAmount: 120,
      quoteAmountRaw: ethers.utils.parseUnits('120', 6),
      collateralAmount: 1,
      marketPrice: 120,
      takeablePrice: 118.8,
      approvedMinOutRaw: ethers.utils.parseUnits('118.8', 6),
      selectedLiquiditySource: LiquiditySource.UNISWAPV3,
      selectedFeeTier: 500,
      routeProfitability: {
        routeExecutionCostQuoteRaw: ethers.utils.parseUnits('1', 6),
        requiredOutputFloorQuoteRaw: ethers.utils.parseUnits('118.8', 6),
        expectedNetProfitQuoteRaw: ethers.utils.parseUnits('19', 6),
        surplusOverFloorQuoteRaw: ethers.utils.parseUnits('1.2', 6),
        gasPolicyEvaluatedAt: Date.now(),
      },
    });

    const getStatusStub = sinon.stub().resolves({
      collateral: ethers.utils.parseEther('1'),
      price: ethers.utils.parseEther('100'),
    });
    const pool = {
      name: 'Fresh Factory Gas Policy Pool',
      poolAddress: '0xfafafafafafafafafafafafafafafafafafafafa',
      quoteAddress: '0x2222222222222222222222222222222222222222',
      collateralAddress: '0x3333333333333333333333333333333333333333',
      getLiquidation: sinon.stub().returns({
        getStatus: getStatusStub,
      }),
    };
    const signer = {
      provider: {
        getGasPrice: sinon.stub().resolves(BigNumber.from(999)),
      },
      getChainId: sinon.stub().resolves(8453),
    };
    const transports = createDiscoveryTransports(
      ethers.utils.parseUnits('1', 'gwei')
    );

    await handleDiscoveredTakeTarget({
      pool: pool as any,
      signer: signer as any,
      target: {
        source: 'discovered',
        poolAddress: pool.poolAddress,
        name: pool.name,
        dryRun: true,
        take: {
          liquiditySource: LiquiditySource.UNISWAPV3,
          marketPriceFactor: 0.99,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerFreshFactoryGas',
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
            maxGasCostNative: 1,
          },
        },
        subgraphUrl: 'http://example-subgraph',
      } as any,
      transports,
      rpcCache: {
        chainId: 8453,
        gasPrice: ethers.utils.parseUnits('1', 'gwei'),
        gasPriceFetchedAt: Date.now(),
        factoryQuoteProviders:
          takeFactoryModule.createFactoryQuoteProviderRuntimeCache(),
      },
    });

    expect(takeLiquidationDirectDexStub.calledOnce).to.be.true;
    expect(transports.readRpc.getGasPrice.calledOnce).to.be.true;
  });

  it('rechecks stale L1 factory route gas policy during discovered take approval', async () => {
    const nowMs = 100_000;
    sinon.stub(Date, 'now').returns(nowMs);
    const takeLiquidationDirectDexStub = sinon
      .stub(takeFactoryModule, 'takeLiquidationDirectDex')
      .resolves(true);
    sinon.stub(takeFactoryModule, 'getFactoryTakeQuoteEvaluation').resolves({
      isTakeable: true,
      quoteAmount: 120,
      quoteAmountRaw: ethers.utils.parseUnits('120', 6),
      collateralAmount: 1,
      marketPrice: 120,
      takeablePrice: 118.8,
      approvedMinOutRaw: ethers.utils.parseUnits('118.8', 6),
      selectedLiquiditySource: LiquiditySource.UNISWAPV3,
      selectedFeeTier: 500,
      routeProfitability: {
        routeExecutionCostQuoteRaw: ethers.utils.parseUnits('1', 6),
        requiredOutputFloorQuoteRaw: ethers.utils.parseUnits('118.8', 6),
        expectedNetProfitQuoteRaw: ethers.utils.parseUnits('19', 6),
        surplusOverFloorQuoteRaw: ethers.utils.parseUnits('1.2', 6),
        gasPolicyEvaluatedAt: nowMs - 6_000,
      },
    });

    const getStatusStub = sinon.stub().resolves({
      collateral: ethers.utils.parseEther('1'),
      price: ethers.utils.parseEther('100'),
    });
    const pool = {
      name: 'Stale L1 Factory Gas Policy Pool',
      poolAddress: '0xfafafafafafafafafafafafafafafafafafafafa',
      quoteAddress: '0x2222222222222222222222222222222222222222',
      collateralAddress: '0x3333333333333333333333333333333333333333',
      getLiquidation: sinon.stub().returns({
        getStatus: getStatusStub,
      }),
    };
    const signer = {
      provider: {
        getGasPrice: sinon.stub().resolves(BigNumber.from(999)),
      },
      getChainId: sinon.stub().resolves(1),
    };
    const transports = createDiscoveryTransports(
      ethers.utils.parseUnits('2', 'gwei')
    );

    await handleDiscoveredTakeTarget({
      pool: pool as any,
      signer: signer as any,
      target: {
        source: 'discovered',
        poolAddress: pool.poolAddress,
        name: pool.name,
        dryRun: true,
        take: {
          liquiditySource: LiquiditySource.UNISWAPV3,
          marketPriceFactor: 0.99,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerStaleFactoryGas',
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
            maxGasCostNative: 1,
          },
        },
        subgraphUrl: 'http://example-subgraph',
      } as any,
      transports,
      rpcCache: {
        chainId: 1,
        gasPrice: ethers.utils.parseUnits('1', 'gwei'),
        gasPriceFetchedAt: nowMs - 6_000,
        factoryQuoteProviders:
          takeFactoryModule.createFactoryQuoteProviderRuntimeCache(),
      },
    });

    expect(takeLiquidationDirectDexStub.calledOnce).to.be.true;
    expect(transports.readRpc.getGasPrice.callCount).to.equal(2);
  });

  it('logs a discovered take summary with skip counters', async () => {
    sinon.stub(oneInchAggregatorExecutionModule, 'takeLiquidationOneInchAggregator').resolves();
    sinon
      .stub(oneInchAggregatorQuoteModule, 'getOneInchAggregatorPathQuoteEvaluation')
      .resolves(buildTakeableOneInchQuote());
    const loggerInfoStub = sinon.stub(logger, 'info');

    const getStatusStub = sinon.stub();
    getStatusStub
      .onCall(0)
      .resolves({
        collateral: ethers.utils.parseEther('1'),
        price: ethers.utils.parseEther('1'),
      })
      .onCall(1)
      .resolves({
        collateral: BigNumber.from(0),
        price: ethers.utils.parseEther('1'),
      });

    const pool = {
      name: 'Discovered Pool',
      poolAddress: '0x1212121212121212121212121212121212121212',
      quoteAddress: '0x2222222222222222222222222222222222222222',
      collateralAddress: '0x3333333333333333333333333333333333333333',
      getLiquidation: sinon.stub().returns({
        getStatus: getStatusStub,
      }),
    };
    const signer = {
      provider: {
        getGasPrice: sinon.stub().resolves(BigNumber.from(1)),
      },
      getChainId: sinon.stub().resolves(1),
    };

    await handleDiscoveredTakeTarget({
      pool: pool as any,
      signer: signer as any,
      target: {
        source: 'discovered',
        poolAddress: pool.poolAddress,
        name: pool.name,
        dryRun: true,
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerSummary',
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
          take: true,
        },
        subgraphUrl: 'http://example-subgraph',
      } as any,
      transports: createDiscoveryTransports(),
    });

    const summaryLog = getDiscoveredTakeSummary(loggerInfoStub);
    expect(summaryLog).to.include('candidates=1');
    expect(summaryLog).to.include('approvedTakeDecisions=1');
    expect(summaryLog).to.include('revalidationSkips=1');
    expect(summaryLog).to.include('executionSkips=0');
    expect(summaryLog).to.include('executedExternalTakes=0');
  });

  it('reports dry-run discovered takes separately from executed takes', async () => {
    sinon.stub(oneInchAggregatorExecutionModule, 'takeLiquidationOneInchAggregator').resolves(true);
    sinon
      .stub(oneInchAggregatorQuoteModule, 'getOneInchAggregatorPathQuoteEvaluation')
      .resolves(buildTakeableOneInchQuote());
    const loggerInfoStub = sinon.stub(logger, 'info');

    const getStatusStub = sinon.stub().resolves({
      collateral: ethers.utils.parseEther('1'),
      price: ethers.utils.parseEther('1'),
    });

    const pool = {
      name: 'Dry Run Summary Pool',
      poolAddress: '0x5656565656565656565656565656565656565656',
      quoteAddress: '0x2222222222222222222222222222222222222222',
      collateralAddress: '0x3333333333333333333333333333333333333333',
      getLiquidation: sinon.stub().returns({
        getStatus: getStatusStub,
      }),
    };

    await handleDiscoveredTakeTarget({
      pool: pool as any,
      signer: {
        provider: {
          getGasPrice: sinon.stub().resolves(BigNumber.from(1)),
        },
        getChainId: sinon.stub().resolves(1),
      } as any,
      target: {
        source: 'discovered',
        poolAddress: pool.poolAddress,
        name: pool.name,
        dryRun: true,
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerDryRunSummary',
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
          take: true,
        },
        subgraphUrl: 'http://example-subgraph',
      } as any,
      transports: createDiscoveryTransports(),
    });

    const summaryLog = getDiscoveredTakeSummary(loggerInfoStub);
    expect(summaryLog).to.include('executedExternalTakes=0');
    expect(summaryLog).to.include('dryRunExternalTakes=1');
    expect(summaryLog).to.include('dryRunRoutes=calldata_aggregator:1');
  });

  it('logs execution-stage discovered take failures separately from evaluation skips', async () => {
    sinon
      .stub(oneInchAggregatorExecutionModule, 'takeLiquidationOneInchAggregator')
      .rejects(new Error('execution boom'));
    sinon
      .stub(oneInchAggregatorQuoteModule, 'getOneInchAggregatorPathQuoteEvaluation')
      .resolves(buildTakeableOneInchQuote());
    const loggerInfoStub = sinon.stub(logger, 'info');

    const getStatusStub = sinon.stub();
    getStatusStub
      .onCall(0)
      .resolves({
        collateral: ethers.utils.parseEther('1'),
        price: ethers.utils.parseEther('1'),
      })
      .onCall(1)
      .resolves({
        collateral: ethers.utils.parseEther('1'),
        price: ethers.utils.parseEther('1'),
      });

    const pool = {
      name: 'Execution Failure Pool',
      poolAddress: '0x3434343434343434343434343434343434343434',
      quoteAddress: '0x2222222222222222222222222222222222222222',
      collateralAddress: '0x3333333333333333333333333333333333333333',
      getLiquidation: sinon.stub().returns({
        getStatus: getStatusStub,
      }),
    };
    const signer = {
      provider: {
        getGasPrice: sinon.stub().resolves(BigNumber.from(1)),
      },
      getChainId: sinon.stub().resolves(1),
    };

    await handleDiscoveredTakeTarget({
      pool: pool as any,
      signer: signer as any,
      target: {
        source: 'discovered',
        poolAddress: pool.poolAddress,
        name: pool.name,
        dryRun: false,
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerExecution',
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
          take: true,
        },
        subgraphUrl: 'http://example-subgraph',
      } as any,
      transports: createDiscoveryTransports(),
    });

    const summaryLog = getDiscoveredTakeSummary(loggerInfoStub);
    expect(summaryLog).to.include('evaluationSkips=0');
    expect(summaryLog).to.include('revalidationSkips=0');
    expect(summaryLog).to.include('executionSkips=1');
    expect(summaryLog).to.include('executedExternalTakes=0');
  });

  it('skips malformed discovered settlement candidates without aborting the target', async () => {
    const handleCandidateAuctionsStub = sinon
      .stub(
        settlementModule.SettlementHandler.prototype,
        'handleCandidateAuctions'
      )
      .resolves();
    sinon
      .stub(settlementModule.SettlementHandler.prototype, 'needsSettlement')
      .resolves({ needs: true, reason: 'Bad debt detected' });

    const pool = {
      name: 'Settlement Pool',
      poolAddress: '0x4545454545454545454545454545454545454545',
      quoteAddress: '0x5555555555555555555555555555555555555555',
      contract: {},
    };
    const signer = {
      provider: {
        getGasPrice: sinon.stub().resolves(BigNumber.from(1)),
      },
    };

    await handleDiscoveredSettlementTarget({
      pool: pool as any,
      signer: signer as any,
      target: {
        source: 'discovered',
        poolAddress: pool.poolAddress,
        name: pool.name,
        dryRun: true,
        settlement: {
          enabled: true,
          minAuctionAge: 60,
          maxBucketDepth: 50,
          maxIterations: 5,
          checkBotIncentive: false,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerBad',
            kickTime: Date.now(),
            debtRemaining: 'not-a-number',
            collateralRemaining: '0',
            neutralPrice: '1',
            debt: '1',
            collateral: '0',
            heuristicScore: 1,
          },
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerGood',
            kickTime: Date.now(),
            debtRemaining: '1',
            collateralRemaining: '0',
            neutralPrice: '1',
            debt: '1',
            collateral: '0',
            heuristicScore: 1,
          },
        ],
      },
      config: {
        autoDiscover: {
          enabled: true,
          settlement: true,
        },
        subgraphUrl: 'http://example-subgraph',
      } as any,
      transports: createDiscoveryTransports(),
    });

    expect(handleCandidateAuctionsStub.calledOnce).to.be.true;
    expect(handleCandidateAuctionsStub.firstCall.args[0]).to.have.length(1);
    expect(handleCandidateAuctionsStub.firstCall.args[0][0].borrower).to.equal(
      '0xBorrowerGood'
    );
  });

  it('logs a discovered settlement summary with skip counters', async () => {
    sinon
      .stub(
        settlementModule.SettlementHandler.prototype,
        'handleCandidateAuctions'
      )
      .resolves();
    sinon
      .stub(settlementModule.SettlementHandler.prototype, 'needsSettlement')
      .resolves({ needs: false, reason: 'No active auction (kickTime = 0)' });
    const loggerInfoStub = sinon.stub(logger, 'info');

    const pool = {
      name: 'Settlement Pool',
      poolAddress: '0x4545454545454545454545454545454545454545',
      quoteAddress: '0x5555555555555555555555555555555555555555',
      contract: {
        kickerInfo: sinon.stub().resolves({ claimable_: BigNumber.from(0) }),
      },
    };
    const signer = {
      provider: {
        getGasPrice: sinon.stub().resolves(BigNumber.from(1)),
      },
      getAddress: sinon
        .stub()
        .resolves('0x6666666666666666666666666666666666666666'),
    };

    await handleDiscoveredSettlementTarget({
      pool: pool as any,
      signer: signer as any,
      target: {
        source: 'discovered',
        poolAddress: pool.poolAddress,
        name: pool.name,
        dryRun: true,
        settlement: {
          enabled: true,
          minAuctionAge: 60,
          maxBucketDepth: 50,
          maxIterations: 5,
          checkBotIncentive: false,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerSummary',
            kickTime: Date.now(),
            debtRemaining: '1',
            collateralRemaining: '0',
            neutralPrice: '1',
            debt: '1',
            collateral: '0',
            heuristicScore: 1,
          },
        ],
      },
      config: {
        autoDiscover: {
          enabled: true,
          settlement: true,
        },
        subgraphUrl: 'http://example-subgraph',
      } as any,
      transports: createDiscoveryTransports(),
    });

    const summaryLog = loggerInfoStub
      .getCalls()
      .map((call) => call.args[0])
      .find(
        (message: any) =>
          typeof message === 'string' &&
          message.includes('Discovered settlement target summary:')
      );
    expect(summaryLog).to.be.a('string');
    expect(summaryLog).to.include('candidates=1');
    expect(summaryLog).to.include('needsSettlementSkips=1');
    expect(summaryLog).to.include('approvedCandidates=0');
    expect(summaryLog).to.include('executionAttempted=false');
  });
});
