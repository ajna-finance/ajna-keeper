# Multi-pool enumeration daemon scenario (design + draft status)

Closes the largest remaining no-spend fidelity gap: today the daemon legs hand the
keeper a **single** auction via a stub that returns one row, so the real
chainwide enumeration → filter → rank → act path (`src/discovery/runtime.ts` →
`getChainwideLiquidationAuctionsShared` → `buildDiscoveredTakeTargets`) is never
exercised across pools. This scenario runs the **real persistent daemon** against
**N auctions across M pools** and asserts it discovers and acts on all the
discovered pools, while a pool placed under `manual.pools` is handled by the
manual loop and **skipped** by discovery (manual-take precedence).

## What is implemented in this PR

| Piece | File | Status |
|---|---|---|
| Pure subgraph stub: serve a LIST with real `id_gt` (chainwide) + `borrower_gt` (per-pool) cursor pagination | `scripts/no-spend/fixture-subgraph-stub.mjs` | ✅ unit-tested |
| Unit test for the stub (enumeration, cursoring, per-pool isolation) | `tests/unit/fixture-subgraph-stub.test.ts` | ✅ passing |
| `startFixtureSubgraphStub` refactor to serve `summaries[]` | `scripts/no-spend/daemon-smoke.mjs` | ✅ (single-pool legs unchanged: 1-element list) |
| `buildDaemonConfig` accepts `allowPools` + `manualPools` | `scripts/no-spend/daemon-smoke.mjs` | ✅ backward-compatible |
| `runDaemonMultipool` leg + assertions | `scripts/no-spend/daemon-smoke.mjs` | 🟡 draft — needs a funded-fork run |
| Aggregator-in-daemon entrypoint (installs the env-gated injector) | `scripts/no-spend/daemon-harness-entry.ts` | 🟡 draft — tsc-clean, needs fork |

## How the real enumeration is driven (the keystone)

`src/subgraph.ts` enumerates chain-wide via
`GetChainwideLiquidationAuctions($first,$afterId)` paged by `id_gt` (asc), and
reads a single pool via `GetLiquidations($poolId,…,$afterBorrower)` paged by
`borrower_gt` (asc). The stub now reproduces **both** cursors faithfully for a
list of auctions, so the keeper's real pagination walks every pool. This logic is
pure and unit-tested (`tests/unit/fixture-subgraph-stub.test.ts`): chainwide
returns every pool's row and terminates on cursor exhaustion; per-pool returns
only that pool's borrowers. That is the mechanism that converts "handed one
candidate" → "enumerates many across pools."

## Manual-take precedence

The chainwide query is a real query of **all** unsettled auctions, so the stub
serves the manual pool's auction too. The keeper's discovery then **skips** any
pool present in `manual.pools` (`buildDiscoveredTakeTargets`, the `manualTakePools`
filter), and the manual loop owns it. The take-cycle summary log
(`src/discovery/runtime.ts` `logDiscoveryCycleSummary`) reports `manualTargets`
and `discoveredTargets` separately, so precedence is provable:

- `auctionCount >= N+1` — enumeration saw every pool including the manual one
- `manualTargets >= 1` — the manual pool was a manual target
- `discoveredTargets <= N` in **every** cycle — the manual pool never leaked into
  discovery (the precedence invariant)

The manual `PoolConfig` uses a `{ source: 'pool', reference: 'lup' }` price origin
(derives the market price from the pool's own LUP on the fork — no external API,
no spend).

## Aggregator coverage in the daemon (answer: yes, via a harness entrypoint)

**Constraint:** the production entry `src/index.ts` never installs the
calldata-aggregator quote injector and never sets
`AJNA_AGENT_HARNESS_AGGREGATOR_QUOTE_MOCK`, so a daemon spawned from it can only
exercise the `direct_dex` (real Uniswap) path. The injector is double-gated and
inert in production by design.

**Seam:** `scripts/no-spend/daemon-harness-entry.ts` is a harness-only entry that
sets the env flag, funds the shared `MockLifiSwapTarget`, installs the injector
(built from the fixture summary's deployed aggregator takers), then calls
`startKeeperFromConfig`. Spawn **this** (instead of `src/index.ts`) for an
aggregator variant of the leg. Production code is untouched and stays inert.

So a richer leg can mix execution paths across pools: some pools `direct_dex`,
others `calldata_aggregator` (LI.FI / Sushi / 1inch) — proving the daemon
enumerates and acts via **different** real execution paths in one run.

## Remaining integration work (needs a funded Base fork)

1. **Fixture multiplication with a SHARED deployment.** The keeper config has a
   single `takers`/`dex` block, so every pool must register against **one**
   `KeeperTakerRouter` + taker set. Drive `create-liquidatable-ajna-fixture-cli.ts`
   M times: run 1 deploys the router + takers + `MockLifiSwapTarget`; runs 2..M
   **reuse** those addresses (the fixture supports reuse via env) and create a
   fresh pool + kicked auction each. Collect the M `FixtureSummary` JSONs.
2. **Orchestrator wiring** in `scripts/run-no-spend-validation.mjs` (mechanical,
   mirrors `--daemon-lifecycle-only`):
   - flags `--run-daemon-multipool` / `--daemon-multipool-only` + envs
     `AJNA_AGENT_NO_SPEND_DAEMON_MULTIPOOL[_ONLY]`
   - read the M summary paths (e.g. `AJNA_AGENT_NO_SPEND_FIXTURE_SUMMARIES`),
     split into `discoveredSummaries` (all but one) + `manualSummary` (one)
   - call `runDaemonMultipool({ discoveredSummaries, manualSummary, rpcUrl,
     tempDir, allowedHosts, egressReportPath })`
   - add the `*-only` early-exit guard requiring the artifact (so it can't pass
     without running), and include the artifact in the validation report
3. **Confirm the manual `PoolConfig.take` field set** against the schema on the
   fork (the draft mirrors the discovery `direct_dex` settings).
4. **Size the aggregator payout** so the mock's quote-token payout exceeds the
   on-chain amount-due (`AJNA_AGENT_HARNESS_AGGREGATOR_PAYOUT_RAW`).

## Scope note

This scenario proves multi-pool **enumerate → filter → rank → act** within one
subgraph page. Real pagination/`_meta`/`fallbackUrls` failover stay at the
subgraph unit layer (`DISCOVERY_PAGE_SIZE = 100` is a constant; forcing multi-page
would need >100 fork auctions or a test-only page-size knob).
