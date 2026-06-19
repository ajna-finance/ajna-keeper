import { expect } from 'chai';
import sinon from 'sinon';
import { getPriceCoinGecko } from '../../src/pricing/coingecko';
import * as alchemy from '../../src/pricing/alchemy';
import { PriceOriginSource } from '../../src/config';

// P2-2 price resilience: when CoinGecko is unavailable (no key, placeholder key,
// or fetch failure) the keeper must fall back to the Alchemy Prices API rather
// than go blind, and must FAIL CLOSED (throw) when the fallback can't resolve a
// price — never silently return a bad number that would mis-gate a kick/take.
// These exercise the no-CoinGecko paths (skipping the live fetch) and stub the
// Alchemy module export.
const cgQuery = (id: string) =>
  ({
    source: PriceOriginSource.COINGECKO,
    query: `price?ids=${id}&vs_currencies=usd`,
  }) as any;

describe('getPriceCoinGecko — Alchemy fallback + fail-closed', () => {
  afterEach(() => sinon.restore());

  it('falls back to Alchemy when no CoinGecko API key is configured', async () => {
    const stub = sinon
      .stub(alchemy, 'getPriceFromAlchemy')
      .resolves(1800);
    const price = await getPriceCoinGecko(
      cgQuery('ethereum'),
      undefined, // no api key -> skip CoinGecko
      8453,
      'https://rpc.example',
      { ethereum: '0x4200000000000000000000000000000000000006' }
    );
    expect(price).to.equal(1800);
    expect(stub.calledOnce).to.equal(true);
  });

  it('treats the placeholder API key as missing and uses Alchemy', async () => {
    sinon.stub(alchemy, 'getPriceFromAlchemy').resolves(1234);
    const price = await getPriceCoinGecko(
      cgQuery('ethereum'),
      'YOUR_COINGECKO_API_KEY_HERE',
      8453,
      'https://rpc.example',
      { ethereum: '0x4200000000000000000000000000000000000006' }
    );
    expect(price).to.equal(1234);
  });

  it('fails closed when the Alchemy fallback has no chainId/rpcUrl', async () => {
    let thrown: Error | undefined;
    try {
      await getPriceCoinGecko(cgQuery('ethereum'), '', undefined, undefined, {});
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).to.match(/chainId and rpcUrl required/);
  });

  it('fails closed when no token-address mapping resolves for the fallback', async () => {
    let thrown: Error | undefined;
    try {
      await getPriceCoinGecko(
        cgQuery('a-token-with-no-mapping'),
        '',
        8453,
        'https://rpc.example',
        {}
      );
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).to.match(/No token address mapping/);
  });
});
