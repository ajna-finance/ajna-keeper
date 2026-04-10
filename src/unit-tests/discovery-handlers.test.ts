import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, ethers } from 'ethers';
import {
  handleDiscoveredSettlementTarget,
  handleDiscoveredTakeTarget,
} from '../discovery/handlers';
import * as takeModule from '../take';
import * as settlementModule from '../settlement';
import { LiquiditySource } from '../config';
import * as erc20 from '../erc20';
import { DexRouter } from '../dex/router';
import { logger } from '../logging';

describe('Discovery Handlers', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('skips a discovered take when subgraph data is stale before onchain revalidation', async () => {
    const takeLiquidationStub = sinon.stub(takeModule, 'takeLiquidation').resolves();
    sinon.stub(takeModule, 'getOneInchTakeQuoteEvaluation').resolves({
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
    });

    expect(takeLiquidationStub.called).to.be.false;
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
    const takeLiquidationStub = sinon.stub(takeModule, 'takeLiquidation').resolves();
    sinon.stub(takeModule, 'getOneInchTakeQuoteEvaluation').resolves({
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
          getChainwideLiquidationAuctions: sinon.stub().rejects(new Error('unused')),
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

  it('skips a discovered settlement when onchain revalidation says the auction no longer needs settlement', async () => {
    const handleCandidateAuctionsStub = sinon
      .stub(settlementModule.SettlementHandler.prototype, 'handleCandidateAuctions')
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
    });

    expect(handleCandidateAuctionsStub.called).to.be.false;
  });

  it('does not require take profit-floor gas quoting for discovered settlement candidates', async () => {
    const handleCandidateAuctionsStub = sinon
      .stub(settlementModule.SettlementHandler.prototype, 'handleCandidateAuctions')
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
    });

    expect(handleCandidateAuctionsStub.calledOnce).to.be.true;
    expect(handleCandidateAuctionsStub.firstCall.args[0]).to.have.length(1);
    expect(handleCandidateAuctionsStub.firstCall.args[0][0].borrower).to.equal('0xBorrowerC');
  });

  it('allows discovered settlement to use a native gas cap without quote conversion config', async () => {
    const handleCandidateAuctionsStub = sinon
      .stub(settlementModule.SettlementHandler.prototype, 'handleCandidateAuctions')
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
        getGasPrice: sinon.stub().resolves(ethers.utils.parseUnits('1', 'gwei')),
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
    });

    expect(handleCandidateAuctionsStub.calledOnce).to.be.true;
  });

  it('reuses the discovered take quote for native gas conversion when collateral is wrapped native', async () => {
    const takeLiquidationStub = sinon.stub(takeModule, 'takeLiquidation').resolves();
    sinon.stub(takeModule, 'getOneInchTakeQuoteEvaluation').resolves({
      isTakeable: true,
      quoteAmount: 2100,
      quoteAmountRaw: ethers.utils.parseUnits('2100', 6),
      collateralAmount: 1,
      marketPrice: 2100,
      takeablePrice: 2200,
    });
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const oneInchQuoteStub = sinon.stub(DexRouter.prototype, 'getQuoteFromOneInch').resolves({
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
        getGasPrice: sinon.stub().resolves(ethers.utils.parseUnits('1', 'gwei')),
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
        delayBetweenActions: 0,
        subgraphUrl: 'http://example-subgraph',
      } as any,
    });

    expect(takeLiquidationStub.calledOnce).to.be.true;
    expect(oneInchQuoteStub.called).to.be.false;
  });

  it('logs a discovered take summary with skip counters', async () => {
    sinon.stub(takeModule, 'takeLiquidation').resolves();
    sinon.stub(takeModule, 'getOneInchTakeQuoteEvaluation').resolves({
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
    expect(summaryLog).to.include('executedExternalTakes=0');
  });

  it('logs a discovered settlement summary with skip counters', async () => {
    sinon
      .stub(settlementModule.SettlementHandler.prototype, 'handleCandidateAuctions')
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
