import 'dotenv/config';
import { KeeperConfig } from '../src/config';
import baseConfig from './example-base-rollout-config';

/**
 * Pure-observation dry-run harness for chain-wide kick discovery (auto-kick).
 *
 * This is example-base-rollout-config with runtime.dryRun forced ON, so the
 * keeper discovers kickable loans across all pools, hydrates real pool + market
 * data, and runs the full kick gate (reward + liveness + bond budget) for every
 * candidate WITHOUT sending any transaction — manual or discovered. Each
 * candidate that clears the gate logs `DryRun - Would kick loan ...`; every Kick
 * cycle logs a typed skip histogram (`Discovered kick cycle: ... skips: {...}`).
 *
 * Workflow:
 *   1. Fill in signer.keystore and the env keys the base config reads
 *      (ALCHEMY_API_KEY, GRAPH_API_KEY, COINGECKO_API_KEY) — the SAME values you
 *      would run in production. Nothing executes, so no bond is ever posted.
 *   2. Run the keeper against this config and let it cycle for a while
 *      (Ctrl-C once you have enough cycles):
 *        yarn start --config examples/example-dry-run-kick-config.ts | tee keeper-dryrun.log
 *   3. Summarize the result to size the knobs:
 *        npm run summarize-kick-report -- keeper-dryrun.log
 *
 * Read the skip histogram to tune: `neutral-below-market` dominating means the
 * reward margin (discovery.defaults.kick.priceFactor) is too wide or the market
 * sits above NP; `liveness-no-arb-room` means no arb profit at the current take
 * config; `bond-budget-exceeded` means discovery.kick.maxBondExposure /
 * maxTotalBondExposure are too low. Adjust those on the imported base config,
 * re-observe, then graduate to live by setting runtime.dryRun=false AND
 * discovery.dryRunNewPools=false.
 */
const config: KeeperConfig = {
  ...baseConfig,
  runtime: {
    ...baseConfig.runtime,
    dryRun: true, // nothing executes: manual AND discovered kicks are simulated
    logLevel: 'debug', // also surface the manual path's per-loan skip detail
  },
};

export default config;
