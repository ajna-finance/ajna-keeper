import { expect } from 'chai';
import sinon from 'sinon';
import * as graphqlRequest from 'graphql-request';
import { clearEndpointHealthState } from '../../src/endpoint-health';
import { logger } from '../../src/logging';
import subgraph from '../../src/subgraph';

// P4 chain-wide kick DISCOVERY signal: pre-auction loans across all pools, the
// only signal that surfaces kickable loans (take discovery is auction-driven).
// Cursor-paginates by loan id with a coarse subgraph-side thresholdPrice_gt
// pre-filter; the precise TP > LUP gate is per-pool on-chain at hydration.
const loanPage = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    borrower: `0xborrower-${prefix}-${index}`,
    thresholdPrice: 1,
    pool: { id: '0x1111111111111111111111111111111111111111' },
  }));

describe('getChainwideKickableLoans', () => {
  afterEach(() => {
    sinon.restore();
    clearEndpointHealthState();
  });

  it('cursor-paginates by loan id until the final short page', async () => {
    const requestStub = sinon.stub(graphqlRequest, 'request');
    requestStub.onCall(0).resolves({ loans: loanPage('loan', 100) });
    requestStub.onCall(1).resolves({ loans: loanPage('loan-second', 100) });
    requestStub.onCall(2).resolves({ loans: loanPage('loan-third', 20) });

    const result = await subgraph.getChainwideKickableLoans(
      'http://example-subgraph',
      100,
      10
    );

    expect(result.loans).to.have.length(220);
    expect(requestStub.callCount).to.equal(3);
    expect((requestStub.firstCall.args[0] as any).variables).to.deep.equal({
      first: 100,
      afterId: '',
      minThresholdPrice: '0',
    });
    expect((requestStub.secondCall.args[0] as any).variables).to.deep.equal({
      first: 100,
      afterId: 'loan-99',
      minThresholdPrice: '0',
    });
    expect((requestStub.thirdCall.args[0] as any).variables).to.deep.equal({
      first: 100,
      afterId: 'loan-second-99',
      minThresholdPrice: '0',
    });
  });

  it('passes the thresholdPrice pre-filter through as a subgraph variable', async () => {
    const requestStub = sinon.stub(graphqlRequest, 'request');
    requestStub.onCall(0).resolves({ loans: [] });

    await subgraph.getChainwideKickableLoans(
      'http://example-subgraph',
      100,
      10,
      '5'
    );

    expect((requestStub.firstCall.args[0] as any).variables).to.deep.equal({
      first: 100,
      afterId: '',
      minThresholdPrice: '5',
    });
  });

  it('warns when discovery hits the configured max page cap', async () => {
    const requestStub = sinon.stub(graphqlRequest, 'request');
    const loggerWarnStub = sinon.stub(logger, 'warn');
    requestStub.onCall(0).resolves({ loans: loanPage('cap', 100) });
    requestStub.onCall(1).resolves({ loans: loanPage('cap-second', 100) });

    const result = await subgraph.getChainwideKickableLoans(
      'http://example-subgraph',
      100,
      2
    );

    expect(result.loans).to.have.length(200);
    expect(loggerWarnStub.calledOnce).to.be.true;
    expect(loggerWarnStub.firstCall.args[0]).to.include(
      'reached maxPages=2 with pageSize=100'
    );
  });
});
