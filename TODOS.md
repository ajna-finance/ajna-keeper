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

**Why:** The biggest maintainability win is already landed, but the discovery/runtime layer is still the largest remaining orchestration surface. The code is correct, though `run.ts`, `auto-discovery.ts`, `auto-discovery-handlers.ts`, and `discovery-runtime.ts` can still be made easier to extend.

**Context:** The keeper now has:
- shared take processing in `take-engine.ts`
- action-specific discovery policy in `config-types.ts`
- a shared in-memory liquidation snapshot for discovered `take` and `settlement`
- a dedicated runtime boundary in `discovery-runtime.ts`

The next cleanup should keep behavior the same while further tightening ownership and reducing cross-file orchestration drift.

**Next Steps:**
- keep narrowing `run.ts` toward pure loop/control concerns
- decide whether `auto-discovery-handlers.ts` should split by action executor
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
