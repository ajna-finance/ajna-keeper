import { expect } from 'chai';
import sinon from 'sinon';
import {
  fetchCoinGeckoPrices,
  getPriceCoinGecko,
} from '../../src/pricing/coingecko';
import { PriceOriginSource } from '../../src/config';
import { resetPriceCaches } from '../../src/pricing/price-cache';

// A minimal fetch Response stand-in (only .ok/.status/.json are read).
function fakeResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

describe('fetchCoinGeckoPrices (batch primitive)', () => {
  beforeEach(() => resetPriceCaches());
  afterEach(() => sinon.restore());

  it('resolves many ids in ONE request, keyed by id', async () => {
    const fetchStub = sinon
      .stub(global as unknown as { fetch: typeof fetch }, 'fetch')
      .resolves(fakeResponse({ ethereum: { usd: 3000 }, 'usd-coin': { usd: 1 } }));

    const prices = await fetchCoinGeckoPrices(['ethereum', 'usd-coin'], 'key');

    expect(fetchStub.calledOnce).to.equal(true);
    expect(String(fetchStub.firstCall.args[0])).to.contain(
      'ids=ethereum,usd-coin'
    );
    expect(prices.get('ethereum')).to.equal(3000);
    expect(prices.get('usd-coin')).to.equal(1);
  });

  it('omits ids CoinGecko cannot price (missing / 0 / negative)', async () => {
    sinon
      .stub(global as unknown as { fetch: typeof fetch }, 'fetch')
      .resolves(
        fakeResponse({
          ethereum: { usd: 3000 },
          zero: { usd: 0 },
          neg: { usd: -5 },
        })
      );

    const prices = await fetchCoinGeckoPrices(
      ['ethereum', 'zero', 'neg', 'absent'],
      'key'
    );

    expect(prices.get('ethereum')).to.equal(3000);
    expect(prices.has('zero')).to.equal(false);
    expect(prices.has('neg')).to.equal(false);
    expect(prices.has('absent')).to.equal(false);
  });

  it('returns empty without issuing a request for no ids', async () => {
    const fetchStub = sinon.stub(
      global as unknown as { fetch: typeof fetch },
      'fetch'
    );
    const prices = await fetchCoinGeckoPrices([], 'key');
    expect(prices.size).to.equal(0);
    expect(fetchStub.called).to.equal(false);
  });

  it('advances to the next request variant on an HTTP failure', async () => {
    const fetchStub = sinon.stub(
      global as unknown as { fetch: typeof fetch },
      'fetch'
    );
    fetchStub
      .onFirstCall()
      .resolves(fakeResponse({ status: { error_message: 'demo down' } }, false, 401));
    fetchStub.onSecondCall().resolves(fakeResponse({ ethereum: { usd: 3000 } }));

    const prices = await fetchCoinGeckoPrices(['ethereum'], 'key');

    expect(fetchStub.calledTwice).to.equal(true);
    expect(prices.get('ethereum')).to.equal(3000);
  });

  it('throws when no variant returns a usable response', async () => {
    sinon
      .stub(global as unknown as { fetch: typeof fetch }, 'fetch')
      .resolves(fakeResponse({ status: { error_message: 'down' } }, false, 500));

    let thrown: Error | undefined;
    try {
      await fetchCoinGeckoPrices(['ethereum'], 'key');
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown, 'should fail closed').to.not.equal(undefined);
  });

  it('serves a cached price within the TTL without a second request', async () => {
    const fetchStub = sinon
      .stub(global as unknown as { fetch: typeof fetch }, 'fetch')
      .resolves(fakeResponse({ ethereum: { usd: 3000 } }));

    const first = await fetchCoinGeckoPrices(['ethereum'], 'key');
    const second = await fetchCoinGeckoPrices(['ethereum'], 'key');

    expect(fetchStub.calledOnce, 'second call served from cache').to.equal(true);
    expect(first.get('ethereum')).to.equal(3000);
    expect(second.get('ethereum')).to.equal(3000);
  });
});

describe('getPriceCoinGecko pool price — one batched request', () => {
  beforeEach(() => resetPriceCaches());
  afterEach(() => sinon.restore());

  it('fetches collateral + quote in a single request and returns the ratio', async () => {
    const fetchStub = sinon
      .stub(global as unknown as { fetch: typeof fetch }, 'fetch')
      .resolves(
        fakeResponse({
          'wrapped-steth': { usd: 3300 },
          ethereum: { usd: 3000 },
        })
      );

    const price = await getPriceCoinGecko(
      {
        source: PriceOriginSource.COINGECKO,
        quoteId: 'ethereum',
        collateralId: 'wrapped-steth',
      } as never,
      'key',
      1,
      'https://rpc.example'
    );

    // The whole point of scope A: both legs resolved in ONE request, not two.
    expect(fetchStub.calledOnce, 'one request for both legs').to.equal(true);
    expect(String(fetchStub.firstCall.args[0])).to.contain(
      'ids=wrapped-steth,ethereum'
    );
    expect(price).to.equal(1.1); // 3300 / 3000
  });
});
