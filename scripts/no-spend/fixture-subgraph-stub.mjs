// Pure response builder for the no-spend fixture subgraph stub.
//
// Extracted from daemon-smoke.mjs so the multi-pool enumeration logic (serving a
// LIST of auctions with real id-cursor pagination, matching the production
// queries in src/subgraph.ts) is unit-testable without spawning a daemon. The
// real keeper drives:
//   - GetChainwideLiquidationAuctions($first,$afterId): paged by `id_gt`, asc
//   - GetLiquidations/GetUnsettledAuctions($poolId,$afterBorrower): per-pool,
//     paged by `borrower_gt`, asc
//   - _meta / bucketTakes / loans: freshness + reward/loan reads
// so the stub must answer all of them faithfully for N auctions across M pools.

/** Build one chainwide `liquidationAuctions` row from a fixture summary. */
export function getFixtureAuction(summary) {
  return {
    id: `${summary.pool.address.toLowerCase()}-${summary.borrower.owner.toLowerCase()}`,
    borrower: summary.borrower.owner,
    kickTime: String(summary.finalKick?.auction?.kickTime ?? '0'),
    debtRemaining:
      summary.finalKick?.auction?.debtToCover ?? summary.borrower.debt ?? '0',
    collateralRemaining: summary.borrower.collateral ?? '0',
    neutralPrice:
      summary.finalKick?.auction?.neutralPrice ?? summary.borrower.neutralPrice,
    debt: summary.borrower.debt ?? '0',
    collateral: summary.borrower.collateral ?? '0',
    pool: {
      id: summary.pool.address.toLowerCase(),
    },
  };
}

/**
 * Build the auction set for N summaries, sorted by `id` ascending so the
 * `id_gt` chainwide cursor paginates deterministically (matching the real
 * subgraph's `orderBy: id, orderDirection: asc`).
 */
export function getFixtureAuctions(summaries) {
  return summaries
    .map(getFixtureAuction)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const lower = (value) => String(value ?? '').toLowerCase();

/**
 * Pure GraphQL `data` builder. `auctions` is the sorted output of
 * getFixtureAuctions; `meta` is the `_meta` block (fresh per request because it
 * carries the live block). Branch order matters: the per-pool query selects
 * `pool(id: ...)` while the chainwide query selects a `pool { id }` SUB-field —
 * so `pool(` must be tested before `liquidationAuctions`.
 */
export function buildFixtureSubgraphData({ query, variables, auctions, meta }) {
  const vars = variables ?? {};
  const rows = auctions ?? [];

  if (query.includes('_meta')) {
    return { _meta: meta };
  }
  if (query.includes('bucketTakes')) {
    return { bucketTakes: [] };
  }
  if (query.includes('loans')) {
    return { loans: [] };
  }
  if (query.includes('pool(')) {
    // Per-pool read (GetLiquidations / GetUnsettledAuctions): return only THIS
    // pool's borrowers, cursor-paginated by `borrower_gt: $afterBorrower`.
    const poolId = lower(vars.poolId);
    const after = lower(vars.afterBorrower);
    const first = Number(vars.first ?? 100);
    const liquidationAuctions = rows
      .filter((auction) => lower(auction.pool.id) === poolId)
      .map((auction) => auction.borrower)
      .filter((borrower) => lower(borrower) > after)
      .sort((a, b) => (lower(a) < lower(b) ? -1 : lower(a) > lower(b) ? 1 : 0))
      .slice(0, first)
      .map((borrower) => ({ borrower }));
    return { pool: { hpb: 0, hpbIndex: 0, liquidationAuctions } };
  }
  if (query.includes('liquidationAuctions')) {
    // Chainwide enumeration (GetChainwideLiquidationAuctions): page by `id_gt`.
    const after = String(vars.afterId ?? '');
    const first = Number(vars.first ?? 100);
    const liquidationAuctions = rows
      .filter((auction) => auction.id > after)
      .slice(0, first);
    return { liquidationAuctions };
  }
  return {};
}
