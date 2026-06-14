# Packet 5: Retire The `oneinch` Execution Family

## Purpose

Move 1inch from its standalone `oneinch` execution family into the shared
`calldata_aggregator` architecture as provider id `oneinch`.

The terminal architecture should have two execution families:

- `factory`
- `calldata_aggregator`

with LI.FI, Sushi, and 1inch modeled as providers inside
`calldata_aggregator`.

## Current Baseline

1inch is still separate today:

- config-facing path: `oneinch`
- liquidity source: `LiquiditySource.ONEINCH`
- contract: `contracts/AjnaKeeperTaker.sol`
- offchain execution: `src/take/one-inch-execution.ts`
- route validation/encoding: `src/dex/one-inch.ts`
- approval helper: `approveOneInchQuoteForExecution(...)`
- telemetry path: `oneinch`
- circuit state: one-inch-specific quote circuit helpers

LI.FI and Sushi already share:

- `contracts/base/BaseAggregatorCalldataTaker.sol`
- thin provider wrappers under `contracts/takers/`
- `ApprovedCalldataAggregatorQuote`
- `approveCalldataAggregatorQuoteForExecution(...)`
- `calldata_aggregator` route identity plus provider id
- provider-local API normalization and execution wrappers

## Current Contract Roles

The current names are historical and should not be carried into the terminal
architecture unchanged:

- `contracts/AjnaKeeperTaker.sol` is the legacy standalone 1inch taker. It is
  owner-only, directly implements the Ajna pool callback, and is intentionally
  not factory-managed.
- `contracts/factories/AjnaKeeperTakerFactory.sol` is not a deployer factory.
  It is a source-to-taker registry and execution router: it validates registered
  takers, maps `LiquiditySource` values to taker deployments, forwards
  `takeWithAtomicSwap(...)`, and recovers tokens from registered takers.
- `FactoryAuthorizedTakerBase` is the shim that makes factory-managed takers
  compatible with the router: it exposes `authorizedFactory()`, implements
  owner-or-factory access control, and shares the `IAjnaKeeperTaker` getters.
- `KeeperTakerBase` is the common taker core used by both the legacy standalone
  1inch taker and the factory-managed takers.
- `BaseAggregatorCalldataTaker` is the shared calldata-aggregator execution
  engine used by LI.FI and Sushi today. It is the intended base for migrated
  1inch execution.

The desired terminal state is:

- remove the standalone `AjnaKeeperTaker` contract after 1inch has equivalent
  calldata-aggregator coverage;
- keep the source-to-taker registry/router concept, but rename it from
  `AjnaKeeperTakerFactory` to `TakerRouter` or `AjnaKeeperTakerRouter`;
- update operator-facing config/docs away from `takers.factory` naming toward a
  router name, while preserving enum source ids.

## Non-Goals

- Do not break existing live 1inch configs without a migration path.
- Do not remove `LiquiditySource.ONEINCH`; preserve enum values.
- Do not reuse deprecated source id `3`.
- Do not add raw 1inch payloads to shared execution types.
- Do not change factory direct-DEX behavior.
- Do not combine this with Packet 4.

## Design Decision Required First

Before implementation, record the contract migration decision:

1. Add a new `OneInchAggregatorKeeperTaker` thin wrapper over
   `BaseAggregatorCalldataTaker`.
2. Keep `contracts/AjnaKeeperTaker.sol` as a legacy supported taker for one
   release while configs migrate.
3. Later retire the standalone taker after equivalence evidence and operator
   migration.
4. Rename the factory-managed execution entrypoint to `TakerRouter` or
   `AjnaKeeperTakerRouter`, because the current contract routes to already
   deployed takers and does not deploy them.

The first implementation packet should not delete the legacy taker until the new
factory-registered path has passing equivalence and canary evidence.

## Proposed Config Contract

Introduce provider id `oneinch` under `calldata_aggregator`.

Compatibility aliases may stay at operator boundaries:

- legacy `allowedExternalTakePaths: ['oneinch']` may normalize to
  `calldata_aggregator` plus provider `oneinch` only after the migration mode is
  explicitly enabled;
- existing `dex.oneInch` config remains the 1inch provider config source until a
  later config-cleanup packet;
- new configs should prefer:

```ts
discovery: {
  take: {
    allowedExternalTakePaths: ['calldata_aggregator'],
    allowedCalldataAggregatorProviders: ['oneinch']
  }
}
```

The compatibility path must be obvious in logs and docs, because operators need
to know when they are using the old standalone taker versus the new
factory-registered provider.

The config cleanup target is to replace `takers.factory` terminology with a
router-facing field name in the same migration window. Compatibility aliases can
exist during migration, but new examples and production docs should use the
router name.

## Implementation Phases

### Phase 1: Design And Evidence

- Create an explicit packet/design doc for the 1inch migration.
- Capture current 1inch quote/swap response fixtures for representative chains.
- Prove the 1inch swap response can normalize into
  `ApprovedCalldataAggregatorQuote` without provider-specific execution fields.
- Define the exact allowlists required for 1inch:
  - router call target;
  - approval spender;
  - calldata selector;
  - aggregation executor policy, if still needed as a provider-local validator.

### Phase 2: Provider-Local Normalization

- Add `src/take/oneinch-aggregator/` or equivalent provider-local modules.
- Decode 1inch API swap calldata and validate:
  - `srcToken`;
  - `dstToken`;
  - `srcReceiver`;
  - `dstReceiver`;
  - exact input amount;
  - minimum output;
  - flags;
  - aggregation executor policy;
  - zero native value.
- Normalize accepted responses into `ApprovedCalldataAggregatorQuote`.
- Keep raw 1inch API responses confined to provider diagnostics, fixtures, or
  telemetry envelopes.

### Phase 3: On-Chain Taker

- Add `OneInchAggregatorKeeperTaker` as a thin wrapper over
  `BaseAggregatorCalldataTaker`.
- Preserve provider-distinct event naming, for example
  `OneInchAggregatorSwapExecuted`.
- Register the taker through `AjnaKeeperTakerFactory` for
  `LiquiditySource.ONEINCH` if the final source model keeps id `1` as the
  factory source for 1inch.
- Reject stale or ambiguous deployments in route preflight.
- Do not change `IAjnaKeeperTaker` mutability unless a separate recorded
  decision accepts the generic immutable-source taker tradeoff.

### Phase 4: Router Rename And Runtime Migration

- Rename or replace `AjnaKeeperTakerFactory` with the chosen router contract
  name (`TakerRouter` or `AjnaKeeperTakerRouter`).
- Update TypeChain imports, deployment scripts, preflight labels, telemetry, and
  production docs from factory terminology to router terminology.
- Add compatibility handling only where needed to let existing configs move from
  `takers.factory` to the router field without ambiguous runtime behavior.
- Add `oneinch` to `CalldataAggregatorProviderId`.
- Extend `AggregatorProviderIdentity` with inert 1inch metadata only.
- Change provider registry and hybrid selection to dispatch 1inch by
  `{ path: 'calldata_aggregator', providerId: 'oneinch' }`.
- Replace `approveOneInchQuoteForExecution(...)` call sites with
  `approveCalldataAggregatorQuoteForExecution(...)` for the migrated path.
- Move execution through the shared calldata-aggregator core.
- Preserve old standalone execution behind an explicit compatibility mode until
  migration is complete.
- Update stats and telemetry to report both canonical path and provider id.
- Update canaries and production docs.

### Phase 5: Retirement

Only after migration evidence:

- remove internal `oneinch` path dispatch;
- remove legacy standalone `AjnaKeeperTaker`;
- delete the standalone approval path;
- retire standalone `AjnaKeeperTaker` deployment docs;
- remove or fail-closed any remaining `takers.oneInch` standalone execution
  config;
- leave compatibility config parsing only where needed for existing operators;
- update tests to ensure no production runtime path reinterprets `oneinch` as a
  separate execution family.

## Equivalence Test Bar

The new provider path must prove equivalence or intentional improvement for:

- quoted raw output;
- debt-clamped exact-fill sizing;
- approved min-out derivation;
- route minimum versus keeper execution floor;
- chain/token/recipient validation;
- aggregation executor policy;
- gas-estimation and pre-broadcast failure classification;
- actual quote-token balance-delta enforcement;
- allowance reset;
- telemetry and execution failure callbacks;
- quote circuit behavior.

## Tests

- Legacy 1inch configs still work during the compatibility phase.
- New calldata-aggregator 1inch configs require provider id `oneinch`.
- Omitted provider list must not accidentally enable 1inch if the current
  default remains LI.FI-only.
- 1inch API responses normalize into `ApprovedCalldataAggregatorQuote`.
- Raw 1inch API payloads do not enter shared execution approval.
- The new taker emits exactly one provider-distinct execution event.
- The new taker rejects unsupported source ids.
- The new taker enforces allowlisted target, spender, and selector.
- The new taker verifies actual balance delta and clears allowance.
- Hybrid route selection can compare LI.FI, Sushi, 1inch, and factory routes
  without path-key collisions.
- Static boundary checks reject production runtime use of the old internal
  `oneinch` path after retirement.
- Full unit and targeted integration suites pass.
- Route-shape and fork execution canaries pass for the migrated 1inch provider.

## Acceptance

- 1inch is available as provider id `oneinch` under `calldata_aggregator`.
- The shared calldata-aggregator approval and execution path is used.
- Existing live 1inch operators have a documented migration path.
- No enum values are reindexed.
- No raw provider payloads are added to shared execution types.
- Old standalone 1inch execution is removed only after compatibility and
  equivalence gates pass.
- The legacy standalone `AjnaKeeperTaker` contract is removed from production
  deployment docs and runtime dispatch.
- The factory-managed execution entrypoint is named as a router, not a factory,
  in new contracts, config, docs, telemetry, and scripts.
