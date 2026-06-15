# Packet 5: Retire The `oneinch` Execution Family And Factory Naming

## Purpose

Move 1inch from its standalone `oneinch` execution family into the shared
`calldata_aggregator` architecture as provider id `oneinch`, while renaming the
factory-managed route family to `direct_dex` and the source-to-taker registry to
`TakerRouter`.

The terminal architecture should have two execution families:

- `direct_dex`
- `calldata_aggregator`

`direct_dex` is the canonical route-family name for router-managed direct DEX
takers such as Uniswap V3 and Curve. LI.FI, Sushi, and 1inch are modeled as
providers inside `calldata_aggregator`. Both families may still execute through
registered taker contracts owned by `TakerRouter`; the route family describes the
quote/execution semantics, not whether the taker is router-managed.

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
- manual/per-pool routing: `take.liquiditySource = LiquiditySource.ONEINCH`
  still resolves through standalone one-inch deployment/context branches

The router-managed direct DEX path is also still named `factory` today:

- config-facing path: `factory`
- config field: `takers.factory`
- contract: `contracts/factories/TakerRouter.sol`
- default source field: `defaultFactoryLiquiditySource`
- hybrid fallback mode: `factory_first`
- telemetry and preflight labels: factory-oriented names

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
- `contracts/factories/TakerRouter.sol` is not a deployer factory.
  It is a source-to-taker registry and execution router: it validates registered
  takers, maps `LiquiditySource` values to taker deployments, forwards
  `takeWithAtomicSwap(...)`, and recovers tokens from registered takers.
- `FactoryAuthorizedTakerBase` is the shim that makes factory-managed takers
  compatible with the router: it exposes `authorizedFactory()`, implements
  owner-or-factory access control, and shares the `IAjnaKeeperTaker` getters.
  Today it is declared inside `contracts/base/KeeperTakerBase.sol`, not in a
  separate file.
  The Packet 5 implementation should rename this shim to
  `RouterAuthorizedTakerBase`.
- `KeeperTakerBase` is the common taker core used by both the legacy standalone
  1inch taker and the factory-managed takers.
- `BaseAggregatorCalldataTaker` is the shared calldata-aggregator execution
  engine used by LI.FI and Sushi today. It is the intended base for migrated
  1inch execution.

The desired terminal state is:

- remove the standalone `AjnaKeeperTaker` contract in the same implementation
  PR that migrates 1inch to the calldata-aggregator path, after the PR's
  equivalence and canary gates pass;
- keep the source-to-taker registry/router concept as `TakerRouter`, while
  removing factory-named config fields, module paths, artifacts, and
  authorization symbols;
- rename the operator-facing route family from `factory` to `direct_dex`;
- rename operator-facing config/docs from `takers.factory` to `takers.router`;
- preserve enum source ids, including `LiquiditySource.ONEINCH = 1`.

## Non-Goals

- Do not preserve standalone 1inch runtime dispatch after the Packet 5 migration
  PR lands.
- Do not preserve runtime compatibility aliases for retired `oneinch`, legacy
configured path alias `lifi`, `factory`, `takers.oneInch`, `takers.factory`,
`defaultFactoryLiquiditySource`, or `factory_first` config names.
- Do not remove `LiquiditySource.ONEINCH`; preserve enum values.
- Do not remove retained non-take 1inch surfaces such as `dex.oneInch.*`,
  gas-quote source support, provider-local API normalization, or
  `PostAuctionDex.ONEINCH`.
- Do not reuse deprecated source id `3`.
- Do not add raw 1inch payloads to shared execution types.
- Do not change direct DEX swap semantics; the direct-DEX work is a naming/API
  cleanup that renames the route family from `factory` to `direct_dex`, the
  registry entrypoint to `TakerRouter`, and factory-named authorization symbols
  to router terminology.
- Do not combine this with Packet 4.

## Recorded Design Decisions

The Packet 5 implementation should use these decisions rather than reopening
the naming model:

1. Add `OneInchAggregatorKeeperTaker` as a thin wrapper over
   `BaseAggregatorCalldataTaker`.
2. Register `OneInchAggregatorKeeperTaker` in `TakerRouter` under
   `LiquiditySource.ONEINCH`.
3. Preserve `LiquiditySource.ONEINCH = 1` as the stable logical source id, but
   route it through `{ path: 'calldata_aggregator', providerId: 'oneinch' }`.
4. Treat `direct_dex` as the canonical route family for router-managed direct
   DEX sources such as Uniswap V3 and Curve.
5. Retire legacy `factory` route/config terms after fail-fast validation errors
   and docs are in place. Use `direct_dex` in runtime and production config.
6. Retire legacy `oneinch` external-take path/config terms after fail-fast
   validation errors and docs are in place. Use `calldata_aggregator` plus
   provider id `oneinch`.
7. Retire legacy top-level `lifi` configured path aliases at the same time.
   Existing configs must use `allowedExternalTakePaths: ['calldata_aggregator']`
   plus `allowedCalldataAggregatorProviders: ['lifi']`.
8. Remove standalone `contracts/AjnaKeeperTaker.sol` production dispatch and
   deployment docs in the same PR, after the PR's equivalence and canary gates
   pass.
9. Preserve the router's functional integration surface where it is already
   route-neutral: `takerContracts(uint8)`, `hasConfiguredTaker(uint8)`,
   `setTaker(uint8,address)`, `takeWithAtomicSwap(...)`, and token recovery.
   Rename contract, type, file, events, errors, config, telemetry, and docs from
   factory terminology to router terminology.
10. Rename the taker authorization ABI at the same time: `authorizedFactory()` to
   `authorizedRouter()`, `_authorizedFactory` to `_authorizedRouter`,
   `onlyOwnerOrFactory` to `onlyOwnerOrRouter`, constructor params, comments,
   TypeChain imports, registration validation, scripts, docs, and tests. Do not
   keep both getters or compatibility aliases in production contracts.
11. Do not port legacy 1inch pro-rating into
   `OneInchAggregatorKeeperTaker`. The migrated 1inch path uses exact-fill
   calldata-aggregator semantics: quote-context drift rejects before execution
   instead of resizing provider calldata on-chain.
12. Manual and per-pool external-take config must materialize the same
    post-validation route identity as autodiscovery. `LiquiditySource.ONEINCH`
    may remain the stable logical source id in operator input, but runtime code
    must not use source id alone to choose an execution family. After validation,
    manual 1inch reaches execution as `{ path: 'calldata_aggregator',
    providerId: 'oneinch', source: LiquiditySource.ONEINCH }`, never as a
    standalone `deploymentType: 'oneinch'`.
13. Do not implement runtime alias normalization for retired config names. Since
    there is a single operator, the implementation should reject old config
    names and require explicit new config before startup.

`LiquiditySource.ONEINCH` must not become a `direct_dex` source merely because
its new taker is registered in `TakerRouter`. The source id identifies the
liquidity source; the route family identifies the execution semantics.

## Proposed Config Contract

Introduce provider id `oneinch` under `calldata_aggregator`.

New configs should use `takers.router` for the shared router contract and
`calldata_aggregator` plus provider id `oneinch` for 1inch routes:

```ts
{
  takers: {
    router: '0x...'
  },
  discovery: {
    take: {
      allowedExternalTakePaths: ['calldata_aggregator'],
      allowedCalldataAggregatorProviders: ['oneinch']
    }
  }
}
```

Direct DEX routes should use the canonical `direct_dex` path:

```ts
{
  takers: {
    router: '0x...'
  },
  discovery: {
    take: {
      allowedExternalTakePaths: ['direct_dex'],
      defaultDirectDexLiquiditySource: LiquiditySource.UNISWAPV3
    }
  }
}
```

Packet 5 is a breaking config cleanup. Existing config must be edited to the
new names before the keeper starts. Retired names are detected only to provide
clear validation errors:

- `allowedExternalTakePaths: ['oneinch']` is invalid. Use
  `allowedExternalTakePaths: ['calldata_aggregator']` and
  `allowedCalldataAggregatorProviders: ['oneinch']`;
- `allowedExternalTakePaths: ['lifi']` is invalid. Use
  `allowedExternalTakePaths: ['calldata_aggregator']` and
  `allowedCalldataAggregatorProviders: ['lifi']`;
- `allowedExternalTakePaths: ['factory']` is invalid. Use
  `allowedExternalTakePaths: ['direct_dex']`;
- `takers.factory` is invalid. Use `takers.router`;
- `defaultFactoryLiquiditySource` is invalid. Use
  `defaultDirectDexLiquiditySource`;
- `factory_first` is invalid. Use `direct_dex_first`;
- `takers.oneInch` is invalid for external takes. Use `takers.router` with
  `takers.contracts.OneInchAggregator` and a router that has
  `OneInchAggregatorKeeperTaker` registered.

The runtime must not carry compatibility branches for these names. Detection can
live in validation and tests only, so the post-validation policy boundary stays
small and canonical.

The same breaking cleanup applies outside `KeeperConfig`. CLI flags, env vars,
fixture summaries, no-spend artifacts, scenario-matrix defaults, and operator
docs must rename retired factory/standalone labels instead of accepting aliases:

- `--hybrid-gas-quote-fallback factory_first` and matching env values become
  `direct_dex_first`;
- `externalTakeRouteSelectionMode: 'factory_first'` becomes
  `'direct_dex_first'`;
- fixture and no-spend artifacts use `defaultDirectDexLiquiditySource`,
  `directDexRouteSources`, `routerAddress`, and provider id `oneinch`;
- generated artifacts must not emit `keeperTakerRouter`, `takers.factory`,
  `defaultFactoryLiquiditySource`, standalone external-take `oneinch`, legacy
  top-level `lifi` path aliases, or `takers.oneInch` labels after validation.

## Canonical Path Boundary

The implementation should separate operator input types from runtime route
identity:

- config parsing may recognize retired names only to throw explicit startup
  errors. It must not normalize them into runtime policy;
- the post-validation policy boundary should expose only canonical paths:
  `direct_dex` and `calldata_aggregator`;
- provider ids should carry aggregator identity, so 1inch reaches runtime as
  `{ path: 'calldata_aggregator', providerId: 'oneinch' }`;
- retired names should not appear in production route identity, telemetry,
  execution stats, dispatch, or post-validation policy;
- source ids should not decide the execution family after migration. Path and
  provider id decide the family, and source id remains the stable logical
  liquidity source identifier.
- helpers that map source ids to routes or paths are operator-input resolution
  helpers only. They may run while materializing `ResolvedExternalTakePolicy` or
  `ResolvedManualExternalTakeRoute`, but execution, approval, discovery,
  preflight, stats, telemetry, and deployment resolution must consume the
  already-materialized route identity instead of calling source-to-route lookup
  helpers.
- manual, per-pool, autodiscovery, preflight, quote approval, and deployment
  resolution should consume the same canonical route identity. There should not
  be a separate manual source-only route path that calls
  `resolveExternalTakePathFromSource(...)` at execution time.

The intended code-judo move is to make that boundary compile-enforced. Do this
by refactoring the existing registry surfaces, not by adding another parallel
metadata map:

- Rename/refactor `src/config/external-take-registry.ts` into the canonical
  route/provider descriptor owner, preferably
  `src/config/external-take-descriptors.ts`.
- Delete `src/config/aggregator-provider-identity.ts` as an exported terminal
  surface and migrate callers to the canonical descriptor helpers. Do not leave
  a thin derived identity wrapper around path, provider, source, taker key,
  config key, or telemetry labels.

The canonical descriptor model is the source of truth for declarative identity
and capability metadata:

- allowed runtime paths: `direct_dex` and `calldata_aggregator`;
- provider ids under `calldata_aggregator`;
- operator-input source-to-route defaults used only during validation and route
  materialization, never as a runtime route-family dispatcher;
- required taker contract key and router registration;
- deployment resolution shape;
- manual/per-pool route identity shape;
- discovery provider lookup keys;
- provider circuit identity keys;
- route/provider stats keys;
- preflight capability requirements;
- telemetry labels.

The descriptor must not become a god registry for executable behavior. Provider
quote functions, execution functions, route-shape parsers, allowlist readers,
canary logic, and provider-specific preflight hooks stay in provider-local
adapter modules keyed by descriptor identity. Shared code may ask the descriptor
which provider/path/source/taker key applies, but it must not import provider
business logic from the descriptor.

Deployment resolution should not keep an independent execution-family enum that
mirrors route paths. Replace `ExternalTakeDeploymentType` and
`deploymentType: 'factory' | 'oneinch' | 'calldata_aggregator'` runtime switches
with a descriptor-backed deployment result, for example:

```ts
{
  route: { path: 'calldata_aggregator', providerId: 'oneinch', source: LiquiditySource.ONEINCH },
  routerAddress: config.takers.router,
  takerContractKey: 'OneInchAggregator',
  resolvedTakerAddress: config.takers.contracts.OneInchAggregator
}
```

Direct DEX deployments should use the same shape with
`path: 'direct_dex'`, the concrete source, and the descriptor's taker key. The
only discriminator runtime dispatch needs is the canonical route identity.

Do not implement Packet 5 by sprinkling `if source === ONEINCH`,
`if path === 'factory'`, `if path === 'lifi'`, or legacy-name checks across
route policy, deployment resolution, manual context, approval, discovery,
telemetry, and preflight. If a branch is needed in more than one layer, the
descriptor model is missing declarative metadata or the provider-local adapter
boundary is missing an operation.

## Manual And Per-Pool Migration

Manual and per-pool `take.liquiditySource = LiquiditySource.ONEINCH` cannot stay
source-only after Packet 5, because source id `1` no longer selects the
standalone execution family. The implementation should introduce an explicit
post-validation manual route identity, for example `ResolvedManualExternalTakeRoute`,
and make manual context creation consume that route identity instead of deriving
path from source inside execution code.

The implementation must update validation, deployment resolution, manual
context selection, and route preflight so:

- manual `LiquiditySource.ONEINCH` is accepted only when it resolves to
  `{ path: 'calldata_aggregator', providerId: 'oneinch',
  source: LiquiditySource.ONEINCH }` through the canonical descriptor and only
  when the explicit new config is present: `takers.router`,
  `takers.contracts.OneInchAggregator`, the provider config, and router
  registration;
- `ExternalTakeTakerContractKey` gains a `OneInchAggregator` key and
  `TakersConfig.contracts.OneInchAggregator` is the configured taker address for
  the migrated provider;
- deployment resolution returns descriptor-backed route plus router/taker
  addresses. It no longer resolves `ONEINCH` through `config.keeperTaker` and no
  longer exposes `deploymentType: 'oneinch'` as a runtime discriminator;
- manual execution context selection dispatches on canonical route identity, not
  on `LiquiditySource.ONEINCH` or a production standalone `oneinch` branch;
- configs with only retired `takers.oneInch` fail with an explicit migration
  error instead of falling back to the standalone taker.

## Retired Vs Retained `oneinch` Surfaces

The static boundary checker must distinguish the retired standalone execution
family from retained 1inch provider surfaces.

Retired after Packet 5:

- external-take path identity `path: 'oneinch'`;
- deployment resolution `deploymentType: 'oneinch'`;
- standalone `AjnaKeeperTaker` production dispatch and deployment docs;
- standalone `oneInchProvider` runtime dispatch;
- one-off production stats and circuit fields that encode standalone 1inch route
  identity, such as `oneInchQuoteCircuit` or route-family counters that cannot be
  derived from provider id `oneinch`;
- `approveOneInchQuoteForExecution(...)` production approval dispatch;
- `takers.oneInch` as external-take execution config.

Retained after Packet 5:

- `LiquiditySource.ONEINCH = 1`;
- `CalldataAggregatorProviderId` value `oneinch`;
- `dex.oneInch.*` provider config, including routers and aggregation executor
  policy;
- 1inch gas-quote source resolution where still used for profitability checks;
- `PostAuctionDex.ONEINCH` reward-swap support;
- provider-local fixtures, diagnostics, and API normalization;
- provider-keyed circuit state and telemetry for provider id `oneinch`;
- docs and tests that explain or assert breaking config behavior.

## Implementation Phases

### Phase 1: Design And Evidence

- Record the reviewed Packet 5 decisions in the implementation PR description.
- Capture current 1inch quote/swap response fixtures for representative chains.
- Prove the 1inch swap response can normalize into
  `ApprovedCalldataAggregatorQuote` without provider-specific execution fields.
- Record the router ABI decision before changing contracts: preserve the
  functional router interface listed above, while renaming contract/type/event
  terminology away from factory.
- Record the retained-vs-retired `oneinch` allow/deny matrix for static checks.
- Record the canonical route/provider descriptor model before touching runtime
  dispatch. Implementation should delete legacy branches by making retired paths
  unrepresentable after validation.
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
- Do not reimplement the exact-fill mechanics already owned by
  `BaseAggregatorCalldataTaker`: callback authentication, owner/router
  authorization, source-token balance accounting, quote-token balance-delta
  enforcement, and allowance reset.
- Keep the wrapper thin. It should only add provider-specific source support,
  source id reporting, and provider-distinct execution-event emission unless the
  implementation PR records a concrete reason to override shared behavior.
- Do not port legacy 1inch proportional input/min-return scaling. The migrated
  path should reject source amount mismatches before calling the aggregator.
- Preserve provider-distinct event naming, for example
  `OneInchAggregatorSwapExecuted`.
- Register the taker through `TakerRouter` for `LiquiditySource.ONEINCH`.
- Reject stale or ambiguous deployments in route preflight.
- Do not change `IAjnaKeeperTaker` mutability unless a separate recorded
  decision accepts the generic immutable-source taker tradeoff.

### Phase 4A: Canonical Descriptor Refactor

This subphase is a no-behavior-change extraction. It should make the later
rename and 1inch migration smaller, not smuggle in runtime changes.

- Rename/refactor `src/config/external-take-registry.ts` into the canonical
  route/provider descriptor owner, preferably
  `src/config/external-take-descriptors.ts`.
- Model route families and calldata-aggregator providers in one typed
  declarative structure that owns path, provider id, source id, taker key,
  config key, preflight capability metadata, deployment-resolution fields,
  manual-route fields, and telemetry labels.
- Delete `src/config/aggregator-provider-identity.ts` as an exported terminal
  surface. Migrate callers to descriptor helpers instead of keeping a second
  manually maintained identity map or thin derived wrapper.
- Derive supported path/provider lists, validation-time source-to-route
  defaults, taker-key lookup, deployment result shape, manual route identity,
  route-preflight labels, and tooling-readable canonical route/provider names
  from the descriptor.
- Keep source-to-route defaults behind validation and manual-route
  materialization helpers. Runtime callers must receive canonical route identity
  rather than importing source-to-route lookup helpers.
- Derive discovery provider lookup keys, provider circuit identity keys, route
  counters, and telemetry dimensions from the descriptor. Provider-local adapter
  modules should still construct the executable quote/execute/preflight entries
  keyed by descriptor identity; do not keep separate hard-coded
  `oneInchProvider`, `lifiProvider`, `sushiAggregatorProvider`, or
  `factoryProvider` selection fields when a provider/path map can express the
  route.
- Keep `ExternalTakeDeploymentType` and the current deployment-resolution return
  shape as a compatibility facade during 4A. The facade should be derived from
  the descriptor, but exported types, logs, and callers must behave the same in
  this no-behavior-change subphase.
- Add descriptor-model tests proving the compatibility facade preserves current
  deployment labels and unavailable reasons while its data comes from the new
  descriptor.
- Update route policy, route binding, quote approval, discovery, telemetry, and
  preflight code to consume descriptor/router helpers instead of adding new
  source/path switch branches.
- Hot files may only shrink, mechanically consume descriptor helpers, or carry a
  documented exception in the PR inventory.

### Phase 4B: Router And `direct_dex` Mechanical Rename

This subphase changes naming only. It must not change 1inch execution semantics.

- Move factory-named module, config, artifact, and authorization surfaces to
  router terminology while preserving the source-to-taker registry concept as
  `TakerRouter`.
- Rename the authorization ABI and internals with it: `authorizedFactory()` to
  `authorizedRouter()`, `_authorizedFactory` to `_authorizedRouter`,
  `onlyOwnerOrFactory` to `onlyOwnerOrRouter`, constructor params, comments,
  TypeChain imports, registration validation, scripts, docs, and tests.
- Update TypeChain imports, deployment scripts, preflight labels, telemetry, and
  production docs from factory terminology to router terminology.
- Rename the canonical router-managed direct DEX path from `factory` to
  `direct_dex`.
- Rename direct DEX policy/config internals:
  - `FactoryLiquiditySource` -> `DirectDexLiquiditySource`;
  - `factoryRouteSources` -> `directDexRouteSources`;
  - `defaultFactoryLiquiditySource` -> `defaultDirectDexLiquiditySource`;
  - `factory_first` -> `direct_dex_first`.
- Rename the production direct DEX module family, not only user-facing labels:
  `src/take/factory/*` should become a direct-DEX module such as
  `src/take/direct-dex/*`, and exported symbols such as `takeLiquidationFactory`,
  `FactoryPathQuoteInput`, and `ApprovedFactoryQuoteEvaluation` should become
  direct-DEX names. Factory-named tests should be renamed unless they exist only
  to assert migration errors or static-boundary behavior.
- Delete runtime alias handling for retired `factory`, `takers.factory`,
  `defaultFactoryLiquiditySource`, `factory_first`, and legacy top-level `lifi`
  config. Validation may detect these names only to raise clear startup errors.
- Rename script-facing and artifact-facing factory terms at the same time:
  command flags, env vars, no-spend artifact fields, fixture harness defaults,
  scenario matrix defaults, and fixture docs should all use `direct_dex` /
  `direct_dex_first` / router terminology with no compatibility aliases.

### Phase 4C: 1inch Calldata-Aggregator Migration

- Add `oneinch` to `CalldataAggregatorProviderId`.
- Add `OneInchAggregator` to `ExternalTakeTakerContractKey` and
  `TakersConfig.contracts`.
- Register descriptor metadata for provider id `oneinch` only through
  `{ path: 'calldata_aggregator', providerId: 'oneinch' }`.
- Rewire deployment resolution and manual context creation so manual/per-pool
  `LiquiditySource.ONEINCH` first materializes canonical route identity, then
  resolves through router + registered `OneInchAggregatorKeeperTaker`, not
  `config.keeperTaker`.
- After route policy, manual context, approval, discovery, telemetry, preflight,
  and deployment call sites consume canonical route identity, delete
  `ExternalTakeDeploymentType` as an independent runtime family axis. Production
  deployment resolution must then return canonical route identity plus
  router/taker address data, and logs that need a human-readable deployment label
  must derive it from the descriptor.
- Change provider registry, discovery adapters, and hybrid selection to dispatch
  1inch by provider id under `calldata_aggregator`. Provider selection should be
  a descriptor-derived map keyed by canonical route/provider identity, not
  public fields such as `oneInchProvider` or path-only lookup tables.
- Delete the standalone `oneInchProvider` runtime path. The implementation may
  reuse provider-local parsing and normalization helpers, but it must not keep a
  wrapper keyed by path `oneinch` or any dispatch route that bypasses provider-id
  selection.
- Change generic approval and discovery binding dispatch so canonical
  path/provider identity wins over `LiquiditySource.ONEINCH`. A migrated 1inch
  route must never fall through to the legacy source-based approval branch.
- Replace `approveOneInchQuoteForExecution(...)` call sites with
  `approveCalldataAggregatorQuoteForExecution(...)` for the migrated path.
- Move execution through the shared calldata-aggregator core.
- Update stats, circuits, and telemetry to report both canonical path and
  provider id. Provider-specific legacy labels may remain only as derived
  presentation values for tests or log formatting; runtime accounting should be
  keyed by descriptor route/provider identity.
- Update canaries and production docs.

### Phase 4D: Retired 1inch Runtime Deletion Gate

- Delete runtime alias handling for retired `oneinch` and `takers.oneInch`
  config plus the retired top-level `lifi` path alias. Validation may detect
  these names only to raise clear startup errors.
- Ensure old standalone execution is not preserved as a production runtime path;
  legacy `oneinch` config names must fail validation before route selection.
- Remove any remaining production approval, discovery, preflight, telemetry, or
  manual-context branch that treats `oneinch` as a path rather than a provider id.

### Phase 5: Same-PR Retirement Closeout

Before the implementation PR is mergeable, and only after the equivalence and
canary evidence exists in that PR:

- remove internal `oneinch` path dispatch;
- remove legacy standalone `AjnaKeeperTaker`;
- delete the standalone approval path;
- retire standalone `AjnaKeeperTaker` deployment docs;
- fail closed any remaining `takers.oneInch` standalone execution config;
- remove runtime compatibility parsing and alias maps for retired names;
- remove the legacy top-level `lifi` configured path alias;
- update tests to ensure no production runtime path reinterprets `oneinch` as a
  separate execution family.

## Migration Inventory

The implementation PR should include an explicit rename and migration inventory
covering at least these surfaces:

- config schema, validation, route policy, and external-take registry;
- the canonical route/provider descriptor model that owns declarative path,
  provider, source, taker-key, deployment-resolution, manual-route,
  preflight-capability, and telemetry metadata;
- deletion of `src/config/aggregator-provider-identity.ts` as an exported
  terminal surface, with callers migrated to canonical descriptor helpers;
- calldata-aggregator provider id typing;
- manual/per-pool take settings, deployment resolution, and manual execution
  context selection, including deletion of source-only runtime dispatch;
- external-take route identity, route binding, quote approval, and reapproval;

### Hot-File Resolution Strategy

The hot-file gate is a design pressure, not a line-count game. Packet 5 should
resolve hot-file failures by moving behavior to the module that owns the domain
invariant. Arbitrary wrappers, generic utility buckets, or duplicate identity
maps are not acceptable remediations.

Current implementation snapshots have failed
`npm run check-hot-file-growth -- --base origin/master` with these targets:

- `src/config/validation.ts`: 135 added lines.
- `src/take/external-take/route.ts`: 66 added lines.
- `src/take/external-take/quote-approval.ts`: 26 added lines.
- `src/discovery/route-preflight.ts`: 51 added lines.
- `scripts/deploy-factory-system.ts`: 24 added lines.
- `scripts/run-fixture-keeper-harness.ts`: 30 added lines.
- `scripts/no-spend/harness-artifacts.ts`: 33 added lines and net growth from
  798 to 803 lines.
- `scripts/create-liquidatable-ajna-fixture.ts`: 29 added lines.

Treat those as extraction targets in this order:

1. Move calldata-aggregator provider policy into provider-owned modules, such as
   `src/take/external-take/calldata-aggregator/identity.ts`,
   `validation.ts`, `binding.ts`, and `preflight.ts`.
2. Keep `src/config/validation-rules.ts` limited to user-facing startup
   diagnostics and delegation to provider/descriptor validators.
   `src/config/validation.ts` may exist only as a compatibility shim. Retired
   name detection can stay in validation rules only as explicit fail-fast
   validation, never as runtime alias normalization.
3. Keep `src/take/external-take/route-binding.ts` limited to canonical route
   binding and descriptor-backed identity helpers.
   `src/take/external-take/route.ts` may exist only as a compatibility shim.
   The route-binding module must not grow source/path dispatch branches or a
   second provider registry.
4. Keep `src/take/external-take/quote-approval-rules.ts` as orchestration over
   shared approval invariants.
   `src/take/external-take/quote-approval.ts` may exist only as a compatibility
   shim. Provider quote normalization and provider-specific calldata checks
   should live in provider modules before approval.
5. Keep `src/discovery/route-preflight-validation.ts` as a thin coordinator over
   config, registry, and on-chain-code checks.
   `src/discovery/route-preflight.ts` may exist only as a compatibility shim.
   Provider-specific router/taker checks should be provider preflight hooks keyed
   by descriptor identity.
6. Extract script behavior into named helper modules only when the helper owns a
   reusable operational contract: deployment policy loading, fixture route
   construction, harness artifact serialization, or authorization evidence
   checks. Do not create one-line script shims solely to satisfy the gate.
7. Treat compatibility shims and executable script wrappers differently:
   operator-facing script filenames may stay as thin CLI dispatchers because
   docs and npm scripts call them, but repo-internal production code and tests
   must import named ownership modules directly. The hot-file checker should
   fail `compatibility-import` when code imports a compatibility-only hot module.

Before recording any hot-file exception, the PR must include a self-review entry
with:

- the extraction attempted first;
- why the canonical descriptor, provider module, route helper, preflight hook,
  or script helper cannot own the remaining logic;
- the security invariant protected by keeping the logic in the hot file;
- the focused tests or static checks that prove the remaining logic is
  fail-closed;
- confirmation that no duplicate route/provider identity map or runtime alias
  path was introduced.

Review notes for this strategy:

- The safest DRY boundary is one canonical source for route/provider identity,
  not one generic helper for all execution behavior.
- The descriptor must stay declarative. If it starts holding quote execution,
  route-shape parsing, canary, or allowlist-reader behavior, the extraction has
  moved provider risk into global config.
- Validation error text and static-boundary allow/deny rules should share
  reviewed retired-name fixtures where practical, but production runtime code
  must not import migration-only grep policy.
- Script extractions should be named after the artifact or operational contract
  they own. If a helper is only used by one script and has no clear invariant,
  a documented exception may be safer than artificial indirection.

The remaining migration inventory still covers:

- direct DEX production module paths and exported symbols, including
  `src/take/factory/*`, `takeLiquidationFactory`, `FactoryPathQuoteInput`, and
  factory-named approved/bound quote evaluation types;
- discovery provider registry, discovery adapters, runtime target building, and
  executor path/provider stats;
- route preflight ABI, labels, stale-deployment checks, and registered taker
  validation;
- `IAjnaKeeperTaker` authorization ABI and every `authorizedFactory` /
  owner-or-factory symbol, renamed to router terminology with no production
  compatibility getter;
- LI.FI and Sushi execution modules that connect to the router;
- TypeChain imports and generated-contract references;
- deployment, fixture, harness, no-spend, and scenario-matrix scripts;
- expansion of `scripts/check-hot-file-growth.ts` to include the Packet 5 script
  hot files before touching their factory/router naming, artifact, or CLI/env
  parsing logic:
  - `scripts/run-fixture-keeper-harness.ts`;
  - `scripts/no-spend/harness-artifacts.ts`;
  - `scripts/create-liquidatable-ajna-fixture.ts`;
- CLI flags, env vars, fixture docs, and generated/no-spend artifacts that
  mention retired `factory`, `factory_first`, `defaultFactoryLiquiditySource`,
  `keeperTakerFactory`, `takers.factory`, standalone `oneinch`, legacy top-level
  `lifi` path aliases, or `takers.oneInch` labels;
- telemetry names, provider circuit keys, execution failure callbacks, and
  operator logs;
- unit, integration, canary, and static boundary tests;
- production docs and fixture docs.

The implementation PR must add an executable static boundary checker:

- package script: `check-external-take-boundaries`;
- command shape:
  `npm run check-external-take-boundaries -- --base <ref>`;
- implementation path:
  `scripts/check-external-take-boundaries.ts`, unless the PR records a better
  repo-local script path;
- required behavior: explicit `--base` is mandatory, matching
  `check-hot-file-growth`.

The checker may import or read the canonical route/provider descriptor for
active route/provider names, but it must own retired-term allow/deny contexts in
the checker or checker test fixtures. Do not put grep policy, migration-doc
exceptions, or production-doc exception lists into the runtime descriptor. The
checker must reject retired standalone external-take path contexts and
factory-named direct DEX production module paths or exported symbols while
allowing canonical provider id `oneinch`, `dex.oneInch.*`, gas-quote support,
`PostAuctionDex.ONEINCH`, provider-local fixtures, migration docs, and tests.

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

The intentional non-equivalence is legacy 1inch pro-rating. The new path should
prove quote-context mismatches reject before execution instead of scaling
provider calldata on-chain.

That proof should use a realistic contention sequence: quote a take, have
another actor partially take the auction before execution, then assert the
migrated 1inch path fails closed on the source-amount mismatch and that offchain
debt-clamping prevents avoidable stale-size submissions.

## Tests

- Retired `allowedExternalTakePaths: ['oneinch']` fails validation and never
  resolves to provider `lifi` or provider `oneinch`.
- Retired `allowedExternalTakePaths: ['lifi']` fails validation. Operators must
  configure `calldata_aggregator` plus provider id `lifi`.
- Retired `allowedExternalTakePaths: ['factory']` fails validation. Operators
  must configure `direct_dex`.
- Retired `takers.factory`, `defaultFactoryLiquiditySource`, and `factory_first`
  fail validation. Operators must configure `takers.router`,
  `defaultDirectDexLiquiditySource`, and `direct_dex_first`.
- Retired script/operator inputs fail fast: CLI flags, env vars, no-spend
  artifacts, fixture docs, and scenario matrix defaults do not accept or emit
  `factory_first`, `defaultFactoryLiquiditySource`, `keeperTakerFactory`,
  `takers.factory`, standalone `oneinch`, legacy top-level `lifi` path aliases,
  or `takers.oneInch`.
- Retired `takers.oneInch` never silently executes the old standalone taker.
- `LiquiditySource.ONEINCH` validation requires `takers.router` and a registered
  `OneInchAggregatorKeeperTaker`, not `takers.oneInch`.
- Manual/per-pool `take.liquiditySource = LiquiditySource.ONEINCH` materializes
  the canonical `{ path: 'calldata_aggregator', providerId: 'oneinch',
  source: LiquiditySource.ONEINCH }` route identity, or fails closed with an
  explicit migration error before execution context creation.
- `ONEINCH` deployment resolution returns canonical route identity plus router +
  `OneInchAggregator` registered taker config, not `config.keeperTaker` or a
  runtime `deploymentType: 'oneinch'` discriminator.
- New calldata-aggregator 1inch configs require provider id `oneinch`.
- Omitted provider list must not accidentally enable 1inch if the current
  default remains LI.FI-only.
- Generic approval and discovery binding choose the migrated
  `calldata_aggregator` provider path for `LiquiditySource.ONEINCH`; they do not
  branch to legacy source-based 1inch approval.
- Discovery provider selection is descriptor/provider-keyed. Tests should fail
  if production code selects 1inch through a public `oneInchProvider` field or a
  path-only `providersByPath.oneinch` entry.
- 1inch API responses normalize into `ApprovedCalldataAggregatorQuote`.
- Raw 1inch API payloads do not enter shared execution approval.
- The new taker emits exactly one provider-distinct execution event.
- The new taker rejects unsupported source ids.
- The new taker enforces allowlisted target, spender, and selector.
- The new taker verifies actual balance delta and clears allowance.
- The new taker rejects source amount mismatches instead of pro-rating 1inch
  calldata, including a same-block partial-take contention scenario.
- Hybrid route selection can compare LI.FI, Sushi, 1inch, and `direct_dex` routes
  without path-key collisions.
- Provider circuit state and route stats are keyed by canonical path/provider
  identity. `oneInchQuoteCircuit` and one-off 1inch route counters are removed or
  proven to be derived presentation values, not independent runtime state.
- Router preflight rejects stale deployments and verifies the registered
  `LiquiditySource.ONEINCH` taker address.
- Contract and TypeChain tests prove production takers expose
  `authorizedRouter()` rather than `authorizedFactory()`, and registration
  validation rejects stale takers that still expose only the factory-named ABI.
- Static boundary checks reject new production code that emits retired `factory`,
  `takers.router`, standalone external-take `oneinch` path, legacy top-level
  `lifi` path aliases, or standalone `takers.oneInch` labels after validation.
- Static boundary checks reject production contract, script, telemetry, and docs
  surfaces that keep factory-named authorization symbols such as
  `authorizedFactory`, `_authorizedFactory`, or `onlyOwnerOrFactory`.
- Static boundary checks reject factory-named direct DEX production module paths
  and exported symbols such as `src/take/factory/*`, `takeLiquidationFactory`,
  `FactoryPathQuoteInput`, and factory-named approved/bound quote evaluation
  types, except in migration/error-message tests.
- Static boundary checks allow retained 1inch surfaces: provider id `oneinch`,
  `dex.oneInch.*`, gas-quote support, `PostAuctionDex.ONEINCH`, provider-local
  fixtures, migration docs, and tests.
- Static boundary checks reject production runtime use of the old internal
  `oneinch` path after retirement.
- Descriptor-model tests prove path lists, provider ids, validation-time
  source-to-route defaults, taker keys, deployment result shape, manual route
  identity, preflight capability labels, and telemetry labels derive from one
  canonical declarative registry rather than separate handwritten maps.
- Provider-adapter tests prove executable quote, execute, route-shape, canary,
  and provider-specific preflight behavior stays in provider-local modules keyed
  by descriptor identity, not in the descriptor itself.
- Static-boundary checker tests prove the checker imports or reads canonical
  active names from the descriptor while keeping retired-term allow/deny
  contexts outside production descriptor metadata.
- Hot-file checks fail any Packet 5 change that adds source/path branching to
  validation, route binding, quote approval, route preflight, deployment scripts,
  fixture harness scripts, no-spend artifact scripts, or fixture-generation
  scripts without a documented exception.
- Static boundary checks cover scripts and docs, not only `src/**`, so retired
  operator-facing names cannot survive in harness usage text, env-var parsing,
  fixture artifacts, no-spend reports, or production docs except in explicit
  migration/error-message contexts.
- Full unit and targeted integration suites pass.
- Route-shape and fork execution canaries pass for the migrated 1inch provider.

## Acceptance

- 1inch is available as provider id `oneinch` under `calldata_aggregator`.
- The shared calldata-aggregator approval and execution path is used.
- Live 1inch config is updated explicitly to `takers.router` plus provider id
  `oneinch`; retired config names fail validation and there is no standalone
  production dispatch after merge.
- No enum values are reindexed.
- No raw provider payloads are added to shared execution types.
- Old standalone 1inch execution is removed in the same PR after explicit new
  config, equivalence tests, and canaries pass.
- The legacy standalone `AjnaKeeperTaker` contract is removed from production
  deployment docs and runtime dispatch.
- The router-managed direct DEX route family is named `direct_dex`.
- The source-to-taker registry entrypoint is named `TakerRouter`, not factory,
  in new contracts, config, docs, telemetry, and scripts.
- Script flags, env vars, fixture artifacts, no-spend reports, and operator docs
  use `direct_dex` / `direct_dex_first` / router terminology without alias
  compatibility.
