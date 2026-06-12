# No-Spend Validation Hardening Plan

## Purpose

The current `npm run no-spend-validation` command is a useful Base-fork smoke:
it starts a local Base fork, creates and kicks a mock-token Ajna pool, runs the
discovered-take harness in dry-run mode, reverts that dry run, and then executes
the discovered factory/Uniswap take path on the local fork.

This plan strengthens that coverage without spending live Base funds and without
changing the live `create-liquidatable-uniswap-fixture` operator flow.

The goal is higher confidence that the LI.FI/factory/1inch refactor did not
break discovery, target construction, route selection, policy wiring, config
validation, read/write transport selection, settlement and reward follow-up
loops, cache/concurrency invariants, or local execution behavior.

## Current Coverage

`npm run no-spend-validation` currently validates:

- local Base fork startup from the configured Base RPC
- mock ERC20 token deployment
- Ajna ERC20 pool creation
- Uniswap V3 collateral/quote and WETH/quote liquidity seeding
- external-take factory and Uniswap V3 taker deployment
- final kick into an active auction
- discovered-take dry-run through the keeper discovery handler
- local discovered factory/Uniswap execution
- collateral reduction after execution

This is valuable, but it is still one happy-path replay. It does not yet cover a
matrix of policy choices, full fixture-backed target discovery, manual-mode
execution, temporary config loading, read/write transport choices, subgraph/RPC
fallback, settlement/bond/LP-reward follow-up, cache/concurrency settings, or
full-daemon startup and observability.

## Safety Contract

All new hardening should preserve these constraints:

- Never mutate `.env`.
- Never use a live operator private key.
- Never point write-capable fixture or harness steps at a non-local RPC.
- Keep live fixture commands separate and unchanged.
- Pass child processes a minimal env allowlist. Harness children may receive
  only generated/local test keys, and full-daemon smokes should use a temporary
  encrypted keystore plus password file instead of `AJNA_AGENT_KEEPER_KEY`.
- Store generated keys, summaries, harness reports, and config files under a
  temporary directory.
- Refuse localhost as the upstream fork source RPC.
- Stop the local Hardhat node on both success and failure.
- Keep default output concise, with detailed child logs written to temp files.
- Treat any secret-looking value in generated configs, reports, or logs as a
  failure; reports should record only redacted env/source metadata.
- Record the requested fork block, resolved fork block number, resolved fork
  block hash, commit SHA, scenario env, local RPC URL, and redacted upstream RPC
  source in the final report.
- Support replay from the exact resolved fork block number recorded in a prior
  report; a run that requested `latest` must still record the concrete block it
  actually used.
- Resolve one concrete Base fork block before a scenario matrix starts, and run
  every scenario against that same block number/hash.
- For local-only smokes, block or fail on unexpected outbound network calls.
  Allowed egress should be limited to localhost and the single upstream Base
  fork RPC, except for commands explicitly classified as
  `external-service-dependent`.
- Before relying on local-only no-egress claims, run an egress-guard self-test
  that intentionally attempts blocked LI.FI, 1inch, relay, and live-subgraph
  requests and fails unless each is rejected with a classified
  `unexpected_egress` result and redacted target metadata.

## Phase 1: Stronger Assertions

Tighten the existing `no-spend-validation` assertions before adding more
scenarios.

Add fixture/report checks for:

- fixture summary has `network=base`
- fixture summary `rpcUrl` is localhost
- resolved fork block is recorded
- resolved fork block hash is recorded
- a requested `latest` fork is reported as the concrete block number/hash that
  was actually used
- pool creation status is `created`
- token deployment status is `deployed`
- Uniswap seeding status is `seeded`
- external-take factory and Uniswap V3 taker are deployed or intentionally
  reused from fixture-local addresses
- final kick status is `kicked` or `already_active`
- route-shape verification status is `passed`
- dry-run `mode` is `discovery`
- dry-run records at least one factory path dry run
- dry-run records no real external execution
- execution `mode` is `discovery`
- execution records exactly one successful external take
- execution records the selected path as `factory`
- execution records the selected factory source as `UNISWAPV3`
- execution records the selected fee tier when the factory route is Uniswap V3
- execution records no pre-broadcast or post-submission failures
- keeper quote balance increases after execution
- auction collateral decreases after execution
- auction debt decreases or the auction is no longer active after execution
- local Hardhat process is stopped at the end

Add transaction and route-artifact checks for:

- structured `routeArtifact` and `txArtifact` report fields rather than
  assertions derived from log parsing
- selected route identity
- selected liquidity source
- selected fee tier
- factory registry address
- selected taker address
- selected transport mode
- transaction hash
- receipt status
- gas used
- Ajna take event or equivalent pool-state delta
- token approvals are reset where the taker is expected to reset them
- keeper quote-token balance delta is positive
- borrower auction collateral/debt deltas match the execution report
- child-process env metadata records only redacted source/classes, never raw
  private keys, API keys, passwords, or RPC URLs with credentials
- harness child env contains only the expected local test key material

Acceptance criteria:

- `npm run no-spend-validation` exits non-zero if any expected fixture,
  discovery, route, transaction, or execution invariant is missing.
- Failure output names the specific missing invariant and points to the temp
  report/log files.
- The report is sufficient to rerun the same validation from the same fork block
  number without resolving `latest` again.
- Route, receipt, balance, approval, transport, and env assertions are backed by
  machine-readable report fields, not by brittle log parsing.

## Phase 2: Scenario Matrix

Expand the wrapper from one scenario into a small matrix. The matrix runner
should resolve one concrete Base fork block number/hash before scenario
execution starts. Each scenario should start from a clean fork snapshot or a
fresh local fork pinned to that same resolved block, run independently, and write
its own summary/report files.

### Strict Hybrid Happy Path

Purpose: preserve the current behavior.

Settings:

- `AJNA_AGENT_UNISWAP_LIQUIDITY_MODE=strict_hybrid`
- `AJNA_AGENT_UNISWAP_FEE_TIER_TEST_MODE=all_configured`
- `--hybrid-gas-quote-fallback factory_first`

Expected result:

- dry-run reaches factory path
- execution reaches factory path
- selected source is `UNISWAPV3`
- collateral is reduced

### Fallback Regression

Purpose: prove the gas quote fallback is not accidentally always-on or
always-off.

Settings:

- `AJNA_AGENT_UNISWAP_LIQUIDITY_MODE=fallback_regression`

Run two harness passes:

- fallback disabled
- fallback set to `factory_first`

Expected result:

- disabled fallback discovers the auction but skips because native gas cannot be
  converted into quote terms
- `factory_first` fallback allows the factory route to execute when policy
  permits it

### Fee-Tier Coverage

Purpose: cover the route selection plumbing across configured Uniswap V3 fee
tiers.

Run:

- `AJNA_AGENT_UNISWAP_FEE_TIER_TEST_MODE=default_only`
- `AJNA_AGENT_UNISWAP_FEE_TIER_TEST_MODE=single_non_default`

Expected result:

- default-only selects the default configured tier
- single-non-default selects the expected non-default tier
- the execution report records the expected tier

If the current report format does not expose the selected fee tier directly,
add it to the harness report before relying on this scenario.

### Policy Rejection Smoke

Purpose: prove the policy layer can reject the same otherwise-valid auction.

Run a dry-run-only pass with one intentionally restrictive setting, such as:

- very low `maxGasCostNative`
- very high `minExpectedProfitQuote`
- too narrow `allowedLiquiditySources`

Expected result:

- auction is discovered
- no execution is attempted
- skip reason identifies the policy that rejected the route

This prevents the smoke from proving only that the route can execute, while
missing fail-closed policy regressions.

### Dry-Run State Integrity

Purpose: prove dry-run evaluation cannot mutate fork state.

Run:

- snapshot local fork before dry-run
- run discovered-take dry-run with auto-warp enabled
- collect balances, allowance, liquidation status, block number, and timestamp
- revert to the snapshot
- collect the same state again

Expected result:

- no token balances, allowances, auction state, or pool debt changed after the
  snapshot is reverted
- the execution pass starts from the original kicked auction state

### Cache and Concurrency Regression

Purpose: prove the refactor did not change candidate ordering, route-probe
budgeting, or cached gas/quote behavior.

Run with a fixture that has either two borrowers in one pool or two fixture
pools. If the current fixture cannot create both deterministically, start with a
mocked discovery-target scenario and promote it to the local fork once the
fixture supports it.

Settings to vary:

- `maxConcurrentCandidateEvaluations=1`
- `maxConcurrentCandidateEvaluations=2`
- `maxInFlightRouteProbes=1`
- `maxInFlightRouteProbes=2`
- `maxExecutionsPerPoolPerRun=1`
- `maxExecutionsPerPoolPerRun=2`
- short gas-price freshness TTL
- short hot-auction candidate TTL

Expected result:

- candidate ordering is deterministic across runs
- quote and execution budgets cap the expected number of candidates
- `maxExecutionsPerPoolPerRun=1` leaves later same-pool candidates for a later
  cycle
- gas price is reused while fresh and refetched after the TTL
- gas quote conversion cache records expected hit/miss counts
- hot-auction candidates are retained across a temporary subgraph miss and later
  expire or are removed after the auction is inactive
- an abandoned or timed-out route probe consumes the abandoned-probe budget,
  blocks additional probes once the configured abandoned limit is exceeded, and
  allows new probes again after the abandoned promise settles

Acceptance criteria:

- The matrix runner produces one JSON summary containing every scenario result.
- Each scenario records pass/fail, temp report paths, selected route metadata,
  selected fee tier, transaction metadata, cache counters, concurrency settings,
  and any rejection reason.
- Each scenario records the same resolved fork block number/hash; a scenario
  that re-resolves `latest` independently fails the matrix.
- A scenario failure fails the wrapper unless explicitly marked optional.

## Phase 3: Config-Loaded Target Discovery Smoke

The harness currently passes config-like objects directly to keeper internals.
Add a smoke that verifies fixture-derived settings can pass through normal config
loading and target construction before execution.

Implementation outline:

1. Build a temporary keeper config file from the fixture summary.
2. Load it through the existing config loader.
3. Run config validation.
4. Run route deployment preflight for the configured factory/taker addresses.
5. Provide fixture-backed subgraph data through a local reader or GraphQL stub.
6. Run subgraph chain-consistency preflight against a matching local `_meta`
   response.
7. Build discovered take targets from that subgraph data.
8. Assert the expected fixture pool/borrower appears in discovered targets.
9. Run one invalid-pool discovery pass where the local subgraph stub returns a
   pool that does not match the configured Ajna deployment.
10. Assert the invalid pool is skipped, hydration cooldown is recorded, and no
   take is attempted for that candidate.
11. Convert the loaded config into the discovery execution config used by the
   harness.
12. Run one dry-run discovered-take pass using the target built from config and
   subgraph data.

Config choices to assert:

- `allowedExternalTakePaths`
- `allowedLiquiditySources`
- `externalTakeRouteSelectionMode`
- `hybridGasQuoteFailureFallbackMode`
- `keeperTakerFactory`
- `takers.contracts.UniswapV3`
- Uniswap router overrides
- route gas policy fields
- `network.readRpcUrls`
- `network.subgraph.fallbackUrls`
- `discovery.take.dryRunNewPools`
- `discovery.allowPools`
- `discovery.denyPools`
- hot-auction candidate cache settings
- runtime dry-run mode

Target-discovery choices to assert:

- fixture-backed subgraph data produces the expected discovered take target
- deny-listed fixture pools are skipped
- allow-listed fixture pools are included
- `dryRunNewPools` marks unknown fixture pools as dry-run
- hot-auction cache keeps the target available across a temporary subgraph miss
- inactive auctions are removed from the hot-auction cache
- malformed subgraph candidate numeric fields are skipped with a specific reason
- primary subgraph failure falls back to a configured local fallback endpoint
- wrong-chain or missing `_meta` data rejects before pool hydration
- the shared discovery scan cache is reused within its short cache window
- a wrong-deployment discovered pool fails hydration without executing a take
- hydration cooldown prevents repeated hydration attempts for the same invalid
  pool during the cooldown window
- an invalid discovered pool does not starve a later valid fixture pool or
  candidate

Acceptance criteria:

- A malformed temporary config fails before discovery execution.
- A valid fixture-derived config loads, validates, passes preflight, constructs
  the expected target from fixture-backed subgraph data, and reaches the
  discovered factory/Uniswap dry-run path.
- The smoke fails if it bypasses target construction and calls
  `handleDiscoveredTakeTarget` with a hand-built target.
- The smoke fails if a wrong-deployment discovered pool reaches route approval,
  execution, or repeated hydration without cooldown.

## Phase 4: Transport and Startup Consistency Smoke

Cover read transport, write transport, and startup preflight choices without
using live funds.

Run local discovery/execution with:

- primary subgraph endpoint failing and fallback local endpoint succeeding
- primary and fallback subgraph endpoints both failing
- subgraph `_meta` matching the local fork block timestamp
- subgraph `_meta` mismatching the local fork block timestamp
- read RPC primary gas-price lookup failing and fallback local RPC succeeding
- read RPC fallback reporting the wrong chain ID during gas-price reads
- public RPC mode against the local fork
- private RPC mode pointed at the same local fork
- `externalTakeTransportPolicy=allow_public_fallback`
- `externalTakeTransportPolicy=prefer_private_or_relay`
- validation-only relay config with a local fake endpoint or stub
- fake private-RPC accepted-submission case where receipt waiting times out
- fake relay accepted-submission case where the relay returns or hides an
  accepted tx hash and receipt waiting times out

Expected result:

- subgraph fallback succeeds only when a configured fallback endpoint is healthy
- missing or wrong-chain `_meta` fails before discovered pool hydration
- read RPC fallback is used for gas price reads when the primary read endpoint
  fails
- wrong-chain read RPC fallback is rejected before route approval or execution;
  if an explicit read-RPC startup preflight is later added, it should reject at
  startup instead
- public RPC execution succeeds locally
- private RPC execution succeeds locally when pointed at the local fork
- prefer-private policy logs or reports the selected private transport
- require-private/relay policy rejects public-only config before execution
- relay validation catches malformed relay config without needing a real relay
- accepted private/relay submissions that lose receipt visibility mark the nonce
  as consumed and do not allow the next local submission to reuse that nonce

Acceptance criteria:

- The report records the read RPC endpoint class, subgraph endpoint class, and
  write transport mode used by each execution.
- The smoke fails if an execution silently falls back to public RPC when policy
  requires private or relay submission.
- The smoke fails if startup continues after a wrong-chain subgraph consistency
  check.
- The smoke fails if a wrong-chain read RPC endpoint can approve or execute a
  route. If a read-RPC startup preflight is added, the smoke should also fail if
  startup continues after that preflight rejects.
- The smoke fails if an accepted private/relay submission can cause nonce reuse
  after a receipt timeout or ambiguous relay response.
- No real relay, private transaction service, or live subgraph is required.
- No external HTTP is allowed except localhost and the upstream fork RPC.

## Phase 5: Manual-Mode Smoke

The PR also changes manual external-take context resolution and manual LI.FI
support, so local validation should cover manual-mode factory execution too.

Implementation outline:

1. Generate a fixture-derived manual pool config.
2. Load it through the normal config loader.
3. Validate the manual pool config.
4. Use fixture-backed subgraph reads for liquidation status.
5. Run manual `handleTakes` against the local fork.
6. Assert the selected deployment and taker source match the fixture config.

Config choices to assert:

- manual pool address
- manual take settings
- manual `liquiditySource`
- manual `allowedExternalTakePaths` when present
- `keeperTakerFactory`
- `takers.contracts.UniswapV3`
- `takers.contracts.LIFI`
- LI.FI canary/production policy settings
- Uniswap router overrides
- runtime dry-run and non-dry-run modes

Expected result:

- dry-run manual take reaches the expected factory/Uniswap route
- dry-run manual LI.FI policy/context resolution reaches the LI.FI path without
  broadcasting and without claiming that mock tokens have a live LI.FI route
- local manual execution reduces collateral
- selected deployment comes from the manual config rather than autodiscovery
  defaults

Acceptance criteria:

- Manual-mode smoke fails if manual config loading, deployment resolution, or
  local execution is broken.
- Manual LI.FI smoke fails if config/policy/context resolution is broken, but it
  may be no-broadcast only unless a deterministic local LI.FI route fixture is
  added.
- The smoke remains local-fork-only and never uses the live fixture operator
  key.
- The smoke fails on unexpected outbound LI.FI, 1inch, relay, or live-subgraph
  HTTP calls.

## Phase 6: Settlement, Bond, and LP Reward Smoke

The keeper runtime is more than the take loop. Add a local smoke for the
follow-up paths that normally run after a successful liquidation take.

Implementation outline:

1. Reuse the local fork fixture after a successful local take.
2. Warp or mine the fork until the auction is old enough for settlement, if
   needed.
3. Provide fixture-backed unsettled-auction data through the local subgraph
   reader or GraphQL stub.
4. Run one discovered settlement dry-run cycle.
5. Run one local settlement execution pass when the fixture is deterministically
   settleable.
6. Run bond collection for the fixture keeper key.
7. Feed a local BucketTake LP-award response into the LP reward ingester.
8. Run LP reward dispatch/sweep in dry-run mode, then in local execution mode if
   the fixture has redeemable LP.

Expected result:

- settlement target construction finds the fixture pool/borrower from subgraph
  data
- settlement dry-run submits no transactions
- local settlement execution records settlement status, iterations, and any
  remaining reason
- bond collection records locked/claimable deltas or a specific no-op reason
- LP reward ingest advances its cursor and dedupes the same stubbed event on
  replay
- LP reward sweep records the bucket, token side, and dry-run/local-execution
  result
- reward-action handling is exercised in dry-run mode without moving live funds

Acceptance criteria:

- The settlement/reward smoke is allowed to start as dry-run-only if the current
  fixture cannot deterministically produce a settleable auction or redeemable LP.
- Once the fixture supports those states, local execution assertions should be
  promoted to required.
- The report distinguishes settlement not-needed, settlement attempted,
  settlement incomplete, bond not-claimable, and reward not-redeemable states.
- The smoke must not require a live subgraph, live operator key, LI.FI API key,
  or 1inch API key.
- The smoke fails on unexpected outbound LI.FI, 1inch, relay, or live-subgraph
  HTTP calls.

## Phase 7: High-Confidence Smoke Wrapper

Add an optional command that runs the strongest no-spend validation stack in one
place.

Candidate command:

```bash
npm run high-confidence-validation
```

Candidate steps:

```bash
git diff --check
node --check scripts/run-no-spend-validation.mjs
npx tsc --noEmit --skipLibCheck
npm run unit-tests
npm run no-spend-validation
npm run no-spend-validation:egress-guard-self-test
npm run preflight-fork-reconciliation
npm run hybrid-lifi-fork-proof
npm run hybrid-fork-loop
```

Classify each step as:

- `required`: must run and pass when the wrapper is invoked
- `optional`: may skip when its optional env is missing
- `external-service-dependent`: may fail because a live API is unavailable, but
  the failure must be explicit and reported

Expected behavior:

- deterministic local gates are required and run before slower fork smokes
- Base RPC is required.
- the wrapper resolves one concrete Base fork block number/hash and passes it to
  every local fork scenario
- LI.FI API key is optional.
- 1inch API key is optional, but the report must say whether 1inch actually
  participated.
- Hybrid fork config and whale env are required only for the hybrid fork steps.
- Missing optional env should produce an explicit skip reason, not a silent pass.
- Required LI.FI route-shape validation with a provided production config should
  fail on route/policy mismatch, not skip.

Acceptance criteria:

- The wrapper writes a machine-readable summary of which smokes ran, passed,
  failed, or skipped.
- The wrapper writes the requested fork block, resolved fork block number,
  resolved fork block hash, and replay command/env for every fork-backed smoke.
- Skips distinguish missing env from real validation failures.
- Failures include the exact command and log path.
- The wrapper reports which external providers actually participated.
- The wrapper labels itself runtime-only if compile/unit gates are intentionally
  skipped by a caller-provided flag.
- Local-only steps run with the no-egress guard enabled; external network calls
  are allowed only for steps classified as `external-service-dependent`.
- The no-egress self-test must intentionally attempt blocked outbound requests
  through the same HTTP/subgraph paths used by the keeper and fail if the guard
  does not classify and redact each blocked destination.

## Phase 8: Full-Daemon Smoke

This is the most system-realistic option, but it is more complex and should come
after the matrix, config-loaded target discovery, transport, manual-mode, and
settlement/reward smokes.

The hard part is discovery. A local fork fixture will not be indexed by the live
Base subgraph, so a full daemon cannot naturally discover the mock auction from
the real subgraph.

Two maintainable options:

### Local GraphQL Stub

Start a tiny local GraphQL server that returns the fixture borrower, pool, loan,
and liquidation records expected by the keeper.

Then start the keeper through its normal CLI with:

- temporary fixture-derived config
- local fork RPC
- local stub subgraph URL
- local or disabled read-RPC fallback URLs
- temporary encrypted keystore containing a local Hardhat test key
- temporary `KEYSTORE_PASSWORD_FILE` pointing at a generated password file
- no `AJNA_AGENT_KEEPER_KEY` in the daemon child env
- dry-run mode for the first pass

This covers:

- CLI startup
- config loading
- production-style encrypted keystore and password-source resolution
- runtime initialization
- read transport construction
- discovery loop wiring
- subgraph reads through the same GraphQL client shape as production
- discovered-target construction
- discovered-take handler entry
- settlement loop wiring when settlement is enabled
- bond and LP reward loop startup when those settings are enabled

### Run-Once Discovery Mode

Add a run-once discovery mode to the keeper runtime if the current CLI cannot
cleanly start, process one cycle, and exit.

This would be less brittle than killing a long-running process after log
inspection, and it would make full-system smokes practical in CI.

Acceptance criteria:

- The full-daemon smoke starts through the normal CLI.
- It loads a temporary fixture-derived config.
- It uses a temporary encrypted keystore and password file, not
  `AJNA_AGENT_KEEPER_KEY`.
- It fails before loop startup when the keystore password file is missing or
  contains the wrong password.
- It reads fixture data through a local subgraph-compatible endpoint.
- It constructs the expected discovered take target.
- It reaches the discovered-take path.
- In dry-run mode, it submits no transactions.
- In local execution mode, it reduces collateral on the local fork.
- It emits expected startup, preflight, and cycle-summary logs.
- It emits no unhandled promise rejection, uncaught exception, or secret-looking
  log output.
- It makes no unexpected outbound network calls in local-only mode.
- It handles `SIGTERM` or run-once completion without leaving child processes.
- It exits cleanly without orphaning child processes.

## Recommended Implementation Order

1. Add stronger assertions to `npm run no-spend-validation`.
2. Add resolved fork-block pinning and no-egress enforcement to the wrapper.
3. Add the strict-hybrid, fallback-regression, fee-tier, policy-rejection, and
   dry-run state-integrity scenario matrix.
4. Add the fixture-derived config loading, target-discovery, and hydration
   cooldown smoke.
5. Add transport/startup smokes for subgraph fallback, read RPC fallback, public
   RPC, private RPC, relay validation, and accepted-submission nonce handling.
6. Add the manual-mode smoke.
7. Add the settlement, bond, and LP reward smoke.
8. Add the high-confidence smoke wrapper for deterministic gates and existing
   fork/canary commands.
9. Add the full-daemon smoke only after the lower-level matrix is stable.

This order gives the most confidence per unit of complexity. It first hardens
the already-working local replay, then expands policy, target discovery, config,
transport, manual-mode, settlement, and reward coverage, and only then moves
into full process startup and subgraph simulation.

## Open Questions

- Should the scenario matrix be one command with all scenarios by default, or
  should expensive scenarios be opt-in?
- Should the high-confidence wrapper fail on missing optional LI.FI/1inch env,
  or record those as skips?
- Is a run-once daemon mode acceptable as a production code addition, or should
  full-daemon smoke stay in test-only harness code?
- Should the local GraphQL stub live in the no-spend wrapper, a reusable test
  helper, or a separate script?
- Should settlement/reward local execution be required immediately, or should it
  begin as dry-run-only until the fixture can deterministically create
  settleable/redeemable states?
- Should cache/concurrency assertions live in the no-spend wrapper report or a
  reusable lower-level integration helper?
- Should deterministic recorded LI.FI route-shape fixtures be added for local
  no-network policy validation?
- Should the no-egress guard be implemented through request monkey-patching in
  the harness, a local proxy, or process-level network restrictions?
- Should read-RPC wrong-chain validation remain a cycle-time gas-read assertion,
  or should a dedicated startup preflight be added?
- Should the accepted-submission nonce smoke reuse the existing durable nonce
  tests or run through a local fake relay/private-RPC server in the no-spend
  wrapper?
