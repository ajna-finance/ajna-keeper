# Sushi Aggregator Packet 1: Remove Direct Sushi

## Purpose

Remove active direct Sushi support in one deletion-focused PR. Do not
hard-disable it by scattering `SUSHISWAP` rejection branches through already-large
shared files. The desired shape is that Sushi disappears from supported
registries and types first, then compile errors drive deletion of unreachable
code.

Packet 0 must land first so the hot-file checker exists before this packet
touches `scripts/deploy-factory-system.ts` or other roadmap hot files.

## Implementation

- Reserve the old enum value and add a new-factory guard for source id `3`.
- Remove Sushi from the canonical external-take registry
  (`src/config/external-take-registry.ts`):
  - `FactoryLiquiditySource`
  - `FACTORY_DYNAMIC_SOURCES`
  - `SUPPORTED_EXTERNAL_TAKE_LIQUIDITY_SOURCES`
  - `EXTERNAL_TAKE_LIQUIDITY_SOURCE_DESCRIPTORS`
- Remove Sushi from post-auction reward-swap enums and validation:
  - `PostAuctionDex.SUSHISWAP`
  - direct Sushi reward-swap validation
  - `dex.sushiswap` examples and docs
- After the merged-test migration below is complete, let type errors drive
  cleanup in factory route selection, validation, preflight, discovery config
  plumbing, gas conversion, reward swaps, deployment scripts, docs, examples,
  and tests. Type errors alone are not sufficient: several merged-test
  breakages are runtime failures or assertion contradictions the compiler
  cannot see.
- Delete direct Sushi code after no active registry path can reach it.

## Hot-File Rule

Do not grow `src/config/validation.ts` or `scripts/deploy-factory-system.ts` for
this packet except for narrow deletion or fail-closed guard edits. If a change
would add more than a small local branch, extract a focused helper/module first.
If this packet touches either file, run the roadmap-wide hot-file check against
the exact packet base ref. `scripts/deploy-factory-system.ts` must remain below
1000 lines, and any added-line growth must be justified in packet closeout with
the file, added lines, reason, and why a focused helper cannot own the guard.

## Merged-Test Migration (Before Any Deletion)

The merged PR #17 audit suite uses Sushi surfaces as shared fixtures, so "let
type errors drive cleanup" is not sufficient: several breakages are runtime
test failures, and one is a direct assertion contradiction. Migrate first,
delete second, and record the coverage mapping in packet closeout so no audit
assertion is silently dropped:

- `tests/integration/factory-registration.test.ts`: the
  "accepts takers authorized for the registering factory" and factory-mismatch
  tests deploy `SushiSwapKeeperTaker` and register at
  `LiquiditySource.SUSHISWAP` (the owner-mismatch test already uses LI.FI and
  needs no change). Resolve them as two distinct tests, not one edit:
  (a) re-point the positive acceptance test to `UniswapV3KeeperTaker` at
  `LiquiditySource.UNISWAPV3` so the "authorized taker accepted" path stays
  covered; (b) add a NEW negative test asserting the on-chain
  `setTaker(SUSHISWAP, <any address>)` deprecated-source revert — it cannot be
  a "flip" of the old test because that test's `SushiSwapKeeperTaker` fixture
  is deleted in this same packet. The `recoverFromTaker` error-bubbling suite
  registers `MockConfigurableTaker` at `SUSHISWAP`; move it to `CURVE` or
  `UNISWAPV3`.
- `tests/integration/taker-hardening.test.ts`: the Sushi-hosted cases
  (callback output-token binding, quote-due ceiling reject/accept, the
  `SwapExecuted` emission assertion) either port to another taker or are
  deleted with an explicit note that equivalent coverage exists on
  Curve/UniswapV3. The event-emission assertion is the only one on a
  surviving direct-DEX taker (the standalone 1inch taker has its own; UniswapV3
  and Curve emit but are not asserted) and must be ported, e.g. onto the
  UniswapV3 ceiling-accept case.
- `tests/integration/factory-slippage-bound.test.ts`: uses
  `LiquiditySource.SUSHISWAP`, `SushiSwapKeeperTaker__factory`, and
  `MockSushiSwapRouter__factory` to verify factory slippage guards — re-point
  to `UniswapV3KeeperTaker` so the slippage-bound coverage survives.
- `tests/integration/taker-partial-fill-scaling.test.ts` and
  `taker-quote-balance-guard.test.ts`: delete the Sushi sections; equivalent
  scaling/guard coverage exists on UniswapV3 and Curve.
- `tests/integration/helpers/mock-taker-base.ts`: remove `deploySushiTaker`,
  `deployFundedSushiRouter`, `encodeSushiKeeperDetails`, `SUSHI_DETAILS_TYPE`,
  and the `SushiSwapKeeperTaker__factory` / `MockSushiSwapRouter__factory`
  imports. This module is shared by the whole hardening suite: stale imports
  here break TypeChain resolution for every taker's tests, not just Sushi's.
- `tests/integration/helpers/factory-route-harness.ts`: full de-Sushi scope,
  not just the `setTaker(SUSHISWAP, ...)` registration — the
  `SushiSwapKeeperTaker__factory` / `MockSushiSwapRouter__factory` imports, the
  `sushiTaker` fixture field and deployment, this file's OWN copy of
  `deployFundedSushiRouter` (it exists in both `mock-taker-base.ts` and here),
  `prepareSushiFactoryRouteExecution`, and the `LiquiditySource.SUSHISWAP`
  switch arms — so factory route harnesses cover only Uniswap V3 and Curve and
  the closing reference gate can pass.

## External-Take Removal Targets

- `contracts/takers/SushiSwapKeeperTaker.sol`
- `contracts/mocks/MockSushiSwapRouter.sol`, if only used by the direct Sushi
  path
- `src/dex/providers/sushiswap-quote-provider.ts`
- `src/take/factory/sushiswap.ts`
- direct Sushi exports from provider/factory indexes
- factory-selection branches that evaluate or execute `LiquiditySource.SUSHISWAP`
- Sushi-specific route models, including `BoundSushiSwapFactoryRouteEvaluation`
  and `ApprovedSushiSwapFactoryQuoteEvaluation`
- quote-approval special cases, stats counters, telemetry branches, and log
  formatters that model Sushi as a direct external-take route
- gas-policy quote conversion branches that initialize Sushi V3 quote providers
- deployment scripts, generated examples, and config docs that register a Sushi
  direct taker
- policy artifact and environment parsers that currently accept `SUSHISWAP`,
  `SUSHI`, or `3` as active liquidity-source labels

## Post-Auction Removal Targets

- `src/dex/sushiswap-router.ts`
- `PostAuctionDex.SUSHISWAP`
- `DexRouter.swap` and reward-action branches that call direct Sushi
- `RewardActionTracker` plumbing that forwards `dex.sushiswap`
- direct Sushi router tests and direct Sushi reward-swap examples
- README sections that document direct Sushi reward swaps

## Stats Cleanup

- Minimum Packet 1 scope: delete direct Sushi stat members such as
  `approvedSushiswapTakeDecisions`, `executedSushiswapTakes`, and
  `dryRunSushiswapTakes` if direct Sushi deletion naturally makes them
  unreachable.
- Packet 1 may keep existing aggregate path counters for `oneinch`, `factory`,
  and `lifi` as current behavior, but only as a temporary pre-Packet-2B state.
- Packet 2B must migrate path-counter storage, summary logs, and failure groups
  to canonical `calldata_aggregator` plus provider id while preserving LI.FI as a
  display label and operator-facing compatibility name.
- Do not retain unreachable direct Sushi stats fields as compatibility baggage.
- Broader descriptor/keyed source counters are valuable, but they should become
  Packet 1b or Packet 2B work if they expand the deletion PR across unrelated
  runtime reporting surfaces.

## Post-Auction Replacement Policy

- No Sushi reward-swap replacement is included in Packet 1.
- Operators should use supported post-auction providers such as 1inch, Uniswap
  V3, or Curve.
- If post-auction aggregator swaps are needed later, design them separately from
  external-take callback execution.

## Tests

- `LiquiditySource.SUSHISWAP` still has numeric value `3`, but is deprecated.
- `LiquiditySource.CURVE` and `LiquiditySource.LIFI` keep their current numeric
  values.
- `FACTORY_DYNAMIC_SOURCES` excludes `SUSHISWAP`.
- `SUPPORTED_EXTERNAL_TAKE_LIQUIDITY_SOURCES` excludes `SUSHISWAP`.
- `isFactoryDynamicSource(SUSHISWAP)` returns false.
- New `AjnaKeeperTakerFactory.setTaker(SushiSwap, nonzero)` reverts with the
  deprecated-source error.
- Reused old factory preflight fails closed when `takerContracts(3)` is nonzero.
- Reused old factory cleanup with `setTaker(3, address(0))` is followed by exact
  zero-mapping verification.
- Source id `3` remains unmapped in factory deployment and route preflight.
- Config validation rejects `allowedLiquiditySources: [SUSHISWAP]`.
- External-take config does not consume `dex.sushiswap`.
- `DiscoveryExecutionConfig`, `FactoryQuoteConfig`, and `LiquiditySourceConfig`
  do not expose `SushiswapRouterOverrides`.
- `BoundFactoryRouteEvaluation` and `ApprovedFactoryQuoteEvaluation` no longer
  include Sushi-specific external-take route variants.
- Direct Sushi external-take quote approval, stats, and telemetry branches are
  deleted rather than retained as unreachable code.
- Direct Sushi stat fields are deleted. If broader stats simplification lands in
  the same packet, external-take source counters are descriptor/keyed for active
  factory sources instead of hardcoded source-specific fields.
- No-spend policy artifacts and env parsers reject `SUSHISWAP`, `SUSHI`, and `3`
  as active liquidity-source labels.
- Route selection never evaluates `LiquiditySource.SUSHISWAP`.
- Post-auction reward config rejects `PostAuctionDex.SUSHISWAP`.
- Direct Sushi reward-swap examples are removed or migrated to supported
  providers.
- Deployment scripts do not deploy or register `SushiSwapKeeperTaker`.
- Gas policy no longer initializes `SushiSwapQuoteProvider`.
- Factory route harnesses cover only Uniswap V3 and Curve factory routes.
- TypeChain generation no longer includes direct Sushi contracts if they are
  deleted.
- Direct Sushi router tests are deleted with the direct router helper.
- The merged-test migration is complete before deletion: factory-registration
  fixtures and `MockConfigurableTaker` use supported sources, the prior
  "setTaker(SUSHISWAP, taker) succeeds" assertion now asserts the
  deprecated-source revert, the `SwapExecuted` emission assertion is ported to
  a surviving taker, and `mock-taker-base.ts` / `factory-route-harness.ts`
  carry no Sushi helpers or imports.
- A closing reference gate passes, in two scopes:
  - helper/contract symbols: a repo search for
    `SushiSwapKeeperTaker|MockSushiSwapRouter|deploySushiTaker|deployFundedSushiRouter|encodeSushiKeeperDetails|SUSHI_DETAILS_TYPE|SOURCE_SUSHISWAP|prepareSushiFactoryRouteExecution`
    across `src/`, `contracts/`, `tests/`, and `scripts/` returns no hits.
  - active production labels: a search for
    `LiquiditySource.SUSHISWAP|PostAuctionDex.SUSHISWAP|dex\.sushiswap|SushiswapRouterOverrides|sushiswap-router|SushiSwapQuoteProvider`
    across `src/` and `scripts/` returns no hits outside the deprecated enum
    member declarations themselves and their deprecation tests — the registry,
    route-selection, validation, reward-swap, and deployment branches that
    consume those labels must be gone, not merely unreachable.
- No new Sushi fixtures are added for the deleted direct path.
- If this packet touches a roadmap hot file, the hot-file check passes against
  the exact packet base ref and records any narrow exception.
- Packet 0 hot-file checker is present before this packet starts.

## Acceptance

- `SUSHISWAP` cannot be selected as a factory liquidity source.
- `SUSHISWAP` remains numeric source id `3`, but no active external-take registry
  treats it as supported.
- `CURVE` and `LIFI` source ids are unchanged.
- Newly deployed `AjnaKeeperTakerFactory` rejects attempts to register a nonzero
  taker for source id `3`.
- Reused old factories pass only when `takerContracts(3) == address(0)`; nonzero
  legacy mappings must be cleared and reverified before live use.
- `dex.sushiswap` cannot enable an external-take direct path.
- `dex.sushiswap` is removed as a direct-router config surface.
- `PostAuctionDex.SUSHISWAP` cannot be configured for reward swaps.
- External-take runtime/config types no longer carry `SushiswapRouterOverrides`.
- External-take route model, quote approval, stats, and telemetry no longer carry
  direct Sushi variants.
- Direct Sushi stats fields are gone. Broader descriptor/keyed stats are either
  completed in Packet 1 without widening the PR materially, or split into Packet
  1b/2B.
- Policy artifacts cannot express deprecated Sushi as an allowed active source.
- No direct Sushi taker is deployed or registered.
- No direct Sushi router/quoter provider is initialized during discovery.
- No direct Sushi router helper remains for post-auction reward swaps.
- Hot-file changes, if any, are deletion-focused or narrowly fail-closed and pass
  the roadmap-wide hot-file gate.
