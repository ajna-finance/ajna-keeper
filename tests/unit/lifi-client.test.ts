import { expect } from 'chai';
import sinon from 'sinon';
import axios from 'axios';
import { fetchLifiQuote } from '../../src/dex/lifi';

describe('LI.FI API client', () => {
  afterEach(() => {
    sinon.restore();
  });

  const config = {
    mode: 'canary' as const,
    apiBaseUrl: 'https://li.quest/v1',
    quoteTimeoutMs: 1234,
    allowExchanges: ['uniswap'],
  };

  const request = {
    chainId: 8453,
    fromToken: '0x1111111111111111111111111111111111111111',
    toToken: '0x2222222222222222222222222222222222222222',
    fromAmount: '1000000',
    fromAddress: '0x3333333333333333333333333333333333333333',
    toAddress: '0x3333333333333333333333333333333333333333',
  };

  it('passes timeout and API-key headers and parses rate-limit headers', async () => {
    const responseBody = { type: 'swap' };
    const axiosGet = sinon.stub(axios, 'get').resolves({
      status: 200,
      headers: {
        'x-ratelimit-limit': '100',
        'x-ratelimit-remaining': '99',
        'x-ratelimit-reset': '60',
        'retry-after': '1',
      },
      data: responseBody,
    });

    const result = await fetchLifiQuote({
      config,
      request,
      apiKey: 'test-api-key',
    });

    expect(result).to.deep.equal({
      data: responseBody,
      status: 200,
      rateLimit: {
        limit: '100',
        remaining: '99',
        reset: '60',
        retryAfter: '1',
      },
    });
    expect(axiosGet.calledOnce).to.equal(true);
    const requestOptions = axiosGet.firstCall.args[1]!;
    expect(requestOptions).to.deep.include({
      timeout: 1234,
      headers: { 'x-lifi-api-key': 'test-api-key' },
    });
    const validateStatus = requestOptions.validateStatus;
    expect(validateStatus).to.be.a('function');
    expect(validateStatus!(429)).to.equal(true);
  });

  it('rejects malformed API base URLs before making requests', async () => {
    const axiosGet = sinon.stub(axios, 'get');

    let caught: unknown;
    try {
      await fetchLifiQuote({
        config: {
          ...config,
          apiBaseUrl: 'https://li.quest/v1?source=keeper',
        },
        request,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).to.be.instanceOf(Error);
    expect((caught as Error).message).to.equal(
      'dex.lifi.apiBaseUrl must be an http(s) URL without credentials, query, or fragment'
    );
    expect(axiosGet.called).to.equal(false);
  });

  it('classifies LI.FI 429 responses as retryable provider failures', async () => {
    sinon.stub(axios, 'get').resolves({
      status: 429,
      headers: {},
      data: { message: 'rate limited' },
    });

    let caught: unknown;
    try {
      await fetchLifiQuote({ config, request });
    } catch (error) {
      caught = error;
    }

    expect(caught).to.be.instanceOf(Error);
    expect((caught as Error).message).to.equal(
      'LI.FI quote request failed status=429'
    );
    expect((caught as { retryable?: boolean }).retryable).to.equal(true);
    expect((caught as { status?: number }).status).to.equal(429);
    expect((caught as { responseBody?: unknown }).responseBody).to.deep.equal({
      message: 'rate limited',
    });
  });

  it('classifies LI.FI 400 responses as nonretryable provider failures', async () => {
    sinon.stub(axios, 'get').resolves({
      status: 400,
      headers: {},
      data: { message: 'bad request' },
    });

    let caught: unknown;
    try {
      await fetchLifiQuote({ config, request });
    } catch (error) {
      caught = error;
    }

    expect(caught).to.be.instanceOf(Error);
    expect((caught as Error).message).to.equal(
      'LI.FI quote request failed status=400'
    );
    expect((caught as { retryable?: boolean }).retryable).to.equal(false);
    expect((caught as { status?: number }).status).to.equal(400);
  });

  it('wraps network and timeout errors as retryable quote failures', async () => {
    const timeout = Object.assign(new Error('timeout of 1234ms exceeded'), {
      code: 'ECONNABORTED',
    });
    sinon.stub(axios, 'get').rejects(timeout);

    let caught: unknown;
    try {
      await fetchLifiQuote({ config, request });
    } catch (error) {
      caught = error;
    }

    expect(caught).to.be.instanceOf(Error);
    expect((caught as Error).message).to.equal(
      'LI.FI quote request failed: timeout of 1234ms exceeded'
    );
    expect((caught as { retryable?: boolean }).retryable).to.equal(true);
  });
});
