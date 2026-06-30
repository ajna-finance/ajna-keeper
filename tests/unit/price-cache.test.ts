import { expect } from 'chai';
import { TtlPriceCache } from '../../src/pricing/price-cache';

describe('TtlPriceCache', () => {
  it('returns a value within the TTL and undefined after it expires', async () => {
    const cache = new TtlPriceCache(20); // 20ms TTL
    cache.set('eth', 3000);
    expect(cache.get('eth')).to.equal(3000);

    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(cache.get('eth'), 'expired entry is dropped').to.equal(undefined);
  });

  it('clear() drops all entries', () => {
    const cache = new TtlPriceCache();
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    expect(cache.get('a')).to.equal(undefined);
    expect(cache.get('b')).to.equal(undefined);
  });
});
