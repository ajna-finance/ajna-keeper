import { expect } from 'chai';
import sinon from 'sinon';
import {
  getPoolPriceFromAlchemy,
  getPriceFromAlchemy,
} from '../../src/pricing/alchemy';

const RPC_URL = 'https://eth-mainnet.g.alchemy.com/v2/test-key';

function fakeResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

function priceEntry(address: string, value: string) {
  return { network: 'eth-mainnet', address, prices: [{ currency: 'USD', value }] };
}

describe('Alchemy pool price — one batched request', () => {
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
});
