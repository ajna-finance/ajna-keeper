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
| P0-3 | Hybrid decision: all providers compete, winner selected, `competingProviders` roster | ✅ core done · 🟡 decision-matrix sub-cases remain |
| P0-4 | On-chain settlement assertion | ✅ core done · 🟡 multi-iteration/multi-auction remain |
| P0-5 | Reward-swap money-safety (defects #1/#2/#7) | ✅ fixed + fork-capture of the submitted `amountOutMinimum` (decoded from live calldata) |
| P1-1 | Full-lifecycle composition + keeper-kick | ✅ done |
| P1-2 | Promote real-Ajna + real-DEX fork tests to first-class | ⬜ not started |
| P1-3 | Daemon lifecycle & resilience (defects #3/#4) | ✅ persistent-daemon multi-cycle + discovery + idempotency + SIGTERM + gas-spike skip + read-RPC cooldown/recovery done · 🟡 fork-level crash-injection / degraded-mode / nonce-mid-broadcast remain |
| P1-4 | Reward-collection & bond-withdrawal loops | 🟡 LP-sweep principal-preservation (found+fixed defect #9) + bond-withdrawal done · LP reactive-settlement retry remains |
| P2-1 | Token/subgraph realism + `verify:routes` canary | ✅ non-18-decimal ceiling + multi-auction enumeration/handling done · 🟡 fee-on-transfer + `verify:routes` canary remain |
| P2-2 | Price sourcing, inversion & multi-chain config (defect #6) | 🟡 defect fixed + unit-guarded · price/inversion scenarios remain |

✅ = implemented & fork-validated 🟡 = partially done (core or defect done; sub-cases remain) ⬜ = not started

---

## Remaining gaps, by priority

### High value

1. **Daemon failure-injection sub-cases (`P1-3`).** ✅ *The persistent-daemon happy path is done* —
   `--daemon-lifecycle-only` runs the real long-lived keeper across ≥2 cycles, proves real-subgraph discovery +
   action + cross-cycle idempotency + clean SIGTERM (validated: 3 cycles / 1 take / idempotent / exit 0). What
   remains is **failure injection**: a throw that *escapes* `runTakeCycle` for one cycle (assert recovery + next
   cycle runs) bound across **all five** loops as `loopCrashRecovery:{take,settlement,kick,collectBond,
   collectLpRewards}`; read-RPC failover; degraded-mode continuity (keep taking on cached data during a
   subgraph outage); gas-spike skip; and nonce consistency when SIGTERM lands mid-broadcast. The two crash
   wrappers are already unit-covered (`loop-crash-recovery.test.ts`); these are the fork-level scenarios.
   **Catches:** silent permanent loop death, ungraceful shutdown, and unsafe degradation under infra failure.
2. **Reward-collection & bond-withdrawal money-safety (`P1-4`).** ✅ *Mostly done.* The
   **LP-redemption-never-burns-principal** invariant is covered (`tests/integration/collect-lp.test.ts`) and
   **found + fixed defect #9** (the sweep redeemed the full position, not the tracked reward). **Bond
   withdrawal** is covered too (`AJNA_AGENT_NO_SPEND_BOND_WITHDRAWAL=1`): after settlement unlocks the keeper's
   kick bond, a dry-run withdraws nothing and a real `collectBondFromPool` pays the keeper exactly the bond
   (`claimable → 0`, balance up — validated). Remaining: LP-sweep → reactive-settlement retry on
   `AuctionNotCleared` (lower value). **Catches:** the settlement-retry redemption path.
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
7. **Decision-matrix sub-cases (`P0-3`).** With injected quotes, exercise the *deciding* branches:
   subsidy-vs-profit tiebreak, profit-floor rejection (all-sub-floor leg executes **zero** takes), circuit-open,
   and execution-fallback (primary fails → fallback candidate). **Catches:** mis-ranking and fail-open in the
   selection policy.
8. ✅ **DONE — Multi-auction discovery + handling (`P2-1`).** Enumeration/dedup of multiple auctions into one
   target's candidates is covered (`discovery-targets.test.ts`), and the executor now has explicit coverage that
   it takes BOTH auctions of a multi-candidate target when `maxExecutions=2` and stops at one when
   `maxExecutions=1` (`external-take-reapproval.test.ts`). Remaining (lower value): multi-*pool* fixture realism.
9. **Promote real-route fork tests to first-class (`P1-2`).** Named npm scripts for the LI.FI/Sushi/Curve
   route canaries (real egress, still fund-free), config-derived whales/blocks with skip-on-drift. **Catches:**
   real aggregator API/route drift that the injected-quote path can't see. (1inch documented as skip-on-401.)
10. **Price sourcing & inversion (`P2-2`).** Defect #6 (multi-chain address map) is fixed; remaining is the
    mock CoinGecko/Alchemy fetch→parse→**fallback** scenario, `price.invert`, and POOL-reference pricing.
    **Catches:** mispricing / fail-closed gaps that gate every kick/take.

### Lower value

11. **Settlement sub-cases (`P0-4`).** Multi-iteration/partial-settle, multi-auction + dedup,
    `checkBotIncentive` negative, dry-run parity leg.
12. **Token realism (`P2-1`).** ✅ *Non-18-decimal ceiling done* — the `quoteAmountDueCeiling` +1-wei backstop
    is unit-pinned for a 6-decimal quote token (`quote-amount-due-ceiling.test.ts`). Remaining: a
    fee-on-transfer collateral token.
13. **Negative-take / partial-fill (`P0-3`, `P1-1`).** A reverting take through the real keeper failure path;
    partial-fill + mixed-availability sub-cases.
14. **Private/relay take transports (`P1-3`).** Only public-RPC transport is exercised; `PRIVATE_RPC`/`RELAY`
    (Flashbots-style) are not driven.
15. **Real keystore signer in the primary flow.** The main flow uses a raw key env; only `daemon-smoke`
    exercises encrypted-keystore + password-file decryption.

---

## Open code defect (not a coverage gap)

One **surfaced defect remains unfixed**: **#5 — Curve + Permit2 reward-swap approvals are `MaxUint256`,
never reset** (low; trusted spenders). See [`surfaced-code-defects.md`](./surfaced-code-defects.md). All other
surfaced defects (#1–#4, #6, #7, #8, #9) are fixed.
