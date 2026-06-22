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
| `runDaemonMultipool` leg + assertions | `scripts/no-spend/daemon-smoke.mjs` | ✅ **fork-validated** (see below) |
| Shared-deployment fixture multiplication driver (`buildMultipoolFixtures`) | `scripts/run-no-spend-validation.mjs` | ✅ **fork-validated** (reuse confirmed) |
| Orchestrator leg: `--run-daemon-multipool` / `--daemon-multipool-only` | `scripts/run-no-spend-validation.mjs` | ✅ **fork-validated** |
| Aggregator-in-daemon entrypoint (installs the env-gated injector) | `scripts/no-spend/daemon-harness-entry.ts` | ✅ **fork-validated** (LI.FI take in the daemon) |
| Aggregator daemon leg `--run-daemon-aggregator` / `--daemon-aggregator-only` | `scripts/no-spend/daemon-smoke.mjs` + orchestrator | ✅ **fork-validated** |
| **Combined** aggregator × multipool leg `--daemon-aggregator-multipool-only` | `scripts/no-spend/daemon-smoke.mjs` + orchestrator | ✅ **fork-validated** (daemon takes N pools via LI.FI) |

**Flags / env:** `--run-daemon-multipool` (env `AJNA_AGENT_NO_SPEND_DAEMON_MULTIPOOL=1`)
or `--daemon-multipool-only` (env `…_MULTIPOOL_ONLY=1`, implies the run + early-exits
after it). Discovered-pool count via `AJNA_AGENT_NO_SPEND_MULTIPOOL_COUNT` (default
2); a manual-precedence pool is always added on top.

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

## Implemented wiring (`buildMultipoolFixtures` in the orchestrator)

The fixture multiplication + orchestrator leg are now wired (draft).
`buildMultipoolFixtures` drives `create-liquidatable-ajna-fixture.ts` N+1 times on
the shared fork: run 0 deploys the `KeeperTakerRouter` + UniswapV3 taker +
aggregator takers + `MockLifiSwapTarget`; runs 1..N **reuse** them by passing
`AJNA_AGENT_KEEPER_TAKER_FACTORY_ADDRESS` + `AJNA_AGENT_UNISWAP_V3_TAKER_ADDRESS`
(from run 0's summary) and `AJNA_AGENT_DEPLOY_EXTERNAL_TAKE=no`, while a unique
`AJNA_AGENT_QUOTE/COLLATERAL_TOKEN_SYMBOL` per run forces a fresh distinct pool.
The last fixture is the manual-precedence pool.

## Fork validation result ✅

Ran `AJNA_AGENT_NO_SPEND_MULTIPOOL_COUNT=1 node scripts/run-no-spend-validation.mjs
--scenario take-settlement-run-once --daemon-multipool-only` against a pinned Base
fork (block 30000000). Both multipool fixtures built — **fixture 2/2 reused run 0's
deployment with no error**, confirming the reuse env contract — and the
`runDaemonMultipool` artifact passed every invariant:

```
cyclesObserved: 3, loopedMultipleCycles: true,
enumeratedAllPools: true, discoveredAllPools: true,
manualPoolHandledByManualLoop: true, manualPrecedenceHeld: true,
allDiscoveredTaken: true, takeTxCount: 2,
idempotentNoDuplicateTake: true, shutdownCleanOnSigterm: true, exit.code: 0
```

So the real persistent keeper enumerated both pools via the real chainwide query,
took both (1 discovered + 1 manual = 2 real fork takes), kept the manual pool out
of discovery (precedence), looped idempotently, and exited cleanly on SIGTERM —
all `direct_dex`. The shared-deployment reuse, the multipool stub, the multipool
`buildDaemonConfig`, and the manual `PoolConfig` are all validated. (Bump
`AJNA_AGENT_NO_SPEND_MULTIPOOL_COUNT` to scale the discovered-pool count.)

**Aggregator-reuse risk retired by code:** the fixture's reuse path
(`resolveExisting`) is read-only — it *validates* the existing router + UniswapV3
taker and returns the addresses; it never calls `setTaker`. Run 0's `setTaker`
registrations (including the aggregator takers) are permanent on the shared router,
so they persist for runs 1..N; the driver's graft of run 0's deployment mirrors
that on-chain reality.

## Aggregator-in-daemon fork validation result ✅

Ran `node scripts/run-no-spend-validation.mjs --scenario take-settlement-run-once
--daemon-aggregator-only` against the Base fork. The `--run-daemon-aggregator` leg
funds the `MockLifiSwapTarget` from the quote-rich fixture keeper, spawns
`daemon-harness-entry.ts` (which installs the env-gated injector) instead of
`src/index.ts`, with a `calldata_aggregator` LI.FI config. The artifact passed:

```
cyclesObserved: 4, discoveredViaSubgraph: true,
tookViaAggregator: true, takeTxCount: 1 (LI.FI path against the mock target),
payoutRaw ~= keeperQuoteBalance/20, idempotentNoDuplicateTake: true,
shutdownCleanOnSigterm: true, exit.code: 0
```

Key things this proved:
- The harness daemon entry installs the injector + starts the keeper; production
  `src/index.ts` is untouched and stays inert.
- The `dex.lifi` **production** config whose allowlist points at the deployed
  `MockLifiSwapTarget` (+ mockSwap selector `0x79c6257b`) passes both config
  validation (`validateAutoDiscoverConfig` / `validateTakeSettingsForChain`) and
  the on-chain route-deployment preflight (`reconcileTakerAllowlistSnapshot`
  exact-matches the config allowlist to the taker's on-chain allowlist).
- `discovery.take.dexGasOverrides: { 5: '900000' }` (LiquiditySource.LIFI) is
  required for the `calldata_aggregator` path.
- The injected payout (`keeperQuoteBalance/20`) exceeds the on-chain amount-due,
  so the take settles.

## Combined aggregator × multipool fork validation result ✅

`AJNA_AGENT_NO_SPEND_MULTIPOOL_COUNT=1 node scripts/run-no-spend-validation.mjs
--scenario take-settlement-run-once --daemon-aggregator-multipool-only` joins the
two flagship scenarios: the orchestrator builds the shared-deployment multipool
fixtures, then runs the aggregator daemon across ALL of them. Artifact:

```
poolCount: 2, cyclesObserved: 2, discoveredAllPools: true,
tookAllViaAggregator: true, takeTxCount: 2 (both pools via LI.FI),
idempotentNoDuplicateTake: true, shutdownCleanOnSigterm: true, exit.code: 0
```

The enabler: `buildInjector` now derives each take's src/dst tokens from the
`pool` object (`pool.collateralAddress`/`pool.quoteAddress`) instead of a single
summary, so ONE shared `MockLifiSwapTarget` — funded with each pool's distinct
quote token by `runDaemonAggregator` — serves every pool. The daemon config is
`calldata_aggregator`-only, so every one of the N successful takes is provably an
aggregator take. Scale with `AJNA_AGENT_NO_SPEND_MULTIPOOL_COUNT` (the run used
count=1 → 2 pools).

> Note: `--daemon-multipool-only` still builds the orchestrator's single fixture
> first (that build is unconditional in `main()`); the multipool leg then builds
> its own N+1 fixtures. A future optimization could reuse the single fixture as
> run 0 to save one deploy.

## Scope note

This scenario proves multi-pool **enumerate → filter → rank → act** within one
subgraph page. Real pagination/`_meta`/`fallbackUrls` failover stay at the
subgraph unit layer (`DISCOVERY_PAGE_SIZE = 100` is a constant; forcing multi-page
would need >100 fork auctions or a test-only page-size knob).
