# Integration-Aggregator Follow-Up Cleanup Plan

## Purpose

This plan captures the deferred code-quality work surfaced by the pre-merge
thermo-nuclear review of `integration-aggregator`, plus the one remaining
functional follow-up from the calldata-aggregator roadmap (1inch allowlist
preflight parity). None of it blocked the merge; all of it is tracked here so it
lands as one or more focused follow-up PRs rather than as drive-by edits.

**Base branch:** `aggregator-followup-cleanup` = `origin/master` (the
squash-merged migration PR #20) + two commits: the group-A test DRY cleanup and
this plan. Because #20 was squash-merged, the pre-merge commit SHAs no longer
resolve on `master`; this plan refers to changes by migration scope (#20), not by
SHA.

> **Revision note.** A second deep review reframed this plan. The original draft
> listed ~13 findings as independent cleanups; most are symptoms of **one** root
> cause (below), so they are now organized as a small number of decisive,
> descriptor-driven moves. The original IDs (B-C1…B-S4) are preserved and mapped
> onto the moves so nothing is lost. Three genuinely-new findings (N1–N3) and a
> test prerequisite were added.

## The unifying insight: one descriptor, N non-consumers

The canonical descriptor registry already owns, per provider, everything most of
these findings re-derive:

```
EXTERNAL_TAKE_SOURCE_IDENTITIES / getAggregatorProviderIdentity(providerId)
  -> { source, label, takerContractKey, providerId, category, path }
resolveExternalTakeDeployment(source) -> taker
```

Yet **at least five surfaces re-hardcode or re-switch on what the descriptor
already owns** instead of consuming it: the deploy CLI (hand-unrolled per
provider), the preflight validators (`validateLifi…`/`validateSushi…` twins), the
discovery quote wrappers (hardcoded `label`/`selectedLiquiditySource`), the
provider `execution.ts` literals (`providerId`+`source`+`label` passed
separately), and the `hybrid`/`stats` source-switches. The guardrails already
forbid "a second or third route/provider identity registry"; these are exactly
that, at the behavior layer. **The work is: make every surface consume the
descriptor, and the per-provider duplication — and most of Group B — disappears.**

The clearest proof: `scripts/deploy-factory-system-cli.ts:134` *throws* for
`dex.oneInch` because there is no loop to extend — the only way to add a provider
today is to hand-edit ~6 sites. The original plan's Wave-3 (1inch) then added a
fifth hand-wired copy on top. Consuming the descriptor turns "add a provider"
into "add a descriptor row + a provider-local normalizer."

## Sequencing

Delivered as **one PR** (per the single-PR decision), with the three waves below
as its internal, ordered commit phases — the ordering is what keeps the bundle
reviewable and the `slither` / deployment-test gates intact (see "Single-PR
execution order").

1. **Wave 1 — deletions & canonical-reuse.** Pure removals / reuse-an-existing
   helper. Mechanical, low-risk.
2. **Wave 2 — make every surface consume the descriptor.** The code-judo core:
   behavior-preserving refactors that delete per-provider branching. Require the
   taker/aggregator + discovery suites (and `slither` for the contract items).
3. **Wave 3 — descriptor-driven deploy loop + 1inch parity.** Gated on first
   adding deployment-script tests (none exist today — see the ⚠️ below). 1inch
   parity rides on this wave as a descriptor row, not a fresh copy.

---

## Wave 1 — deletions & canonical-reuse

### M-B — Delete the LI.FI allowlist alias shims *(new; supersedes the spirit of B-D2/B-D3 at a larger scale)*
- **Location:** `src/dex/lifi/taker-allowlist.ts` (19-line shim), `address-allowlist.ts`,
  `selector-allowlist.ts`, plus their wildcard re-export in `src/dex/lifi/index.ts`.
  Consumers: `scripts/deployment/lifi-factory-deployment.ts`,
  `src/discovery/route-preflight-validation.ts:20-23,410-431`,
  `src/dex/lifi/chain-policy.ts`, `src/dex/sushi-aggregator/validate-route.ts`.
- **Problem:** All three files are pure cosmetic-rename re-export barrels over the
  provider-neutral `src/take/aggregator-calldata/allowlist.ts` (e.g.
  `LIFI_TAKER_ALLOWLIST_ABI = AGGREGATOR_TAKER_ALLOWLIST_ABI`,
  `readLifiTakerAllowlistSnapshot = readTakerAllowlistSnapshot`) — 7 fns + 6 types,
  zero own logic. They create a parallel **vocabulary** (`Lifi*` names) for neutral
  primitives; Sushi already imports the canonical names directly. They also force
  LI.FI deploy to load the full `takerArtifact.abi` where Sushi binds the 3-fn ABI.
- **Remedy (delete-indirection):** Delete the three barrels, drop them from
  `dex/lifi/index.ts`, repoint the ~6 consumers at the canonical names. Prerequisite
  for **M-A** — once gone, the LI.FI and Sushi deploy paths are the same code modulo
  the normalizer.
- **Effort:** S. **Risk:** low (mechanical rename). **Verify:** `tsc`, lifi unit +
  preflight tests.

### M-E — Delete the empty per-provider quote-path types *(new)*
- **Location:** `src/discovery/external-take/quotes.ts:44-87`,
  `src/discovery/external-take/calldata-aggregator-providers.ts:45-76`.
- **Problem:** `OneInchAggregatorPathQuoteInput` / `LifiPathQuoteInput` /
  `SushiAggregatorPathQuoteInput` are **empty** interfaces extending
  `CalldataAggregatorPathQuoteInput`; the three `*PathQuoteFn` aliases are
  byte-identical to `CalldataAggregatorPathQuoteFn`; `*CircuitOutcome` are bare
  aliases. They make three identical closures look type-distinct.
- **Remedy:** Delete the empty interfaces + redundant aliases; reference the
  canonical types directly. The three closures collapse toward one.
- **Effort:** S. **Risk:** none. **Verify:** `tsc`, discovery unit tests.

### N3 — Export one on-chain details-tuple ABI constant *(new)*
- **Location:** `src/take/aggregator-calldata/execution.ts:171` (inlined, un-exported)
  + 6 test files re-typing it verbatim (`oneinch-aggregator-taker`,
  `sushi-aggregator-taker`, `lifi-fork-execution-canary`, `hybrid-fork-loop` integ;
  `lifi-execution` unit; `lifi-taker-fixture` helper).
- **Problem:** The load-bearing tuple
  `tuple(address approvalSpender,address srcToken,address dstToken,address dstReceiver,uint256 amountInTokenUnits,uint256 amountOutMinimum,bytes callData)`
  has no single source of truth (7 copies). A struct change desyncs the tests
  silently — they would encode the wrong shape and still "pass" their own encode/decode.
- **Remedy (reuse-canonical):** Export `AGGREGATOR_SWAP_DETAILS_TUPLE_ABI` from
  `aggregator-calldata` (used by `encodeAggregatorSwapDetails`); have manual-encode
  tests call `encodeAggregatorSwapDetails` (as the sushi fork canary already does) or
  import the constant for decode-side assertions.
- **Effort:** S. **Risk:** none. **Verify:** the aggregator taker suites.

### N1 — `txValue` is a write-only dead field *(new; correctness-adjacent)*
- **Location:** declared `src/take/aggregator-calldata/types.ts:68`; written
  `src/take/lifi/quote-service.ts:122`, `src/take/oneinch-aggregator/quote-service.ts:173`;
  **never read anywhere**, and absent from the on-chain `AggregatorSwapDetails` tuple.
- **Problem:** It is documented as load-bearing ("native value… `'0'` for ERC20-input
  takes") but `encodeAggregatorSwapDetails` never references it and no *shared* approval
  check asserts it. **Important correction (pass 2):** the guard is only *partially*
  present — **Sushi already fail-closes** on a non-zero native value
  (`src/dex/sushi-aggregator/validate-route.ts:138-143`), while **LI.FI and 1inch do
  not** (LI.FI copies `transactionRequest.value` raw at `quote-service.ts:122`; 1inch
  `normalizeTxValue`s it). So the "silently dropped" risk is real for LI.FI/1inch only.
- **Remedy:** Prefer **asserting** over deleting — add one boundary assertion in
  `approveCalldataAggregatorQuoteForExecution` that rejects `txValue !== '0'`. That
  brings LI.FI/1inch up to Sushi's existing fail-closed behavior with a single shared
  guard (and lets the per-provider Sushi check be deduped into it). Deleting the field
  would instead drop Sushi's guard — don't.
- **Effort:** S. **Risk:** low. **Verify:** quote-approval unit tests (assert the
  non-zero-`txValue` reject for each provider).

### N2 — Provider-neutral allowlist module hard-defaults labels to LI.FI *(new)*
- **Location:** `src/take/aggregator-calldata/allowlist.ts:89,330,368,427`
  (`?? 'LI.FI selector allowlist'`, `?? 'LI.FI taker'`).
- **Problem:** A module documented as provider-neutral and now consumed by Sushi/1inch
  preflight falls back to LI.FI-branded diagnostic labels. Any caller that omits the
  override silently emits LI.FI error text for another provider — a latent
  mislabeling trap (and it gets worse as 1inch is added in Wave 3).
- **Remedy:** Make `label`/`labelPrefix` required (no default) so the compiler forces
  each call site to supply its own, or default to a neutral `'aggregator taker'`.
- **Effort:** S. **Risk:** low. **Verify:** allowlist/preflight unit tests.

### B-T1 — `direct-dex/route-selection.ts` is a 73-line pure re-export barrel
- **Location:** `src/take/direct-dex/route-selection.ts:1-73` (zero own definitions).
- **Problem:** The honest-modules refactor (#20) split the former 573-line file into
  siblings (`route-amounts`, `route-candidates`, `route-ranking`, `route-profitability`,
  `providers`, `availability`, `logs`, `runtime-cache`, `route-types`, `route-rejection`)
  but left this barrel as a façade hiding which module owns each symbol.
- **Remedy:** Repoint the 6 importers at the owning siblings; delete the barrel.
- **Effort:** S. **Risk:** low. **Verify:** `tsc`, unit suite,
  `npm run check-external-take-boundaries -- --base <ref>`.

### B-T3 — `routeMetadata` built eagerly but only used in the catch
- **Location:** `src/take/direct-dex/index.ts:661-682`.
- **Problem:** `routeMetadata` (a 4-part concat) is built unconditionally before the
  `try`, but read only by the catch's `logger.error`.
- **Remedy:** Move the construction into the catch block.
- **Effort:** S. **Risk:** none. **Verify:** unit suite.

### B-D2 — Duplicate Uniswap V3 required-address-fields constant
- **Location:** `src/config/liquidity-source.ts:56-72`.
- **Problem:** `UNISWAP_V3_FACTORY_ROUTE_REQUIRED_ADDRESS_FIELDS` and
  `UNISWAP_V3_DIRECT_DEX_ROUTE_CONTRACT_ADDRESS_FIELDS` are byte-identical.
- **Remedy:** Drop the second; have `route-preflight-validation.ts:475` import the first.
- **Effort:** S. **Risk:** none. **Verify:** `tsc`, route-preflight tests.

### B-D3 — Private `getErrorMessage` in `lifi-policy.ts` duplicates `src/utils.ts`
- **Location:** `src/config/lifi-policy.ts:39-41`.
- **Remedy (reuse-canonical):** Import from `../utils`, delete the local copy.
- **Effort:** S. **Risk:** none. **Verify:** `tsc`.

### N4 — Delete five dead mock contracts orphaned by #20 *(new; dead-code)*
- **Location (all five named — pass 3):** `contracts/mocks/MockOneInchUnderdeliveryRouter.sol`,
  `MockReentrantOneInchRouter.sol`, `UniswapV3SwapAdapter.sol`, `MockUniversalRouter.sol`, and
  `MockPermit2.sol`.
- **Problem:** Adversarial doubles for the 1inch / UniversalRouter+Permit2 paths #20 deleted. Four
  have zero references; **`MockPermit2` is only *transitively* dead** — its sole reference is the
  `import` inside `MockUniversalRouter.sol`, which is itself dead.
- **Remedy:** Delete `MockUniversalRouter.sol` **first** (that is what makes `MockPermit2` dead),
  then `MockPermit2.sol`, alongside the other three; regenerate typechain. ⚠️ A one-shot grep
  mis-classifies `MockPermit2` as live (it has a reference until `MockUniversalRouter` is gone) and
  Solidity compiles every `.sol` regardless of references, so neither a single grep nor `compile`
  catches the transitive orphan — **iterate-to-fixpoint** (re-grep after each deletion) or use a
  no-unused check. **Do NOT** delete `contracts/OneInchInterfaces.sol` (`IGenericRouter` etc.) —
  still used by the surviving 1inch decode path.
- **Effort:** S. **Risk:** low. **Verify:** `npm run compile`, full test suite, + a final grep
  confirming none of the five names remains.

### N5 — Delete four dead imports in `validation-rules.ts` *(new; dead-code)*
- **Location:** `src/config/validation-rules.ts:21,25,27,29` (`isDirectDexDynamicSource`,
  `formatSupportedExternalTakePaths`, `getExternalTakePathDescriptor`,
  `resolveExternalTakePathFromSource` — each grep-matches only at its own import line).
- **Problem:** Imported, never used. Uncaught because `noUnusedLocals` is off and there is no lint.
- **Remedy:** Delete the four imports. Independently, consider enabling
  `noUnusedLocals`/`noUnusedParameters` (or an eslint `no-unused-vars` rule) so this rot is caught
  mechanically — scope that as its own follow-up since it may surface other dead locals repo-wide.
- **Effort:** S. **Risk:** none. **Verify:** `tsc`.

### N8 — Delete the dead duplicate `getDiscoveryTokenDecimalsCache` *(new; dead-code)*
- **Location:** `src/discovery/take-executor.ts:158-166`.
- **Problem:** Module-private, never called/exported here; byte-identical to the live copy in
  `discovered-take-target-runtime.ts`.
- **Remedy:** Delete it (the live copy is unaffected).
- **Effort:** S. **Risk:** none. **Verify:** `tsc`, discovery tests.

### N9 — Delete the `route-preflight.ts` re-export barrel *(new; same kind as B-T1)*
- **Location:** `src/discovery/route-preflight.ts` (one line:
  `export * from './route-preflight-validation';`).
- **Problem:** Pure re-export barrel with exactly one consumer (`scripts/no-spend/config-smoke.ts:11`);
  the real production consumer imports from `route-preflight-validation` directly.
- **Remedy:** Repoint `config-smoke.ts` at `route-preflight-validation`, delete the barrel.
- **Effort:** S. **Risk:** none. **Verify:** `tsc`, no-spend config-smoke.

### N10 — Import `BASE_ONEINCH_ROUTER` instead of re-hardcoding the literal *(new; duplication)*
- **Location:** `scripts/oneinch-route-canary.ts:39` re-declares
  `0x1111111254EEB25477B68fb85Ed929f73A960582`; canonical export is
  `scripts/no-spend/fixture-constants.ts:14`.
- **Remedy:** Import `BASE_ONEINCH_ROUTER` (still allowing the `AJNA_AGENT_ONEINCH_ROUTER_BASE`
  override). (Leave the `.mjs` daemon-smoke copy — it can't import the `.ts` const.)
- **Effort:** S. **Risk:** none. **Verify:** `tsc`, route-canary.

### N11 — Deduplicate the aggregator-taker test fixtures *(new; duplication)*
- **Location:** `tests/integration/oneinch-aggregator-taker.test.ts:18-45` (`deployOneInchAggregatorFixture`)
  vs `tests/integration/sushi-aggregator-taker.test.ts:21-48` (`deploySushiFixture`) — character-for-
  character identical except the taker `__factory` class and the `LiquiditySource` enum.
- **Remedy:** Add `deployAggregatorTaker(base, { factory, source })` (and an
  `executeAggregatorTake` matching the group-A `executeOneInchTake`) to
  `tests/integration/helpers/mock-taker-base.ts`, alongside the existing `deployUniswapTaker`/
  `deployCurveTaker`; both suites (and the group-A `executeOneInchTake`) consume it. Folds the
  Sushi suite into the same helper the 1inch suite already half-uses.
- **Effort:** S. **Risk:** low. **Verify:** the oneinch + sushi taker suites.

### N6 — Drop the redundant per-source `category` descriptor field *(new; descriptor hygiene)*
- **Location:** `src/config/external-take-descriptors.ts:36` (type) + `70,77,84,92,100`
  (5 hardcoded copies).
- **Problem:** `category` is strictly determined by `path` (`direct_dex`→`'direct_dex'`,
  `calldata_aggregator`→`'aggregator'`), and `EXTERNAL_TAKE_PATH_METADATA` already owns that
  `path`→`category` mapping. The source-level copies are derivable computed metadata.
- **Remedy:** Drop `category` from `ExternalTakeSourceIdentityBase` and all 5 rows; derive via
  `getExternalTakePathDescriptor(identity.path).category` where needed.
- **Effort:** S. **Risk:** low. **Verify:** `tsc`, descriptor + config unit tests.

### N7 — Derive `EXTERNAL_TAKE_SOURCE_ORDER` from the identities map *(new; correctness)*
- **Location:** `src/config/external-take-descriptors.ts:127-133`.
- **Problem:** A hand-maintained `readonly ExternalTakeLiquiditySource[]` with **no** exhaustiveness
  guard (it seeds `SUPPORTED_EXTERNAL_TAKE_LIQUIDITY_SOURCES`, `DIRECT_DEX_DYNAMIC_SOURCES`, etc.);
  a new source added to the identities map but forgotten here is silently dropped from those derived
  sets.
- **Remedy:** Keep an **explicit ordered array** and add a compile-time exhaustiveness guard
  (a `satisfies`/mapped-type check that every `EXTERNAL_TAKE_SOURCE_IDENTITIES` key appears) —
  do **NOT** derive via raw `Object.keys`. ⚠️ **(pass 2)** the identities map is keyed by numeric
  enum values (`ONEINCH=1,UNISWAPV3=2,CURVE=4,LIFI=5,SUSHI_AGGREGATOR=6`), so key-iteration is
  ascending-numeric and would silently reorder the list (`ONEINCH` jumps last→first). That order
  feeds the operator-facing `liquiditySource must be …` validation message
  (`formatSupportedExternalTakeLiquiditySources`) and telemetry grouping — both cosmetic (routing
  is by key, not order), but no test pins the string so the change would be silent. The
  `satisfies`-guard variant gets the exhaustiveness win with zero reorder; if you instead accept
  the reorder, pin `formatSupportedExternalTakeLiquiditySources()` output in a test.
- **Effort:** S. **Risk:** low. **Verify:** `tsc`, config unit tests.

### N12 — Delete the dead `approveExternalTakeQuoteForExecution` dispatcher *(new; dead-code)*
- **Location:** `src/take/external-take/quote-approval-rules.ts:334-359` (+ its dedicated
  `ApprovedExternalTakeQuoteEvaluation` / `ExternalTakeQuoteApprovalResult<…>` union specialization).
- **Problem:** This is the path-dispatching approval wrapper (re-bind route → delegate to
  `approveCalldataAggregatorQuoteForExecution` or `approveDirectDexQuoteForExecution`). A repo-wide
  grep (src/tests/scripts/docs) finds **zero** callers — discovery calls the per-path approvers
  directly. Dead since the descriptor wiring made the dispatcher redundant.
- **Remedy:** Delete the function and the now-unused union return type (the per-path approvers stay).
- **Effort:** S. **Risk:** none. **Verify:** `tsc`, external-take approval unit tests.

### N13 — Delete the dead `warnings` field on `CalldataAggregatorRouteSummary` *(new; same pattern as N1)*
- **Location:** `src/take/aggregator-calldata/types.ts:41-42` (`warnings?: string[]`).
- **Problem:** Same write-only-dead-field pattern as N1: `warnings` appears **only** at its own
  declaration — never written by any provider, never read. (The enclosing
  `CalldataAggregatorRouteSummary` is itself largely write-only telemetry; `warnings` is the
  clean-delete subset.)
- **Remedy:** Delete the `warnings?` field.
- **Effort:** S. **Risk:** none. **Verify:** `tsc`.

### N14 — Reuse the canonical `pruneMapToMaxSize` in **six** inline copies *(new; duplication)*
- **Location (all six — pass 3):** `src/discovery/gas-policy.ts:542-548`, `src/erc20.ts:91-99`,
  `src/take/external-take/chain.ts:35-41` (`getCachedTokenDecimals`),
  `src/dex/providers/curve-quote-provider.ts:337-344`,
  `src/dex/providers/pool-existence-cache.ts:89-94` (`prune()`),
  `src/discovery/targets.ts:293-299` (`pruneToMax()`) — each a byte-identical insertion-order
  size-cap eviction loop reimplementing `src/utils.ts:22-30`.
- **Remedy (reuse-canonical):** Replace each body with `pruneMapToMaxSize(map, MAX_…)` (import from
  `./utils` / `../utils`), preserving each site's early-return-on-no-cache where present. (The
  `targets.ts` 6-line→1-line dedup is a *reduction*, not the decomposition the out-of-scope note
  defers — it is in scope.)
- **Effort:** S. **Risk:** none. **Verify:** `tsc`, the respective unit suites.

### N15 — Delete the remaining dead re-export barrels + prune the stale guard config *(new; same kind as B-T1/N9)*
- **Location:** sibling barrels `src/take/external-take/route.ts` (`export * from './route-binding'`)
  and `src/take/external-take/quote-approval.ts` (`export * from './quote-approval-rules'`); package
  barrels `src/dex/index.ts`, `src/discovery/external-take/index.ts`, `src/take/external-take/index.ts`,
  `src/take/lifi/index.ts`; and the no-spend shim `scripts/no-spend/harness-artifacts.ts`
  (`export * from './harness-report'`).
- **Problem:** Each has **zero** importers (real consumers import the owning sibling directly; e.g.
  `take/index.ts:36` pulls `createLifiTakeAdapter` from `./lifi/adapter`, not the `lifi/index`
  barrel). They are the same dead-barrel pattern as B-T1/N9, missed by the prior passes. Two of them
  also rot the **manual guard registries**: `check-hot-file-growth.ts` lists `external-take/route.ts`,
  `quote-approval.ts`, and `harness-artifacts.ts` in `HOT_FILES` + `COMPATIBILITY_ONLY_HOT_MODULES`,
  and `check-external-take-boundaries.ts:100` special-cases `quote-approval.ts` — so the guards police
  import paths nothing uses (corroborating the known "guards partly broken" state).
- **Remedy:** Delete the barrels (each only after confirming there is **no** `import … from '<dir>'`
  directory-import that would resolve to its `index.ts`). Then prune the now-stale guard entries:
  `check-hot-file-growth.ts` `HOT_FILES`/`COMPATIBILITY_ONLY_HOT_MODULES` lines for the three files
  and `check-external-take-boundaries.ts:100`; **keep** the `OWNERSHIP_FILE_LINE_CAPS` cap on the
  live `harness-report.ts` (it guards the real owner). Land the guard-config prune in the same commit
  so the gate stays auditable.
- **Also prune guard entries for files deleted by OTHER items (pass 8):** N9 deletes
  `src/discovery/route-preflight.ts` (live in `check-hot-file-growth.ts` `HOT_FILES:28` +
  `COMPATIBILITY_ONLY_HOT_MODULES:86-89`) and B-T1 deletes `src/take/direct-dex/route-selection.ts`
  (live in `OWNERSHIP_FILE_LINE_CAPS:45`). Drop those entries too, in the same commit as their
  respective deletions — otherwise the plan re-creates the exact stale-pointer rot N15 exists to
  remove. (Inert to the gate — a deleted file reports 0 lines — but it violates this plan's own
  "keep the gate auditable" principle.)
- **Effort:** S. **Risk:** low (the package `index.ts` deletions need the directory-import check;
  the sibling/shim barrels are zero-risk). **Verify:** `tsc`,
  `npm run check-external-take-boundaries -- --base <ref>`, `npm run check-hot-file-growth -- --base <ref>`.

### N16 — Validate the Sushi `apiBaseUrl` (parity with LI.FI) *(new; fail-closed completeness)*
- **Location:** `src/config/schema.ts:636` (`SushiAggregatorDexConfig.apiBaseUrl`),
  `src/config/sushi-aggregator-policy.ts:74-141` (`assertValidSushiAggregatorDexConfig` — no
  `apiBaseUrl` branch), consumed unvalidated at `src/dex/sushi-aggregator/client.ts:36-60`.
- **Problem:** Sushi's `apiBaseUrl` flows straight into the live quote URL (`${base}/${chainId}?…` →
  `axios.get`) but is **never validated**, while every other Sushi field is — and the sibling LI.FI
  provider routes the same field through `normalizeLifiApiBaseUrl` with `requireHttps` in production
  (`lifi-policy.ts:61-65`, `dex/lifi/api-policy.ts:12-57`: rejects non-http(s), embedded
  credentials, query, fragment). Sushi is production-only yet accepts a plaintext `http://` or
  credentialed base URL silently; a malformed value surfaces as a confusing runtime axios failure
  instead of a clear startup rejection. Defense-in-depth + provider parity (on-chain exact-fill
  allowlist reconciliation still gates execution, so not a fund path).
- **Remedy (reuse-canonical):** Validate `apiBaseUrl` in `assertValidSushiAggregatorDexConfig` with
  the same URL-shape policy — ideally **extract a provider-neutral `normalizeAggregatorApiBaseUrl`**
  shared by LI.FI and Sushi (and 1inch in W3) rather than two copies. Add a Sushi validation test
  asserting a non-HTTPS/malformed `apiBaseUrl` is rejected.
- **Effort:** S. **Risk:** low. **Verify:** `tsc`, `sushi-aggregator-validation` + `lifi-validation`
  unit tests.

### N17 — Delete three more dead exported helpers orphaned by #20 *(new; same class as N12)*
- **Location:** `src/take/external-take/route-binding.ts:375-397`
  (`getExternalTakeRouteBindingFailurePath`, `getExternalTakeRouteBindingFailureSource`) and
  `src/dex/lifi/exchange-policy.ts:100-104` (`isReviewedBroadLifiExchangePolicy`).
- **Problem:** All three are exported but have **zero** callers tree-wide (`grep` over
  src/tests/scripts returns only the declaration line). They survived because `noUnusedLocals` is off
  and exported symbols escape it anyway (the exact gap N5 notes). The two route-binding accessors are
  the dead subset of a union whose live consumer is the *sibling* `formatExternalTakeRouteBindingFailure`;
  `isReviewedBroadLifiExchangePolicy` narrows to a type itself never consumed externally.
- **Remedy:** Delete the three exports (and the now-unreferenced `ReviewedBroadLifiExchangePolicy`
  narrowing target if nothing else needs it); fold into the same Wave-1 deletion commit as N12.
  Reinforces N5's recommendation to enable `noUnusedLocals` / `no-unused-vars`.
- **Effort:** S. **Risk:** none. **Verify:** `tsc`, + a re-grep confirming none of the three names remains.

### N19 — Make `examples/example-config.ts` internally consistent *(new; docs-accuracy)*
- **Location:** `examples/example-config.ts:221` (`liquiditySource: LiquiditySource.ONEINCH` active),
  `:266` (`liquiditySource: LiquiditySource.CURVE` active); no top-level `takers` block anywhere in
  the example.
- **Problem:** Two pools **activate** external-take sources (ONEINCH, CURVE) while the example
  provides **no `takers: { router, contracts }` block** — yet the example's own comments
  (`:110-114`) correctly state ONEINCH/UNISWAPV3/CURVE "require `takers.router` + `takers.contracts.*`".
  External-take validation requires a registered taker per source, so the example config **as written
  would fail validation**; an operator copying it hits a confusing startup error. (Verified the rest
  is accurate: `dex.oneInch` is still a valid runtime key — `schema.ts:653` — and the migrated
  `takers.router` / `takers.contracts.OneInchAggregator` naming in the comments is correct; the
  inconsistency is only the missing `takers` block vs the active sources.)
- **Remedy:** Either comment out the active `liquiditySource`/`marketPriceFactor`/`allowSubsidy` lines
  in those two pools (matching the "uncomment after deployment" pattern the other pools use), **or**
  add an illustrative `takers: { router: '0x…', contracts: { OneInchAggregator: '0x…', Curve: '0x…' } }`
  block so the example validates. Prefer adding the `takers` block (operators need to see its shape).
- **Effort:** S. **Risk:** none. **Verify:** load the example through `readConfigFile`/validation in a test.

---

## Wave 2 — make every surface consume the descriptor

### M-C — Consume `getAggregatorProviderIdentity` instead of re-deriving `{source,label}` *(consolidates B-D1, B-D4; new sub-items)*
- **Locations & sub-items:**
  - `src/discovery/external-take/hybrid.ts:55-68` — `formatProviderWarnLabel` hardcodes
    `providerId -> label` **(was B-D1)**. **Behavior note:** the descriptor label is
    `'Sushi Aggregator'` (capital A; `external-take-descriptors.ts:93`) while the switch
    emits `'Sushi aggregator'` (lowercase; `hybrid.ts:64`). Pick one casing and update
    the `hybrid-external-take-*` assertion — this is the one place the emitted string
    can drift.
  - `src/discovery/external-take/stats.ts:30-31,222-229` — per-DEX scalar counters
    filled by a hardcoded `switch (routeIdentity?.source)` paralleling the generic maps
    **(was B-D4)**.
  - Provider `execution.ts` (`lifi:21,108-112`, `sushi-aggregator:19,85-87`,
    `oneinch-aggregator:17,76-78`) each pass `providerId` + `liquiditySource` + `label`
    as three literals to `takeLiquidationCalldataAggregatorProvider`, when the descriptor
    maps `providerId -> {source,label}`.
  - Discovery quote wrappers (`lifi-quote.ts:27-29`, `oneinch-aggregator-quote.ts:30-32`,
    `sushi-aggregator-quote.ts:24-26`) hardcode `label`/`selectedLiquiditySource`
    (a 4th parallel label source) and synthesize `abortErrorMessage`/`timeoutLabel`.
  - Per-provider rejection-reason strings (`missingRouterReason` etc.) are
    `${label} <fixed suffix>` templates duplicated across providers.
- **Remedy (code-judo):** Take only `providerId` through the shared core /
  prepare/evaluate params and derive `{source,label}` internally via
  `getAggregatorProviderIdentity`. Replace the per-site switches with the descriptor
  lookup; build the rejection reasons from `label` + shared suffix constants. Net-deletes
  the `liquiditySource`/`label` params, the two source-switches, and ~21 literal strings.
- **Effort:** M. **Risk:** low-medium (touches the shared evaluator + discovery). **Verify:**
  aggregator quote/circuit + discovery + `hybrid-external-take-*` unit tests.

### M-D — One neutral notification-callback pair on the base config *(supersedes B-T2)*
- **Location:** `src/take/{lifi,sushi-aggregator,oneinch-aggregator}/types.ts`
  (`on*QuoteResult`/`on*ExecutionFailure` fields); `src/take/aggregator-calldata/execution.ts`
  (`makeCalldataAggregatorProviderRejectionRecorder` + selector threading);
  `src/discovery/external-take/calldata-aggregator-providers.ts:124,151,181`.
- **Problem:** Each provider declares an identically-typed but differently-**named**
  callback pair (`onLifiQuoteResult` vs `onSushiAggregatorQuoteResult` vs
  `onOneInchAggregatorQuoteResult`). Verified: nothing keys off the names; they carry no
  provider-specific data. The cosmetic rename forces a whole selector-threading layer
  (`makeCalldataAggregatorProviderRejectionRecorder`) whose only job is to map the neutral
  hook onto each provider's name. B-T2 proposed passing a `selectors` object — that
  rearranges; this **deletes the layer**.
- **Remedy (code-judo):** Add `onCalldataAggregatorQuoteResult?` /
  `onCalldataAggregatorExecutionFailure?` to `CalldataAggregatorExecutionConfigBase`; have
  the shared core call them directly. Delete the three provider field-pairs, the
  selector-threading params, and `makeCalldataAggregatorProviderRejectionRecorder`.
- **Blast radius (pass 5):** four test artifacts reference the provider-named callbacks and must be
  migrated in the **same commit**: `tests/unit/lifi-execution.test.ts`,
  `tests/unit/helpers/lifi-execution-scenarios.ts`, `tests/unit/lifi-discovery-handlers.test.ts`,
  `tests/unit/discovery-handlers.test.ts`. ⚠️ Asymmetric and dangerous: `lifi-discovery-handlers`
  stubs with a **typed** param so a rename compile-breaks (safe), but `discovery-handlers.test.ts:2535`
  stubs `takeLiquidationOneInchAggregator` with `params: any` and fires
  `params.config.onOneInchAggregatorQuoteResult?.(…)` via **optional chaining** — after the rename
  that chain **silently short-circuits to a no-op**, the intended 1inch fault-injection never fires,
  the test still passes, and the discovery-fallback path it claims to cover goes unexercised. Fix:
  re-type that stub off `any` (so the rename compile-breaks) **or** migrate its `onOneInchAggregator*`
  call sites to the neutral name as part of the move.
- **Effort:** M. **Risk:** low-medium (the silent-no-op test regression above is the real trap).
  **Verify:** aggregator execution + circuit + the three provider taker suites **+ both discovery
  suites** (`discovery-handlers`, `lifi-discovery-handlers`).

### M-C′ — One generic `validateAggregatorAllowlistPreflight` *(folds the preflight twins; pre-solves Wave 3)*
- **Location:** `src/discovery/route-preflight-validation.ts:358-440`
  (`validateLifiAllowlistPreflight`, the LI.FI twin) and `src/dex/sushi-aggregator/preflight.ts:53-141`
  (the Sushi twin + its `validateSushiAggregatorTakerRouterSupport` companion).
  `route-preflight-validation.ts:495-532` is only the descriptor-table wiring that calls both.
- **Problem:** The two validators share **only** the snapshot reconciliation core
  (normalize → `readTakerAllowlistSnapshot` → `compareTakerAllowlistPolicy` over
  `AGGREGATOR_TAKER_ALLOWLIST_ABI`). They are **not** mere normalizer+label twins — they differ in
  **three** fail-closed-relevant ways, each of which a naive collapse would silently regress:
  1. **Sushi-only compilation guard:** `validateSushiAggregatorTakerRouterSupport`
     (`preflight.ts:53-86`) asserts via `getConfiguredTakers()` that the on-chain `TakerRouter` was
     compiled **with** the `SUSHI_AGGREGATOR` source id (rejecting a stale factory). LI.FI has no
     equivalent.
  2. **`selectorTargets` differ:** LI.FI reads `[...callTargets, ...Object.keys(selectorAllowlist)]`
     (`route-preflight-validation.ts:415-418`); Sushi reads only `policy.callTargets` (`preflight.ts:126`).
  3. **LI.FI-only target/spender contract-code checks (pass 4):** `validateLifiAllowlistPreflight`
     loops `requireContractCode` over **both** `expectedTargets` and `expectedSpenders`
     (`route-preflight-validation.ts:390-405`); the Sushi validator does **no** `getCode` on its
     targets/spenders (`preflight.ts:113-140`). Both descriptor rows set
     `getContractCodeRequirements: () => []`, and the shared runner only code-checks the taker
     **address**, not targets/spenders. So this is NOT shared. A collapse that runs the loop in the
     core silently **extends** `eth_getCode` checks to Sushi (new RPC + fail-closed surface; the
     Sushi preflight test stub has no `getCode`); one that omits it silently **drops** LI.FI's
     bytecode check (covered by `route-preflight.test.ts:631-672`).
  4. **Read-retry policy differs (pass 6):** the `read` injector passed into the shared
     `readTakerAllowlistSnapshot` is itself per-provider. LI.FI passes `retryRpcRead` (retries
     **only** when `isRetryableRpcReadError` — rate-limit/5xx/timeout — else fails fast,
     `route-preflight-validation.ts:243-267`); Sushi passes `readWithRetries` (retries on **any**
     error, `preflight.ts:32-51`). Identical delays `[100,250,500]`, but the retryability gate
     differs: on a transient-but-unclassified error Sushi can recover where LI.FI fails fast. A
     core-collapse hardcoding one `read` impl silently changes the other's preflight read behavior.
- **Remedy:** Collapse only the reconciliation core; keep **five** per-provider hooks off the
  descriptor: `normalizeChainPolicy`, a `selectorTargets` builder, an optional `preStep` (the
  compilation guard), a `contractCodeTargets` builder / per-source flag (whether to `getCode`
  targets+spenders), and a `read`/retry-strategy injector. For each of the **four** asymmetries make
  the **apply-to-all-vs-keep-as-is decision explicit** (e.g. the compilation guard and contract-code
  checks arguably *should* extend to all providers, and the gated `retryRpcRead` is the better shared
  default — but each is a conscious, tested behavior change, not an incidental one). Then Wave 3's
  1inch preflight is a descriptor row. (Depends on **M-B** / **N2**.)
- **Effort:** M. **Risk:** medium-high (fail-closed preflight — preserve 'contains'→'exact'
  reconciliation; do **not** silently extend-or-drop any of the four asymmetric behaviors).
- **Verify:** preflight unit + fork-reconciliation tests, with **per-source** coverage of (a) the
  stale-factory rejection and (b) the no-bytecode target/spender rejection. **The Sushi preflight
  test stub must gain a `getCode` stub** if Sushi is brought into the contract-code check.

### M-G — Unify the circuit-breaker mechanics; kill the 1inch dual-bookkeeping *(new)*
- **Location:** `src/discovery/external-take/lifi-circuit.ts` (~116 lines),
  `src/discovery/external-take/one-inch-circuit.ts` (~185 lines); `src/discovery/types.ts:110-114`
  (`OneInchQuoteCircuitState`) vs `:121-125` (`ExternalProviderCircuitState`), `:130-132`
  (dead `ExternalTakeCircuitPurpose`); `src/discovery/rpc-cache.ts:43-46`,
  `src/discovery/runtime.ts:89,412-413,993`.
- **Problem:** `lifi-circuit.ts` and `one-inch-circuit.ts` are two near-identical implementations
  of the same circuit-breaker state machine (failure threshold, cooldown clamp to `MAX_*`,
  5-min open-heartbeat, reset-on-expiry, record success/failure). Worse, the 1inch path keeps a
  **parallel legacy bookkeeping** (the scalar `oneInchQuoteCircuit` + the `oneInchQuoteCircuits`
  map) hand-synced with the canonical `providerCircuits.oneinch` map via
  `linkOneInchProviderCircuitState` / `getExistingOneInchCircuitState` — triple storage with a
  latent desync surface. LI.FI already uses **only** `providerCircuits.lifi`.
  `OneInchQuoteCircuitState` is byte-identical to `ExternalProviderCircuitState`, and
  `ExternalTakeCircuitPurpose` is dead (referenced only at its own definition; its comment claims
  a `provider.ts` field that does not exist). This is precisely the parallel-registry pattern the
  guardrails forbid, sitting directly beneath the wrappers M-C touches.
- **Remedy (conservative, high-confidence subset):** Delete the 1inch dual-bookkeeping
  (`oneInchQuoteCircuit` / `oneInchQuoteCircuits` / `linkOneInchProviderCircuitState` /
  `getExistingOneInchCircuitState`) and collapse onto `providerCircuits.*` (mirroring LI.FI);
  replace `OneInchQuoteCircuitState` with `ExternalProviderCircuitState`; delete the dead
  `ExternalTakeCircuitPurpose`. (The larger "one circuit primitive keyed by descriptor identity,
  purpose-sets as descriptor data" rewrite can follow once M-C lands — do **not** bundle it here.)
- **Blast radius (pass 2):** the legacy fields `oneInchQuoteCircuit`/`oneInchQuoteCircuits` are
  asserted (via `expect`/fixture literals) in **8** unit-test files, not the 2–3 first listed:
  `one-inch-circuit`, `lifi-circuit`, `discovery-runtime`, `discovery-handlers`,
  `discovery-gas-policy`, `discovery-external-take-route-binding`, `hybrid-external-take-probes`,
  `lifi-discovery-handlers`. Migrating those assertions onto `providerCircuits.oneinch.*` is part
  of **the same commit** (a `discovery-gas-policy` object-literal seed becomes a TS excess-property
  error the moment the field is deleted), not a follow-up.
- **Effort:** M. **Risk:** low-medium (advisory cooldowns, no fund/correctness risk, but the
  hand-sync removal must preserve current open/close behavior). **Verify:** all 8 files above.

### N18 — Resolve the Sushi quote-circuit parity gap *(new; parity — pairs with M-G)*
- **Location:** `src/discovery/external-take/sushi-aggregator-quote.ts:28` (no circuit) vs
  `lifi-quote.ts:31-48` + `oneinch-aggregator-quote.ts:34-51` (both wire a quote circuit breaker).
- **Problem:** LI.FI **and** 1inch each guard their discovery quote path with a circuit breaker
  (open-on-repeated-failure cooldown), but Sushi has none — an unexplained provider asymmetry on the
  exact `providerCircuits.*` state M-G consolidates onto.
- **Remedy:** Make it a **conscious** decision: either add a Sushi quote circuit mirroring LI.FI/1inch
  (reusing the unified `providerCircuits.*` from M-G — cheap once M-G lands), **or** add a one-line
  comment at `sushi-aggregator-quote.ts:28` stating why Sushi deliberately omits it. Do this as part
  of M-G so the circuit story is uniform across providers.
- **Effort:** S. **Risk:** low. **Verify:** sushi discovery quote tests (if a circuit is added).

### M-H — Lift the 1inch/Sushi route-canary orchestration into `src/` (mirror LI.FI) *(new)*
- **Location:** `scripts/oneinch-route-canary.ts:1-546`,
  `scripts/sushi-aggregator-route-canary.ts:71-149`; contrast the LI.FI shape:
  `scripts/lifi-route-canary.ts` (~59-line shell) delegating to `src/dex/lifi/route-canary.ts`
  + `route-canary-env.ts`, which has a real unit test (`tests/unit/lifi-route-canary.test.ts`).
- **Problem:** The LI.FI canary already established the right layering — env parsing, check-running,
  quote validation, and summary building live in `src/` and are unit-tested. The 1inch and Sushi
  canaries instead bury that orchestration in the script, untested.
- **Remedy:** Lift the 1inch and Sushi canary bodies into `src/dex/{oneinch-aggregator,sushi-aggregator}/route-canary.ts`
  (or one shared aggregator route-canary harness parameterized by provider), leaving the scripts as
  thin shells; add unit tests mirroring `lifi-route-canary.test.ts`.
- **Effort:** M. **Risk:** low (test/dev tooling). **Verify:** the new + existing route-canary unit tests.

### M-F — One named `CalldataAggregatorPathQuoteEvaluator` type *(new; improvement)*
- **Location:** `src/take/aggregator-calldata/adapter.ts:23-31` (descriptor
  `getPathQuoteEvaluation` typed `TQuoteConfig`) vs the prepare-execution / quote-evaluation
  params (typed the broader `TExecutionConfig`).
- **Problem:** The same provider function (`getLifiPathQuoteEvaluation`) threads through three
  descriptor surfaces whose 5th param is typed differently, relying on structural compatibility +
  a `Partial<>` widening to line up — a 7-positional-arg contract that is easy to mis-wire.
- **Remedy:** Define one named object-params type `CalldataAggregatorPathQuoteEvaluator` in the
  shared module; have all three surfaces + the provider fns reference it. Rearranges (not deletes)
  but collapses three near-duplicate signatures into one and removes the positional-arg fragility.
- **Effort:** S. **Risk:** low. **Verify:** `tsc`, aggregator quote tests.

### B-C1 — Stale "standalone owner-only mode" comments describe an unreachable path
- **Location:** `contracts/base/KeeperTakerBase.sol:122-124`;
  `contracts/takers/CurveKeeperTaker.sol:38-39`; `contracts/takers/UniswapV3KeeperTaker.sol:26-27`.
- **Problem:** The comments say the authorized router may be zero for standalone owner-only
  mode, but the aggregator base hard-rejects a zero router (`'Zero authorized router'`) and
  every deploy path supplies one.
- **Remedy:** Either make the direct-DEX takers also `require(authorizedRouter_ != address(0))`
  (one shared invariant) or delete the standalone-mode comments.
- **Effort:** S. **Risk:** low (re-run taker suites + `slither` if tightening the require).

### B-C2 — Collapse the vestigial `KeeperTakerBase` / `RouterAuthorizedTakerBase` split
- **Location:** `contracts/base/KeeperTakerBase.sol:17,120` (+ owner/poolFactory 54,59,140,145).
- **Problem:** The two-level split existed only so the deleted standalone `AjnaKeeperTaker`
  could inherit the lower layer. `AjnaKeeperTaker.sol` is gone (deleted in the #20 migration)
  and no contract inherits `KeeperTakerBase` directly anymore.
- **Remedy:** Merge into a single `abstract contract KeeperTakerBase is IAjnaKeeperTaker,
  ReentrancyGuard` owning the wiring, helpers, AND router authorization.
- **Effort:** M. **Risk:** medium — security-critical base contract; full taker suites +
  `slither` + a re-read of the donation-immune callback path. **Keep B-C1/B-C2 in their own
  PR** so the `slither` gate is unambiguous.

---

## Wave 3 — descriptor-driven deploy loop + 1inch parity

### M-A — One descriptor-driven deploy loop *(consolidates B-S1, B-S2, B-S3, B-S4)*
- **Location:** `scripts/deploy-factory-system-cli.ts` (the `dex.oneInch` throw ~130-145;
  the `configureFactory` uniswap/curve if-chain ~459-475; `verifyDeployment` with Uniswap
  ~514-563 + LI.FI ~565-615 but **no Sushi branch** = the B-S1 asymmetry; the hardcoded
  `generateConfigUpdate` labels + address-print ~631-693; the deploy/configure/register
  blocks ~789-892) + `scripts/deployment/{lifi-factory,sushi-aggregator}-deployment.ts`.
- **Problem:** The deploy CLI is a fully hand-unrolled per-provider sequence; each provider
  re-appears in ~6 sites (deploy block, configure-allowlists call, `register*` fn, verify
  branch, config label, address line). B-S1 (missing Sushi verify), B-S2 (`register*`
  near-identical), B-S3 (`configure*Allowlists` duplicate orchestration), and B-S4 (hardcoded
  labels) are all symptoms. The `dex.oneInch` throw is the tell: there is no loop to extend.
- **Remedy (code-judo):** Hang two provider-local fields off each aggregator descriptor —
  `takerArtifact` (path) and `normalizeChainPolicy` (already exists per provider:
  `normalizeLifiProductionChainPolicy` / `normalizeSushiAggregatorChainPolicy`) — then write
  **one** loop over present aggregator sources: `deploy → reconcileTakerAllowlists(normalize…) →
  registerTakerInRouter(source) → verifyAggregatorTakerRegistration(source) →
  emit ${takerContractKey}: addr`. Direct-DEX (uniswap/curve) folds into the same loop minus
  the allowlist step. `reconcileTakerAllowlists` is net-new (the orchestration the per-provider
  `configure*` fns duplicate); **preserve** LI.FI's `hasProductionLifiConfig` short-circuit and
  bind `AGGREGATOR_TAKER_ALLOWLIST_ABI` directly (free once **M-B** lands).
- **⚠️ Prerequisite — add deployment-script tests first.** There are **zero** deployment-script
  unit tests today, so the safety net the other waves rely on does not exist here, and the
  per-provider paths differ in real ways (the `hasProductionLifiConfig` short-circuit, inter-step
  delays, gating predicates). Write characterization tests for the current per-provider deploy
  output **before** collapsing to the loop, then assert the loop reproduces them.
- **Effort:** L (incl. the test prerequisite). **Risk:** medium — deploy-only tooling (no
  runtime/contract/fund risk) but currently untested. **Verify:** the new deployment-script
  tests + a fork deploy dry-run.

### W3-FINAL — 1inch allowlist preflight parity *(now a descriptor row, not a fresh copy)*
With M-A (deploy loop), M-C′ (generic preflight), and M-B (shims gone) in place, bringing 1inch
to LI.FI/Sushi parity collapses to:
1. **`normalizeOneInchChainPolicy`** — a provider-local normalizer mirroring
   `normalizeSushiAggregatorChainPolicy` (per-chain target/spender/selector allowlists,
   fail-closed coverage), reusing `normalizeTakerSelectorAllowlistRecord` (do **not** fork it).
2. **Descriptor row** — add `takerArtifact` + `normalizeChainPolicy` to the 1inch descriptor
   entry; this auto-enrolls it in M-A's deploy loop and M-C′'s preflight (deleting the
   `deploy-factory-system-cli.ts:134` throw).
3. **Schema** — production 1inch allowlist policy fields, with validation rejecting a production
   1inch source that lacks target/spender/selector policy (mirror Sushi/LI.FI `reviewed_broad`).
4. **Fork canary** — `oneinch-aggregator-fork-canary` mirroring the Sushi canary. **Blocked
   locally:** the dev `ONEINCH_API_KEY` is 401; run it where a valid key exists, pinned near the
   live head (the Sushi canary needed `BASE_FORK_BLOCK=latest` to avoid live-quote-vs-stale-block
   skew).

**Acceptance:** production 1inch config without a complete allowlist policy fails validation;
preflight fail-closed reconciliation rejects on-chain allowlist drift; the canary executes a real
1inch take.

---

## Out of scope (honest scoping)

The repo's >1000-line files are **not** aggregator-cleanup targets:
- `src/discovery/gas-policy.ts` (~1205) was **shrunk** (net −92) by the migration; if decomposed
  later, extract the gas-quote conversion-cache + config-identity cluster (~200 lines) into
  `src/discovery/gas-quote-cache.ts` — but as orthogonal work, not bundled here.
- `src/discovery/targets.ts` (~1133) has **zero** production churn on this branch — out of scope.

Decompose only with a clean domain split; do not bundle into the aggregator cleanup.

## Guardrails (carried from `docs/calldata-aggregator-followup-plan.md`)

- This revision **is** the "fold everything into the one canonical descriptor" the guardrails
  demand: do not add a second/third route or provider identity registry — make surfaces consume
  `external-take-descriptors.ts`.
- Do not add provider-specific execution-approval helpers or new top-level external-take paths;
  normalize into `ApprovedCalldataAggregatorQuote` and use the shared approval path.
- Keep provider-local **behavior** (quote/execute/route-shape/canary/preflight-hook/normalizer)
  in provider modules keyed by descriptor identity; keep shared route/preflight/approval/telemetry
  thin (no new `source`/`path` switch branches — M-C removes the existing ones).
- Preserve exact-fill calldata-aggregator mechanics (route freshness, exact source amount,
  balance-delta checks, allowance reset) — the contract refactors (B-C1/B-C2) must not touch them.
- Run `npm run check-hot-file-growth -- --base <ref>` and
  `npm run check-external-take-boundaries -- --base <ref>` at closeout for any PR touching the hot
  files; remediate by domain ownership, not line-count appeasement.

## Single-PR execution order

One PR, committed in dependency order so the bundle stays reviewable and the two hard gates
(`slither`, deployment tests) are not skipped:

1. **Deletions & canonical-reuse** — M-B, M-E, N1, N2, N3, N4, N5, N6, N7, N8, N9, N10, N11,
   N12, N13, N14, N15, N16, N17, N19, B-T1, B-T3, B-D2, B-D3.
2. **Descriptor consumers** — M-C, M-C′, M-D, M-F, M-G, M-H, N18 (M-C′ depends on M-B from step 1;
   N18 pairs with M-G).
3. **Contracts** — B-C1, B-C2; **run `npm run slither`** and the full taker suites here as a
   distinct commit so the contract gate stays auditable inside the single PR. (N4's dead-mock
   deletion + typechain regen also lands with the contract commit.)
4. **Deploy** — write deployment-script **characterization tests first** (none exist), then M-A
   (the descriptor-driven loop), asserting the loop reproduces the captured per-provider output.
5. **1inch parity** — `normalizeOneInchChainPolicy` + descriptor row + schema. ⚠️ Its
   `oneinch-aggregator-fork-canary` cannot be verified in this env (401 `ONEINCH_API_KEY`); land
   the canary code but run it where a valid key exists. This is the one step whose live
   verification can't happen here — if every line must be CI-green before merge, it's the natural
   candidate to split off; otherwise note the unrun canary in the PR description.

Keep each step a separate commit so a reviewer can read the single PR as these five phases. The
build/typecheck/unit + taker/aggregator integration suites run at each step; `slither` at step 3.

---

## Implementation status

Implemented on branch `aggregator-cleanup-impl` as 16 verified commits (`impl phase 1a … phase 4`).
Every gate was run and green at each step: `npm run typecheck`, `npm run unit-tests` (grew 1008 →
1045), the taker/aggregator integration suites, and `npm run slither` at the contract step.

**Done (Waves 1–4):**
- **Wave 1** — all deletions/canonical-reuse: M-B, M-E, N1, N3, N4, N5, N6, N7, N8, N9, N10, N11,
  N12, N13, N14, N15, N16, N17, N19, B-T1, B-T3, B-D2, B-D3.
- **Wave 2** — M-C, M-D, M-F, M-G, N18, M-H, and M-C′. **N2** landed in Wave 2 (after M-B) as planned.
- **Wave 3 (contracts)** — B-C2 (merged `RouterAuthorizedTakerBase` into `KeeperTakerBase`) and B-C1;
  `slither` showed only the 15 pre-existing findings (none in the merged base, none new).
- **Wave 4 (deploy)** — M-A: characterization tests (`tests/unit/deploy-factory-system.test.ts`,
  18) written first, then the descriptor-driven loop via a deploy-side `scripts/deployment/deploy-registry.ts`.

**Conscious deviations from the literal remedy (each behavior-preserving + verified):**
- **M-C′** — implemented as a shared `reconcileTakerAllowlistSnapshot` helper in the canonical
  allowlist module rather than one 8-hook generic. The two validators already shared the
  reconciliation core; the genuinely-divergent fail-closed parts (compilation guard, contract-code
  checks, selectorTargets, retry strategy, gating/messages) are kept **explicit per provider** —
  clearer and lower-risk than burying them behind hooks. A future 1inch validator reuses the same helper.
- **B-C1** — the zero-router "standalone owner-only mode" comment was **corrected, not deleted**:
  standalone mode is a real, fixture-exercised capability for the direct-DEX takers (only the
  aggregator base rejects a zero router), so extending the non-zero `require` to the base (which would
  remove that tested capability) was deliberately not done.
- **M-A residue (bounded follow-ups, not dead-in-prod risk):** the superseded per-provider helper fns
  (`configure*Allowlists` / `register*` / `deploy*KeeperTaker` in
  `scripts/deployment/{lifi-factory,sushi-aggregator}-deployment.ts`) are no longer called by the CLI
  but retained as test-only utilities; `generateConfigUpdate` (B-S4) keeps its hardcoded per-provider
  label lines (correct + char-tested).
- **N18** — Sushi quote-circuit parity resolved by the documented-omission route (Sushi exposes no
  quote-failure threshold/cooldown config to drive a circuit); the unified `providerCircuits.*` makes
  adding one a small follow-up.

**Wave 5 — W3-FINAL (1inch allowlist parity): IMPLEMENTED.**
- **Schema + normalizer** — `OneInchDexConfig` gains optional `callTargetAllowlist` /
  `approvalSpenderAllowlist` / `selectorAllowlist`; `src/config/oneinch-aggregator-policy.ts` adds
  `normalizeOneInchChainPolicy` (mirrors Sushi, reuses `normalizeTakerSelectorAllowlistRecord` with
  fail-closed call-target coverage) + `hasOneInchAggregatorAllowlistPolicy` +
  `assertValidOneInchAggregatorDexConfig`.
- **Validation** — `validateOneInchTakeSource` requires a complete allowlist policy for live
  (non-dry-run) 1inch takes; a present-but-incomplete/non-covering policy fails closed at config time.
- **Deploy** — a 1inch entry in `scripts/deployment/deploy-registry.ts` auto-enrolls it in M-A's loop
  (gated on the allowlist policy); the CLI's blanket 1inch throw is replaced by a no-policy-only guard,
  and `generateConfigUpdate` emits the `OneInchAggregator` lines.
- **Preflight** — the ONEINCH descriptor row gains `validateOneInchAggregatorAllowlistPreflight`
  (reuses M-C′'s `reconcileTakerAllowlistSnapshot`), giving fail-closed on-chain drift detection.
- **Fork canary** — `tests/integration/oneinch-aggregator-fork-canary.test.ts` mirrors the Sushi
  canary via the production `requestValidatedOneInchAggregatorQuote` path. ⚠️ Gated off by default
  (`RUN_ONEINCH_FORK_CANARY`) and **not run here** — the dev `ONEINCH_API_KEY` is 401; it typechecks
  and skips cleanly and must be run where a valid key exists, pinned near the live head.
- **Tests** — `tests/unit/oneinch-aggregator-policy.test.ts` covers the normalizer + the production /
  quote-only / incomplete-policy validation paths; existing 1inch production fixtures were given the
  allowlist policy. typecheck clean; unit suite 1045 → 1055.

**Entire plan implemented.** The only piece not executed in this environment is the 1inch fork
canary's live run (401 key) — code landed + gated, per the execution order's split-off note.
