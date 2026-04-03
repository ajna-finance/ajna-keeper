# TODOS

## Auto-Discovery

### Kick Auto-Discovery Behind Explicit Opt-In

**What:** Add chain-wide `kick` auto-discovery as a later feature behind an explicit opt-in flag and stronger safety policy.

**Why:** This completes the long-term "one keeper per chain" operator model, but it is intentionally deferred because `kick` creates new auctions and commits bond capital, so the blast radius is much higher than `take` or `settlement`.

**Context:** The current auto-discovery plan keeps `kick` manual in V1 on purpose. If V1 discovery for `take` and `settlement` proves reliable, the next logical step is to extend the shared discovery and policy pipeline to `kick`. Start from the central policy evaluator, resolved target validation, and detailed skip logging added for V1.

**Effort:** L
**Priority:** P2
**Depends on:** V1 auto-discovery for `take` and `settlement` shipping cleanly, plus operator feedback on false positives and false negatives
