I have completed a thorough static review of the calldata-aggregator taker surface, cross-referenced the extraction against the pre-refactor `LifiKeeperTaker`, and mapped the test coverage. Here are my findings.

---

# Ajna Keeper — Calldata-Aggregator Taker Review (first-pass, isolated)

**Scope reviewed:** `contracts/base/BaseAggregatorCalldataTaker.sol`, `contracts/base/KeeperTakerBase.sol`, `contracts/libraries/TakerTakeScaling.sol`, `contracts/takers/{Lifi,SushiAggregator,OneInchAggregator,Curve,UniswapV3}KeeperTaker.sol`, `contracts/factories/TakerRouter.sol`, `contracts/interfaces/IAjnaKeeperTaker.sol`, `contracts/AjnaInterfaces.sol`, plus `tests/integration/{lifi-taker,taker-hardening}.test.ts`, the mock pool, and the `master→HEAD` diff for each.

**Bottom line:** No high/critical/medium exploitable defect found. The repayment invariant, allowlist enforcement, active-callback binding, reentrancy posture, and approval hygiene are correctly implemented and (mostly) well-tested. The base was extracted from `LifiKeeperTaker` faithfully — I diffed the removed inline logic against the new base line-by-line and confirmed every security-critical check (stale check, callback binding, exact-fill, ceiling backstop, allowlist+code check, approval reset) is preserved; only a dead `SourceNotConsumed` error and the renamed event differ. Two **Low** findings and a set of residual risks follow.

---

## Findings

### F1 — Non-18-decimal quote ceil-pull invariant is unverified on the aggregator path (the review's primary invariant)

- **id:** AGG-1
- **title:** `quoteAmountDueCeiling` (+1 token-wei) repayment backstop is exercised only for direct-DEX takers, never for the calldata-aggregator takers
- **severity:** Low (assurance/regression-protection gap; not a live bug)
- **confidence:** High
- **file:line:**
  - Code under test: `contracts/base/BaseAggregatorCalldataTaker.sol:284-291` (backstop) → `contracts/libraries/TakerTakeScaling.sol:61-63` (ceiling) + `contracts/base/KeeperTakerBase.sol:102-105` (worst-case approval).
  - Coverage present (direct-DEX only): `tests/integration/taker-hardening.test.ts:270-432` and `:459-542`.
  - Coverage absent (aggregator): `tests/integration/lifi-taker.test.ts` runs every case through `deployMockTakerBase()` default `quoteTokenScale = 1` (`tests/integration/helpers/mock-taker-base.ts:119`).
- **Ajna invariant / property:** Take repayment — the taker must hold ≥ the pool's *ceil-divided* quote pull (`Pool._transferQuoteTokenFrom`), which can exceed the callback's floor-divided `quoteAmountDue` by 1 token-wei when `quoteTokenScale > 1`. This is the PR #17 "failed-take for non-18-decimal quote" regression class.
- **actor/fund impact:** None today. Risk is latent: a future edit to the aggregator backstop (e.g. reverting to a floored-due comparison) would reintroduce the failed-take bug for 6-decimal quote pools (USDC/USDT) and the suite would stay green, because no aggregator test sets `quoteTokenScale > 1` + `quotePullOverride = due + 1`.
- **source evidence:** I traced the arithmetic with concrete USDC values (scale `1e12`): approval `= ceilDiv(ceilWmul(maxAmount, auctionPrice), scale)` is monotone ≥ `ceil(quoteWad/scale)` = pool pull, and the backstop requires `quoteReceived ≥ quoteAmountDue + 1`. The code is **correct**. The direct-DEX takers prove this exact path (`taker-hardening.test.ts:289-431`: reject-floored / accept-ceil / over-reject-on-exact-divide); the aggregator wrappers share the identical library + base helpers but have no analogous test.
- **minimal failure sequence (regression the missing test would catch):** change `BaseAggregatorCalldataTaker.sol:285` to compare against raw `quoteAmountDue` → a 6-decimal-quote aggregator take whose swap returns exactly the floored due passes the taker guard, then reverts opaquely inside the pool's ceil pull. No current test fails.
- **required test/proof:** Port the three `taker-hardening` cases to the aggregator path (build a Lifi/Sushi/1inch fixture on `deployMockTakerBase({ quoteDecimals: 6, quoteTokenScale: 1e12 })` with `setQuotePullOverride(due+1)`): (a) reject when output == floored due, (b) accept + full pool repayment when output == due+1, (c) over-reject on exact division. Assert `quote.balanceOf(pool) == due+1`.
- **residual risk:** Even with the test, collateral-side scaling (`collateralScale > 1`, e.g. WBTC) is not modeled anywhere — the mock always uses `collateralScale = 1`. The exact-fill check is precision-agnostic so I expect no bug, but it is unproven.

---

### F2 — Collateral donation griefs the aggregator takers' liveness (forced-balance DoS)

- **id:** AGG-2
- **title:** A 1-wei collateral transfer forces every subsequent aggregator take on that collateral to revert until the owner sweeps it
- **severity:** Low (griefing/liveness; fail-closed, no fund loss, recoverable)
- **confidence:** High (behavior is asserted as intended at `tests/integration/lifi-taker.test.ts:203-209`)
- **file:line:** `contracts/base/BaseAggregatorCalldataTaker.sol:132-134` (`StaleSourceBalance` requires `balanceOf == 0` pre-take) and `:274-277` (`UnexpectedSourceBalance` requires `balanceOf == amountInTokenUnits` in-callback).
- **property:** Liveness / griefing resistance. Exact-fill is enforced via *absolute balance equality*, so any externally-injected collateral breaks the equality.
- **actor/fund impact:** Any address, ~1 wei + gas, can block a specific aggregator-taker deployment from taking *any* auction on a given collateral token. Impact is the keeper's missed-liquidation opportunity cost (Dutch-auction windows decay / get taken by others), not protocol or user funds. The direct-DEX takers (`Uniswap/Curve`) are **not** affected — they measure quote deltas and ignore residual collateral.
- **source evidence:** `BaseAggregatorCalldataTaker.sol:132` rejects pre-take; even absent that outer guard, `:275` rejects in-callback. Recovery exists (`KeeperTakerBase.recover` / `TakerRouter.recoverFromTaker`) but is a *separate* transaction, so an attacker can re-donate after each sweep; there is no atomic recover-and-take.
- **minimal exploit sequence:** (1) read deployed taker address `T` and pool collateral `COLL`; (2) `COLL.transfer(T, 1)`; (3) keeper's `router.takeWithAtomicSwap(...)` reverts `StaleSourceBalance`, `takeCount` stays 0; (4) owner must `recover(COLL)` then retry; (5) attacker re-donates. Repeatable indefinitely at gas cost only.
- **required test/proof:** If the team accepts the trade-off, keep `lifi-taker.test.ts:203` and add an explicit comment that this is a known liveness/griefing surface. If liveness matters: switch to a **take-scoped collateral delta** — capture `balanceBefore` in `takeWithAtomicSwap`, require callback `balanceOf - balanceBefore == amountInTokenUnits` (donations get swept to owner by the existing `_settleAfterTake`, exact-fill preserved) — and add a donation-griefing regression asserting the take still succeeds with a pre-existing stray balance.
- **residual risk:** Workarounds blunt severity (owner can `recover`, run a direct-DEX taker, or redeploy), which is why this is Low rather than Medium. A delta-based fix would still not support fee-on-transfer/rebasing collateral.

---

## Highest-risk surfaces reviewed and found sound

- **Repayment / quote approval (`KeeperTakerBase.sol:102-105`, `BaseAggregatorCalldataTaker.sol:284-291`):** worst-case approval `ceilDiv(ceilWmul(maxAmount, auctionPrice), scale)` is provably ≥ the pool's ceil pull (monotone in a decreasing Dutch-auction price); backstop is `quoteReceived ≥ max(amountOutMinimum, due+ (scale>1?1:0))`, measured as a **delta** so pre-existing/donated quote cannot mask an underdelivering swap. Underflow on a quote-decreasing swap reverts (0.8 checked math). Verified.
- **Active-callback binding + reentrancy (`:135-146`, `:159-168`):** callback gated on `msg.sender == _activeCallbackPool` **and** `keccak256(data) == _activeCallbackDataHash`, plus `nonReentrant`, plus `_validatePool`. Out-of-band invocation (`lifi-taker.test.ts:464`), mutated callback bytes (`:521`), and reentrancy (`:603`) are all rejected. A direct `pool.take` with the taker as callee cannot use it as a swap conduit (binding unset → revert) — strictly stronger than the direct-DEX takers, which correctly rely on token re-binding + delta guard instead.
- **Allowlist enforcement (`:316-341`):** target ∈ `_callTargets`, `target.code.length > 0` (codeless no-op defense, `lifi-taker.test.ts:669`), spender ∈ `_approvalSpenders`, and **per-target** selector ∈ `_callSelectors`; `callData.length ≥ 4` precedes the assembly selector load so there is no OOB read. Opaque args are bounded by the collateral approval cap + quote backstop, so arbitrary args can't redirect funds (`:258`, `:316`, `:369`).
- **Approval hygiene / USDT (`KeeperTakerBase.sol:81-89`):** zero-first reset satisfies OZ `safeApprove`'s non-zero→non-zero guard; collateral approval reset to 0 immediately after the call (`:282`), quote approval reset in `_settleAfterTake`; the taker holds no funds between takes. Strict-approval token loop proven for the shared helper (`taker-hardening.test.ts:544`).
- **Access control (`:154-162`, `TakerRouter.sol:58-139`):** `onlyOwnerOrRouter` on takes/recover; router take is `onlyOwner`; `setTaker` validates owner/router/poolFactory parity and fails closed on the deprecated direct-Sushi slot (`TakerRouter.sol:64`). Unauthorized callers rejected (`lifi-taker.test.ts:737`).
- **Extraction fidelity:** `master:LifiKeeperTaker` inline logic == new base, check-for-check (constructor router/source guards added; `SourceNotConsumed` dead error dropped; `LifiSwapExecuted` → parameterized `AggregatorSwapExecuted`). No behavioral regression.

## Tests still required
- F1: aggregator-path `quoteTokenScale > 1` reject/accept/exact-divide cases (currently direct-DEX only).
- F2: a donation-griefing regression pinning the chosen behavior.
- Aggregator-path coverage for non-18-decimal **collateral** (`collateralScale > 1`) and a USDT-style **srcToken** approval (only the direct-DEX path tests the shared helper today).
- I could not execute the suite/`forge` (sandbox is read-only and, per environment notes, fork tests need network keys); F1/F2 rest on static tracing + test-file reading, not a green/red run.

## Residual risks (no fix required, document)
- **Fee-on-transfer / rebasing collateral:** unsupported, fail-closed via `:275` (received < `amountInTokenUnits`). FoT **quote** would break the pool's `transferFrom` pull — an ajna-core limitation, out of scope.
- **Exact-fill fragility:** debt-constrained or racing auctions where actual collateral ≠ off-chain `amountInTokenUnits` revert (`UnexpectedSourceBalance`); fail-closed, keeper retries with fresh sizing.
- **Malicious allowlisted target:** return-bomb / gas griefing and execution-quality skim down to `amountOutMinimum`/`ceilDue` are bounded by owner-set `amountOutMinimum` and the allowlist — owner configuration responsibility, no third-party fund risk.
- **ABI changes:** `LifiSwapExecuted`/`SwapExecuted` → `AggregatorSwapExecuted` and `authorizedFactory()` → `authorizedRouter()` — off-chain monitoring/integrators must update (intended; pinned by `lifi-taker.test.ts:47`).
