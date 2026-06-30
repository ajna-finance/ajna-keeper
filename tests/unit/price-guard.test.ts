import { expect } from 'chai';
import {
  assertFinitePositivePrice,
  PriceUnavailableError,
} from '../../src/pricing/price-guard';
import { getPrice } from '../../src/pricing';
import { PriceOriginSource } from '../../src/config';

// P0 price-boundary hardening: every resolved price gates an on-chain kick/take
// decision, so a 0 / NaN / Infinity / negative must be rejected at the boundary
// rather than silently producing a degenerate gate or limitIndex. These pin the
// guard helper and the getPrice boundary via the FIXED (no-network) source.
describe('assertFinitePositivePrice', () => {
  it('returns a finite positive value unchanged', () => {
    expect(assertFinitePositivePrice(1800, 'ctx')).to.equal(1800);
    expect(assertFinitePositivePrice(0.0001, 'ctx')).to.equal(0.0001);
  });

  for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
    it(`throws PriceUnavailableError for ${bad}`, () => {
      let thrown: Error | undefined;
      try {
        assertFinitePositivePrice(bad, 'ctx');
      } catch (error) {
        thrown = error as Error;
      }
      expect(thrown).to.be.instanceOf(PriceUnavailableError);
    });
  }

  it('includes the context in the error message', () => {
    let thrown: Error | undefined;
    try {
      assertFinitePositivePrice(0, 'source=fixed (inverted)');
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).to.contain('source=fixed (inverted)');
  });
});

describe('getPrice boundary (FIXED source, no network)', () => {
  it('passes a valid positive price through', async () => {
    expect(
      await getPrice({ source: PriceOriginSource.FIXED, value: 100 })
    ).to.equal(100);
  });

  for (const value of [0, -5]) {
    it(`fails closed on a non-positive FIXED value (${value})`, async () => {
      let thrown: Error | undefined;
      try {
        await getPrice({ source: PriceOriginSource.FIXED, value });
      } catch (error) {
        thrown = error as Error;
      }
      expect(thrown).to.be.instanceOf(PriceUnavailableError);
    });
  }
});
