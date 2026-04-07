import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, ethers } from 'ethers';
import {
  handleDiscoveredSettlementTarget,
  handleDiscoveredTakeTarget,
} from '../auto-discovery-handlers';
import * as erc20Module from '../erc20';
import * as takeModule from '../take';
import * as settlementModule from '../settlement';
import { LiquiditySource } from '../config-types';

describe('Auto Discovery Handlers', () => {
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

  it('does not apply minExpectedProfitQuote to discovered settlement candidates', async () => {
    const handleCandidateAuctionsStub = sinon
      .stub(settlementModule.SettlementHandler.prototype, 'handleCandidateAuctions')
      .resolves();
    sinon
      .stub(settlementModule.SettlementHandler.prototype, 'needsSettlement')
      .resolves({ needs: true, reason: 'Bad debt detected' });
    sinon.stub(erc20Module, 'getDecimalsErc20').resolves(18);

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
          minExpectedProfitQuote: 9999,
        },
        tokenAddresses: {
          weth: pool.quoteAddress,
        },
        delayBetweenActions: 0,
        subgraphUrl: 'http://example-subgraph',
      } as any,
    });

    expect(handleCandidateAuctionsStub.calledOnce).to.be.true;
    expect(handleCandidateAuctionsStub.firstCall.args[0]).to.have.length(1);
    expect(handleCandidateAuctionsStub.firstCall.args[0][0].borrower).to.equal('0xBorrowerC');
  });
});
