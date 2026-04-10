# Discovery Orchestration Refactor

## Goal

Reduce the discovery/runtime orchestration surface across `src/run.ts`, `src/discovery-targets.ts`, and `src/discovery-handlers.ts` without changing keeper behavior.

The target state is:

- `src/run.ts` owns loop cadence, crash recovery, and top-level control flow.
- `src/discovery-targets.ts` stays focused on candidate ranking, target resolution, validation, and pool hydration.
- `src/discovery-handlers.ts` stays focused on discovered action execution and gas-policy decisions.
- A dedicated runtime/scheduler boundary owns snapshot lifecycle, target assembly, cycle-scoped RPC caches, and discovered-target dispatch.

## Invariants

- Manual `take` still overrides discovered `take` for the same pool.
- Manual `settlement` still overrides discovered `settlement` for the same pool.
- `kick` stays manual.
- The shared in-memory liquidation snapshot still refreshes on the take cadence when discovered takes are enabled.
- Settlement-only discovery still refreshes on the slower settlement cadence.
- No config changes.
- No contract changes.
- No cadence changes.
- No policy changes.

## Current Boundary Problems

- `src/run.ts` currently owns loop timing and crash recovery, but also partially owns snapshot refresh, target assembly, RPC cache setup, pool resolution, and discovered-target dispatch.
- `src/discovery-targets.ts` is mostly pure target-building logic, but `run.ts` still has to know too much about how and when to feed it snapshot state.
- `src/discovery-handlers.ts` is focused on execution, but `run.ts` still duplicates some of the target-to-handler wiring that should be centralized.

## Refactor Phases

### Phase 1: Extract Runtime Boundary

Create `src/discovery-runtime.ts` and move these runtime-oriented concerns there:

- discovery snapshot state type
- take-cycle snapshot refresh decision
- settlement-cycle snapshot refresh decision
- snapshot refresh helper
- settlement interval helper
- target assembly helpers for take and settlement
- cycle-scoped RPC cache creation helpers
- discovered/manual pool resolution helper
- discovered/manual target dispatch helpers

This phase should be purely structural.

### Phase 2: Narrow run.ts

Update `src/run.ts` so that:

- `processTakeCycle()` asks the runtime layer for the take-cycle snapshot
- `processTakeCycle()` asks the runtime layer for the effective take targets
- `processTakeCycle()` asks the runtime layer for the shared RPC cache
- `processTakeCycle()` resolves and dispatches targets only through the runtime layer

Do the same for `processSettlementCycle()`.

After this phase, `run.ts` should primarily read as:

1. prepare cycle context
2. resolve effective targets
3. iterate targets
4. sleep / recover

### Phase 3: Follow-Up Cleanup

Once the extracted boundary is stable:

- consider whether `src/discovery-handlers.ts` should later split into `discovery-take-executor.ts` and `discovery-settlement-executor.ts`
- consider whether discovered target dispatch can be further unified behind an action registry
- leave `src/discovery-targets.ts` as the pure target-resolution layer unless behavior changes justify more movement

## Implementation Checklist

- [x] Add `src/discovery-runtime.ts`
- [x] Move snapshot lifecycle helpers out of `src/run.ts`
- [x] Move cycle target assembly helpers behind the runtime boundary
- [x] Move cycle-scoped RPC cache creation behind the runtime boundary
- [x] Move discovered/manual pool resolution behind the runtime boundary
- [x] Move discovered/manual target dispatch behind the runtime boundary
- [x] Update `src/run.ts` to consume the new runtime module
- [x] Keep unit coverage green in `src/unit-tests/discovery-runtime.test.ts`
- [x] Run full verification after the extraction

## Verification

Required commands after the refactor:

- `npm run unit-tests`
- `npm run integration-tests`
- `npx hardhat compile`
