# TODOS

## Auto-Discovery

### Kick Auto-Discovery Behind Explicit Opt-In

**What:** Add chain-wide `kick` auto-discovery as a later feature behind an explicit opt-in flag and stronger safety policy.

**Why:** This completes the long-term "one keeper per chain" operator model, but it is intentionally deferred because `kick` creates new auctions and commits bond capital, so the blast radius is much higher than `take` or `settlement`.

**Context:** The current auto-discovery plan keeps `kick` manual in V1 on purpose. If V1 discovery for `take` and `settlement` proves reliable, the next logical step is to extend the shared discovery and policy pipeline to `kick`. Start from the central policy evaluator, resolved target validation, and detailed skip logging added for V1.

**Effort:** L
**Priority:** P2
**Depends on:** V1 auto-discovery for `take` and `settlement` shipping cleanly, plus operator feedback on false positives and false negatives

### Continue Discovery Orchestration Simplification

**What:** Continue shrinking the discovery/runtime orchestration surface now that `discovery-runtime.ts` owns snapshot lifecycle, cycle target assembly, cycle-scoped RPC caches, and target dispatch.

**Why:** The biggest maintainability win is already landed, but the discovery/runtime layer is still the largest remaining orchestration surface. The code is correct, though `run.ts`, `discovery-targets.ts`, `discovery-handlers.ts`, and `discovery-runtime.ts` can still be made easier to extend.

**Context:** The keeper now has:
- shared take processing in `take-engine.ts`
- action-specific discovery policy in `config-types.ts`
- a shared in-memory liquidation snapshot for discovered `take` and `settlement`
- a dedicated runtime boundary in `discovery-runtime.ts`

The next cleanup should keep behavior the same while further tightening ownership and reducing cross-file orchestration drift.

**Next Steps:**
- keep narrowing `run.ts` toward pure loop/control concerns
- decide whether `discovery-handlers.ts` should split by action executor
- keep target selection separate from action execution, but make the runtime interfaces smaller and more explicit
- reduce any remaining cross-file "discovered target -> handler" wiring that is still orchestration rather than policy

**Effort:** M
**Priority:** P1
**Depends on:** the extracted runtime boundary staying stable in tests and initial operator rollout

## Operational Hardening

### Harden RPC, Subgraph, and Submission Resilience

**What:** Improve runtime resilience around RPC providers, subgraph discovery, and transaction submission so the keeper degrades gracefully during upstream failures instead of merely being logically correct under healthy conditions.

**Why:** The biggest remaining live risk is no longer contract logic. It is operational dependency on RPC availability, subgraph freshness, quote quality, and public mempool behavior.

**Context:** Recent work reduced unnecessary external calls and improved caching, but the keeper still relies heavily on:
- RPC for hydration, quote reads, gas price, and onchain revalidation
- the subgraph for chain-wide discovery and manual pool scanning
- public submission paths unless operators layer in private routing themselves

**Next Steps:**
- support primary/fallback RPC and subgraph endpoints with explicit health/backoff behavior
- add better observability for stale discovery snapshots, repeated hydration failures, quote failures, and skipped actions
- add or formalize private relay / private RPC submission for take paths where MEV matters
- document recommended production thresholds and failure modes more explicitly for operators
- consider lightweight runtime metrics around quote rate, discovery lag, and execution success/failure reasons

**Effort:** M
**Priority:** P1
**Depends on:** preserving the current green test baseline while hardening live behavior

### Add Read-Path Endpoint Failover Without Write-Path Ambiguity

**What:** Introduce primary/fallback RPC and subgraph endpoints for read-heavy keeper operations, with bounded retries, timeouts, and simple health tracking.

**Why:** The keeper is now architecturally clean, but it still assumes a single healthy RPC and a single healthy subgraph. Read-path failover is the highest-value resilience improvement because discovery, hydration, and quote evaluation all depend on upstream availability.

**Context:** The main read-path touchpoints are:
- `provider.ts` and `utils.ts` for RPC connectivity and fee data
- `subgraph.ts` for manual and chain-wide discovery queries
- `discovery-runtime.ts` and `discovery-targets.ts` for cycle-level discovery refreshes

Keep this scoped to reads first. Transaction submission should not silently rotate across write endpoints until nonce and replacement behavior are intentionally designed.

**Next Steps:**
- define config for ordered read endpoints, health windows, and retry budgets
- wrap subgraph requests with timeout, retry, and endpoint rotation behavior
- add RPC read failover for gas, hydration, and revalidation reads
- expose clear logs when the keeper enters fallback mode and when the primary recovers

**Effort:** M
**Priority:** P1
**Depends on:** keeping write-path behavior explicit and unchanged during the first hardening pass

### Add Discovery and Execution Health Signals

**What:** Add cycle-level and action-level observability so operators can tell whether the keeper is healthy, degraded, or silently skipping work for environmental reasons.

**Why:** The current code is test-clean, but live debugging still depends too much on reading raw logs after the fact. Discovery lag, repeated hydrate failures, and quote-source instability should be visible as first-class signals.

**Context:** The best attachment points are:
- `discovery-runtime.ts` for per-cycle snapshot age, pages fetched, target counts, and consecutive cycle failures
- `discovery-handlers.ts` for quote failures, gas-policy skips, stale revalidation, and execution failures by liquidity source
- `run.ts` for loop-level degraded mode and crash recovery visibility

**Next Steps:**
- add counters or structured logs for discovery lag, failed refreshes, and skipped actions
- record repeated pool hydration failures and cooldown hits
- distinguish economic skips from infrastructure failures in logs and metrics
- document the expected operator response to each degraded-mode signal

**Effort:** M
**Priority:** P1
**Depends on:** the current discovery runtime boundary staying stable

### Separate Public Writes From Optional Private Submission

**What:** Formalize transaction submission so operators can choose between normal public writes and optional private submission for take flows where frontrun/MEV exposure matters.

**Why:** Read resilience and write resilience are different problems. The keeper should not conflate “fallback RPC for reads” with “send transactions anywhere.” Private submission is the cleaner next layer once read-path resilience is in place.

**Context:** The current keeper submission path is logically correct, but still effectively public from the keeper side. Profitable external takes are the most likely place where private submission meaningfully improves outcomes.

**Next Steps:**
- define an explicit write transport abstraction instead of piggybacking on read provider selection
- support opt-in private submission for take execution paths
- keep nonce handling and replacement policy explicit per write transport
- document operational caveats when private submission is unavailable or degraded

**Effort:** M
**Priority:** P2
**Depends on:** read-path resilience landing first and preserving current transaction semantics
