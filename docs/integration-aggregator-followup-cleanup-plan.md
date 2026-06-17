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

**What is NOT in scope here:** the inclusion review confirmed the merge is a
strict superset of PR #18 with zero missing content, and the donation-DoS
exact-fill fix is already shipped. This plan is cleanup + one parity feature, not
correctness recovery.

## Sequencing

Three waves, cheapest-and-safest first:

1. **Wave 1 — canonical-reuse wins (pure deletion, no behavior change).** Reuse an
   existing helper / descriptor instead of a near-duplicate. Mechanical, low risk,
   independently mergeable. Items: B-D1, B-D2, B-D3, B-T1, B-T3.
2. **Wave 2 — structural simplifications (behavior-preserving refactors).** Touch
   shared structure; require the full taker/aggregator suites (and `slither` for
   the contract item) to re-confirm. Items: B-C1, B-C2, B-T2, B-S1, B-S2, B-S3,
   B-S4, B-D4.
3. **Wave 3 — 1inch allowlist preflight parity (functional feature).** The only
   non-cleanup item; needs a valid `ONEINCH_API_KEY` for its fork canary (the dev
   env key is currently 401, so the canary cannot be exercised locally here).

Each item below lists: location, the problem, the remedy (thermo-nuclear style),
effort (S/M/L), risk, and how to verify.

---

## Group B — code-quality findings (pre-existing in OURS, verified by the review)

### Contracts

#### B-C1 — Stale "standalone owner-only mode" comments describe an unreachable path
- **Location:** `contracts/base/KeeperTakerBase.sol:122-124`;
  `contracts/takers/CurveKeeperTaker.sol:38-39`;
  `contracts/takers/UniswapV3KeeperTaker.sol:26-27`.
- **Problem:** The comments say the authorized router "may be zero to deploy in
  standalone owner-only mode." After Packet 5, the aggregator base hard-rejects a
  zero router (`'Zero authorized router'`) and every deploy path supplies a
  router, so the documented mode is effectively dead for the direct-DEX takers and
  contradicted for the aggregator base.
- **Remedy:** Pick one invariant. Preferred: make the direct-DEX takers also
  `require(authorizedRouter_ != address(0))` so all takers share one rule and the
  comment becomes "router is mandatory." Alternative: delete the standalone-mode
  comments and keep the (intentionally) permissive direct-DEX constructors.
- **Effort:** S. **Risk:** low (but it is the security-critical base — if tightening
  the require, re-run the taker suites + `slither`).
- **Verify:** `npm run compile`, taker integration suites, `npm run slither`.

#### B-C2 — The two-level abstract split is vestigial — collapse it
- **Location:** `contracts/base/KeeperTakerBase.sol:17,120` (+ owner/poolFactory at
  54,59,140,145).
- **Problem:** `KeeperTakerBase` (lower) / `RouterAuthorizedTakerBase` (upper)
  existed only so the deleted standalone `AjnaKeeperTaker` could inherit the lower
  layer and the factory could detect a legacy taker by the absence of the router
  mixin. `AjnaKeeperTaker.sol` is gone (deleted in the #20 migration) and no contract inherits
  `KeeperTakerBase` directly anymore, so the split is indirection with one
  consumer path.
- **Remedy:** Merge into a single `abstract contract KeeperTakerBase is
  IAjnaKeeperTaker, ReentrancyGuard` that owns the wiring, helpers, AND the router
  authorization (`_authorizedRouter`, `onlyOwnerOrRouter`).
- **Effort:** M. **Risk:** medium — security-critical base contract; needs careful
  diff + full taker suites + `slither` + a re-read of the donation-immune callback
  path to confirm nothing shifts.
- **Verify:** `npm run compile`, all `tests/integration/*taker*`, `npm run slither`.

### src/take

#### B-T1 — `direct-dex/route-selection.ts` is a 74-line pure re-export barrel
- **Location:** `src/take/direct-dex/route-selection.ts:1-73` (zero own definitions).
- **Problem:** The honest-modules refactor (#20) split the former
  573-line file into siblings (`route-amounts`, `route-candidates`, `route-ranking`,
  `route-profitability`, `providers`, `availability`, `logs`, `runtime-cache`,
  `route-types`, `route-rejection`) but left `route-selection.ts` as a re-export
  façade. It is indirection that hides which module actually owns each symbol.
- **Remedy:** Repoint the 6 importers at the owning sibling modules (mechanical
  import rewrite — the symbols already live there) and delete the barrel. The two
  `src/discovery` importers pull a small set; confirm none rely on the barrel as a
  compatibility boundary per the followup-plan hot-file rules.
- **Effort:** S. **Risk:** low. **Verify:** `npm run typecheck`, unit suite,
  `npm run check-external-take-boundaries -- --base origin/master`.

#### B-T2 — Each aggregator provider wires the same two callbacks through three descriptor fields
- **Location:** `src/take/lifi/execution.ts:108-123`,
  `src/take/sushi-aggregator/execution.ts:84-102`,
  `src/take/oneinch-aggregator/execution.ts:75-94`.
- **Problem:** After the (good) shared-execution-closure consolidation, each
  `takeLiquidationXxx` still re-specifies the provider's two real knobs
  (`onXxxQuoteResult`, `onXxxExecutionFailure`) spread across three descriptor
  slots (`recordPreparedRejection`, the quote-result hook, the failure hook),
  byte-identical across all three providers.
- **Remedy (code-judo):** Change `takeLiquidationCalldataAggregatorProvider` to
  accept a single `selectors: { onQuoteResult, onExecutionFailure }` and derive
  `recordPreparedRejection` internally (via the existing factory). The three
  providers shrink to one selector object each.
- **Effort:** M. **Risk:** low-medium (shared aggregator execution path; full
  aggregator suites + the circuit/refresh tests).
- **Verify:** `npm run typecheck`, lifi/sushi/oneinch taker + circuit unit tests.

#### B-T3 — `routeMetadata` diagnostic string built eagerly but only used in the catch
- **Location:** `src/take/direct-dex/index.ts:661-682`.
- **Problem:** In `takeLiquidationDirectDex`, `routeMetadata` (a 4-part concat) is
  built unconditionally before the `try`, but referenced only in the catch's
  `logger.error`. Built and discarded on every successful take.
- **Remedy (code-judo, trivial):** Move the construction into the catch block.
- **Effort:** S. **Risk:** none. **Verify:** unit suite.

### src/config + src/discovery

#### B-D1 — `hybrid.ts` re-derives provider labels via a hardcoded switch the descriptor owns
- **Location:** `src/discovery/external-take/hybrid.ts:55-68`
  (`formatProviderWarnLabel`).
- **Problem:** Hardcodes `'oneinch'->'1inch'`, `'lifi'->'LI.FI'`,
  `'sushi_aggregator'->'Sushi aggregator'` — exactly the provider-specific
  special-casing the descriptor table exists to eliminate.
  `getAggregatorProviderIdentity(providerId).label` already returns these.
- **Remedy (reuse-canonical):** Replace the switch body with
  `provider.providerId ? getAggregatorProviderIdentity(provider.providerId).label
  : (provider.path === 'direct_dex' ? 'direct DEX' : provider.path)`.
  **Behavior note:** this is the one Wave-1 item that changes an emitted string —
  the descriptor `label` is `'Sushi Aggregator'` (capital A;
  `external-take-descriptors.ts:93`) while the current switch emits `'Sushi
  aggregator'` (lowercase; `hybrid.ts:64`). Pick one casing (align the descriptor
  `label` or lowercase at the call site) and update the `hybrid-external-take-*`
  assertion to match, so the warning text doesn't silently drift.
- **Effort:** S. **Risk:** low. **Verify:** unit suite (`hybrid-external-take-*`).

#### B-D2 — Duplicate Uniswap V3 required-address-fields constant
- **Location:** `src/config/liquidity-source.ts:56-72`.
- **Problem:** `UNISWAP_V3_FACTORY_ROUTE_REQUIRED_ADDRESS_FIELDS` and
  `UNISWAP_V3_DIRECT_DEX_ROUTE_CONTRACT_ADDRESS_FIELDS` hold byte-identical
  four-string lists, consumed by different callers.
- **Remedy (reuse-canonical):** Drop the second; have
  `route-preflight-validation.ts:475` import the first directly.
- **Effort:** S. **Risk:** none. **Verify:** `npm run typecheck`, route-preflight tests.

#### B-D3 — Private `getErrorMessage` in `lifi-policy.ts` duplicates `src/utils.ts`
- **Location:** `src/config/lifi-policy.ts:39-41`.
- **Problem:** Byte-identical to the exported `getErrorMessage` in `src/utils.ts`
  that `quotes.ts`/`hybrid.ts` already import.
- **Remedy (reuse-canonical):** Import from `../utils`, delete the local copy.
- **Effort:** S. **Risk:** none. **Verify:** `npm run typecheck`.

#### B-D4 — `stats.ts` keeps legacy per-DEX scalar counters in parallel with the generic maps
- **Location:** `src/discovery/external-take/stats.ts:30-31,222-229`.
- **Problem:** Dedicated `uniswapV3`/`curve` approved/executed/dryRun scalar fields
  filled by a hardcoded `switch (routeIdentity?.source)`, paralleling the generic
  `externalTakeByPath`/`externalTakeByProvider` maps.
- **Remedy (decompose, deferred):** Derive the scalars from the generic maps (or a
  `source -> field` descriptor map) and drop the hardcoded switch. Lower priority —
  touch only when the telemetry surface is next revisited (consumers may read the
  scalar fields).
- **Effort:** M. **Risk:** medium (telemetry consumers). **Verify:** stats unit tests
  + any dashboard/telemetry consumer.

### scripts / deployment

#### B-S1 — `verifyDeployment` never reads back the Sushi router mapping
- **Location:** `scripts/deploy-factory-system-cli.ts:486-618` (`verifyDeployment`),
  `:875-889` (sushi branch in `main`).
- **Problem:** Step 4 cross-checks `hasConfiguredTaker`/`takerContracts`/
  `authorizedRouter`/`owner` for Uniswap and LI.FI, but has no branch for
  `sushiAggregatorTaker`; Sushi's only post-deploy check is the allowlist
  reconciliation. Asymmetric verification coverage.
- **Remedy (tighten-boundary):** Extract the LI.FI verification block into a generic
  `verifyAggregatorTakerRegistration({ factory, source, takerAddress, deployer,
  label })` and call it for LI.FI, Sushi (and 1inch once W3 lands).
- **Effort:** M. **Risk:** low (deploy tooling, no runtime contract change).
- **Verify:** `deploy-factory-system` script unit tests / a dry-run.

#### B-S2 — `registerSushiAggregatorTakerInFactory` ≈ `registerLifiTakerInFactory`
- **Location:** `scripts/deployment/sushi-aggregator-deployment.ts:187-217` vs
  `scripts/deployment/lifi-factory-deployment.ts:147-178`.
- **Problem:** Differ only in the `LiquiditySource` value, the address-bag field
  name, and log strings. Both load the TakerRouter artifact, build the contract,
  `setTaker`, and wait.
- **Remedy (reuse-canonical):** Add a shared `registerTakerInRouter({ deployer,
  routerAddress, source, takerAddress, label })`; both `register*` become thin
  callers. (Fold the 1inch registration into the same helper in W3.)
- **Effort:** S. **Risk:** low. **Verify:** deployment-script unit tests.

#### B-S3 — `configure*Allowlists` duplicate ~85 lines of reconciliation orchestration
- **Location:** `scripts/deployment/sushi-aggregator-deployment.ts:98-182` vs
  `scripts/deployment/lifi-factory-deployment.ts:180-282`.
- **Problem:** The canonical helper (`src/take/aggregator-calldata/allowlist.ts`)
  factored out the PRIMITIVES (`readTakerAllowlistSnapshot`,
  `buildTakerAllowlistReconciliationPlan`, `assertTakerAllowlistPolicy`,
  `createTakerAllowlistReader`) but NOT the orchestration that strings them
  together (read snapshot -> build plan -> enable -> assert 'contains' -> disable ->
  assert 'exact'), which is duplicated line-for-line.
- **Remedy (reuse-canonical):** Hoist the orchestration into the canonical helper as
  `reconcileTakerAllowlists({ taker, desired, labelPrefix, txLabel })` taking an
  ethers.Contract bound to `AGGREGATOR_TAKER_ALLOWLIST_ABI`. Both `configure*`
  collapse to a desired-policy computation + one call. (`reconcileTakerAllowlists`
  does not exist yet — confirmed; it is net-new. Reused again by 1inch in W3.)
- **Preserve when refactoring:** the LI.FI path additionally loads the taker via
  `takerArtifact.abi` and goes through wrapper fns (`readLifiTakerAllowlistSnapshot`
  etc., re-exports of the generic primitives Sushi calls directly) and has a
  `hasProductionLifiConfig` guard that Sushi lacks. The shared helper must keep the
  production-config short-circuit and bind to `AGGREGATOR_TAKER_ALLOWLIST_ABI`
  directly rather than re-exporting per provider.
- **Effort:** M. **Risk:** low-medium (deploy reconciliation is fail-closed — keep the
  'contains'-then-'exact' assertion order intact and tested).
- **Verify:** the allowlist reconciliation unit tests + a deploy dry-run.

#### B-S4 — `generateConfigUpdate` hardcodes contract labels instead of the descriptor registry
- **Location:** `scripts/deploy-factory-system-cli.ts:631-673` (and the parallel
  hardcoding in `configureFactory:459-475`, `verifyDeployment`).
- **Problem:** Emits literal `UniswapV3:`/`Curve:`/`Lifi:`/`SushiAggregator:` labels
  via hand-maintained per-field `if`s, while
  `getExternalTakeTakerContractKeyForSource` (in `external-take-descriptors.ts`)
  already owns the canonical `LiquiditySource -> takerContractKey` mapping.
- **Remedy (reuse-canonical):** Drive the contracts block from an array of
  `{ address, source }` pairs, mapping each present address through
  `getExternalTakeTakerContractKeyForSource(source)` for its label.
- **Effort:** M. **Risk:** low. **Verify:** deploy-script unit tests / dry-run diff.

---

## Wave 3 — 1inch allowlist preflight parity (the deferred "LI.FI-style selector" work)

### Problem
1inch is the only calldata-aggregator path **without** an on-chain allowlist
preflight. LI.FI and Sushi each register a `validateAdditional` hook
(`validateLifiAllowlistPreflight` / `validateSushiAggregatorAllowlistPreflight`)
that, in production mode, reads the deployed taker's call-target / approval-spender
/ selector allowlists and fail-closed reconciles them against the configured
policy. The `ONEINCH` preflight descriptor
(`src/discovery/route-preflight-validation.ts:464`) has **no** `validateAdditional`,
and there is **no** 1inch allowlist policy module at all (compare
`src/dex/lifi/chain-policy.ts`, `src/config/sushi-aggregator-policy.ts`).

The on-chain support already exists: `OneInchAggregatorKeeperTaker` inherits the
allowlist setters (`setCallTarget` / `setApprovalSpender` / `setCallSelector`,
exercised in the taker fixture). The gap is entirely off-chain: policy config,
preflight reconciliation, deploy-time reconciliation, and a fork canary.

### Work items (mirror the LI.FI/Sushi structure)
1. **1inch chain policy + normalizer** — add a `OneInchAggregatorChainPolicyConfig`
   (per-chain `callTargetAllowlist` / `approvalSpenderAllowlist` / `selectorAllowlist`)
   and a `normalizeOneInchAggregatorChainPolicy`, analogous to
   `normalizeSushiAggregatorChainPolicy` (fail-closed: `requireCallTargetCoverage`,
   selector coverage cross-check). Reuse the shared
   `normalizeTakerSelectorAllowlistRecord` primitive — do **not** fork a new one.
2. **Preflight hook** — add `validateOneInchAggregatorAllowlistPreflight`
   (mirroring `validateLifiAllowlistPreflight`: contract-code checks for targets/
   spenders + `readTakerAllowlistSnapshot` reconciliation via the shared
   `AGGREGATOR_TAKER_ALLOWLIST_ABI`) and wire it as the `ONEINCH` descriptor's
   `validateAdditional`.
3. **Schema** — add the production 1inch allowlist policy fields under the 1inch
   config, with validation rejecting a production 1inch source that lacks target/
   spender/selector policy (mirror the Sushi/LI.FI `reviewed_broad` requirement).
4. **Deploy-time reconciliation** — provision the 1inch taker allowlists at deploy
   using the **shared** `reconcileTakerAllowlists` helper introduced by B-S3 (and
   register via B-S2's `registerTakerInRouter`, verify via B-S1's
   `verifyAggregatorTakerRegistration`). This is why W3 should land after W2.
5. **Fork canary** — add a `oneinch-aggregator-fork-canary` (mirror
   `sushi-aggregator-fork-canary`) exercising real 1inch calldata through the taker
   on a pinned-fresh Base fork. **Blocked locally:** the dev `ONEINCH_API_KEY` is
   401; the canary must be run wherever a valid key is available, and pinned near
   the live head (the Sushi canary needed `BASE_FORK_BLOCK=latest` to avoid
   live-quote-vs-stale-block skew).

### Acceptance
- `ONEINCH` production config without a complete allowlist policy fails validation
  with an explicit error (parity with LI.FI/Sushi).
- Preflight fail-closed reconciliation rejects a deployed 1inch taker whose
  on-chain allowlist drifts from config.
- The fork canary executes a real 1inch take through the taker (run with a valid
  key).

---

## Guardrails (carried from `docs/calldata-aggregator-followup-plan.md`)

- Do **not** add a second/third route or provider identity registry; consume the
  canonical descriptor (`src/config/external-take-descriptors.ts`).
- Do **not** add provider-specific execution-approval helpers or new top-level
  external-take paths; normalize into `ApprovedCalldataAggregatorQuote` and use the
  shared approval path.
- Keep provider policy/allowlist/route-shape/canary/preflight-hook behavior in
  provider-local modules keyed by descriptor identity; keep shared route/preflight/
  approval/telemetry thin (no new `source`/`path` switch branches — B-D1 is exactly
  this anti-pattern to remove, not to add to).
- Preserve exact-fill calldata-aggregator mechanics (route freshness, exact source
  amount, balance-delta checks, allowance reset) — the W2 contract refactors
  (B-C1/B-C2) must not touch these behaviors.
- Run `npm run check-hot-file-growth -- --base <ref>` and
  `npm run check-external-take-boundaries -- --base <ref>` at closeout for any PR
  touching the hot files; remediate by domain ownership, not line-count appeasement.

## Suggested PR decomposition

- **PR 1 (Wave 1):** B-D1, B-D2, B-D3, B-T1, B-T3 — pure canonical-reuse deletions,
  one review pass.
- **PR 2 (Wave 2a, contracts):** B-C1 + B-C2 — isolated so the `slither` + taker
  suite gate is unambiguous.
- **PR 3 (Wave 2b, plumbing):** B-T2, B-S1, B-S2, B-S3, B-S4 (and B-D4 if revisiting
  telemetry) — the helper-extraction refactors; lands the shared deploy helpers W3
  depends on.
- **PR 4 (Wave 3):** 1inch allowlist preflight parity, built on PR 3's shared deploy
  helpers; canary run where a valid `ONEINCH_API_KEY` exists.
