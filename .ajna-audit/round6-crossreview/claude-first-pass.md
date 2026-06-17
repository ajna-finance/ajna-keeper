# Ajna Audit — calldata-aggregator migration PR (`calldata-aggregator-packets-4-5` vs `master`)

Read-only first-pass review, isolated child run (no cross-review launched). Scope: Solidity taker↔pool integration + deploy/config tooling.

## Verdict

**No exploitable (fund-loss) finding on the changed surface.** The four security-critical invariants the request flags — (1) ceil-quote repayment backstop, (2) the recently changed callback-collateral exact-fill check, (3) token-scale floor/ceil rounding, (5) reentrancy/active-callback binding — are implemented correctly, fail closed, and have targeted regression tests. The headline change (balanceOf → pool-callback-arg exact-fill) is correct and provably donation-immune. Findings below are **Low/Informational** (deploy-tooling completeness, a documented token limitation, advisory redundancy, cosmetic).

---

## Findings

### F-1 — `verifyDeployment` step 4 omits the Sushi aggregator taker (deploy-tooling completeness)
- **Severity:** Low · **Confidence:** High
- **file:line:** `scripts/deploy-factory-system-cli.ts:486-618` (checks `uniswapTaker` + `lifiTaker`; no `sushiAggregatorTaker` branch); compare register path `:875-889`.
- **Property:** Operational verification completeness ("register strictly after verification").
- **Actor/fund impact:** None directly. The register-after-verify invariant the request asks about **does hold** for Sushi: `configureSushiAggregatorAllowlists` throws on any allowlist mismatch (`assertTakerAllowlistPolicy({mode:'exact'})`, `sushi-aggregator-deployment.ts:169-177`) *before* `registerSushiAggregatorTakerInFactory`, and on-chain `TakerRouter.setTaker` re-validates `isSourceSupported`/`owner`/`authorizedRouter`/`poolFactory` (`TakerRouter.sol:72-97`). So a misconfigured Sushi taker cannot be registered. The gap is only that the final summary step never reads the Sushi mapping/authorization back, unlike Uniswap/LI.FI.
- **Source evidence:** `verifyDeployment` has `if (addresses.lifiTaker){...}` but no `if (addresses.sushiAggregatorTaker){...}`.
- **Failure sequence:** A future regression in the Sushi register path would not be caught by step 4 (still caught by the exact-allowlist assert). Not reachable today.
- **Required fix/test:** Add a Sushi branch to `verifyDeployment` (mirror the LI.FI block: `hasConfiguredTaker(SUSHI_AGGREGATOR)`, `takerContracts(6)`, `authorizedRouter`, owner). Add a deploy-script unit test asserting the Sushi read-back.
- **Residual risk:** None material.

### F-2 — Fee-on-transfer collateral bricks aggregator (and direct-DEX) takes (documented limitation)
- **Severity:** Informational · **Confidence:** High
- **file:line:** `contracts/base/BaseAggregatorCalldataTaker.sol:279-285` (exact-fill + exact approval `_safeApproveWithReset(srcToken, spender, amountInTokenUnits)`).
- **Property:** ERC20 parity (fee-on-transfer).
- **Actor/fund impact:** Liveness only, no fund loss. If collateral is FoT, the pool transfers `collateral` but the taker receives `collateral − fee`; the exact-fill check still passes (callback arg = pre-fee amount), but the aggregator's `transferFrom(amountInTokenUnits)` exceeds the taker's balance → swap reverts → whole take reverts. The keeper simply skips that auction. Shared with `CurveKeeperTaker`/`UniswapV3KeeperTaker`, which also pass the callback `collateral` as `amountIn` (`CurveKeeperTaker.sol:129`).
- **Source evidence:** approval is sized to `amountInTokenUnits == collateral` with no FoT slack.
- **Required test/proof:** A negative test asserting graceful revert (not silent loss) with an FoT collateral mock; a one-line "FoT collateral unsupported" note in the taker NatSpec / production setup guide.
- **Residual risk:** Keeper cannot service auctions whose collateral is FoT; acceptable given Ajna's own weak FoT support.

### F-3 — `dstReceiver` is validated but not bound into the opaque calldata (advisory redundancy)
- **Severity:** Informational · **Confidence:** High
- **file:line:** `BaseAggregatorCalldataTaker.sol:330` (`details.dstReceiver != address(this)` → revert) vs the opaque `details.callData` passed verbatim at `:308`.
- **Property:** Generic EVM — output-routing integrity.
- **Actor/fund impact:** None. The real recipient is whatever the off-chain calldata encodes; `dstReceiver` is not cross-checked against it. Fully backstopped by the balance-delta output guard: `quoteReceived = dstToken.balanceOf(after) − before` (`:283,288`). If output is routed elsewhere, the delta is 0 → `InsufficientQuoteReceived` revert. The taker's pre-existing balance sits in `before`, so it cannot be counted/drained.
- **Required proof:** Existing `lifi-taker.test.ts:226-247` (underdelivery revert) already exercises the backstop. Optionally a test with a divergent in-calldata receiver to document the field is advisory.
- **Residual risk:** None.

### F-4 — Stale `keeperTakerFactory` env-var alias in fixture CLI (cosmetic)
- **Severity:** Informational · **Confidence:** High
- **file:line:** `scripts/create-liquidatable-ajna-fixture-cli.ts:2589,3229,3240` (`existingKeeperTakerFactoryAddress` → assigned to `keeperTakerRouterAddress`).
- **Property:** Rename completeness.
- **Actor/fund impact:** None — production config path (`src/config`, `takers.router` → `keeperTakerRouter`) is fully renamed; the value flows to the correct router field. The boundary guard `scripts/check-external-take-boundaries.ts:156,169` intentionally flags the retired terms elsewhere (so these are guard rules, not stale usage). Only the fixture harness retains the legacy env-var spelling.
- **Required fix:** Rename the env var for consistency (or document the alias).
- **Residual risk:** None.

---

## What was verified clean (highest-risk surfaces)

**Repayment invariant (#1).** `quoteAmountDueCeiling = quoteAmountDue + (quoteTokenScale>1 ? 1 : 0)` (`TakerTakeScaling.sol:61`) provably covers the pool's `ceilDiv` pull: ceil−floor of `quoteWad/scale` ∈ {0,1}, so pull ≤ `quoteAmountDue+1` = ceiling; `quoteReceived ≥ ceiling ≥ pull` (`BaseAggregatorCalldataTaker.sol:288-295`). The pool's quote allowance (`_approveQuoteForTake`, `KeeperTakerBase.sol:102-105`) is a worst-case over-approval `ceilDiv(ceilWmul(maxAmount, auctionPrice), quoteScale) ≥ pull` (auction price is monotonically decreasing, so the keeper's last-known price ≥ execution price). Both reset to 0 in `_settleAfterTake`. Tested: `taker-hardening.test.ts:270-432, 459-543` via `quotePullOverride = due+1`.

**Exact-fill check (#2) — correct, donation-immune, rejects partial fills.** `collateral` is the pool's token-precision callback arg (= tokens actually received; `AjnaInterfaces.sol:43-57` natspec), not `balanceOf`, so a 1-wei srcToken donation cannot alter it → no grief; dust is swept by `_settleAfterTake`. Off-chain sizing sets `amountInTokenUnits = convertWadToTokenDecimals(executionCollateralWad)` and submits `executionCollateralWad` as `maxAmount` (`src/take/aggregator-calldata/execution.ts:316-377,490-498`); since the pool never sends more than `maxAmount`, `collateral ≤ amountInTokenUnits`, and any debt-clamp makes `collateral < amountInTokenUnits` → `UnexpectedSourceBalance`. Tested: donation immunity `lifi-taker.test.ts:203-224`; drift/partial rejection `oneinch-aggregator-taker.test.ts:135-180`.

**Reentrancy + active-callback binding (#5).** `atomicSwapCallback` is `nonReentrant` (contract-wide, blocks same- and cross-pool reentry of the callback); `takeWithAtomicSwap` guards `_activeCallbackPool != 0` (`:133`) and the callback requires `msg.sender == _activeCallbackPool && keccak256(data) == _activeCallbackDataHash` (`:159`). Binding storage is set/cleared around `pool.take` and rolls back on revert. A direct callback outside a take reverts (`_activeCallbackPool == 0`). Tested via `MockAtomicSwapPool.mutateCallbackData` (data-hash binding) and `_validatePool` factory check.

**Approval handling (#6) / USDT (#4).** `_safeApproveWithReset` does the zero-first reset USDT requires (`KeeperTakerBase.sol:81-89`); srcToken approval is bounded to `amountInTokenUnits` and reset to 0 immediately after the call (`:284,286`); no lingering allowance. Tested `taker-hardening.test.ts:544`.

**Allowlist enforcement (#7).** `_validateSwapDetails` (`:320-345`) enforces call-target ∈ allowlist, target `code.length > 0` (fail-closed on EOA/self-destructed), approval-spender ∈ allowlist, and `(target,selector)` ∈ allowlist where the checked selector is the first 4 bytes of the calldata actually executed. Opaque calldata to a trusted target is bounded by the exact srcToken approval + the output backstop, so arbitrary calldata cannot lose more than the swap economics permit. Setters are `onlyOwner`.

**Access control + rename (#8).** `takeWithAtomicSwap` is `onlyOwnerOrRouter`; the only contract call site is `TakerRouter.sol:129` (itself `onlyOwner`). `recover` `onlyOwnerOrRouter`; allowlist setters `onlyOwner`. The factory→router rename is complete in `src/`/`scripts/`/`contracts/` (no stale `AjnaKeeperTakerFactory` outside the intentional `MockLegacyDirectOneInchTaker` + its detection path `TakerRouter.sol:212-225`). `LAST_LIQUIDITY_SOURCE = type(...).max` auto-syncs the registry enumeration.

**Deploy completeness (#9).** Register-after-verify holds for LI.FI and Sushi (apply → `mode:'contains'` → disable-stale → `mode:'exact'` → register; `sushi-aggregator-deployment.ts:118-217`). Reconciliation math (`src/take/aggregator-calldata/allowlist.ts`) is set-correct (sorted-lowercase exact compare, dedup-on-normalize, stale on-chain targets folded into `selectorTargets`). TS↔Solidity `LiquiditySource` enum parity is exact (`schema.ts:84-92` ↔ `IAjnaKeeperTaker.sol:11-19`, incl. deprecated `SushiSwap=3` reserved). The 1inch guard (`deploy-factory-system-cli.ts:134-142`) aborts before any deployment when `dex.oneInch` is set; the loop is closed because `validateOneInchTakeSource` requires `dex.oneInch.routers` at runtime (`validation-rules.ts:443-455`) — so an operator cannot reach a router that maps `ONEINCH` to an unprovisioned/under-allowlisted taker via this script (worst case is a fail-closed `TakerNotSet`/`none` resolution, `external-take-descriptors.ts:474-482`).

---

## Open questions / operational notes
- **1inch one-shot deploy ergonomics (not a vuln):** because the guard aborts the *entire* script when `dex.oneInch` is present, an operator wanting LI.FI/Sushi *and* 1inch must remove `dex.oneInch`, run the deploy, then manually deploy+allowlist+`setTaker(ONEINCH,…)`, then re-add `dex.oneInch`. Intentional and fail-closed; worth a runbook line.

## Tests run / still required
- **Not executed** (read-only review): I did not run the suite or fork canaries. I traced sources, the mock, and existing test bodies.
- **Falsifiable caveat:** the callback-semantics premise (token-precision floored args; ceil pull from `msg.sender`; gap ≤ 1 wei) rests on in-repo `AjnaInterfaces.sol:43-57` + `MockAtomicSwapPool.sol:77-83`, not an independent re-derivation against `ajna-core` this run. The 1-wei bound makes the `+1` ceiling provably sufficient; the binding proof is the **fork canaries** (`lifi-fork-execution-canary`, `sushi-aggregator-fork-canary`, `tests/integration/sushi-aggregator-fork-canary.test.ts`) — these should be run green before release.
- **Recommended additions:** F-1 Sushi read-back deploy test; F-2 FoT-collateral graceful-revert test.

## Residual risks
- Aggregator takes are intentionally strict exact-fill: any sizing drift between off-chain quote and on-chain reality reverts (gas cost, no loss) — acceptable, mitigated by `getAggregatorQuoteContextMismatch` + freshness re-asserts.
- MEV: `scaleAmountOutMinimum` linear pro-rate (direct-DEX path only) is a loose floor on partial fills, bounded below by `quoteAmountDue` (auction always repaid); mitigated operationally by private-RPC/relay submission (`TakerTakeScaling.sol:28-36`). Aggregator path is exact-fill so not pro-rated.
