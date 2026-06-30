import { BigNumber } from 'ethers';
import { weiToDecimaled } from '../utils';
import { SubgraphReader } from '../read-transports';
import { AutoDiscoverKickPolicy } from '../config';
import { evaluateKickCandidate } from './candidate';
import { BondBudget } from './bond-budget';
import { KickSkipReason } from './skip-reason';
import { logger } from '../logging';

export interface KickPoolHydration {
  poolAddress: string;
  /** pool LUP, WAD. */
  lup: BigNumber;
  /** pool HPB == _priceAt(depositIndex(1)), WAD. */
  hpb: BigNumber;
  /** highest-meaningful bucket price (deposit >= minDeposit); undefined if none. */
  hmbPrice: number | undefined;
  /** already-locked bond for this pool (kickerInfo.locked), quote token, decimaled. */
  lockedBondQuote: number;
}

export interface KickLoanHydration {
  thresholdPrice: BigNumber;
  debt: BigNumber;
  neutralPrice: BigNumber;
  liquidationBond: BigNumber;
  /** resolved market price (collateral in quote units), decimaled & price-guarded. */
  marketPrice: number;
}

export interface DiscoveredKickCycleParams {
  subgraph: Pick<SubgraphReader, 'getChainwideKickableLoans'>;
  kickPolicy: AutoDiscoverKickPolicy;
  /** discovery.defaults.kick — the per-pool reward-gate settings. */
  kickDefaults: { minDebt: number; priceFactor: number };
  /** discovery.defaults.take arb settings, consumed by the liveness gate. */
  takeDefaults: { hpbPriceFactor?: number };
  /**
   * Load + hydrate a discovered pool once. Return undefined to skip the pool
   * entirely — e.g. it cannot be loaded/priced, or it is not yet acknowledged
   * for live kicks (dryRun/live-ack gating lives in the caller).
   */
  hydratePool: (poolAddress: string) => Promise<KickPoolHydration | undefined>;
  /**
   * Hydrate one loan + its market price. Return undefined to skip the loan
   * (e.g. the resolved price failed the finite/positive guard).
   */
  hydrateLoan: (
    pool: KickPoolHydration,
    borrower: string
  ) => Promise<KickLoanHydration | undefined>;
  /** Submit (or dry-run) the kick. */
  kickLoan: (
    pool: KickPoolHydration,
    borrower: string,
    liquidationBond: BigNumber,
    marginPrice: number
  ) => Promise<void>;
}

export interface KickReport {
  poolsConsidered: number;
  candidatesConsidered: number;
  kicked: number;
  /** typed skip histogram for observability. */
  skippedByReason: Partial<Record<KickSkipReason, number>>;
  /** pools dropped because they could not be hydrated/priced/acknowledged. */
  poolsSkipped: number;
}

/**
 * Chain-wide discovered kick cycle. Sources pre-auction kickable loans across
 * all pools (the only signal that surfaces them; take discovery is auction-
 * driven), groups them by pool, hydrates each pool once, and runs every loan
 * through the shared executor with liveness REQUIRED (Option 1: only kick where
 * this keeper can take) and the configured bond budget. All I/O is injected so
 * the orchestration is testable; run.ts provides the real hydration + submit.
 *
 * maxPoolsPerRun caps the number of pools kicked in per cycle; the per-pool +
 * global bond budget caps the total bond at risk.
 */
export async function runDiscoveredKickCycle(
  params: DiscoveredKickCycleParams
): Promise<KickReport> {
  const report: KickReport = {
    poolsConsidered: 0,
    candidatesConsidered: 0,
    kicked: 0,
    skippedByReason: {},
    poolsSkipped: 0,
  };
  const bump = (reason: KickSkipReason) => {
    report.skippedByReason[reason] = (report.skippedByReason[reason] ?? 0) + 1;
  };

  const { loans } = await params.subgraph.getChainwideKickableLoans(
    undefined,
    undefined,
    String(params.kickPolicy.minThresholdPrice ?? 0)
  );

  // Group kickable loans by pool, preserving discovery order.
  const byPool = new Map<string, string[]>();
  for (const loan of loans) {
    const key = loan.pool.id.toLowerCase();
    const list = byPool.get(key) ?? [];
    list.push(loan.borrower);
    byPool.set(key, list);
  }

  // First pass: hydrate each pool once and seed the budget's locked-bond
  // baseline before any reservation is charged.
  const hydratedPools = new Map<string, KickPoolHydration>();
  const lockedByPool = new Map<string, number>();
  for (const poolAddress of byPool.keys()) {
    const pool = await params.hydratePool(poolAddress);
    if (!pool) {
      report.poolsSkipped++;
      continue;
    }
    hydratedPools.set(poolAddress, pool);
    lockedByPool.set(poolAddress, pool.lockedBondQuote);
  }

  const budget = new BondBudget({
    limits: {
      maxBondExposurePerPool: params.kickPolicy.maxBondExposure!,
      maxTotalBondExposure: params.kickPolicy.maxTotalBondExposure,
    },
    lockedByPool,
  });

  const maxPools = params.kickPolicy.maxPoolsPerRun;
  let poolsKickedIn = 0;

  for (const [poolAddress, borrowers] of byPool) {
    const pool = hydratedPools.get(poolAddress);
    if (!pool) {
      continue; // already counted in poolsSkipped
    }
    if (maxPools !== undefined && poolsKickedIn >= maxPools) {
      break; // chain-wide volume throttle
    }
    report.poolsConsidered++;

    let kickedInThisPool = false;
    for (const borrower of borrowers) {
      report.candidatesConsidered++;
      const loan = await params.hydrateLoan(pool, borrower);
      if (!loan) {
        bump('price-unavailable');
        continue;
      }
      const decision = evaluateKickCandidate(
        {
          poolAddress,
          thresholdPrice: loan.thresholdPrice,
          lup: pool.lup,
          hpb: pool.hpb,
          debt: loan.debt,
          neutralPrice: loan.neutralPrice,
          marketPrice: loan.marketPrice,
          minDebt: params.kickDefaults.minDebt,
          priceFactor: params.kickDefaults.priceFactor,
          requireLiveness: true,
          hmbPrice: pool.hmbPrice,
          hpbPriceFactor: params.takeDefaults.hpbPriceFactor,
          bondQuote: weiToDecimaled(loan.liquidationBond),
        },
        budget
      );
      if (!decision.kick) {
        bump(decision.reason);
        continue;
      }
      await params.kickLoan(
        pool,
        borrower,
        loan.liquidationBond,
        decision.marginPrice
      );
      report.kicked++;
      kickedInThisPool = true;
    }
    if (kickedInThisPool) {
      poolsKickedIn++;
    }
  }

  logger.info(
    `Discovered kick cycle: kicked ${report.kicked} across ${report.poolsConsidered} pools ` +
      `(${report.candidatesConsidered} candidates, ${report.poolsSkipped} pools skipped); ` +
      `skips: ${JSON.stringify(report.skippedByReason)}`
  );
  return report;
}
