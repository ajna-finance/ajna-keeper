# Sushi Aggregator Packet 2B: Shared Calldata Core

## Purpose

Refactor LI.FI onto shared calldata-aggregator primitives while preserving live
behavior and deleting LI.FI-specific internal execution state.

## Provider Identity

- `CalldataAggregatorProviderId` is the provider-id union active in the current
  packet.
- Packet 2B's provider-id union is only `lifi`.
- Any shared packet-local layer registry must use
  `satisfies Record<CalldataAggregatorProviderId, ...>`.
- `AggregatorProviderIdentity` is the only shared source/path/source-id identity
  registry. Do not add a second source/path identity map with overlapping fields.
- `AggregatorProviderIdentity` is inert metadata only: provider id, canonical
  path, label, execution family, liquidity source id, taker contract key, and
  config key. It must not own deployment validation, canary behavior, allowlist
  policy, quote parsing, API clients, or route-source semantics.
- Packet 3B extends `CalldataAggregatorProviderId` with `sushi_aggregator` in the
  same diff that adds Sushi support.
- Packet 2B must not add Sushi source ids, config, execution, deployment paths,
  parser branches, or placeholder descriptors.

## Canonical Internal Identity

Legacy `lifi` inputs may exist only at operator/config boundaries. Internally,
LI.FI must normalize to:

- `externalTakePath: 'calldata_aggregator'`
- `providerId: 'lifi'`
- `deploymentType: 'calldata_aggregator'`
- adapter/strategy kind: `calldata_aggregator`

Packet 2B must remove internal `path: 'lifi'`, `kind: 'lifi'`, and
`deploymentType: 'lifi'` sentinels from route binding, quote approval, deployment
resolution, manual/discovery adapter state, execution telemetry, and
take-decision state. `lifi` may remain in config parsing tests, env/no-spend
input parsing tests, display labels, and provider ids.

Provider dispatch is part of this boundary. Calldata-aggregator route identity
and execution candidate identity must carry `providerId`; path-only dispatch is
valid for `oneinch` and `factory`, but invalid for `calldata_aggregator`.
Provider registry lookup, hybrid selection, execution plans, stats, and
telemetry must dispatch calldata routes by `{ path: 'calldata_aggregator',
providerId }`.

`allowedExternalTakePaths` remains a family-level switch. Packet 2B must add the
canonical provider-level enablement field
`allowedCalldataAggregatorProviders?: CalldataAggregatorProviderId[]` wherever
take-policy config is parsed, validated, and normalized.

Provider enablement semantics are part of this packet:

- Packet 2B's `CalldataAggregatorProviderId` union contains only `lifi`.
- Legacy operator inputs such as path `lifi` normalize to family
  `calldata_aggregator` plus provider id `lifi`.
- Canonical family input `calldata_aggregator` with no explicit
  `allowedCalldataAggregatorProviders` resolves to provider `lifi` only.
- A non-empty `allowedCalldataAggregatorProviders` value is valid only when the
  normalized family set includes `calldata_aggregator`.
- Explicit empty lists, duplicates, unknown provider ids, and provider ids not
  active in the current packet are validation failures.
- Adding Sushi in Packet 3B must require an explicit
  `allowedCalldataAggregatorProviders` value containing `sushi_aggregator`;
  appending the provider id must not silently enable Sushi for existing configs.

Packet 2B must introduce one canonical post-validation policy object:
`ResolvedExternalTakePolicy`, produced by `resolveExternalTakePolicy(...)` in
`src/config/route-policy.ts`. Raw operator-facing config may still contain
legacy paths and optional provider fields, but downstream runtime modules must
consume the resolved object instead of reinterpreting raw config. The resolved
object must carry:

- canonical execution families
- enabled calldata aggregator providers
- factory route sources
- default factory route source, if any
- route-selection and fallback policy needed by execution planning

After that boundary, route preflight, discovery runtime, hybrid selection,
execution planning, stats, and telemetry must not read raw
`allowedExternalTakePaths`, raw `allowedCalldataAggregatorProviders`, legacy
`lifi` path aliases, or default-source fallbacks directly.
`resolveExternalTakePaths(...)`, `resolveDefaultFactoryLiquiditySource(...)`, and
provider-list defaulting should become private implementation details of
`resolveExternalTakePolicy(...)`, except in resolver tests.

Add an AST/import boundary check,
`tests/unit/resolved-external-take-policy-boundary.test.ts`, that fails if
production runtime modules outside `src/config/route-policy.ts` import raw
path/default-source/provider-list resolution helpers or inspect raw policy fields
for execution decisions. This check targets policy interpretation only; it must
not grep for provider API string literals.

The boundary check must scan at least:

- `src/discovery/**/*.ts`
- `src/take/**/*.ts`
- `src/dex/**/*.ts`
- `scripts/deploy-factory-system.ts`

The boundary check must reject production imports of:

- `resolveExternalTakePaths`
- `resolveDefaultFactoryLiquiditySource`
- `resolveFactoryRouteSelectionSources`
- raw provider-list defaulting helpers

The boundary check must reject production member reads of raw take-policy fields
for routing/preflight/approval/stats/telemetry decisions:

- `allowedExternalTakePaths`
- `allowedCalldataAggregatorProviders`
- `defaultFactoryLiquiditySource`

The boundary check must reject external-take path-alias interpretation of `lifi`
outside config/env/no-spend input parsing. It must not reject provider API
payload parsing or provider labels, including LI.FI response checks such as
`quote.type === 'lifi'`, LI.FI tool-name validation, config field names, log
labels, fixture payloads, or diagnostics.

Allowed exceptions are `src/config/route-policy.ts`, config/schema/validation
parsing, env/no-spend input parsing, tests, fixtures, and the boundary-check file
itself. Production routing, preflight, discovery, approval, stats, and telemetry
code must consume `ResolvedExternalTakePolicy`.

Stats and logs are part of this boundary. Packet 2B must migrate
`externalTakeByPath`, summary route groups, and failure groups to the canonical
`calldata_aggregator` path plus provider id. `lifi` may remain as a provider id
and display label, but not as the internal stats key.

1inch remains intentionally separate. Do not migrate 1inch onto the
calldata-aggregator core, add `providerId` requirements to 1inch, or change
1inch route binding, approval, execution, telemetry, or path typing in Packet 2B.

## Shared Quote Boundary

- `ApprovedCalldataAggregatorQuote` is the only execution-facing quote shape for
  calldata aggregators.
- Shared `lifiQuote?` state must be deleted from route binding, quote approval,
  execution, telemetry, and take-decision types.
- LI.FI provider parsing may keep local provider response types, but must
  normalize into `ApprovedCalldataAggregatorQuote` before route binding or
  approval.
- `CalldataAggregatorRouteSummary` is the only shared source-filter/telemetry
  summary.
- `CalldataAggregatorRouteSummary` must not contain raw provider responses,
  untyped provider blobs, `any`, `unknown`, provider-specific nested route blobs,
  or fields execution approval needs to interpret.
- Raw LI.FI API responses remain confined to provider diagnostics, recorded
  fixtures, or telemetry envelopes outside execution approval.
- Delete `approveLifiQuoteForExecution` runtime helpers, exports, and call sites.
  Calldata-aggregator approval has one shared implementation.

## Hot-File Gate

The packet must declare its exact target base ref for the hot-file check.

The mechanical check must fail on:

- per-file added-line growth in `src/config/validation.ts`,
  `src/take/external-take/route.ts`,
  `src/take/external-take/quote-approval.ts`,
  `src/discovery/route-preflight.ts`, or `scripts/deploy-factory-system.ts`
- additions above 10 lines in any one hot file
- `scripts/deploy-factory-system.ts` reaching 1000 lines
- final total-line violations
- using the wrong base ref

Human review must separately reject:

- broad branches in the hot files
- unrelated compensating deletions
- any hot-file growth exception that does not list the file, added lines, reason,
  and why a provider-neutral helper cannot own the logic

Narrow deletion fallout, input-boundary compatibility shims, and fail-closed
guards may override the mechanical line-growth failure only when that review
justification is recorded in the packet closeout.

## Tests

- LI.FI unit and integration behavior remains unchanged after extraction.
- `LifiKeeperTaker` still supports only `LiquiditySource.LIFI`.
- The on-chain shape decision is recorded before contract edits, including
  interface/type-generation impact and wrapper/base LOC comparison.
- The default on-chain shape is thin provider wrappers over a shared base or
  internal library.
- `IAjnaKeeperTaker.getSupportedSources()` and `isSourceSupported(...)` remain
  `pure` unless the recorded decision proves a generic immutable-source taker is
  strictly cheaper after interface, typegen, existing-taker, deployment, and
  review impact.
- If the generic immutable-source taker is chosen, source support is immutable
  per deployment and old LI.FI behavior is equivalent.
- Wrapper code is thin and common callback mechanics live in the shared core.
- LI.FI target/spender/selector allowlists remain isolated.
- Legacy `lifi` config/env/no-spend/canary inputs normalize to the canonical
  calldata-aggregator model without behavior changes.
- Internal LI.FI route binding, quote approval, deployment resolution, adapter
  kind, strategy kind, telemetry, and manual/discovery adapter state carry
  `calldata_aggregator` plus provider id `lifi`, not internal `lifi` sentinels.
- Calldata-aggregator route identity, execution plans, hybrid selection, provider
  registry lookup, stats, and telemetry dispatch by path plus provider id, not by
  path alone.
- `ResolvedExternalTakePolicy` is produced by `resolveExternalTakePolicy(...)` at
  the config/env/no-spend input boundary and reused by route preflight,
  discovery runtime, hybrid selection, execution planning, stats, and telemetry.
- `allowedExternalTakePaths` controls execution families only, and
  `allowedCalldataAggregatorProviders` controls providers within the
  `calldata_aggregator` family.
- An omitted provider list resolves to `lifi` only when the normalized family set
  includes `calldata_aggregator`.
- Explicit `allowedCalldataAggregatorProviders: ['lifi']` works.
- Explicit empty lists, duplicates, unknown ids, packet-inactive ids, and provider
  lists without the `calldata_aggregator` family fail validation.
- External-take path counters, summary route groups, and failure groups are
  keyed by `calldata_aggregator` plus provider id `lifi`, not by internal path
  key `lifi`.
- 1inch route binding, quote approval, execution, telemetry, and path typing
  remain unchanged and do not require `AggregatorProviderId`.
- Downstream runtime modules do not inspect raw `allowedExternalTakePaths`, raw
  `allowedCalldataAggregatorProviders`, legacy `lifi` aliases, or default-source
  fallbacks after normalized policy construction.
- Downstream runtime modules do not call raw path/default-source/provider-list
  resolution helpers directly; they consume `ResolvedExternalTakePolicy` instead.
- The AST/import boundary check fails if production runtime modules outside
  `src/config/route-policy.ts` import raw policy-resolution helpers or inspect raw
  path/provider/default-source fields for execution decisions, without rejecting
  provider API payload literals or provider labels.
- `ApprovedCalldataAggregatorQuote` covers only normalized execution fields.
- `CalldataAggregatorRouteSummary` contains only normalized telemetry/source-filter
  fields.
- Shared `lifiQuote?` fields are deleted.
- `approveLifiQuoteForExecution` runtime helpers, exports, and call sites are
  deleted.
- Shared offchain execution modules accept normalized provider output and do not
  parse LI.FI raw API responses.
- Packet 2B contains no Sushi source id, `dex.sushiAggregator`, Sushi execution,
  Sushi path parsing, Sushi deployment path, or Sushi placeholder descriptors.
- LI.FI stale-quote, final-min-out, gas-estimation, and pre-broadcast failure
  paths still pass.
- LI.FI deployment/preflight wrappers use shared allowlist helpers.
- Existing LI.FI route-shape and fork execution canaries still pass.
- Provider identity and any shared packet-local layer registries compile against
  the same current `CalldataAggregatorProviderId` key set.
- No second source/path identity descriptor or parallel identity map is added.
- Provider behavior lives in provider-local capabilities or narrowly owned shared
  execution/deployment/canary modules, not in `AggregatorProviderIdentity`.
- Reusable allowlist ABI, snapshot, reconciliation, and assertion helpers live in
  a provider-neutral module, not under `src/dex/lifi`.
- The mechanical hot-file growth check fails when the packet violates the gate.

## Acceptance

- LI.FI behavior is preserved after shared-core extraction.
- Config/operator `lifi` aliases survive only at input boundaries.
- Internal route, approval, deployment, adapter, strategy, manual/discovery
  adapter, telemetry, and take-decision state uses `calldata_aggregator` plus
  provider id `lifi`.
- Calldata-aggregator execution dispatch, route selection, execution plans,
  provider registry lookup, stats, and telemetry are provider-id-aware.
- `resolveExternalTakePolicy(...)` in `src/config/route-policy.ts` is the single
  normalized policy boundary for path/provider/default-source resolution;
  downstream runtime modules consume `ResolvedExternalTakePolicy` rather than
  duplicating config interpretation.
- `allowedExternalTakePaths` remains family-level, and
  `allowedCalldataAggregatorProviders` is the provider-level enablement contract
  inside `calldata_aggregator`. In Packet 2B it can only enable `lifi`.
- Path-counter storage, summary route groups, and failure groups use canonical
  `calldata_aggregator` plus provider id `lifi`; `lifi` remains only as a
  provider/display label.
- 1inch remains a separate `oneinch` path/family and is regression-tested as
  unchanged.
- Shared offchain execution primitives are provider-neutral.
- Shared offchain primitives consume normalized provider output through
  `ApprovedCalldataAggregatorQuote` / `calldataQuote`.
- Shared `lifiQuote?` state is deleted.
- LI.FI-specific runtime approval helpers are deleted.
- The on-chain shared core defaults to wrapper/base reuse without changing
  `IAjnaKeeperTaker` mutability. A generic immutable-source taker is accepted only
  if its recorded decision proves lower total complexity.
- `CalldataAggregatorProviderId` is only `lifi` in Packet 2B; no inactive Sushi
  provider id or descriptor is predeclared.
- Any shared layer-specific calldata-aggregator registries compile against the
  current provider id key set and have a single owner.
- `AggregatorProviderIdentity` remains the single shared identity registry for
  source/path/source-id/taker/config identity.
- `AggregatorProviderIdentity` remains behavior-free; deployment validation,
  allowlists, canaries, quote parsing, and source-filter semantics are owned by
  provider-local capabilities or focused shared modules.
- Reusable allowlist helpers are no longer canonical under `src/dex/lifi`.
- A mechanical hot-file growth check is present, uses the exact packet base ref,
  and fails on added-line growth, hot-file additions above 10 lines, total-line
  violations, or the wrong base ref.
- The AST/import resolved-policy boundary check is present and fails on raw policy
  imports or execution-policy interpretation outside the canonical resolver,
  without rejecting provider API payload parsing, labels, fixtures, or
  diagnostics.
- Packet closeout records human review of hot-file exceptions, broad branches,
  and unrelated compensating deletions.
