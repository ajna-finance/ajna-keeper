# No-Spend Testing — Coverage Gaps & Fidelity

A crisp tracker of what the no-spend test suite **does and does not** exercise, and the prioritized
backlog of remaining gaps. The full design for each item lives in
[`no-spend-testing-plan.md`](./no-spend-testing-plan.md) (referenced by packet ID, e.g. `P1-3`); the
real-but-fixed code defects surfaced along the way live in
[`surfaced-code-defects.md`](./surfaced-code-defects.md). This file is the at-a-glance index — it links to
those for detail rather than restating it.

---

## What the test actually is (fidelity boundary)

**The primary flow is a driven-handler harness; a dedicated lifecycle scenario now also runs the real
daemon.** `npm run no-spend-validation` spawns `scripts/run-fixture-keeper-harness.ts`, which calls the
**real production handlers** — `handleKicks`, `handleDiscoveredTakeTarget`, `handleTakes`,
`handleSettlements` — **once each**, against a synthetic mock-token Ajna pool on a pinned Base fork (block
`30000000`). Separately, the **`--daemon-lifecycle-only` scenario (P1-3)** *does* start the long-lived daemon
(`src/index.ts` / `startKeeperFromConfig`) with its timer loops, proving it discovers via the real subgraph
enumeration, takes, stays idempotent across cycles, and shuts down cleanly on SIGTERM (see the status table).
The remaining daemon gaps are the failure-injection sub-cases, not the happy-path lifecycle.

What this means concretely:

| Aspect | Real (production code runs) | Simulated / not exercised |
|---|---|---|
| **Decision + execution** | ✅ route ranking, gas policy, approval, kick, take, settlement — all genuine `src/` code, real on-chain txs + receipts, strong invariant assertions | — |
| **Discovery / "finding work"** | the handler consumes the candidate verbatim | ❌ the keeper is **handed** the exact pool/borrower the fixture made (`buildDiscoveredTakeTarget` builds a single hard-coded candidate); the real chainwide subgraph **enumeration** (`getChainwideLiquidationAuctionsShared` → `buildDiscoveredTakeTargets`) is bypassed |
| **Subgraph** | gated on real on-chain `auctionInfo`/`getLiquidation` reads | ❌ in-process fake (`makeFixtureSubgraphReader`) returning the one fixture borrower; no live Graph query, pagination, `_meta` freshness, or `fallbackUrls` failover |
| **Aggregator quotes** | real probe → rank → execute calldata path | ❌ the off-chain LI.FI/Sushi/1inch quote is **injected** against a pre-funded `MockLifiSwapTarget`; the live 1inch circuit is force-disabled |
| **Daemon lifecycle** | ✅ (lifecycle scenario) persistent process, `while(true)` loops, `delayBetweenRuns` cadence, multi-cycle, real-subgraph discovery, cross-cycle idempotency, SIGTERM graceful shutdown | ❌ still: fork-level crash-injection across all 5 loops, read-RPC failover, degraded-mode continuity, gas-spike skip, nonce-consistency during a SIGTERM mid-broadcast |
| **Time** | real auction-state reads | ❌ `evm_increaseTime` warps into the take window; real wall-clock decay is not waited on |

**Two daemon legs use the real entrypoint** (both against an HTTP **subgraph stub** returning the single
fixture auction): `--run-daemon-smoke` runs one `--run-once` cycle; `--daemon-lifecycle-only` (P1-3) runs the
**persistent** daemon across multiple cycles with SIGTERM teardown. Multi-*pool* enumeration is still not
exercised (the stub returns one auction).

**Net:** the suite faithfully proves the **take/kick/settlement execution mechanics are real and
no-spend-safe**, and the **happy-path long-running daemon now genuinely discovers + acts + shuts down
cleanly**. What remains simulated/uncovered: multi-pool enumeration realism and the daemon **failure-injection**
sub-cases (gas-spike skip and read-RPC cooldown/recovery are now covered; fork-level crash-injection,
degraded-mode, and nonce-during-broadcast remain).

---

## Packet status at a glance

| Packet | Scope | Status |
|---|---|---|
| P0-1 | Harness reliability (fork pin) | ✅ done |
| P0-2 | Real aggregator calldata-take via mock target | ✅ done |
| P0-3 | Hybrid decision: all providers compete, winner selected, `competingProviders` roster | ✅ core + decision-matrix (all-rejected→no-take, subsidy precedence, profit-floor, circuit recording/skip) done · execution-fallback stats-tracked |
| P0-4 | On-chain settlement assertion | ✅ core done · 🟡 multi-iteration/multi-auction remain |
| P0-5 | Reward-swap money-safety (defects #1/#2/#7) | ✅ fixed + fork-capture of the submitted `amountOutMinimum` (decoded from live calldata) |
| P1-1 | Full-lifecycle composition + keeper-kick | ✅ done |
| P1-2 | Promote real-Ajna + real-DEX fork tests to first-class | ⬜ not started |
| P1-3 | Daemon lifecycle & resilience (defects #3/#4) | ✅ persistent-daemon multi-cycle + discovery + idempotency + SIGTERM + gas-spike skip + read-RPC cooldown/recovery done · 🟡 fork-level crash-injection / degraded-mode / nonce-mid-broadcast remain |
| P1-4 | Reward-collection & bond-withdrawal loops | 🟡 LP-sweep principal-preservation (found+fixed defect #9) + bond-withdrawal done · LP reactive-settlement retry remains |
| P2-1 | Token/subgraph realism + `verify:routes` canary | ✅ non-18-decimal ceiling + multi-auction enumeration/handling done · 🟡 fee-on-transfer + `verify:routes` canary remain |
| P2-2 | Price sourcing, inversion & multi-chain config (defect #6) | ✅ defect fixed + invert/FIXED/POOL dispatch + CoinGecko→Alchemy fallback + fail-closed covered |

✅ = implemented & fork-validated 🟡 = partially done (core or defect done; sub-cases remain) ⬜ = not started

---

## Remaining gaps, by priority

### High value

1. **Daemon failure-injection sub-cases (`P1-3`).** ✅ *Substantially done.* Persistent-daemon happy path
   (3 cycles / discovery / idempotency / SIGTERM), **gas-spike skip**, and **read-RPC cooldown/recovery** are
   done; the five loops' crash-recovery wrappers are unit-covered (`loop-crash-recovery.test.ts`) and
   **degraded-mode continuity** (keep acting on the cached snapshot through a subgraph-refresh failure) is
   covered by `discovery-runtime.test.ts` (10+ snapshot-freshness / fallback tests, incl. "continues manual
   take targets when snapshot refresh fails"). Remaining (thin): a single fork-level scenario that injects a
   throw *escaping* `runTakeCycle` and asserts the live daemon re-enters, plus nonce-consistency when SIGTERM
   lands mid-broadcast.
2. **Reward-collection & bond-withdrawal money-safety (`P1-4`).** ✅ *Done.* The
   **LP-redemption-never-burns-principal** invariant is covered (`tests/integration/collect-lp.test.ts`) and
   **found + fixed defect #9** (the sweep redeemed the full position, not the tracked reward). **Bond
   withdrawal** is covered too (`AJNA_AGENT_NO_SPEND_BOND_WITHDRAWAL=1`): after settlement unlocks the keeper's
   kick bond, a dry-run withdraws nothing and a real `collectBondFromPool` pays the keeper exactly the bond
   (`claimable → 0`, balance up — validated). The LP-sweep → reactive-settlement retry on `AuctionNotCleared`
   is covered by `settlement.test.ts:272`.
3. **Multi-cycle idempotency / no duplicate action (`P1-3`).** After cycle 1 takes/kicks, assert cycle 2
   (same state) submits **zero** additional keeper txs; optional SIGTERM-then-restart variant. **Catches:**
   double-spend / re-action on an already-actioned auction across cycles or restart.

### Medium value

4. ✅ **DONE — Fork-capture of the submitted `amountOutMinimum` (`P0-5`).** A real `swapToWeth` on the mainnet
   fork now has its live `exactInputSingle` calldata decoded and the submitted floor asserted to be ≥90% of the
   realized WETH output (quote-derived, in output units) — pinning the fix at the real call site against a
   re-introduced input-denominated / near-zero floor (`tests/integration/uniswap.test.ts`).
5. **Read-RPC failover & degraded-mode continuity (`P1-3`).** ✅ *Failover + cooldown/recovery done* — the
   endpoint health state machine (3-failure threshold → 30s cooldown deprioritization → retry after the window)
   is unit-pinned (`tests/unit/endpoint-health.test.ts`), on top of the existing single-failure failover.
   Remaining: degraded-mode continuity (keep taking on cached data through a subgraph outage,
   `snapshotFallbackUsed===true`).
6. ✅ **DONE — Gas-spike skip (`P1-3`).** A persistent-daemon leg with a tiny `maxGasCostNative` proves the
   keeper still discovers the auction each cycle but the gas policy rejects every take → **zero** broadcasts,
   loop survives ≥2 cycles, clean SIGTERM (`daemon-smoke.mjs` `runDaemonLifecycle` gas-spike leg).
7. ✅ **DONE — Decision-matrix sub-cases (`P0-3`).** Subsidy-vs-profit precedence
   (`hybrid-external-take-selection.test.ts`), profit-floor rejection at the policy level
   (`external-take-policy.test.ts`), circuit recording/skip (`hybrid-external-take-probes.test.ts`,
   `one-inch-circuit.test.ts`), and the hybrid **all-rejected → zero-takes** money-safety invariant
   (`hybrid-external-take-probes.test.ts`, added this round) are covered. Execution-fallback (primary fails →
   fallback candidate) is stats-tracked (`hybridFallbackAttempts/Successes`) + integration-exercised; a focused
   unit test of `executeHybridExternalTakeForDiscovery` remains the only thin sliver (deep internal helpers).
8. ✅ **DONE — Multi-auction discovery + handling (`P2-1`).** Enumeration/dedup of multiple auctions into one
   target's candidates is covered (`discovery-targets.test.ts`), and the executor now has explicit coverage that
   it takes BOTH auctions of a multi-candidate target when `maxExecutions=2` and stops at one when
   `maxExecutions=1` (`external-take-reapproval.test.ts`). Remaining (lower value): multi-*pool* fixture realism.
9. **Promote real-route fork tests to first-class (`P1-2`).** Named npm scripts for the LI.FI/Sushi/Curve
   route canaries (real egress, still fund-free), config-derived whales/blocks with skip-on-drift. **Catches:**
   real aggregator API/route drift that the injected-quote path can't see. (1inch documented as skip-on-401.)
10. ✅ **DONE — Price sourcing & inversion (`P2-2`).** Defect #6 (multi-chain address map) fixed; the
    `invert`/FIXED/POOL dispatch + zero-guard + POOL fail-closed (`get-price-invert.test.ts`) and the
    CoinGecko→Alchemy **fallback** + fail-closed (`coingecko-fallback.test.ts`) are covered;
    `getPoolPrice` references + `getTokenAddress` were already covered.

### Lower value

11. ✅ **Already covered — Settlement sub-cases (`P0-4`).** `settlement.test.ts` covers reactive settlement on
    `AuctionNotCleared` (`:272`), bond unlock through settlement (`:348`), `checkBotIncentive` gating (`:539`),
    and iteration/bucket-depth limits (`:582`). Thin remaining: a dry-run tx-count parity leg.
12. **Token realism (`P2-1`).** ✅ *Non-18-decimal ceiling done* (`quote-amount-due-ceiling.test.ts`).
    Fee-on-transfer is **handled by the on-chain exact-fill backstop** — a transfer-fee swap shortfall reverts
    the take (`lifi-taker.test.ts` "reverts when LI.FI underdelivers below the approved floor" / "misses quote
    due") and donations are swept (`:203`). A dedicated fee-on-transfer *fixture* remains (lower value).
13. ✅ **Already covered — Negative-take.** The reverting/failed-take path is classified and handled:
    pre-broadcast vs accepted-then-failed and nonce-consumed semantics (`take-write-submission.test.ts`
    `:734-779`, `write-transport.ts`).
14. ✅ **Already covered — Private/relay take transports.** PUBLIC/PRIVATE/RELAY mode selection + submission +
    durable nonce floors are covered (`take-write-transport.test.ts` `:39/:53/:73/:249/:324`).
15. ✅ **Already covered — Keystore signer.** Keystore decryption (incl. fail-closed on bad/missing password)
    is covered (`run.test.ts` / `getProviderAndSigner`; "throws when keystore decryption fails instead of
    returning a random wallet").

---

## Open code defect (not a coverage gap)

One **surfaced defect remains unfixed**: **#5 — Curve + Permit2 reward-swap approvals are `MaxUint256`,
never reset** (low; trusted spenders). See [`surfaced-code-defects.md`](./surfaced-code-defects.md). All other
surfaced defects (#1–#4, #6, #7, #8, #9) are fixed.
