# Test-Coverage Hardening Plan (handoff)

Goal: raise **merged** coverage — especially **branch** coverage — by testing the
fail-closed guards, error/`catch` paths, and money-path branches that integration
(happy-path-only) never reaches. This is a multi-file grind; the lever is proven.

## Current state (branch `mh/auto-kick-followups`)

Coverage is now a **local/manual diagnostic**, not a CI gate. PR CI runs the
ordinary unit suite (`npm run unit-tests`) without `c8`; use coverage reports
only when working this hardening plan.

For the real merged number, run `npm run coverage:merged` locally/manually
(unit + integration, ~5 min). This may require the same env/secrets as the
integration suite; on a stock checkout, prefer `npm run coverage` for the fast
unit-only signal. `npm run coverage` is diagnostic-only; use
`npm run coverage:check` only when you intentionally want the local `.c8rc.json`
thresholds enforced.

Regenerate `coverage/lcov.info` with `npm run coverage` before trusting the
unit-only table; ordinary CI/unit-test runs do not refresh it.

| Metric | Unit-only (`coverage/lcov.info` after last local coverage run) | **Merged** (last manual measurement) |
|---|---|---|
| Statements | 88.1% | **88.5%** |
| Branches | 87.4% | **82.5%** |
| Functions | 89.0% | **92.0%** |

Branch is the laggard: ~5,800 unit branches / ~6,200 merged branches, with
roughly 1,000+ uncovered. Each guard-heavy file holds only ~20–40 branches
(~0.3–0.6 pt each), so reaching merged branch ~88%
means closing ~300 branches across ~12–18 files. **Functions jumped on the merge but
branches didn't** — proof the residual gap is the *untaken* (guard/error) side of
conditionals, which is exactly what unit guard-tests close.

### Baseline already reflected in this working tree

These are implementation facts this plan assumes. Verify commit status
separately; this section is a handoff baseline, not a commit log.

- **Merged coverage scripts** (`coverage:unit|integration|report|merged`) — integration is now instrumented; +3.9 pts stmt / +4.1 pts func with zero new tests.
- **`dex/universal-router.ts`: 15% → 97% lines, 0% → 90% branch.** Both its old unit + integration tests stubbed the function under test; now `tests/unit/universal-router-swap.test.ts` drives the real body.
- **`config/validation-rules.ts`: 80% → 94% branch** via `tests/unit/validation-rules.test.ts` (49 cases on the config guards).

## How to measure (fast loop)

- **Fast iteration on guard-heavy files:** `npm run coverage` (unit only, ~30s, no threshold gate). Guards aren't integration-covered, so unit ≈ merged *for these files*. Only re-run `coverage:merged` for the final number.
- **Target ledger report:** `npm run coverage:targets` reads `coverage-hardening-targets.json` and, after `npm run coverage`, overlays live branch status from `coverage/lcov.info`.
- **Per-file branch %:** parse `coverage/lcov.info` (`BRF:` total, `BRH:` hit per `SF:`), or `npx c8 report --temp-directory=coverage/tmp --reporter=text --check-coverage=false | grep <file>`.
- **Uncovered branch lines:** in lcov, `BRDA:<line>,<block>,<branch>,<taken>` with `taken` = `0` or `-` is uncovered.

## Target ledger (single source of truth)

Target ownership, safety invariants, test-file homes, and stale coverage
snapshots live in `coverage-hardening-targets.json`. Update that manifest first
when adding/removing targets, then run `npm run coverage:targets` after
`npm run coverage` to print current branch status. Keep this document focused on
workflow, ordering, and implementation guidance; do not hand-maintain coverage
percentages in prose.

## Testing patterns & gotchas (READ FIRST — saves hours)

1. **Do not rely on bare imported-binding stubs for money-path tests.** `new Contract(...)` is not reliably stubbable via `sinon.stub(ethers,'Contract')` under the test loader — the test's `ethers` import and the source's can resolve to different module objects (CJS/ESM identity split). Directly imported helper functions have the same problem when the source captures the binding at module load. **Fix:** route construction/collaborators through an exported deps object and stub its methods, e.g.
   ```ts
   export const fooDeps = { makeContract: (a,abi,sp) => new ethers.Contract(a,abi,sp) };
   // ...use fooDeps.makeContract(...) internally
   // test: sinon.stub(fooDeps, 'makeContract').callsFake(addr => mockByAddr[addr])
   ```
   See `src/dex/universal-router.ts` + `tests/unit/universal-router-swap.test.ts` for the working template. Exported **object-method** stubs work; only replacing a bare imported binding is unreliable. For large orchestration files, extract a smaller collaborator first and put the seam there instead of adding one monolithic deps object.
2. **Config builders:** reuse `tests/unit/auto-discover-validation-helpers.ts` → `baseAutoDiscoverConfig()` (a valid `KeeperConfig` to mutate). For slice validators, build partial `{ dex: {...} } as KeeperConfig` (a `const cfg = (p: unknown) => p as KeeperConfig` helper is in validation-rules.test.ts).
3. **Default-param gotcha:** `fn(x, undefined)` triggers the param's *default value*, not `undefined`. To truly omit an arg, call the function directly with the positional `undefined` (don't go through a helper that defaults it).
4. **Async rejection:** `import chaiAsPromised; chai.use(chaiAsPromised)` → `await expect(fn()).to.be.rejectedWith(/msg/)`.
5. Tests run under `.mocharc` (ts-node); a positional file does NOT override its `spec` glob, so `npx mocha <file>` runs the whole unit suite (~25s). That's fine for the honest check. `--no-config` uses Node's native TS stripper (breaks `import = require`) — avoid it.
6. Lint runs only on `src/**` + `scripts/**`, not `tests/**`; typecheck (`tsc --noEmit`) covers everything — run it before committing (CI gates on it).

## Prioritized work

The canonical target list is `coverage-hardening-targets.json`; the tables below
only group execution order and summarize safety intent.

### Tier A — guard-dense, pure/near-pure, no source change (do first)
| File | Safety invariant / failure mode | Test file |
|---|---|---|
| `src/config/auto-discover-validation.ts` | **Completed.** Invalid auto-discovery config fails before keeper startup; partial kick/take config cannot silently enable unsafe discovery. Focused guard tests now cover disabled/no-action discovery, missing defaults, warning-only operator footguns, direct-DEX path/source controls, chain-specific 1inch executor allowlists, gas override keys and bounds, quote-normalized profit floor context, and settlement defaults/gas caps. | `tests/unit/auto-discover-validation.test.ts` |
| `src/dex/sushi-aggregator/validate-route.ts` | **Completed.** Malformed Sushi routes fail closed before quote approval or execution calldata is trusted. Table-driven route-shape mutations now cover the validator branches. | `tests/unit/sushi-aggregator-validation.test.ts` |
| `src/take/external-take/quote-approval-rules.ts` + `src/take/aggregator-calldata/quote-approval.ts` | **Hardened.** Aggregator quotes cannot execute when provider identity, source, native value, route floor, or pool metadata is inconsistent. Execution approval now covers wrong provider-id/source, non-zero native value, missing floor, missing fee tier, missing Curve pool, and missing min-out floor. Remaining uncovered branch is the private direct-DEX unsupported-source fallback, rejected earlier by exported route binding. | `tests/unit/external-take-quote-approval.test.ts` |
| `src/discovery/external-take/profitability-policy.ts` | **Hardened.** Discovery approval rejects external takes that do not clear route-derived profit floors or lack raw profitability context. The focused policy suite now covers simple profitability telemetry, raw aggregator/direct-DEX floor approvals and rejects, hybrid fallback missing gas cost, stale floor handling, legacy quote-normalized floor rejects, subsidy approvals, and stats counting. Remaining uncovered branches are defensive fallbacks unreachable through the public wrapper. | `tests/unit/external-take-profitability-policy.test.ts` |
| `src/dex/lifi/route-canary-env.ts` | **Completed.** LiFi canary env parsing rejects malformed live-check input instead of running with bad route or allowlist assumptions. Direct parser tests now cover env, route JSON, and selector allowlist branches. | `tests/unit/lifi-route-canary.test.ts` |

Expected: ~+1.5–2 pts merged branch. Mostly pure functions; mirror `validation-rules.test.ts`.

### Tier B — money-path guards (highest safety value; some need a deps/stub seam)
| File | Safety invariant / implementation guidance | Test file |
|---|---|---|
| `src/dex/router.ts` | **Hardened.** `DexRouter.swap` now covers invalid/no-op/dust preflights, unsupported DEX dispatch, missing 1inch router/config/env, 1inch malformed amounts/native value/target/retryability/patching flags, Universal Router slippage percent-to-bps conversion and failure without legacy fallback, legacy Uniswap fallback/failure, and Curve missing config/pool lookup/router failure. No broad `dexRouterDeps` bag was added; focused branch tests were enough to harden the money-path behavior. Remaining uncovered branches are low-value optional/default fallbacks or defensive parse catches not reachable through realistic API payloads. | `tests/unit/dex-router.test.ts` |
| `src/discovery/gas-policy.ts` | **Hardened.** Discovery rejects takes when gas cost cannot be priced or exceeds native/quote policy. The suite now covers provider/gas/native/quote cap rejects, no-quote approvals, zero-gas native-profit apportionment, wrapped-native direct pricing, 1inch failure/circuit telemetry, Uniswap fallback/direct-DEX quote selection, and cached Curve provider success/failure. Remaining uncovered branches are defensive/private helper fallbacks or logging/cache-key branches not reachable through public source selection. | `tests/unit/discovery-gas-policy.test.ts` |
| `src/take/write-transport.ts` | **Hardened.** Take writes choose the intended public/private/relay transport and fail closed on unsupported or unhealthy submission paths. The suite now covers explicit transport overrides, missing private/relay config, relay signer chain/provider guards, public/private accepted-submission receipt failures, private durable nonce floor persistence failure, relay populated-nonce guard, relay object-form hashes/custom headers, accepted hash in relay error responses, explicit relay errors without nonce preservation, and null receipt wrapping after acceptance. Existing submission tests cover direct DEX write transport use and pre/post-broadcast classification. | `tests/unit/take-write-transport.test.ts` and `tests/unit/take-write-submission.test.ts` |
| `src/rewards/action-tracker.ts` | **Hardened.** Reward action tracking refuses unsafe post-auction swaps when DEX config or target resolution is incomplete. The suite now covers missing `dexProvider`, `validatePostAuctionDex` failure, unresolved swap targets, WETH target fallback resolution, router-level QuoterV2 fallback, default exchange options, transfer conversion/dust/error retry handling, retry-ceiling cleanup, malformed queued reward keys, unsupported actions, and missing-entry removal accounting without live swap execution. | `tests/unit/reward-action-tracker.test.ts` |
| `src/rewards/collect-lp.ts` | **Hardened for collateral legs.** LP reward collection now covers `redeemFirst: COLLATERAL`, quote-to-collateral and collateral-to-quote residual redemption, reward-equivalent withdrawal bounds so principal LP is not swept, collateral reward-action enqueue before post-read, post-withdrawal read failure without redundant fallback, stale collateral rejection cleanup, and dry-run no-submit behavior. Remaining uncovered branches are mostly ingester/default/logging, below-threshold dust pruning, `AuctionNotCleared` rethrow, and negative-LP accounting guards. | `tests/unit/collect-lp-collector.test.ts` and `tests/unit/collect-lp-manager.test.ts` |
| `src/take/aggregator-calldata/execution.ts` | **Hardened.** Pre-signing guards now reject stale, context-mismatched, or below-floor quotes before signing. The suite covers approval rejection telemetry, approved-floor encoding, quote age, auction-context drift, route min-out/fresh-quote floors, dry-run preflight, missing router/taker guards, zero-rounded collateral rejection, quote-provider failure retry metadata, stale quote rejection, ready execution wiring, and still-current assertion failure notification. Remaining uncovered branches are optional/default expression fallbacks and low-value telemetry shape branches. | `tests/unit/aggregator-calldata-execution.test.ts` |
| `src/dex/providers/curve-quote-provider.ts` | **Hardened.** Curve quote provider now treats unavailable initialization, pool-selection cache hit/miss/expiry, symbol lookup/address fallback, token-index discovery, ETH/WETH normalization, zero-output quotes, missing pools, quote-provider errors, and market-price failures as explicit non-executable signals. A narrow deps seam covers contract construction/decimals without changing production behavior. Remaining missed branch is low-value optional-expression noise. | `tests/unit/curve-quote-provider.test.ts` |

Expected: ~+2–3 pts merged branch AND closes the highest-severity safety gaps (irreversible money / fail-closed). `kick/index.ts` price-unavailable + approve/kick tx-failure catches belong here too (extend `kick.test.ts`).

### Tier C — error-path & orchestration (more setup)
- `src/discovery/targets.ts` + `src/discovery/runtime.ts`: **Hardened.** Runtime tests now cover discovered take handler failure containment and summary accounting, hot auction cache chain-id lookup failure, pool hydration unavailability, and cached malformed take/settlement snapshots rethrowing with `phase=targets` failure logs. Existing target tests cover invalid discovered take/settlement targets and shared scan cache isolation. Remaining misses are lower-value optional/default branches, telemetry formatting, and hot-cache removal/debug paths.
- `src/take/engine.ts`: **Hardened.** `tests/unit/external-take-reapproval.test.ts` now covers external take followed by post-take arbTake revalidation, nonce-consumed arbTake receipt failure classification as `submittedTransaction`/`poolStateMayHaveChanged` with `executedArbTake=false`, execution callback classification, and dry-run propagation. Remaining branches are broader engine orchestration paths such as skip logging, candidate-loop stop options, and optional/default callback branches.
- `src/run.ts` entrypoints (`startKeeperFromConfig`, `--run-once`, `collectLpRewardsLoop`): **Hardened.** Startup tests now cover no-work take-loop disablement, successful/transient/permanent take write transport initialization, run-once live acknowledgement, and daemon-loop launch planning. The LP reward redeemer resolver is extracted and tested for normalized cache hits, default LP settings, per-pool LP overrides, missing settings, and hydration failure. Remaining misses are mostly hard-imported infinite loop bodies and low-value optional/logging branches.
- `src/utils.ts`, `src/provider.ts`, `src/nonce.ts`: **Hardened.** Provider fee-data tests now cover priority-fee RPC usage, EIP-1559 fee calculation, RPC fallback to default priority fee, and legacy no-base-fee responses. Durable nonce tests cover provider-caught-up floor clearing and block-height lookup failure preservation. Remaining misses are low-value utility/default-expression branches and broader optional nonce paths.

## Non-test levers (cheap branch/quality wins)
- **Confirm exported legacy helpers before deleting:** `dex/one-inch.ts encodeOneInchSwapDetailsBytes` has no caller in `src/`, `scripts/`, or `tests/`, but it is exported. Treat deletion as an API-removal decision; if keeping it for compatibility, add a round-trip encode/decode test instead of deleting it just for coverage.
- **Don't chase branch noise:** c8 counts every `??`, `||`, `?.`, and default parameter as a branch. ~5–10% of the gap is fallbacks that never realistically fire — forcing them is low-value. Target ~88–90% branch, not 100%.

## Local coverage tracking (not CI)
- **Do not gate CI on coverage.** CI intentionally runs `npm run unit-tests`, not `npm run coverage`, so coverage churn and live-integration prerequisites do not block unrelated PRs.
- **If adding local critical-file floors, make them metric-specific.** A branch-only floor is misleading for files with no branch points or poor line/function coverage (`transactions.ts` currently has `0/0` branches but low lines/functions; `dex/universal-router.ts` has strong branch coverage but weak function coverage). Prefer a local checker over `coverage/lcov.info` with explicit per-file metrics: branch floors where branch data exists, plus line/function floors for orchestration files.
- **Do not use blanket `c8 --per-file`.** `c8 --per-file` applies one threshold set to every included `src/**/*.ts` file, so enabling it directly fails unrelated low-coverage files. If useful, keep any named-file lcov checker as an opt-in local command for this hardening effort.
- **Keep fork/live execution as manual credentialed validation.** `preflight-fork-reconciliation` and `hybrid-fork-loop` remain true-execution backstops for env-gated guard logic, but not per-PR coverage gates.

## Reference
- Use `coverage-hardening-targets.json` as the handoff source of truth; regenerate `coverage/lcov.info` before starting a new batch.
- Working templates: `tests/unit/universal-router-swap.test.ts` (deps-seam + real-function), `tests/unit/validation-rules.test.ts` (pure-guard branch coverage).
