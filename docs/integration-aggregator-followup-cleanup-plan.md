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
  takes") but `encodeAggregatorSwapDetails` never references it and no approval check
  asserts it. A provider returning a non-zero native value would be **silently
  dropped, not rejected** — execution is ERC20-input-only by construction.
- **Remedy:** Either delete `txValue` (and `normalizeTxValue`) since execution is
  ERC20-input-only, **or** add one boundary assertion in
  `approveCalldataAggregatorQuoteForExecution` that rejects `txValue !== '0'`. Deleting
  is simpler; asserting is safer if a native-value provider is ever plausible. Pick one.
- **Effort:** S. **Risk:** low. **Verify:** quote-approval unit tests.

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
- **Effort:** M. **Risk:** low-medium. **Verify:** aggregator execution + circuit + the
  three provider taker suites.

### M-C′ — One generic `validateAggregatorAllowlistPreflight` *(folds the preflight twins; pre-solves Wave 3)*
- **Location:** `src/discovery/route-preflight-validation.ts:358-440` (LI.FI),
  `:495-532` (the SUSHI/LIFI descriptor `validateAdditional` hooks).
- **Problem:** `validateLifiAllowlistPreflight` and `validateSushiAggregatorAllowlistPreflight`
  are the same shape (contract-code checks for targets/spenders + snapshot reconciliation
  via `AGGREGATOR_TAKER_ALLOWLIST_ABI`), differing only by the provider's normalizer + label.
- **Remedy:** Collapse to one `validateAggregatorAllowlistPreflight` parameterized by a
  provider-local `normalizeChainPolicy` + descriptor label, wired once into the descriptor
  table. Then Wave 3's 1inch preflight is a descriptor row, not a third copy. (Depends on
  **M-B** so the neutral primitives are used directly, and **N2** so labels aren't LI.FI-biased.)
- **Effort:** M. **Risk:** medium (fail-closed preflight — keep the 'contains'→'exact'
  reconciliation and contract-code checks intact and tested). **Verify:** preflight unit +
  fork-reconciliation tests.

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

1. **Deletions & canonical-reuse** — M-B, M-E, N1, N2, N3, B-T1, B-T3, B-D2, B-D3.
2. **Descriptor consumers** — M-C, M-C′, M-D, M-F (M-C′ depends on M-B from step 1).
3. **Contracts** — B-C1, B-C2; **run `npm run slither`** and the full taker suites here as a
   distinct commit so the contract gate stays auditable inside the single PR.
4. **Deploy** — write deployment-script **characterization tests first** (none exist), then M-A
   (the descriptor-driven loop), asserting the loop reproduces the captured per-provider output.
5. **1inch parity** — `normalizeOneInchChainPolicy` + descriptor row + schema. ⚠️ Its
   `oneinch-aggregator-fork-canary` cannot be verified in this env (401 `ONEINCH_API_KEY`); land
   the canary code but run it where a valid key exists. This is the one step whose live
   verification can't happen here — if every line must be CI-green before merge, it's the natural
   candidate to split off; otherwise note the unrun canary in the PR description.

Keep each step a separate commit so a reviewer can read the single PR as these five phases. The
build/typecheck/unit + taker/aggregator integration suites run at each step; `slither` at step 3.
