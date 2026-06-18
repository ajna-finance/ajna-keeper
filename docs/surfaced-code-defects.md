# Surfaced Code Defects (from the no-spend coverage review)

These are **real code defects** in the keeper — distinct from the *coverage gaps* tracked in
[`no-spend-testing-plan.md`](./no-spend-testing-plan.md). They were surfaced as a side effect of the
coverage/assurance review (the review kept finding paths with no test, and several of those paths turned out
to be wrong, not merely untested), then **independently verified against the current code** by an adversarial
auditor that defaulted to "not a defect" unless the code proved otherwise. All six below were confirmed with
high confidence; severities were adjusted down from the reviewer's first framing where the code showed
mitigations.

None are fixed yet. Where a no-spend test packet is designed to *expose* the defect, it's noted — those tests
are expected to fail against current code until the defect is fixed (that failure is their assurance value).

| # | Sev | Defect | Location | Exposed by |
|---|-----|--------|----------|-----------|
| 1 | **High** | ✅ **FIXED** — Legacy reward swap dropped operator slippage + floored `minOut` to ~0.01% of input | `src/dex/uniswap.ts` | P0-5 |
| 2 | **Medium** | ✅ **FIXED** — Universal Router reward swap derived `amountOutMin` from the **input** amount, not a quote | `src/dex/universal-router.ts` | P0-5 |
| 3 | **Medium** | No process-level crash/shutdown guards (`unhandledRejection`/SIGTERM/`.catch`) | `src/index.ts:55`, `src/run.ts:307-322` | P1-3 |
| 4 | Low | Kick/Bond/LP loops lack the crash-recovery wrapper Take/Settlement have | `src/run.ts:420-461,497-525,644-758` | P1-3 |
| 5 | Low | Curve + Permit2 reward-swap approvals are `MaxUint256`, never reset | `src/dex/curve-router.ts:195-198`, `src/dex/universal-router.ts:160-163` | — |
| 6 | Low | Alchemy price-fallback `addressMap` omits Optimism (10) + Polygon (137) | `src/pricing/coingecko.ts:100-153` | P2-2 |

---

## 1. [HIGH] Legacy reward swap (`swapToWeth`) drops operator slippage and floors `amountOutMinimum` to 0.01% of input

**Where:** `src/dex/uniswap.ts` — `swapToWeth` (signature `:92-98`), hardcoded `const slippageTolerance = new Percent(50, 10000)` (`:217`), and the fallback `if (minOut.lte(constants.Zero)) { minOut = amount.div(10000) }` (`:222-223`) passed as `amountOutMinimum` (`:248`).

**What's wrong — two compounding issues:**
1. `swapToWeth` has **no slippage parameter**. The operator slippage is read (`action-tracker.ts:151-154`), forwarded through `DexRouter.swap` (`router.ts:652-660`), but the legacy branch (`router.ts:793-812`) calls `swapToWeth(...)` **without passing it** — so every legacy swap uses a hardcoded 0.5% regardless of config. (The `legacy?: UniswapV3Overrides` config block, `schema.ts:449-455`, has no slippage field either, so it can't be threaded through overrides.)
2. The `minOut = amount.div(10000)` fallback sets `amountOutMinimum` to **0.01% of the input amount** (and in input-token units), which is essentially no MEV/sandwich protection. It fires whenever the SDK-computed `minimumAmountOut` floors to ≤0 — plausible here because the pool is reconstructed from a single synthetic tick with zero liquidity (`uniswap.ts:181-199`), so the quote is unreliable for low-value / low-decimal reward tokens.

**Impact:** On the legacy Uniswap-V3 reward-swap path, collected reward tokens being swapped to WETH are exposed to near-total loss to MEV — a sandwich bot can extract almost the entire swap value and still satisfy the 0.01% floor. Operator funds (the keeper's harvested rewards) at risk. Triggers on every reward EXCHANGE action over the legacy path.

**Does NOT trigger when:** the full Universal Router path is configured (passes `slippage*100` correctly — but see defect #2); or the operator uses 1inch / Curve / LI.FI / Sushi; or the reward action is TRANSFER not EXCHANGE. The 0.5% hardcode is unconditional on the legacy path; the 0.01% floor additionally requires the SDK min-out to floor to ≤0.

**Suggested fix:** add a `slippage` param to `swapToWeth` and pass it from `router.ts:795`; compute `slippageTolerance` from it; **delete** the `amount.div(10000)` fallback — if the SDK min-out is ≤0, abort the swap rather than substituting a meaningless input-denominated floor. The floor must be output-token-denominated from a trustworthy quote.

---

## 2. [MEDIUM] Universal Router reward swap derives `amountOutMin` from the input amount, not a quote

**Where:** `src/dex/universal-router.ts:218-223` — `amountOutMin = amount.mul(floor((10000-slippageBps)/10000 * 10000)).div(10000)`, encoded as the `V3_SWAP_EXACT_IN` output floor (`:247-251`). No quoter/pool price call is made (only `factoryContract.getPool` for existence, `:132`, whose result is ignored for pricing).

**What's wrong:** `amount` is the **input**-token quantity, but `amountOutMin` is enforced against the **output** token. So the floor is in the wrong units/decimals and reflects no real price — the "0.5% slippage" guard is illusory. The legacy path (`uniswap.ts:201-220`) does it correctly via `pool.getOutputAmount → trade.minimumAmountOut(slippage)`, so the codebase already knows the right pattern. A code comment (`:218-219`) shows this was a deliberate "without quotes" shortcut, and the log line (`:228-230`) prints it as if it were an output estimate, masking the issue.

**Impact:** Reward-swap value leakage. When the input token is worth more than the output (or output has more decimals), `amountOutMin` sits far below fair value → exposed to sandwich/MEV or a thin pool returning much less than fair value. When reversed, an over-large floor reverts legitimate swaps, blocking reward conversion. Medium (not high) because it's rewards-only and the swap signer is the keeper. **This is the documented/default LP-rewards config** (`production_setup_guide.md:884-892`, the Avalanche/Hemi examples), so it's a common-path issue.

**Suggested fix:** quote the output first (the repo already has `quoteExactInputSingle` at `src/dex/providers/uniswap-quote-provider.ts:29`), then `amountOutMin = quotedOut * (10000-slippageBps)/10000`. If no quote is available, fail closed (skip the swap) rather than encoding an input-based pseudo-floor.

---

## 3. [MEDIUM] Keeper daemon installs no process-level crash/shutdown guards

**Where:** `src/index.ts:55` (entrypoint invoked as bare `main();` with no `.catch`); `src/run.ts:307-322` (`startKeeperFromConfig` launches five loops fire-and-forget, not awaited). Repo-wide grep for `process.on|SIGTERM|SIGINT|unhandledRejection|uncaughtException` across `src/` finds nothing but an unrelated `process.exit(1)` in `config/load.ts:33`.

**What's wrong:** No `SIGTERM`/`SIGINT` handler (no graceful shutdown); no `unhandledRejection`/`uncaughtException` handler; no top-level `.catch` on `main()`. Because the five loops aren't awaited, any rejection that escapes a loop becomes a process-level unhandled rejection with no handler. The most plausible entry point is `kickPoolsLoop` (`run.ts:427-430`), whose per-cycle path is **not** fully wrapped (the inner try in `processKickCycle` covers only `handleKicks`; the `getManualPools().filter` / `getAddressInsensitiveMapValue(...)!` / `delay` outside it are unguarded).

**Impact:** (1) On container stop / restart / Ctrl-C there is no graceful shutdown — in-flight take/settlement/kick txs and nonce bookkeeping (`src/nonce.ts`) are abandoned mid-flight, risking nonce gaps. (2) Under modern Node defaults an unhandled rejection terminates the daemon, halting all loops until an external supervisor restarts it (and if run without a supervisor, it stays down silently).

**Does NOT trigger when:** four of five loops wrap each cycle in try/catch with a recovery delay (so transient per-cycle errors don't crash them — the common case); or the keeper runs under a supervisor with a restart policy (masks the missing rejection guard, though abandoned-in-flight-tx on every restart remains). Medium because no direct fund loss — it's liveness/resilience.

**Suggested fix:** in `src/index.ts` add `main().catch(err => { logger.error(...); process.exit(1) })`, a `process.on('unhandledRejection', …)`, a `process.on('uncaughtException', …)`, and `SIGTERM`/`SIGINT` handlers (log + cooperative shutdown flag the loops check). Additionally wrap the `kickPoolsLoop` body in a per-cycle try/catch mirroring `runTakeLoopIteration`.

---

## 4. [LOW] Kick/Bond/LP loops lack the crash-recovery wrapper Take/Settlement have

**Where:** `src/run.ts` — Take has an outer wrapper (`runTakeLoopIteration:479-495`: `catch → logLoopCrash('Take') → recovered:true`), Settlement too (`:527-549`). Kick (`:420-461`), `collectBondLoop` (`:497-525`), and `collectLpRewardsLoop` (`:644-758`) wrap only their inner I/O calls, with **no outer while-body wrapper**.

**What's wrong:** an error escaping the inner try in the Kick/Bond/LP loops rejects that loop's un-awaited promise with no handler — the single loop dies permanently while the process and other loops keep running (silent partial outage: liquidations stop being kicked, or bonds/LP rewards stop being collected), with no auto-restart. Take/Settlement self-heal after `LOOP_CRASH_RECOVERY_DELAY_SECONDS`; the other three don't.

**Impact / why LOW:** the asymmetry is unambiguously real, but on current code the only statements *outside* the inner try in each of the three loops are synchronous pure helpers (`getManualPools().filter`, Map lookups, `normalizeAddress`) that don't throw in practice (the `!` non-null assertion is compile-time only — returns `undefined`, doesn't throw). So there's no clearly-reachable throw today; it's a defense-in-depth/symmetry deficiency that becomes live under an unexpected synchronous throw or a future refactor that adds awaited work to a loop body.

**Suggested fix:** extract the `logLoopCrash + delay` pattern into a shared `runLoopForever(name, iterationFn, delayFn)` and route all five loops through it, so every while-body is wrapped uniformly. Combine with the process-level `unhandledRejection` net from defect #3.

---

## 5. [LOW] Curve + Permit2 reward-swap approvals are `MaxUint256`, never reset

**Where:** `src/dex/curve-router.ts:195-198` (`approve(poolAddress, MaxUint256)`); `src/dex/universal-router.ts:160-163` (`approve(permit2Address, MaxUint256)`). Neither is reset to 0.

**What's wrong:** the keeper (hot) wallet holds a standing unlimited ERC20 allowance to the configured Curve pool and to canonical Permit2 for every token it has reward-swapped. (Note: the reviewer's blanket framing was an overstatement — the *other* two reward-swap paths approve the exact amount: `uniswap.ts:140` and the 1inch path `router.ts:737`; and the Permit2→router leg `universal-router.ts:198-203` is amount-bounded with a 24h expiry. The kick path's `clearAllowances` reset (`kick.ts:387-390`) targets the quote-token→pool bond allowance, a different surface.)

**Impact / why LOW:** residual attack surface, not an active loss — exploitable only if the trusted spender (Curve pool or Permit2) is later compromised, and only the hot keeper working balance is at risk. Under trusted/immutable spenders this is benign and matches common DeFi practice.

**Suggested fix:** approve `amount` instead of `MaxUint256` in `curve-router.ts:195-198` and `universal-router.ts:160-163` (matching the bounded `uniswap.ts:140` / `router.ts:737` pattern) — removes the standing-infinite surface at no extra gas. Optionally reset to 0 after each swap for full kick-path parity.

---

## 6. [LOW] Alchemy price-fallback `addressMap` omits Optimism (10) and Polygon (137)

**Where:** `src/pricing/coingecko.ts:100-153` — the built-in `addressMap` has only `1`, `8453`, `42161`, `43114`; `10` and `137` are absent. `getTokenAddress` returns `null` for an unmapped chain (`:155-158`), which throws "No token address mapping…" in `getPrice` (`:205-210`) and `getPoolPrice` (`:269-274`).

**What's wrong:** the 6 in-scope chains include 10 and 137 (`sushi-aggregator-policy.ts:16`), and `getAlchemyNetwork` (`alchemy.ts:22-37`) *does* map all six (`10: 'opt-mainnet'`, `137: 'polygon-mainnet'`) — so the Alchemy backend is intended to support OP/Polygon and the `addressMap` omission is an inconsistency, not an intentional scope limit.

**Impact:** on Optimism/Polygon, a pool with a CoinGecko-based price source throws from `getPrice` the moment the CoinGecko leg is unavailable (missing/placeholder key, outage, rate-limit) → the Alchemy fallback can't resolve the token address → kick evaluation for that pool aborts. Fails closed (throws, no mispricing). Low because there's a documented workaround (operator `tokenAddresses` override, checked first) and no fund risk.

**Suggested fix:** add `10` and `137` entries to the `addressMap` (canonical WETH/USDC/DAI/USDT/WBTC for those chains, mirroring the existing 42161/8453 entries), bringing it to parity with `getAlchemyNetwork`.

---

*Generated from an adversarial verification pass (6/6 confirmed) during the no-spend coverage review. The
reward-swap defects (#1, #2) are the highest priority — they put harvested operator funds at MEV risk on
common configs, and the documented LP-rewards setup uses the path with defect #2.*
