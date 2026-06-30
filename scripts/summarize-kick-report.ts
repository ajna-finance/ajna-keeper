/**
 * Summarize an auto-kick dry-run log.
 *
 * Reads keeper log output (a file path argument, or stdin) and aggregates the
 * chain-wide discovered-kick cycle reports + dry-run "would kick" lines into one
 * summary: how many candidates were evaluated, how many WOULD have been kicked,
 * and — the key tuning signal — the typed histogram of why the rest were
 * skipped, annotated with the config knob each reason points at.
 *
 * Usage:
 *   npm run summarize-kick-report -- path/to/keeper.log
 *   cat keeper.log | npm run summarize-kick-report
 *   yarn ts-node scripts/summarize-kick-report.ts keeper.log
 */
import { readFileSync } from 'fs';
import type { KickSkipReason } from '../src/kick/skip-reason';

// Which config knob each skip reason points at. Typed by KickSkipReason so
// adding or renaming a reason is a compile error here until the guide is updated.
const TUNING_GUIDE: Record<KickSkipReason, string> = {
  collateralized: 'not liquidatable yet (TP <= LUP) — nothing to tune',
  'debt-below-min':
    'below discovery.defaults.kick.minDebt — lower it to widen coverage',
  'neutral-below-market':
    'reward margin not met (NP < market/priceFactor) — priceFactor too wide, or market genuinely above NP',
  'neutral-below-hpb':
    'NP below HPB — a bucketTake could penalize the bond; pool not safely kickable',
  'price-unavailable':
    'no market price (Alchemy/CoinGecko) — pricing coverage gap, not a tuning knob',
  'no-meaningful-bucket':
    'no highest-meaningful bucket to arbTake into — pool has no meaningful deposit',
  'liveness-hmb-above-np':
    'HMB bucket priced above NP — your own take would penalize the bond (gate working as intended)',
  'liveness-no-arb-room':
    'market not below the HMB arb threshold — no arb profit at the current take config',
  'bond-budget-exceeded':
    'bond would exceed a cap — raise discovery.kick.maxBondExposure / maxTotalBondExposure',
};

interface CycleRecord {
  kicked: number;
  poolsConsidered: number;
  candidates: number;
  poolsSkipped: number;
  skips: Partial<Record<KickSkipReason, number>>;
}

// Matches kick/cycle.ts's per-cycle summary line (the skip histogram is JSON).
const CYCLE_RE =
  /Discovered kick cycle: kicked (\d+) across (\d+) pools \((\d+) candidates, (\d+) pools skipped\); skips: (\{.*\})/;
// Matches kick/index.ts's dry-run line (shared by manual + discovered kicks).
const WOULD_KICK_RE =
  /DryRun - Would kick loan - pool: (.+?), borrower: (0x[0-9a-fA-F]+)/;
const TS_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/;

function main(): void {
  const path = process.argv[2];
  let raw: string;
  try {
    raw = readFileSync(path ?? 0, 'utf8');
  } catch (err) {
    console.error(
      `Could not read ${path ? `'${path}'` : 'stdin'}: ${(err as Error).message}`
    );
    process.exit(1);
  }

  const cycles: CycleRecord[] = [];
  const wouldKick = new Map<string, number>();
  let firstTs: string | undefined;
  let lastTs: string | undefined;

  for (const line of raw.split('\n')) {
    const ts = line.match(TS_RE)?.[1];
    if (ts) {
      firstTs ??= ts;
      lastTs = ts;
    }

    const cycle = line.match(CYCLE_RE);
    if (cycle) {
      let skips: Partial<Record<KickSkipReason, number>> = {};
      try {
        skips = JSON.parse(cycle[5]);
      } catch {
        // leave skips empty if the histogram JSON is malformed
      }
      cycles.push({
        kicked: Number(cycle[1]),
        poolsConsidered: Number(cycle[2]),
        candidates: Number(cycle[3]),
        poolsSkipped: Number(cycle[4]),
        skips,
      });
      continue;
    }

    const wk = line.match(WOULD_KICK_RE);
    if (wk) {
      const key = `${wk[1]}\t${wk[2]}`;
      wouldKick.set(key, (wouldKick.get(key) ?? 0) + 1);
    }
  }

  if (cycles.length === 0) {
    console.log(
      'No discovered-kick cycle reports found in the log.\n' +
        'Expected lines like: "Discovered kick cycle: kicked N across P pools ' +
        '(C candidates, S pools skipped); skips: {...}".\n' +
        'Check that discovery.kick is enabled and the keeper ran at least one Kick cycle.'
    );
    return;
  }

  const totals = { kicked: 0, poolsConsidered: 0, candidates: 0, poolsSkipped: 0 };
  const skips = new Map<KickSkipReason, number>();
  for (const c of cycles) {
    totals.kicked += c.kicked;
    totals.poolsConsidered += c.poolsConsidered;
    totals.candidates += c.candidates;
    totals.poolsSkipped += c.poolsSkipped;
    for (const [reason, count] of Object.entries(c.skips) as [
      KickSkipReason,
      number,
    ][]) {
      skips.set(reason, (skips.get(reason) ?? 0) + (count ?? 0));
    }
  }

  const span = firstTs && lastTs ? `${firstTs} → ${lastTs}` : 'time span unknown';
  console.log(`\nAuto-kick dry-run summary  (${cycles.length} cycles, ${span})`);
  console.log('═'.repeat(72));
  console.log(`Candidates evaluated : ${totals.candidates}`);
  console.log(`Would-kick (passed)  : ${totals.kicked}`);
  console.log(`Pools considered     : ${totals.poolsConsidered}`);
  console.log(`Pools skipped (hydr) : ${totals.poolsSkipped}`);

  const skipRows = [...skips.entries()].sort((a, b) => b[1] - a[1]);
  if (skipRows.length > 0) {
    const rWidth = Math.max(...skipRows.map(([r]) => r.length));
    const nWidth = Math.max(...skipRows.map(([, n]) => String(n).length));
    console.log('\nWhy candidates were not kicked (tune the dominant reasons):');
    for (const [reason, count] of skipRows) {
      console.log(
        `  ${reason.padEnd(rWidth)}  ${String(count).padStart(nWidth)}  ${TUNING_GUIDE[reason]}`
      );
    }
  }

  if (wouldKick.size > 0) {
    const wkRows = [...wouldKick.entries()].sort((a, b) => b[1] - a[1]);
    const pWidth = Math.max(...wkRows.map(([k]) => k.split('\t')[0].length));
    console.log('\nWould-kick candidates (DryRun lines — also includes manual kicks):');
    for (const [key, count] of wkRows) {
      const [pool, borrower] = key.split('\t');
      console.log(
        `  ${pool.padEnd(pWidth)}  ${borrower}${count > 1 ? `  (x${count})` : ''}`
      );
    }
    console.log(
      '\nThe discovered "Would-kick (passed)" total above is authoritative for auto-kick;\n' +
        'the DryRun lines also include any manual-pool dry-run kicks.'
    );
  }
  console.log('');
}

main();
