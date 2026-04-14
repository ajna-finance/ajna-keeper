import { expect } from 'chai';
import sinon from 'sinon';
import * as graphqlRequest from 'graphql-request';
import { clearEndpointHealthState } from '../endpoint-health';
import { logger } from '../logging';
import subgraph from '../subgraph';

describe('Subgraph Discovery Pagination', () => {
  afterEach(() => {
    sinon.restore();
    clearEndpointHealthState();
  });

  it('paginates pool loan discovery until the final short page', async () => {
    const requestStub = sinon.stub(graphqlRequest, 'request');
    requestStub.onCall(0).resolves({
      loans: Array.from({ length: 1000 }, (_, index) => ({
        borrower: `0xborrower-${index}`,
        thresholdPrice: 1,
      })),
    });
    requestStub.onCall(1).resolves({
      loans: Array.from({ length: 250 }, (_, index) => ({
        borrower: `0xborrower-next-${index}`,
        thresholdPrice: 1,
      })),
    });

    const result = await subgraph.getLoans(
      'http://example-subgraph',
      '0x1111111111111111111111111111111111111111'
    );

    expect(result.loans).to.have.length(1250);
    expect(requestStub.callCount).to.equal(2);
    expect((requestStub.firstCall.args[0] as any).variables).to.deep.equal({
      poolId: '0x1111111111111111111111111111111111111111',
      first: 1000,
      afterBorrower: '',
    });
    expect((requestStub.secondCall.args[0] as any).variables).to.deep.equal({
      poolId: '0x1111111111111111111111111111111111111111',
      first: 1000,
      afterBorrower: '0xborrower-999',
    });
  });

  it('paginates chain-wide liquidation auctions until the final short page', async () => {
    const requestStub = sinon.stub(graphqlRequest, 'request');
    requestStub.onCall(0).resolves({
      liquidationAuctions: Array.from({ length: 100 }, (_, index) => ({
        id: `auction-${index}`,
        borrower: `0xborrower-${index}`,
        kickTime: '1',
        debtRemaining: '1',
        collateralRemaining: '1',
        neutralPrice: '1',
        debt: '1',
        collateral: '1',
        pool: { id: '0x1111111111111111111111111111111111111111' },
      })),
    });
    requestStub.onCall(1).resolves({
      liquidationAuctions: Array.from({ length: 100 }, (_, index) => ({
        id: `auction-second-${index}`,
        borrower: `0xborrower-second-${index}`,
        kickTime: '1',
        debtRemaining: '1',
        collateralRemaining: '1',
        neutralPrice: '1',
        debt: '1',
        collateral: '1',
        pool: { id: '0x1111111111111111111111111111111111111111' },
      })),
    });
    requestStub.onCall(2).resolves({
      liquidationAuctions: Array.from({ length: 20 }, (_, index) => ({
        id: `auction-third-${index}`,
        borrower: `0xborrower-third-${index}`,
        kickTime: '1',
        debtRemaining: '1',
        collateralRemaining: '1',
        neutralPrice: '1',
        debt: '1',
        collateral: '1',
        pool: { id: '0x1111111111111111111111111111111111111111' },
      })),
    });

    const result = await subgraph.getChainwideLiquidationAuctions(
      'http://example-subgraph',
      100,
      10
    );

    expect(result.liquidationAuctions).to.have.length(220);
    expect(requestStub.callCount).to.equal(3);
    const firstRequest = requestStub.firstCall.args[0] as any;
    const secondRequest = requestStub.secondCall.args[0] as any;
    const thirdRequest = requestStub.thirdCall.args[0] as any;
    expect(firstRequest).to.include({
      url: 'http://example-subgraph',
    });
    expect(firstRequest.variables).to.deep.equal({ first: 100, afterId: '' });
    expect(secondRequest.variables).to.deep.equal({
      first: 100,
      afterId: 'auction-99',
    });
    expect(thirdRequest.variables).to.deep.equal({
      first: 100,
      afterId: 'auction-second-99',
    });
  });

  it('fails over to fallback subgraph endpoints on request failure', async () => {
    const requestStub = sinon.stub(graphqlRequest, 'request');
    requestStub.onCall(0).rejects(new Error('primary unavailable'));
    requestStub.onCall(1).resolves({
      liquidationAuctions: [],
    });

    const result = await subgraph.getChainwideLiquidationAuctions(
      'http://primary-subgraph',
      100,
      1,
      { fallbackUrls: ['http://fallback-subgraph'] }
    );

    expect(result.liquidationAuctions).to.deep.equal([]);
    expect(requestStub.callCount).to.equal(2);
    expect(requestStub.firstCall.args[0] as any).to.include({
      url: 'http://primary-subgraph',
    });
    expect(requestStub.secondCall.args[0] as any).to.include({
      url: 'http://fallback-subgraph',
    });
  });

  it('warns when chain-wide discovery hits the configured max page cap', async () => {
    const requestStub = sinon.stub(graphqlRequest, 'request');
    const loggerWarnStub = sinon.stub(logger, 'warn');
    requestStub.onCall(0).resolves({
      liquidationAuctions: Array.from({ length: 100 }, (_, index) => ({
        id: `cap-auction-${index}`,
        borrower: `0xborrower-${index}`,
        kickTime: '1',
        debtRemaining: '1',
        collateralRemaining: '1',
        neutralPrice: '1',
        debt: '1',
        collateral: '1',
        pool: { id: '0x1111111111111111111111111111111111111111' },
      })),
    });
    requestStub.onCall(1).resolves({
      liquidationAuctions: Array.from({ length: 100 }, (_, index) => ({
        id: `cap-auction-second-${index}`,
        borrower: `0xborrower-second-${index}`,
        kickTime: '1',
        debtRemaining: '1',
        collateralRemaining: '1',
        neutralPrice: '1',
        debt: '1',
        collateral: '1',
        pool: { id: '0x1111111111111111111111111111111111111111' },
      })),
    });

    const result = await subgraph.getChainwideLiquidationAuctions(
      'http://example-subgraph',
      100,
      2
    );

    expect(result.liquidationAuctions).to.have.length(200);
    expect(loggerWarnStub.calledOnce).to.be.true;
    expect(loggerWarnStub.firstCall.args[0]).to.include(
      'reached maxPages=2 with pageSize=100'
    );
  });
});
