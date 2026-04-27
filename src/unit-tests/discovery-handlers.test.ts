import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, ethers } from 'ethers';
import {
  handleDiscoveredSettlementTarget,
  handleDiscoveredTakeTarget,
} from '../discovery/handlers';
import {
  refreshDiscoveryGasPriceIfStale,
  resolveHybridExternalTakeExecutionSelection,
  selectBestExternalTakeQuoteEvaluation,
} from '../discovery/take-executor';
import * as oneInchExecutionModule from '../take/one-inch-execution';
import * as takeFactoryModule from '../take/factory';
import * as settlementModule from '../settlement';
import * as arbModule from '../take/arb';
import { LiquiditySource } from '../config';
import * as erc20 from '../erc20';
import { DexRouter } from '../dex/router';
import { logger } from '../logging';

function createDiscoveryTransports(gasPrice: BigNumber = BigNumber.from(1)) {
  return {
    subgraph: {
      cacheKey: 'test-subgraph',
      getLoans: sinon.stub().rejects(new Error('unused')),
      getLiquidations: sinon.stub().rejects(new Error('unused')),
      getHighestMeaningfulBucket: sinon.stub().rejects(new Error('unused')),
      getUnsettledAuctions: sinon.stub().rejects(new Error('unused')),
      getChainwideLiquidationAuctions: sinon
        .stub()
        .rejects(new Error('unused')),
      getBucketTakeLPAwards: sinon.stub().rejects(new Error('unused')),
      getSubgraphMeta: sinon.stub().rejects(new Error('unused')),
    },
    readRpc: {
      getGasPrice: sinon.stub().resolves(gasPrice),
    },
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

describe('Discovery Handlers', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('skips a discovered take when subgraph data is stale before onchain revalidation', async () => {
    const takeLiquidationStub = sinon
      .stub(oneInchExecutionModule, 'takeLiquidation')
      .resolves();
    const onCandidateInactive = sinon.spy();
    sinon
      .stub(oneInchExecutionModule, 'getOneInchTakeQuoteEvaluation')
      .resolves({
        isTakeable: true,
        quoteAmount: 10,
        collateralAmount: 1,
        marketPrice: 10,
        takeablePrice: 12,
      });

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
        delayBetweenActions: 0,
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

  it('removes hot-cache candidates when the approved quote is stale after auction price increases', async () => {
    const takeLiquidationStub = sinon
      .stub(oneInchExecutionModule, 'takeLiquidation')
      .resolves();
    const onCandidateInactive = sinon.spy();
    sinon
      .stub(oneInchExecutionModule, 'getOneInchTakeQuoteEvaluation')
      .resolves({
        isTakeable: true,
        quoteAmount: 10,
        collateralAmount: 1,
        marketPrice: 10,
        takeablePrice: 12,
        quotedAuctionPriceWad: ethers.utils.parseEther('1'),
        quotedCollateralWad: ethers.utils.parseEther('1'),
      });

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
        delayBetweenActions: 0,
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
      .stub(oneInchExecutionModule, 'takeLiquidation')
      .resolves();
    const quoteStub = sinon
      .stub(oneInchExecutionModule, 'getOneInchTakeQuoteEvaluation')
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
        delayBetweenActions: 0,
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
      .stub(oneInchExecutionModule, 'takeLiquidation')
      .rejects(new Error('external take failed'));
    const arbTakeLiquidationStub = sinon
      .stub(arbModule, 'arbTakeLiquidation')
      .resolves();
    sinon
      .stub(oneInchExecutionModule, 'getOneInchTakeQuoteEvaluation')
      .resolves({
        isTakeable: true,
        quoteAmount: 10,
        collateralAmount: 1,
        marketPrice: 10,
        takeablePrice: 12,
        quoteAmountRaw: BigNumber.from(10),
      });
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
          delayBetweenActions: 0,
          subgraphUrl: 'http://example-subgraph',
          keeperTaker: '0x4444444444444444444444444444444444444444',
          oneInchRouters: {
            1: '0x5555555555555555555555555555555555555555',
          },
        } as any,
        transports: {
          subgraph: {
            cacheKey: 'test-subgraph',
            getLoans: sinon.stub().rejects(new Error('unused')),
            getLiquidations: sinon.stub().rejects(new Error('unused')),
            getHighestMeaningfulBucket: sinon
              .stub()
              .rejects(new Error('unused')),
            getUnsettledAuctions: sinon.stub().rejects(new Error('unused')),
            getChainwideLiquidationAuctions: sinon
              .stub()
              .rejects(new Error('unused')),
            getBucketTakeLPAwards: sinon.stub().rejects(new Error('unused')),
            getSubgraphMeta: sinon.stub().rejects(new Error('unused')),
          },
          readRpc: {
            getGasPrice: sinon.stub().resolves(BigNumber.from(1)),
          },
        },
      });
    } catch (error) {
      expect.fail(
        `Did not expect discovered take handler to throw: ${String(error)}`
      );
    }

    expect(takeLiquidationStub.calledOnce).to.be.true;
    expect(arbTakeLiquidationStub.called).to.be.false;
  });

  it('records retryable 1inch swap-data execution failures in the shared circuit', async () => {
    const rpcCache: any = {
      chainId: 1,
      gasPrice: BigNumber.from(1),
      gasPriceFetchedAt: Date.now(),
      factoryQuoteProviders:
        takeFactoryModule.createFactoryQuoteProviderRuntimeCache(),
    };
    const takeLiquidationStub = sinon
      .stub(oneInchExecutionModule, 'takeLiquidation')
      .callsFake(async ({ config }: any) => {
        config.onOneInchSwapDataResult?.({
          success: false,
          retryable: true,
          errorCode: 429,
          error: 'rate limited',
        });
        return false;
      });
    sinon
      .stub(oneInchExecutionModule, 'getOneInchTakeQuoteEvaluation')
      .resolves({
        isTakeable: true,
        quoteAmount: 10,
        collateralAmount: 1,
        marketPrice: 10,
        takeablePrice: 12,
        quoteAmountRaw: BigNumber.from(10),
      });

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
        delayBetweenActions: 0,
        subgraphUrl: 'http://example-subgraph',
        keeperTaker: '0x4444444444444444444444444444444444444444',
        oneInchRouters: {
          1: '0x5555555555555555555555555555555555555555',
        },
      } as any,
      transports: createDiscoveryTransports(BigNumber.from(1)),
      rpcCache,
    });

    expect(takeLiquidationStub.calledOnce).to.be.true;
    expect(rpcCache.oneInchQuoteCircuit?.failures).to.equal(1);
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
      .stub(oneInchExecutionModule, 'takeLiquidation')
      .resolves();
    sinon
      .stub(oneInchExecutionModule, 'getOneInchTakeQuoteEvaluation')
      .resolves({
        isTakeable: true,
        quoteAmount: 10,
        collateralAmount: 1,
        marketPrice: 10,
        takeablePrice: 12,
        quoteAmountRaw: BigNumber.from(10),
      });

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
        delayBetweenActions: 0,
        subgraphUrl: 'http://example-subgraph',
        keeperTaker: '0x4444444444444444444444444444444444444444',
        oneInchRouters: {
          1: '0x5555555555555555555555555555555555555555',
        },
      } as any,
      transports: {
        subgraph: {
          cacheKey: 'test-subgraph',
          getLoans: sinon.stub().rejects(new Error('unused')),
          getLiquidations: sinon.stub().rejects(new Error('unused')),
          getHighestMeaningfulBucket: sinon.stub().rejects(new Error('unused')),
          getUnsettledAuctions: sinon.stub().rejects(new Error('unused')),
          getChainwideLiquidationAuctions: sinon
            .stub()
            .rejects(new Error('unused')),
          getBucketTakeLPAwards: sinon.stub().rejects(new Error('unused')),
          getSubgraphMeta: sinon.stub().rejects(new Error('unused')),
        },
        readRpc: {
          getGasPrice: sinon.stub().resolves(BigNumber.from(1)),
        },
      },
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
        delayBetweenActions: 0,
        subgraphUrl: 'http://example-subgraph',
      } as any,
      transports: {
        subgraph: {
          cacheKey: 'test-subgraph',
          getLoans: sinon.stub().rejects(new Error('unused')),
          getLiquidations: sinon.stub().rejects(new Error('unused')),
          getHighestMeaningfulBucket: sinon.stub().rejects(new Error('unused')),
          getUnsettledAuctions: sinon.stub().rejects(new Error('unused')),
          getChainwideLiquidationAuctions: sinon
            .stub()
            .rejects(new Error('unused')),
          getBucketTakeLPAwards: sinon.stub().rejects(new Error('unused')),
          getSubgraphMeta: sinon.stub().rejects(new Error('unused')),
        },
        readRpc: {
          getGasPrice: sinon.stub().resolves(BigNumber.from(1)),
        },
      },
    });

    expect(arbTakeLiquidationStub.calledOnce).to.be.true;
    expect(
      arbTakeLiquidationStub.firstCall.args[0].config.takeWriteTransport
    ).to.equal(takeWriteTransport);
  });

  it('probes 1inch and factory hybrid external take paths in parallel', async () => {
    const takeLiquidationStub = sinon
      .stub(oneInchExecutionModule, 'takeLiquidation')
      .resolves(true);
    const takeLiquidationFactoryStub = sinon
      .stub(takeFactoryModule, 'takeLiquidationFactory')
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
      .stub(oneInchExecutionModule, 'getOneInchPathQuoteEvaluation')
      .callsFake(async () => {
        markStarted('oneinch');
        return await oneInchDeferred.promise;
      });
    sinon
      .stub(takeFactoryModule, 'getFactoryTakeQuoteEvaluation')
      .callsFake(async () => {
        markStarted('factory');
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
            allowedExternalTakePaths: ['oneinch', 'factory'],
            defaultFactoryLiquiditySource: LiquiditySource.UNISWAPV3,
          },
        },
        tokenAddresses: {
          weth: pool.quoteAddress,
        },
        delayBetweenActions: 0,
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
    expect(startedPaths).to.have.members(['oneinch', 'factory']);

    oneInchDeferred.resolve({
      isTakeable: true,
      externalTakePath: 'oneinch',
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
    });
    factoryDeferred.resolve({
      isTakeable: true,
      externalTakePath: 'factory',
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
    expect(takeLiquidationFactoryStub.called).to.be.false;
  });

  it('ranks hybrid paths by normalized expected net profit instead of 1inch gross output', async () => {
    const takeLiquidationStub = sinon
      .stub(oneInchExecutionModule, 'takeLiquidation')
      .resolves(true);
    const takeLiquidationFactoryStub = sinon
      .stub(takeFactoryModule, 'takeLiquidationFactory')
      .resolves(true);
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    sinon
      .stub(oneInchExecutionModule, 'getOneInchPathQuoteEvaluation')
      .resolves({
        isTakeable: true,
        externalTakePath: 'oneinch',
        selectedLiquiditySource: LiquiditySource.ONEINCH,
        quoteAmount: 130,
        quoteAmountRaw: ethers.utils.parseUnits('130', 6),
        collateralAmount: 1,
        marketPrice: 130,
        takeablePrice: 128.7,
        approvedMinOutRaw: ethers.utils.parseUnits('128', 6),
        quotedAuctionPriceWad: ethers.utils.parseEther('100'),
        quotedCollateralWad: ethers.utils.parseEther('1'),
      });
    sinon.stub(takeFactoryModule, 'getFactoryTakeQuoteEvaluation').resolves({
      isTakeable: true,
      externalTakePath: 'factory',
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
            allowedExternalTakePaths: ['oneinch', 'factory'],
            defaultFactoryLiquiditySource: LiquiditySource.UNISWAPV3,
          },
        },
        tokenAddresses: {
          weth: pool.quoteAddress,
        },
        delayBetweenActions: 0,
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
    expect(takeLiquidationFactoryStub.calledOnce).to.be.true;
  });

  it('falls back to factory after a hybrid 1inch pre-broadcast execution failure', async () => {
    const takeLiquidationStub = sinon
      .stub(oneInchExecutionModule, 'takeLiquidation')
      .callsFake(async ({ config }: any) => {
        config.onOneInchExecutionFailure?.({
          preBroadcast: true,
          error: 'gas estimation failed',
        });
        return false;
      });
    const takeLiquidationFactoryStub = sinon
      .stub(takeFactoryModule, 'takeLiquidationFactory')
      .resolves(true);
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    sinon
      .stub(oneInchExecutionModule, 'getOneInchPathQuoteEvaluation')
      .resolves({
        isTakeable: true,
        externalTakePath: 'oneinch',
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
      });
    sinon.stub(takeFactoryModule, 'getFactoryTakeQuoteEvaluation').resolves({
      isTakeable: true,
      externalTakePath: 'factory',
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
            allowedExternalTakePaths: ['oneinch', 'factory'],
            defaultFactoryLiquiditySource: LiquiditySource.UNISWAPV3,
          },
        },
        tokenAddresses: {
          weth: pool.quoteAddress,
        },
        delayBetweenActions: 0,
        subgraphUrl: 'http://example-subgraph',
        keeperTaker: '0x4444444444444444444444444444444444444444',
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
    expect(takeLiquidationFactoryStub.calledOnce).to.be.true;
    expect(
      takeLiquidationFactoryStub.firstCall.args[0].liquidation.auctionPrice.eq(
        ethers.utils.parseEther('95')
      )
    ).to.be.true;
  });

  it('falls back to 1inch after a hybrid factory pre-broadcast execution failure', async () => {
    const takeLiquidationStub = sinon
      .stub(oneInchExecutionModule, 'takeLiquidation')
      .resolves(true);
    const takeLiquidationFactoryStub = sinon
      .stub(takeFactoryModule, 'takeLiquidationFactory')
      .callsFake(async ({ config }: any) => {
        config.onFactoryExecutionFailure?.({
          preBroadcast: true,
          error: 'gas estimation failed',
        });
        return false;
      });
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    sinon
      .stub(oneInchExecutionModule, 'getOneInchPathQuoteEvaluation')
      .resolves({
        isTakeable: true,
        externalTakePath: 'oneinch',
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
      });
    sinon.stub(takeFactoryModule, 'getFactoryTakeQuoteEvaluation').resolves({
      isTakeable: true,
      externalTakePath: 'factory',
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
            allowedExternalTakePaths: ['oneinch', 'factory'],
            defaultFactoryLiquiditySource: LiquiditySource.UNISWAPV3,
          },
        },
        tokenAddresses: {
          weth: pool.quoteAddress,
        },
        delayBetweenActions: 0,
        subgraphUrl: 'http://example-subgraph',
        keeperTaker: '0x4444444444444444444444444444444444444444',
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

    expect(takeLiquidationFactoryStub.calledOnce).to.be.true;
    expect(takeLiquidationStub.calledOnce).to.be.true;
  });

  it('falls back to factory when the hybrid 1inch probe times out', async () => {
    const takeLiquidationFactoryStub = sinon
      .stub(takeFactoryModule, 'takeLiquidationFactory')
      .resolves(true);
    sinon.stub(oneInchExecutionModule, 'takeLiquidation').resolves(true);
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    sinon
      .stub(oneInchExecutionModule, 'getOneInchPathQuoteEvaluation')
      .rejects(new Error('timeout of 5ms exceeded'));
    sinon.stub(takeFactoryModule, 'getFactoryTakeQuoteEvaluation').resolves({
      isTakeable: true,
      externalTakePath: 'factory',
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
            allowedExternalTakePaths: ['oneinch', 'factory'],
            defaultFactoryLiquiditySource: LiquiditySource.UNISWAPV3,
            oneInchQuoteTimeoutMs: 5,
          },
        },
        tokenAddresses: {
          weth: pool.quoteAddress,
        },
        delayBetweenActions: 0,
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

    expect(takeLiquidationFactoryStub.calledOnce).to.be.true;
  });

  it('does not let a slow factory hybrid probe block a valid 1inch path', async () => {
    const takeLiquidationStub = sinon
      .stub(oneInchExecutionModule, 'takeLiquidation')
      .resolves(true);
    const takeLiquidationFactoryStub = sinon
      .stub(takeFactoryModule, 'takeLiquidationFactory')
      .resolves(true);
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    sinon
      .stub(oneInchExecutionModule, 'getOneInchPathQuoteEvaluation')
      .resolves({
        isTakeable: true,
        externalTakePath: 'oneinch',
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
      });
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
            allowedExternalTakePaths: ['oneinch', 'factory'],
            defaultFactoryLiquiditySource: LiquiditySource.UNISWAPV3,
            externalTakeProbeTimeoutMs: 5,
          },
        },
        tokenAddresses: {
          weth: pool.quoteAddress,
        },
        delayBetweenActions: 0,
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
    expect(takeLiquidationFactoryStub.called).to.be.false;
  });

  it('uses factory-first hybrid mode to avoid 1inch calls when factory approves first', async () => {
    const takeLiquidationFactoryStub = sinon
      .stub(takeFactoryModule, 'takeLiquidationFactory')
      .resolves(true);
    const oneInchQuoteStub = sinon.stub(
      oneInchExecutionModule,
      'getOneInchPathQuoteEvaluation'
    );
    const oneInchGasQuoteStub = sinon
      .stub(DexRouter.prototype, 'getQuoteFromOneInch')
      .rejects(
        new Error('factory-first mode should not require gas conversion')
      );
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    sinon.stub(oneInchExecutionModule, 'takeLiquidation').resolves(true);
    sinon.stub(takeFactoryModule, 'getFactoryTakeQuoteEvaluation').resolves({
      isTakeable: true,
      externalTakePath: 'factory',
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
            allowedExternalTakePaths: ['oneinch', 'factory'],
            defaultFactoryLiquiditySource: LiquiditySource.UNISWAPV3,
            externalTakeRouteSelectionMode: 'factory_first',
          },
        },
        tokenAddresses: {
          weth: '0x4200000000000000000000000000000000000006',
        },
        oneInchRouters: {
          1: '0x1111111111111111111111111111111111111111',
        },
        delayBetweenActions: 0,
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
    expect(takeLiquidationFactoryStub.calledOnce).to.be.true;
  });

  it('continues factory-first probing when the approved factory path is subsidized', async () => {
    const takeLiquidationStub = sinon
      .stub(oneInchExecutionModule, 'takeLiquidation')
      .resolves(true);
    const takeLiquidationFactoryStub = sinon
      .stub(takeFactoryModule, 'takeLiquidationFactory')
      .resolves(true);
    const oneInchQuoteStub = sinon
      .stub(oneInchExecutionModule, 'getOneInchPathQuoteEvaluation')
      .resolves({
        isTakeable: true,
        externalTakePath: 'oneinch',
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
      });
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    sinon.stub(takeFactoryModule, 'getFactoryTakeQuoteEvaluation').resolves({
      isTakeable: true,
      externalTakePath: 'factory',
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
            allowedExternalTakePaths: ['oneinch', 'factory'],
            defaultFactoryLiquiditySource: LiquiditySource.UNISWAPV3,
            externalTakeRouteSelectionMode: 'factory_first',
          },
        },
        tokenAddresses: {
          weth: '0x4200000000000000000000000000000000000006',
        },
        oneInchRouters: {
          1: '0x1111111111111111111111111111111111111111',
        },
        delayBetweenActions: 0,
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
    expect(takeLiquidationFactoryStub.called).to.be.false;
  });

  it('does not execute when all hybrid external take paths are rejected', async () => {
    const debugStub = sinon.stub(logger, 'debug');
    const takeLiquidationStub = sinon
      .stub(oneInchExecutionModule, 'takeLiquidation')
      .resolves(true);
    const takeLiquidationFactoryStub = sinon
      .stub(takeFactoryModule, 'takeLiquidationFactory')
      .resolves(true);
    sinon
      .stub(oneInchExecutionModule, 'getOneInchPathQuoteEvaluation')
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
            allowedExternalTakePaths: ['oneinch', 'factory'],
            defaultFactoryLiquiditySource: LiquiditySource.UNISWAPV3,
          },
        },
        delayBetweenActions: 0,
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
    expect(takeLiquidationFactoryStub.called).to.be.false;
    expect(
      debugStub
        .getCalls()
        .some((call) =>
          String(call.args[0]).includes('no viable external take path')
        )
    ).to.be.true;
  });

  it('rejects disabled hybrid execution paths before dispatch', () => {
    const disabledPath = resolveHybridExternalTakeExecutionSelection({
      allowedExternalTakePaths: ['factory'],
      quoteEvaluation: {
        isTakeable: true,
        externalTakePath: 'oneinch',
        selectedLiquiditySource: LiquiditySource.ONEINCH,
        quoteAmount: 125,
        quoteAmountRaw: ethers.utils.parseUnits('125', 6),
        collateralAmount: 1,
        marketPrice: 125,
        takeablePrice: 123.75,
      } as any,
    });

    expect(disabledPath).to.deep.include({
      approved: false,
      effectiveSelectedPath: 'oneinch',
      selectedSource: LiquiditySource.ONEINCH,
      reason: 'selected disabled path=oneinch',
    });

    const missingFactorySource = resolveHybridExternalTakeExecutionSelection({
      allowedExternalTakePaths: ['factory'],
      quoteEvaluation: {
        isTakeable: true,
        externalTakePath: 'factory',
        quoteAmount: 125,
        quoteAmountRaw: ethers.utils.parseUnits('125', 6),
        collateralAmount: 1,
        marketPrice: 125,
        takeablePrice: 123.75,
      } as any,
    });

    expect(missingFactorySource).to.deep.include({
      approved: false,
      effectiveSelectedPath: 'factory',
      reason: 'selected factory path without a concrete factory source',
    });

    const missingSelectedPath = resolveHybridExternalTakeExecutionSelection({
      allowedExternalTakePaths: ['oneinch', 'factory'],
      quoteEvaluation: {
        isTakeable: true,
        quoteAmount: 125,
        quoteAmountRaw: ethers.utils.parseUnits('125', 6),
        collateralAmount: 1,
        marketPrice: 125,
        takeablePrice: 123.75,
      } as any,
    });

    expect(missingSelectedPath).to.deep.include({
      approved: false,
      reason: 'hybrid external take selection missing selected path',
    });
  });

  it('prefers non-subsidized hybrid external take quotes over higher-profit subsidized quotes', () => {
    const nonSubsidized = {
      isTakeable: true,
      externalTakePath: 'factory',
      selectedLiquiditySource: LiquiditySource.UNISWAPV3,
      quoteAmountRaw: BigNumber.from(125),
      routeProfitability: {
        expectedNetProfitQuoteRaw: BigNumber.from(20),
        expectedSubsidyQuoteRaw: BigNumber.from(0),
        subsidyAllowed: false,
      },
    } as any;
    const subsidized = {
      isTakeable: true,
      externalTakePath: 'oneinch',
      selectedLiquiditySource: LiquiditySource.ONEINCH,
      quoteAmountRaw: BigNumber.from(140),
      routeProfitability: {
        expectedNetProfitQuoteRaw: BigNumber.from(35),
        expectedSubsidyQuoteRaw: BigNumber.from(5),
        subsidyAllowed: true,
      },
    } as any;

    expect(
      selectBestExternalTakeQuoteEvaluation({
        evaluations: [subsidized, nonSubsidized],
        externalTakePaths: ['oneinch', 'factory'],
      })
    ).to.equal(nonSubsidized);
  });

  it('chooses the smallest subsidy among subsidized hybrid external take quotes', () => {
    const smallerSubsidy = {
      isTakeable: true,
      externalTakePath: 'factory',
      selectedLiquiditySource: LiquiditySource.SUSHISWAP,
      quoteAmountRaw: BigNumber.from(130),
      routeProfitability: {
        expectedNetProfitQuoteRaw: BigNumber.from(15),
        expectedSubsidyQuoteRaw: BigNumber.from(2),
        subsidyAllowed: true,
      },
    } as any;
    const largerSubsidy = {
      isTakeable: true,
      externalTakePath: 'oneinch',
      selectedLiquiditySource: LiquiditySource.ONEINCH,
      quoteAmountRaw: BigNumber.from(150),
      routeProfitability: {
        expectedNetProfitQuoteRaw: BigNumber.from(40),
        expectedSubsidyQuoteRaw: BigNumber.from(8),
        subsidyAllowed: true,
      },
    } as any;

    expect(
      selectBestExternalTakeQuoteEvaluation({
        evaluations: [largerSubsidy, smallerSubsidy],
        externalTakePaths: ['oneinch', 'factory'],
      })
    ).to.equal(smallerSubsidy);
  });

  it('does not clear 1inch circuit failures for local policy quote rejects', async () => {
    sinon.stub(oneInchExecutionModule, 'takeLiquidation').resolves(true);
    const oneInchQuoteStub = sinon
      .stub(oneInchExecutionModule, 'getOneInchTakeQuoteEvaluation')
      .resolves({
        isTakeable: false,
        externalTakePath: 'oneinch',
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
        delayBetweenActions: 0,
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
    const errorStub = sinon.stub(logger, 'error');
    const takeLiquidationStub = sinon
      .stub(oneInchExecutionModule, 'takeLiquidation')
      .resolves(true);
    const takeLiquidationFactoryStub = sinon
      .stub(takeFactoryModule, 'takeLiquidationFactory')
      .resolves(true);
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    sinon.stub(takeFactoryModule, 'getFactoryTakeQuoteEvaluation').resolves({
      isTakeable: true,
      externalTakePath: 'oneinch',
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
            allowedExternalTakePaths: ['factory'],
            defaultFactoryLiquiditySource: LiquiditySource.UNISWAPV3,
          },
        },
        delayBetweenActions: 0,
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
    expect(takeLiquidationFactoryStub.called).to.be.false;
    expect(
      errorStub
        .getCalls()
        .some((call) =>
          String(call.args[0]).includes('selected inconsistent path=factory')
        )
    ).to.be.true;
  });

  it('refuses execution when a factory hybrid quote has no selected factory source', async () => {
    const errorStub = sinon.stub(logger, 'error');
    const takeLiquidationFactoryStub = sinon
      .stub(takeFactoryModule, 'takeLiquidationFactory')
      .resolves(true);
    sinon.stub(oneInchExecutionModule, 'takeLiquidation').resolves(true);
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    sinon.stub(takeFactoryModule, 'getFactoryTakeQuoteEvaluation').resolves({
      isTakeable: true,
      externalTakePath: 'factory',
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
            allowedExternalTakePaths: ['factory'],
            defaultFactoryLiquiditySource: LiquiditySource.UNISWAPV3,
          },
        },
        delayBetweenActions: 0,
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

    expect(takeLiquidationFactoryStub.called).to.be.false;
    expect(
      errorStub
        .getCalls()
        .some((call) =>
          String(call.args[0]).includes(
            'selected factory path without a concrete factory source'
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
        .stub(oneInchExecutionModule, 'getOneInchPathQuoteEvaluation')
        .returns(oneInchDeferred.promise);
      const takeLiquidationStub = sinon
        .stub(oneInchExecutionModule, 'takeLiquidation')
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
              allowedExternalTakePaths: ['oneinch'],
              externalTakeRouteSelectionMode: 'factory_first',
              externalTakeProbeTimeoutMs: 50,
              oneInchQuoteFailureThreshold: 2,
            },
          },
          delayBetweenActions: 0,
          subgraphUrl: 'http://example-subgraph',
        } as any,
        transports,
        rpcCache,
      });

      await clock.tickAsync(50);
      await handlePromise;
      expect(rpcCache.oneInchQuoteCircuit?.failures).to.equal(1);
      expect(takeLiquidationStub.called).to.be.false;

      oneInchDeferred.resolve({
        isTakeable: true,
        externalTakePath: 'oneinch',
        selectedLiquiditySource: LiquiditySource.ONEINCH,
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
      expect(rpcCache.oneInchQuoteCircuit?.failures).to.equal(1);
      expect(transports.readRpc.getGasPrice.called).to.be.false;
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
        .stub(oneInchExecutionModule, 'getOneInchPathQuoteEvaluation')
        .resolves({
          isTakeable: false,
          reason: '1inch rejected',
        });
      sinon.stub(oneInchExecutionModule, 'takeLiquidation').resolves(true);
      sinon.stub(takeFactoryModule, 'takeLiquidationFactory').resolves(true);

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
              allowedExternalTakePaths: ['factory', 'oneinch'],
              defaultFactoryLiquiditySource: LiquiditySource.UNISWAPV3,
              externalTakeRouteSelectionMode: 'factory_first',
              externalTakeProbeTimeoutMs: 50,
            },
          },
          delayBetweenActions: 0,
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
        externalTakePath: 'factory',
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
      .stub(oneInchExecutionModule, 'takeLiquidation')
      .resolves(true);
    sinon
      .stub(oneInchExecutionModule, 'getOneInchTakeQuoteEvaluation')
      .resolves({
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
      });

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
        delayBetweenActions: 0,
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
      .stub(oneInchExecutionModule, 'takeLiquidation')
      .resolves(true);
    sinon
      .stub(oneInchExecutionModule, 'getOneInchTakeQuoteEvaluation')
      .resolves({
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
      });

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
        delayBetweenActions: 0,
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
      .stub(oneInchExecutionModule, 'takeLiquidation')
      .resolves(true);
    sinon
      .stub(oneInchExecutionModule, 'getOneInchTakeQuoteEvaluation')
      .resolves({
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
      });

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
        delayBetweenActions: 0,
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
        delayBetweenActions: 0,
        subgraphUrl: 'http://example-subgraph',
      } as any,
      transports: {
        subgraph: {
          cacheKey: 'test-subgraph',
          getLoans: sinon.stub().rejects(new Error('unused')),
          getLiquidations: sinon.stub().rejects(new Error('unused')),
          getHighestMeaningfulBucket: sinon.stub().rejects(new Error('unused')),
          getUnsettledAuctions: sinon.stub().rejects(new Error('unused')),
          getChainwideLiquidationAuctions: sinon
            .stub()
            .rejects(new Error('unused')),
          getBucketTakeLPAwards: sinon.stub().rejects(new Error('unused')),
          getSubgraphMeta: sinon.stub().rejects(new Error('unused')),
        },
        readRpc: {
          getGasPrice: sinon
            .stub()
            .resolves(ethers.utils.parseUnits('100', 'gwei')),
        },
      },
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
        delayBetweenActions: 0,
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
        delayBetweenActions: 0,
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
        delayBetweenActions: 0,
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
        delayBetweenActions: 0,
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
      .stub(oneInchExecutionModule, 'takeLiquidation')
      .resolves();
    sinon
      .stub(oneInchExecutionModule, 'getOneInchTakeQuoteEvaluation')
      .resolves({
        isTakeable: true,
        quoteAmount: 2100,
        quoteAmountRaw: ethers.utils.parseUnits('2100', 6),
        collateralAmount: 1,
        marketPrice: 2100,
        takeablePrice: 2200,
      });
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
        delayBetweenActions: 0,
        subgraphUrl: 'http://example-subgraph',
      } as any,
      transports: createDiscoveryTransports(
        ethers.utils.parseUnits('1', 'gwei')
      ),
    });

    expect(takeLiquidationStub.calledOnce).to.be.true;
    expect(oneInchQuoteStub.calledTwice).to.be.true;
  });

  it('uses raw quote units for discovered take profit-floor checks', async () => {
    const takeLiquidationStub = sinon
      .stub(oneInchExecutionModule, 'takeLiquidation')
      .resolves();
    sinon
      .stub(oneInchExecutionModule, 'getOneInchTakeQuoteEvaluation')
      .resolves({
        isTakeable: true,
        quoteAmount: Number('9100000000000000'),
        quoteAmountRaw: ethers.utils.parseUnits('9100000000000000', 6),
        collateralAmount: 1,
        marketPrice: Number('9100000000000000'),
        takeablePrice: Number('9100000000000000'),
      });
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
        delayBetweenActions: 0,
        subgraphUrl: 'http://example-subgraph',
      } as any,
      transports: createDiscoveryTransports(BigNumber.from(0)),
    });

    expect(takeLiquidationStub.calledOnce).to.be.true;
  });

  it('reuses fresh factory route gas policy during discovered take approval', async () => {
    const takeLiquidationFactoryStub = sinon
      .stub(takeFactoryModule, 'takeLiquidationFactory')
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
        delayBetweenActions: 0,
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

    expect(takeLiquidationFactoryStub.calledOnce).to.be.true;
    expect(transports.readRpc.getGasPrice.calledOnce).to.be.true;
  });

  it('rechecks stale L1 factory route gas policy during discovered take approval', async () => {
    const nowMs = 100_000;
    sinon.stub(Date, 'now').returns(nowMs);
    const takeLiquidationFactoryStub = sinon
      .stub(takeFactoryModule, 'takeLiquidationFactory')
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
        delayBetweenActions: 0,
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

    expect(takeLiquidationFactoryStub.calledOnce).to.be.true;
    expect(transports.readRpc.getGasPrice.callCount).to.equal(2);
  });

  it('logs a discovered take summary with skip counters', async () => {
    sinon.stub(oneInchExecutionModule, 'takeLiquidation').resolves();
    sinon
      .stub(oneInchExecutionModule, 'getOneInchTakeQuoteEvaluation')
      .resolves({
        isTakeable: true,
        quoteAmount: 10,
        collateralAmount: 1,
        marketPrice: 10,
        takeablePrice: 12,
      });
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
        delayBetweenActions: 0,
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
          message.includes('Discovered take target summary:')
      );
    expect(summaryLog).to.be.a('string');
    expect(summaryLog).to.include('candidates=1');
    expect(summaryLog).to.include('approvedTakeDecisions=1');
    expect(summaryLog).to.include('revalidationSkips=1');
    expect(summaryLog).to.include('executionSkips=0');
    expect(summaryLog).to.include('executedExternalTakes=0');
  });

  it('logs execution-stage discovered take failures separately from evaluation skips', async () => {
    sinon
      .stub(oneInchExecutionModule, 'takeLiquidation')
      .rejects(new Error('execution boom'));
    sinon
      .stub(oneInchExecutionModule, 'getOneInchTakeQuoteEvaluation')
      .resolves({
        isTakeable: true,
        quoteAmount: 10,
        collateralAmount: 1,
        marketPrice: 10,
        takeablePrice: 12,
      });
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
        delayBetweenActions: 0,
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
          message.includes('Discovered take target summary:')
      );
    expect(summaryLog).to.be.a('string');
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
        delayBetweenActions: 0,
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
        delayBetweenActions: 0,
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
