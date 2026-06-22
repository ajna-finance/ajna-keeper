import { expect } from 'chai';
import path from 'path';
import { pathToFileURL } from 'url';

// ts-node compiles this suite to CommonJS, which downlevels a real `import()`
// into `require()` — unusable for an ESM .mjs. `new Function` hides the import
// from the compiler so it stays a genuine dynamic import at runtime.
const esmImport = new Function('url', 'return import(url)') as (
  url: string
) => Promise<any>;

// The multi-pool no-spend daemon scenario depends on the fixture subgraph stub
// faithfully reproducing the production subgraph's cursor pagination (so the
// REAL keeper enumeration in src/subgraph.ts / src/discovery walks every auction
// across every pool). These tests pin that pure response logic without spawning
// a daemon: chainwide `id_gt` paging, per-pool `borrower_gt` paging, and pool
// isolation. The stub lives in an .mjs harness module, loaded via dynamic import.
describe('fixture subgraph stub — multi-pool enumeration + cursor pagination', () => {
  let mod: {
    getFixtureAuctions: (summaries: unknown[]) => any[];
    buildFixtureSubgraphData: (args: {
      query: string;
      variables: Record<string, unknown>;
      auctions: any[];
      meta: unknown;
    }) => any;
  };

  before(async () => {
    const abs = path.resolve(
      __dirname,
      '../../scripts/no-spend/fixture-subgraph-stub.mjs'
    );
    mod = await esmImport(pathToFileURL(abs).href);
  });

  const POOL_A = '0xAAaA000000000000000000000000000000000001';
  const POOL_B = '0xbBbB000000000000000000000000000000000002';
  const BORR_1 = '0x1111000000000000000000000000000000000001';
  const BORR_2 = '0x2222000000000000000000000000000000000002';
  const BORR_3 = '0x3333000000000000000000000000000000000003';

  const sum = (pool: string, borrower: string) => ({
    pool: { address: pool },
    borrower: {
      owner: borrower,
      debt: '1000',
      collateral: '2000',
      neutralPrice: '1.5',
    },
    finalKick: { auction: { kickTime: '111', debtToCover: '900' } },
  });

  // POOL_A < POOL_B by address, so sorted ids are [A-1, A-2, B-3].
  const auctions = () =>
    mod.getFixtureAuctions([
      sum(POOL_A, BORR_2),
      sum(POOL_B, BORR_3),
      sum(POOL_A, BORR_1),
    ]);

  const CHAINWIDE_QUERY =
    'query GetChainwideLiquidationAuctions { liquidationAuctions(first: $first, where: { settled: false, id_gt: $afterId }) { id borrower pool { id } } }';
  const PER_POOL_QUERY =
    'query GetLiquidations { pool(id: $poolId) { hpb hpbIndex liquidationAuctions(where: { borrower_gt: $afterBorrower }) { borrower } } }';

  it('sorts the auction set by id ascending for deterministic cursoring', () => {
    const ids = auctions().map((a) => a.id);
    expect(ids).to.deep.equal([...ids].sort());
  });

  it('chainwide: returns every auction across pools on the first (uncursored) page', () => {
    const data = mod.buildFixtureSubgraphData({
      query: CHAINWIDE_QUERY,
      variables: { first: 100, afterId: '' },
      auctions: auctions(),
      meta: {},
    });
    expect(data.liquidationAuctions).to.have.length(3);
    // Distinct pools really are enumerated (not just one).
    const pools = new Set(
      data.liquidationAuctions.map((a: any) => a.pool.id)
    );
    expect(pools).to.deep.equal(
      new Set([POOL_A.toLowerCase(), POOL_B.toLowerCase()])
    );
  });

  it('chainwide: paginates by id_gt and terminates', () => {
    const all = auctions();
    const page1 = mod.buildFixtureSubgraphData({
      query: CHAINWIDE_QUERY,
      variables: { first: 2, afterId: '' },
      auctions: all,
      meta: {},
    }).liquidationAuctions;
    expect(page1.map((a: any) => a.id)).to.deep.equal([all[0].id, all[1].id]);

    const page2 = mod.buildFixtureSubgraphData({
      query: CHAINWIDE_QUERY,
      variables: { first: 2, afterId: page1[page1.length - 1].id },
      auctions: all,
      meta: {},
    }).liquidationAuctions;
    expect(page2.map((a: any) => a.id)).to.deep.equal([all[2].id]);

    const page3 = mod.buildFixtureSubgraphData({
      query: CHAINWIDE_QUERY,
      variables: { first: 2, afterId: page2[0].id },
      auctions: all,
      meta: {},
    }).liquidationAuctions;
    expect(page3).to.deep.equal([]); // cursor exhausted
  });

  it('per-pool: returns only the queried pool’s borrowers (isolation)', () => {
    const aData = mod.buildFixtureSubgraphData({
      query: PER_POOL_QUERY,
      variables: { poolId: POOL_A.toLowerCase(), afterBorrower: '', first: 100 },
      auctions: auctions(),
      meta: {},
    });
    expect(aData.pool.liquidationAuctions.map((x: any) => x.borrower)).to.deep.equal(
      [BORR_1, BORR_2]
    );

    const bData = mod.buildFixtureSubgraphData({
      query: PER_POOL_QUERY,
      variables: { poolId: POOL_B.toLowerCase(), afterBorrower: '', first: 100 },
      auctions: auctions(),
      meta: {},
    });
    expect(bData.pool.liquidationAuctions.map((x: any) => x.borrower)).to.deep.equal(
      [BORR_3]
    );
  });

  it('per-pool: paginates by borrower_gt', () => {
    const data = mod.buildFixtureSubgraphData({
      query: PER_POOL_QUERY,
      variables: {
        poolId: POOL_A.toLowerCase(),
        afterBorrower: BORR_1.toLowerCase(),
        first: 100,
      },
      auctions: auctions(),
      meta: {},
    });
    expect(data.pool.liquidationAuctions.map((x: any) => x.borrower)).to.deep.equal(
      [BORR_2]
    );
  });

  it('answers _meta / bucketTakes / loans like the production subgraph', () => {
    const meta = { block: { number: 1, timestamp: 2 } };
    expect(
      mod.buildFixtureSubgraphData({
        query: 'query { _meta { block { number } } }',
        variables: {},
        auctions: auctions(),
        meta,
      })._meta
    ).to.equal(meta);
    expect(
      mod.buildFixtureSubgraphData({
        query: 'query { bucketTakes { id } }',
        variables: {},
        auctions: auctions(),
        meta,
      }).bucketTakes
    ).to.deep.equal([]);
    expect(
      mod.buildFixtureSubgraphData({
        query: 'query GetLoans { loans { id } }',
        variables: {},
        auctions: auctions(),
        meta,
      }).loans
    ).to.deep.equal([]);
  });
});
