# TODOS

## Auto-Discovery

### Kick Auto-Discovery Behind Explicit Opt-In

**What:** Add chain-wide `kick` auto-discovery as a later feature behind an explicit opt-in flag and stronger safety policy.

**Why:** This completes the long-term "one keeper per chain" operator model, but it is intentionally deferred because `kick` creates new auctions and commits bond capital, so the blast radius is much higher than `take` or `settlement`.

**Context:** The current auto-discovery plan keeps `kick` manual in V1 on purpose. If V1 discovery for `take` and `settlement` proves reliable, the next logical step is to extend the shared discovery and policy pipeline to `kick`. Start from the central policy evaluator, resolved target validation, and detailed skip logging added for V1.

**Effort:** L
**Priority:** P2
**Depends on:** V1 auto-discovery for `take` and `settlement` shipping cleanly, plus operator feedback on false positives and false negatives

## Take Flow Cleanup

### Finish Strategy-Level Take Cleanup After Shared arbTake Unification

**What:** Complete the remaining take-flow cleanup by renaming the misleading legacy handler and collapsing external-take orchestration onto a smaller strategy surface.

**Why:** `arbTake` is now shared, but the take system still has a misleading `handleTakesWith1inch` name and separate manual/discovered external-take orchestration layers. That is a maintainability risk even though the runtime behavior is currently correct.

**Context:** The current take architecture is functionally sound:
- per-pool routing chooses legacy 1inch vs factory multi-DEX vs arb-only
- shared `arbTake` logic now covers manual, factory, and discovered flows
- the remaining cleanup is mostly naming and orchestration shape, not protocol behavior

**Next Steps:**
- rename `handleTakesWith1inch` to reflect that it also handles arb-only fallback
- introduce a shared external-take strategy interface so manual and discovered flows stop branching on liquidity source in multiple places

**Effort:** M
**Priority:** P2
**Depends on:** current take refactor settling cleanly in tests and production rollout
