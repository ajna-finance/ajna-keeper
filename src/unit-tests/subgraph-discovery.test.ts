import { expect } from 'chai';
import sinon from 'sinon';
import * as graphqlRequest from 'graphql-request';
import subgraph from '../subgraph';

describe('Subgraph Discovery Pagination', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('paginates chain-wide liquidation auctions until the final short page', async () => {
    const requestStub = sinon.stub(graphqlRequest, 'request');
    requestStub.onCall(0).resolves({
      liquidationAuctions: Array.from({ length: 100 }, (_, index) => ({
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
    expect(requestStub.firstCall.args[2]).to.deep.equal({ first: 100, skip: 0 });
    expect(requestStub.secondCall.args[2]).to.deep.equal({ first: 100, skip: 100 });
    expect(requestStub.thirdCall.args[2]).to.deep.equal({ first: 100, skip: 200 });
  });
});
