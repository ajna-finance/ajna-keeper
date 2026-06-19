import { expect } from 'chai';
import { ethers } from 'ethers';
import { getPrice, getPoolPrice } from '../../src/pricing';
import { PriceOriginSource, PriceOriginPoolReference } from '../../src/config';

// P2-2 price sourcing & inversion: the resolved price gates every kick/take
// decision, and `invert` flips it (e.g. quote-per-collateral vs
// collateral-per-quote). These pin the FIXED / POOL dispatch + the invert
// transform + its zero-guard + the POOL fail-closed — no network needed.
describe('getPrice — source dispatch, inversion, and fail-closed', () => {
  it('returns the FIXED value unchanged when invert is not set', async () => {
    const price = await getPrice({ source: PriceOriginSource.FIXED, value: 100 });
    expect(price).to.equal(100);
  });

  it('inverts the FIXED value when invert is set', async () => {
    const price = await getPrice({
      source: PriceOriginSource.FIXED,
      value: 100,
      invert: true,
    });
    expect(price).to.equal(0.01);
  });

  it('guards against division-by-zero when inverting a zero price', async () => {
    const price = await getPrice({
      source: PriceOriginSource.FIXED,
      value: 0,
      invert: true,
    });
    expect(price).to.equal(0); // not Infinity
  });

  it('resolves a POOL reference and applies invert on the WAD-decoded price', async () => {
    const poolPrices = {
      hpb: ethers.utils.parseEther('100'),
      htp: ethers.utils.parseEther('50'),
      lup: ethers.utils.parseEther('25'),
      llb: ethers.utils.parseEther('1'),
    } as any;
    const upright = await getPrice(
      { source: PriceOriginSource.POOL, reference: PriceOriginPoolReference.HPB },
      '',
      poolPrices
    );
    expect(upright).to.equal(100);

    const inverted = await getPrice(
      {
        source: PriceOriginSource.POOL,
        reference: PriceOriginPoolReference.HPB,
        invert: true,
      },
      '',
      poolPrices
    );
    expect(inverted).to.equal(0.01);
  });

  it('fails closed when a POOL price origin is used without pool prices', async () => {
    let thrown: Error | undefined;
    try {
      await getPrice({
        source: PriceOriginSource.POOL,
        reference: PriceOriginPoolReference.HPB,
      });
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).to.match(/Pool prices required/);
  });
});

describe('getPoolPrice — reference selection', () => {
  const poolPrices = {
    hpb: ethers.utils.parseEther('500'),
    htp: ethers.utils.parseEther('300'),
    lup: ethers.utils.parseEther('250'),
    llb: ethers.utils.parseEther('2'),
  } as any;

  it('selects each supported reference and WAD-decodes it', async () => {
    expect(await getPoolPrice(poolPrices, PriceOriginPoolReference.HPB)).to.equal(
      500
    );
    expect(await getPoolPrice(poolPrices, PriceOriginPoolReference.HTP)).to.equal(
      300
    );
    expect(await getPoolPrice(poolPrices, PriceOriginPoolReference.LUP)).to.equal(
      250
    );
    expect(await getPoolPrice(poolPrices, PriceOriginPoolReference.LLB)).to.equal(
      2
    );
  });

  it('throws on an unknown pool price reference', async () => {
    let thrown: Error | undefined;
    try {
      await getPoolPrice(poolPrices, 'not-a-reference' as never);
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).to.match(/Unknown pool price reference/);
  });
});
