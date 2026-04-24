import { expect } from 'chai';
import sinon from 'sinon';
import { PoolExistenceCache } from '../dex/providers/pool-existence-cache';

describe('PoolExistenceCache', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('normalizes token order and casing', () => {
    const cache = new PoolExistenceCache();

    cache.set(
      '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      500,
      true,
      1_000
    );

    expect(
      cache.get(
        '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        500
      )
    ).to.equal(true);
  });

  it('expires stale entries', () => {
    const clock = sinon.useFakeTimers();
    const cache = new PoolExistenceCache();

    cache.set(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      3000,
      false,
      1_000
    );

    clock.tick(999);
    expect(
      cache.get(
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        3000
      )
    ).to.equal(false);

    clock.tick(1);
    expect(
      cache.get(
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        3000
      )
    ).to.be.undefined;
  });

  it('prunes the oldest entries when capacity is exceeded', () => {
    const cache = new PoolExistenceCache(1);

    cache.set(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      500,
      true,
      1_000
    );
    cache.set(
      '0xcccccccccccccccccccccccccccccccccccccccc',
      '0xdddddddddddddddddddddddddddddddddddddddd',
      500,
      false,
      1_000
    );

    expect(
      cache.get(
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        500
      )
    ).to.be.undefined;
    expect(
      cache.get(
        '0xcccccccccccccccccccccccccccccccccccccccc',
        '0xdddddddddddddddddddddddddddddddddddddddd',
        500
      )
    ).to.equal(false);
  });

  it('refreshes insertion order when an existing entry is written again', () => {
    const cache = new PoolExistenceCache(2);

    cache.set(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      500,
      true,
      1_000
    );
    cache.set(
      '0xcccccccccccccccccccccccccccccccccccccccc',
      '0xdddddddddddddddddddddddddddddddddddddddd',
      500,
      false,
      1_000
    );
    cache.set(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      500,
      true,
      1_000
    );
    cache.set(
      '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      '0xffffffffffffffffffffffffffffffffffffffff',
      500,
      true,
      1_000
    );

    expect(
      cache.get(
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        500
      )
    ).to.equal(true);
    expect(
      cache.get(
        '0xcccccccccccccccccccccccccccccccccccccccc',
        '0xdddddddddddddddddddddddddddddddddddddddd',
        500
      )
    ).to.be.undefined;
  });
});
