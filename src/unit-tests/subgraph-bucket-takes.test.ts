import { expect } from 'chai';
import sinon from 'sinon';
import * as graphqlRequest from 'graphql-request';
import subgraph from '../subgraph';
import { resetReadRpcHealthForTests } from '../read-rpc';
import { clearEndpointHealthState } from '../endpoint-health';

describe('Subgraph getBucketTakeLPAwards', () => {
  beforeEach(() => {
    clearEndpointHealthState();
  });
  afterEach(() => {
    sinon.restore();
    clearEndpointHealthState();
  });

  it('passes the expected variables on the first call and lowercases addresses', async () => {
    const requestStub = sinon
      .stub(graphqlRequest, 'request')
      .resolves({ bucketTakes: [] });

    await subgraph.getBucketTakeLPAwards(
      'http://example-subgraph',
      '0xPoOL1111111111111111111111111111111111AA',
      '0xSiGnEr2222222222222222222222222222222222',
      '500',
      ''
    );

    const variables = (requestStub.firstCall.args[0] as any).variables;
    expect(variables).to.deep.equal({
      poolId: '0xpool1111111111111111111111111111111111aa',
      signerId: '0xsigner2222222222222222222222222222222222',
      cursorTs: '500',
      cursorId: '',
      first: 1000,
    });
  });

  it('advances the composite (cursorTs, cursorId) cursor across pages', async () => {
    const firstPage = Array.from({ length: 1000 }, (_, i) => ({
      id: `take-${String(i).padStart(4, '0')}`,
      index: 2000 + i,
      taker: '0xabc',
      lpAwarded: {
        lpAwardedTaker: '1.0',
        lpAwardedKicker: '0',
        kicker: '0xdef',
      },
      blockTimestamp: String(1000 + i),
    }));
    const secondPage = [
      {
        id: 'take-later-0',
        index: 3000,
        taker: '0xabc',
        lpAwarded: {
          lpAwardedTaker: '2.0',
          lpAwardedKicker: '0',
          kicker: '0xdef',
        },
        blockTimestamp: '2000',
      },
    ];
    const requestStub = sinon.stub(graphqlRequest, 'request');
    requestStub.onCall(0).resolves({ bucketTakes: firstPage });
    requestStub.onCall(1).resolves({ bucketTakes: secondPage });

    const result = await subgraph.getBucketTakeLPAwards(
      'http://example-subgraph',
      '0xpool',
      '0xsigner',
      '0',
      ''
    );

    expect(result.bucketTakes).to.have.length(1001);
    expect(result.truncated).to.equal(false);
    expect(requestStub.callCount).to.equal(2);
    const secondVars = (requestStub.secondCall.args[0] as any).variables;
    // Next page's cursor must be the last item's (blockTimestamp, id) pair
    expect(secondVars.cursorTs).to.equal(String(1000 + 999));
    expect(secondVars.cursorId).to.equal('take-0999');
  });

  it('uses the caller-provided (cursorTs, cursorId) as the initial pagination cursor', async () => {
    const requestStub = sinon
      .stub(graphqlRequest, 'request')
      .resolves({ bucketTakes: [] });

    await subgraph.getBucketTakeLPAwards(
      'http://example-subgraph',
      '0xpool',
      '0xsigner',
      '500',
      'resume-from-this-id'
    );

    const variables = (requestStub.firstCall.args[0] as any).variables;
    expect(variables.cursorTs).to.equal('500');
    expect(variables.cursorId).to.equal('resume-from-this-id');
  });

  it('reports truncated=true when pagination hits the max-pages cap', async () => {
    // Pretend every page is full so pagination keeps walking up to the cap
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({
      id: `take-${Math.random().toString(16).slice(2)}-${i}`,
      index: 2000 + i,
      taker: '0xabc',
      lpAwarded: {
        lpAwardedTaker: '1.0',
        lpAwardedKicker: '0',
        kicker: '0xdef',
      },
      blockTimestamp: '1000',
    }));
    const requestStub = sinon
      .stub(graphqlRequest, 'request')
      .callsFake(async () => ({
        bucketTakes: fullPage.map((take, idx) => ({
          ...take,
          id: `cursor-${requestStub.callCount}-${idx}`,
        })),
      }));

    const result = await subgraph.getBucketTakeLPAwards(
      'http://example-subgraph',
      '0xpool',
      '0xsigner',
      '0',
      ''
    );

    expect(result.truncated).to.equal(true);
    expect(requestStub.callCount).to.equal(100);
  });

  it('falls over to the fallback subgraph URL when the primary fails', async () => {
    resetReadRpcHealthForTests();
    const requestStub = sinon.stub(graphqlRequest, 'request');
    requestStub.onCall(0).rejects(new Error('primary down'));
    requestStub.onCall(1).resolves({ bucketTakes: [] });

    const result = await subgraph.getBucketTakeLPAwards(
      'http://primary',
      '0xpool',
      '0xsigner',
      '0',
      '',
      { fallbackUrls: ['http://fallback'] }
    );

    expect(result.bucketTakes).to.deep.equal([]);
    expect(result.truncated).to.equal(false);
    expect((requestStub.secondCall.args[0] as any).url).to.equal('http://fallback');
  });
});
