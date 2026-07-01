import { expect } from 'chai';
import sinon from 'sinon';
import {
  getPoolPriceFromAlchemy,
  getPriceFromAlchemy,
} from '../../src/pricing/alchemy';
import { resetPriceCaches } from '../../src/pricing/price-cache';

const RPC_URL = 'https://eth-mainnet.g.alchemy.com/v2/test-key';

function fakeResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

function priceEntry(address: string, value: string) {
  return {
    network: 'eth-mainnet',
    address,
    prices: [{ currency: 'USD', value }],
  };
}

async function expectRejects(
  promise: Promise<unknown>,
  message: string
): Promise<void> {
  let thrown: Error | undefined;
  try {
    await promise;
  } catch (error) {
    thrown = error as Error;
  }
  expect(thrown?.message).to.include(message);
}

describe('Alchemy pool price — one batched request', () => {
  beforeEach(() => resetPriceCaches());
  afterEach(() => sinon.restore());

  it('fetches collateral + quote in a single request and returns the ratio', async () => {
    const fetchStub = sinon
      .stub(global as unknown as { fetch: typeof fetch }, 'fetch')
      .resolves(
        fakeResponse({
          data: [
            priceEntry('0xCollateral', '3300'),
            priceEntry('0xQuote', '3000'),
          ],
        })
      );

    const price = await getPoolPriceFromAlchemy(
      '0xQuote',
      '0xCollateral',
      1,
      RPC_URL
    );

    // The whole point: both legs in ONE Alchemy request, not two.
    expect(fetchStub.calledOnce, 'one request for both legs').to.equal(true);
    const body = JSON.parse(String(fetchStub.firstCall.args[1]?.body));
    expect(body.addresses).to.have.length(2);
    expect(price).to.equal(1.1); // 3300 / 3000
  });

  it('keys results by address (case-insensitive) and fails closed on a missing leg', async () => {
    sinon
      .stub(global as unknown as { fetch: typeof fetch }, 'fetch')
      .resolves(fakeResponse({ data: [priceEntry('0xCollateral', '3300')] }));

    let thrown: Error | undefined;
    try {
      await getPoolPriceFromAlchemy('0xQuote', '0xCollateral', 1, RPC_URL);
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).to.match(/No USD price available/);
  });

  it('resolves a single address through the same primitive', async () => {
    sinon
      .stub(global as unknown as { fetch: typeof fetch }, 'fetch')
      .resolves(fakeResponse({ data: [priceEntry('0xToken', '42')] }));

    const price = await getPriceFromAlchemy('0xtoken', 1, RPC_URL);
    expect(price).to.equal(42);
  });

  it('serves repeated lookups from the shared cache without another fetch', async () => {
    const fetchStub = sinon
      .stub(global as unknown as { fetch: typeof fetch }, 'fetch')
      .resolves(fakeResponse({ data: [priceEntry('0xToken', '42')] }));

    expect(await getPriceFromAlchemy('0xtoken', 1, RPC_URL)).to.equal(42);
    expect(await getPriceFromAlchemy('0xTOKEN', 1, RPC_URL)).to.equal(42);
    expect(fetchStub.calledOnce).to.equal(true);
  });

  it('fails closed for unsupported chains, missing API keys, HTTP failures, and token-level errors', async () => {
    await expectRejects(
      getPriceFromAlchemy('0xToken', 999_999, RPC_URL),
      'Unsupported chainId for Alchemy Prices API'
    );

    await expectRejects(
      getPriceFromAlchemy('0xToken', 1, 'https://example.invalid/rpc'),
      'Could not extract Alchemy API key from RPC URL'
    );

    const fetchStub = sinon.stub(
      global as unknown as { fetch: typeof fetch },
      'fetch'
    );
    fetchStub.resolves(fakeResponse({ data: [] }, false, 502));
    await expectRejects(
      getPriceFromAlchemy('0xToken', 1, RPC_URL),
      'Alchemy API request failed: 502'
    );

    fetchStub.resetHistory();
    fetchStub.resolves(
      fakeResponse({
        data: [{ address: '0xToken', error: { message: 'not indexed' } }],
      })
    );
    await expectRejects(
      getPriceFromAlchemy('0xToken', 1, RPC_URL),
      'No USD price available from Alchemy'
    );
  });
});
