# No-Spend Testing — Coverage Gaps & Fidelity

A crisp tracker of what the no-spend test suite **does and does not** exercise, and the prioritized
backlog of remaining gaps. The full design for each item lives in
[`no-spend-testing-plan.md`](./no-spend-testing-plan.md) (referenced by packet ID, e.g. `P1-3`); the
real-but-fixed code defects surfaced along the way live in
[`surfaced-code-defects.md`](./surfaced-code-defects.md). This file is the at-a-glance index — it links to
those for detail rather than restating it.

---

## What the test actually is (fidelity boundary)

**It is a driven-handler harness, not a real running keeper.** `npm run no-spend-validation` spawns
`scripts/run-fixture-keeper-harness.ts`, which calls the **real production handlers** — `handleKicks`,
`handleDiscoveredTakeTarget`, `handleTakes`, `handleSettlements` — **once each**, against a synthetic
mock-token Ajna pool on a pinned Base fork (block `30000000`). It never starts the long-lived daemon
(`src/index.ts main` / `startKeeperFromConfig`) and never runs the timer-driven polling loops.

What this means concretely:

| Aspect | Real (production code runs) | Simulated / not exercised |
|---|---|---|
| **Decision + execution** | ✅ route ranking, gas policy, approval, kick, take, settlement — all genuine `src/` code, real on-chain txs + receipts, strong invariant assertions | — |
| **Discovery / "finding work"** | the handler consumes the candidate verbatim | ❌ the keeper is **handed** the exact pool/borrower the fixture made (`buildDiscoveredTakeTarget` builds a single hard-coded candidate); the real chainwide subgraph **enumeration** (`getChainwideLiquidationAuctionsShared` → `buildDiscoveredTakeTargets`) is bypassed |
| **Subgraph** | gated on real on-chain `auctionInfo`/`getLiquidation` reads | ❌ in-process fake (`makeFixtureSubgraphReader`) returning the one fixture borrower; no live Graph query, pagination, `_meta` freshness, or `fallbackUrls` failover |
| **Aggregator quotes** | real probe → rank → execute calldata path | ❌ the off-chain LI.FI/Sushi/1inch quote is **injected** against a pre-funded `MockLifiSwapTarget`; the live 1inch circuit is force-disabled |
| **Daemon lifecycle** | — | ❌ no persistent process, no `while(true)` loops, no `delayBetweenRuns` cadence, no multi-cycle, no crash-recovery restart, no SIGTERM/SIGINT graceful shutdown, no cross-cycle nonce/dedup |
| **Time** | real auction-state reads | ❌ `evm_increaseTime` warps into the take window; real wall-clock decay is not waited on |

**One exception:** the optional `--run-daemon-smoke` leg *does* launch the real entrypoint in `--run-once`
mode through the real enumeration code — but against an HTTP **subgraph stub** that always returns the single
fixture auction. So even there, multi-pool/multi-cycle/long-running behavior is not proven.

**Net:** the suite faithfully proves the **take/kick/settlement execution mechanics are real and
no-spend-safe**; the **discovery/enumeration and long-running daemon orchestration are simulated.** Closing
that second half is what most of the remaining backlog below is about.

---

## Packet status at a glance

| Packet | Scope | Status |
|---|---|---|
| P0-1 | Harness reliability (fork pin) | ✅ done |
| P0-2 | Real aggregator calldata-take via mock target | ✅ done |
| P0-3 | Hybrid decision: all providers compete, winner selected, `competingProviders` roster | ✅ core done · 🟡 decision-matrix sub-cases remain |
| P0-4 | On-chain settlement assertion | ✅ core done · 🟡 multi-iteration/multi-auction remain |
| P0-5 | Reward-swap money-safety (defects #1/#2/#7) | ✅ fixed · 🟡 fork-capture of submitted `amountOutMinimum` remains |
| P1-1 | Full-lifecycle composition + keeper-kick | ✅ done |
| P1-2 | Promote real-Ajna + real-DEX fork tests to first-class | ⬜ not started |
| P1-3 | Daemon lifecycle & resilience (defects #3/#4) | 🟡 defects fixed + unit-guarded · daemon scenarios remain |
| P1-4 | Reward-collection & bond-withdrawal loops | ⬜ not started |
| P2-1 | Token/subgraph realism + `verify:routes` canary | ⬜ not started |
| P2-2 | Price sourcing, inversion & multi-chain config (defect #6) | 🟡 defect fixed + unit-guarded · price/inversion scenarios remain |

✅ = implemented & fork-validated 🟡 = partially done (core or defect done; sub-cases remain) ⬜ = not started

---

## Remaining gaps, by priority

### High value

1. **Daemon multi-cycle + crash-recovery + SIGTERM (`P1-3`).** The single biggest fidelity gap. The
   production entrypoint launches five infinite loops; today only a single `--run-once` cycle is ever proven.
   Spawn the real persistent entrypoint against the fixture, run ≥2 cycles, inject a throw that *escapes*
   `runTakeCycle`, and assert `runResilientLoopIteration` returns `{recovered:true, delaySeconds:30}` and the
   next cycle runs. **Catches:** silent permanent loop death and ungraceful shutdown (the defect class of #3/#4
   — now fixed, but unproven at the loop level). Bind a `loopCrashRecovery:{take,settlement,kick,collectBond,
   collectLpRewards}` artifact across **all five** loops.
2. **Reward-collection & bond-withdrawal money-safety (`P1-4`).** Fund-moving paths with **zero** no-spend
   coverage (explicitly excluded by `daemon-smoke`). The load-bearing one: **LP redemption must never burn
   lender principal** — feed an inflated/stale BucketTake reward and assert post-sweep
   `lpBalance >= principalLp`. Plus reactive-settlement-retry on `AuctionNotCleared`, and bond withdrawal
   (`claimable → 0`, balance up). **Catches:** principal-burning LP bugs and stuck-bond/withdrawal bugs.
3. **Multi-cycle idempotency / no duplicate action (`P1-3`).** After cycle 1 takes/kicks, assert cycle 2
   (same state) submits **zero** additional keeper txs; optional SIGTERM-then-restart variant. **Catches:**
   double-spend / re-action on an already-actioned auction across cycles or restart.

### Medium value

4. **Fork-capture of the submitted `amountOutMinimum` (`P0-5`).** The reward-swap defects (#1/#2/#7) are fixed
   and unit-guarded, but a fork-level assertion that the *actually submitted* swap floor matches a real quote
   would be the strongest regression guard at the real call sites. **Catches:** a future regression that
   re-introduces an input-denominated or near-zero floor.
5. **Read-RPC failover & degraded-mode continuity (`P1-3`).** Two `readRpcUrls` with the first dead → failover
   keeps producing gas prices; and a subgraph outage within the snapshot-freshness window → keeper keeps
   taking on cached data (`snapshotFallbackUsed===true`). **Catches:** liveness loss on transient
   infra failure.
6. **Gas-spike skip (`P1-3`).** One cycle with the gas cap below the fork's real gas cost → route artifact
   records `native_gas_cost_above_cap`, zero take txs, loop survives. **Catches:** the keeper spending into an
   unprofitable gas environment.
7. **Decision-matrix sub-cases (`P0-3`).** With injected quotes, exercise the *deciding* branches:
   subsidy-vs-profit tiebreak, profit-floor rejection (all-sub-floor leg executes **zero** takes), circuit-open,
   and execution-fallback (primary fails → fallback candidate). **Catches:** mis-ranking and fail-open in the
   selection policy.
8. **Multi-pool / multi-auction discovery realism (`P2-1`, `P1-3`).** Extend the subgraph stub to return
   multiple auctions so `resolveTakeCycleTargets`/`findSettleableAuctions` enumerate more than one — the only
   place real pagination/dedup gets exercised. **Catches:** enumeration, target-dedup, and hot-auction TTL bugs.
9. **Promote real-route fork tests to first-class (`P1-2`).** Named npm scripts for the LI.FI/Sushi/Curve
   route canaries (real egress, still fund-free), config-derived whales/blocks with skip-on-drift. **Catches:**
   real aggregator API/route drift that the injected-quote path can't see. (1inch documented as skip-on-401.)
10. **Price sourcing & inversion (`P2-2`).** Defect #6 (multi-chain address map) is fixed; remaining is the
    mock CoinGecko/Alchemy fetch→parse→**fallback** scenario, `price.invert`, and POOL-reference pricing.
    **Catches:** mispricing / fail-closed gaps that gate every kick/take.

### Lower value

11. **Settlement sub-cases (`P0-4`).** Multi-iteration/partial-settle, multi-auction + dedup,
    `checkBotIncentive` negative, dry-run parity leg.
12. **Token realism (`P2-1`).** 6-decimal quote token (exercises the `quoteAmountDueCeiling` +1-wei ceiling)
    and a fee-on-transfer collateral token. **Catches:** the non-18-decimal / fee-on-transfer bug class.
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
surfaced defects (#1–#4, #6, #7, #8) are fixed.
