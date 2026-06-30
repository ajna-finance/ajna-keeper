import { FungiblePool, Signer } from '@ajna-finance/sdk';
import {
  runDiscoveredKickCycle,
  KickReport,
  KickLoanHydration,
} from '../../src/kick/cycle';
import { SubgraphReader } from '../../src/read-transports';
import { kick } from '../../src/kick';
import { weiToDecimaled } from '../../src/utils';

export interface FixtureDiscoveredKickOptions {
  pool: FungiblePool;
  signer: Signer;
  /** The fixture's single borrower (summary.borrower.owner). */
  borrower: string;
  /** Mirrors the harness dryRun flag: false posts a real bond, true simulates. */
  dryRun: boolean;
  /** Per-pool bond cap; only needs to exceed the fixture's (small) bond. */
  maxBondExposure?: number;
  /** Reward-margin factor in (0,1): NP must exceed market by 1/priceFactor. */
  priceFactor?: number;
  /** Liveness arb factor: market must clear below hmbPrice * hpbPriceFactor. */
  hpbPriceFactor?: number;
  /** Minimum debt worth kicking (quote token). */
  minDebt?: number;
  /**
   * Synthetic local market price = neutralPrice * this. Kept well below NP so a
   * kick-eligible fixture clears the reward + arb-room gates without a live price
   * feed (the harness is no-egress; production resolves this via Alchemy).
   */
  marketPriceFactor?: number;
}

/**
 * Run the chain-wide discovered (auto-)kick cycle (src/kick/cycle.ts) against the
 * local fixture pool, exercising the auto-kick gates — reward + liveness + bond
 * budget — and the real kick submission end-to-end.
 *
 * Unlike the daemon's runDiscoveredKickStep, this builds the cycle deps from
 * local SDK reads with a synthetic market price, so it never calls Alchemy (no
 * egress) and needs no poolMap/hydrationCooldowns/full KeeperConfig — the same
 * approach the discovered-kick fork test uses. Returns the KickReport (kicked
 * count + typed skip histogram), which the caller surfaces.
 */
export async function runDiscoveredFixtureKick(
  opts: FixtureDiscoveredKickOptions
): Promise<KickReport> {
  const { pool, signer, borrower, dryRun } = opts;
  const maxBondExposure = opts.maxBondExposure ?? 1_000_000;
  const priceFactor = opts.priceFactor ?? 0.99;
  const hpbPriceFactor = opts.hpbPriceFactor ?? 0.99;
  const minDebt = opts.minDebt ?? 0;
  const marketPriceFactor = opts.marketPriceFactor ?? 0.25;
  const signerAddress = await signer.getAddress();

  // Single-borrower chain-wide source derived from chain (no subgraph). The
  // cycle only consumes pool.id + borrower from each row.
  const subgraph: Pick<SubgraphReader, 'getChainwideKickableLoans'> = {
    getChainwideKickableLoans: async () => {
      const loan = await pool.getLoan(borrower);
      if (loan.isKicked) {
        return { loans: [] }; // already in auction -> not kickable
      }
      return {
        loans: [
          {
            id: `${pool.poolAddress}-${borrower}`,
            borrower,
            thresholdPrice: weiToDecimaled(loan.thresholdPrice),
            pool: { id: pool.poolAddress },
          },
        ],
      };
    },
  };

  return runDiscoveredKickCycle({
    subgraph,
    kickPolicy: { enabled: true, maxBondExposure },
    kickDefaults: { minDebt, priceFactor },
    takeDefaults: { hpbPriceFactor },
    hydratePool: async (poolAddress) => {
      const [prices, kickerInfo] = await Promise.all([
        pool.getPrices(),
        pool.kickerInfo(signerAddress),
      ]);
      // The fixture funds a single meaningful deposit bucket, so the highest
      // meaningful bucket is the HPB. (Production resolves HMB via the subgraph's
      // getHighestMeaningfulBucket, which can differ when the top bucket is dust.)
      const hpbPrice = weiToDecimaled(prices.hpb);
      return {
        poolAddress,
        lup: prices.lup,
        hpb: prices.hpb,
        hmbPrice: hpbPrice > 0 ? hpbPrice : undefined,
        lockedBondQuote: weiToDecimaled(kickerInfo.locked),
      };
    },
    hydrateLoans: async (_hydratedPool, borrowers) => {
      const loans = new Map<string, KickLoanHydration>();
      for (const loanBorrower of borrowers) {
        const loan = await pool.getLoan(loanBorrower);
        loans.set(loanBorrower, {
          thresholdPrice: loan.thresholdPrice,
          debt: loan.debt,
          neutralPrice: loan.neutralPrice,
          liquidationBond: loan.liquidationBond,
          marketPrice: weiToDecimaled(loan.neutralPrice) * marketPriceFactor,
        });
      }
      return loans;
    },
    kickLoan: async (
      _hydratedPool,
      loanBorrower,
      liquidationBond,
      marginPrice
    ) => {
      await kick({
        pool,
        signer,
        loanToKick: {
          borrower: loanBorrower,
          liquidationBond,
          estimatedRemainingBond: liquidationBond,
          limitPrice: marginPrice,
        },
        config: { dryRun },
      });
    },
  });
}
