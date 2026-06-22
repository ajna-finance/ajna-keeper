import { expect } from 'chai';
import { getTokenAddress } from '../../src/pricing/coingecko';

// Reproducer for surfaced-defects #6: the Alchemy price-fallback addressMap
// omitted Optimism (10) and Polygon (137) — 2 of the 6 in-scope chains — so a
// CoinGecko-sourced pool on those chains throws "No token address mapping" the
// moment the CoinGecko leg is unavailable, absent an operator override.
describe('getTokenAddress — price addressMap chain coverage (defect #6)', () => {
  // The 6 in-scope chains (src/config/sushi-aggregator-policy.ts).
  const IN_SCOPE_CHAINS = [1, 8453, 42161, 10, 137, 43114];

  for (const chainId of IN_SCOPE_CHAINS) {
    it(`resolves WETH + USDC for chain ${chainId} without an operator override`, () => {
      expect(getTokenAddress('weth', chainId), `weth on ${chainId}`).to.be.a(
        'string'
      );
      expect(getTokenAddress('usdc', chainId), `usdc on ${chainId}`).to.be.a(
        'string'
      );
    });
  }

  it('still honors an operator tokenAddresses override (rescue path)', () => {
    const override = { weth: '0x000000000000000000000000000000000000dEaD' };
    expect(getTokenAddress('weth', 10, override)).to.equal(override.weth);
  });
});
