# Sushi Aggregator Keeper Plan

## Purpose

Remove SushiSwap from all direct-router keeper paths and replace it, if needed,
with first-class aggregator calldata support built on shared infrastructure.

The current direct Sushi integrations are `exactInputSingle` integrations, while
the public Sushi execution path observed on major chains is aggregator-style
calldata. Since this deployment is controlled by a single operator, the clean
answer is to delete the misleading direct paths instead of preserving
compatibility exceptions.

After this roadmap:

- `LiquiditySource.SUSHISWAP = 3` remains reserved, deprecated, and unmapped.
- Sushi is no longer a direct factory route or direct post-auction router.
- First-class Sushi support, if implemented, is a new aggregator source id on a
  shared calldata aggregator core.
- LI.FI may still route through Sushi when its policy allows it, but that is
  incidental LI.FI behavior, not independent Sushi support.

## Packet Boundaries

Do not land this entire roadmap as one PR. Split it into these packets:

0. Hot-file guard bootstrap.
   - Add the mechanical hot-file growth checker before any packet touches
     already-large central files.
   - Add no runtime, config, contract, Sushi, or deployment behavior.
   - Detailed gates: `docs/sushiswap-external-take-packet-0.md`.
1. Direct Sushi removal.
   - Delete direct external-take Sushi support.
   - Delete direct post-auction Sushi reward-swap support.
   - Reserve source id `3` as deprecated and unsupported.
   - Add fail-closed old-factory checks for nonzero `takerContracts(3)`.
   - Detailed gates: `docs/sushiswap-external-take-packet-1.md`.
2A. Read-only Sushi route-shape spike.
   - Fetch representative Sushi same-chain routes and prove they normalize into
     the intended shared calldata-aggregator quote model.
   - Do not change production LI.FI execution in this packet.
   - Detailed gates: `docs/sushiswap-external-take-packet-2a.md`.
2B. Shared aggregator calldata core.
   - Refactor LI.FI onto provider-neutral shared execution and deployment
     primitives without changing behavior.
   - Preserve LI.FI source id, config, operator-facing telemetry labels, and
     production policy.
   - Detailed gates: `docs/sushiswap-external-take-packet-2b.md`.
3A. Sushi competitiveness decision.
   - Compare Sushi against LI.FI and 1inch on the required route matrix.
   - Classify incumbent failures instead of treating all LI.FI/1inch errors as
     equivalent coverage gaps.
   - Commit an explicit `proceed` or `defer` artifact.
   - Add no source-id, factory, config, deployment, provider-id, or runtime Sushi
     aggregator surface.
   - Detailed gates: `docs/sushiswap-external-take-packet-3a.md`.
3B. First-class Sushi aggregator.
   - Runs only after Packet 3A records `proceed`.
   - Add a new appended Sushi aggregator source id and provider config.
   - Require a newly compiled factory that knows the appended source id; do not
     support old factories for first-class Sushi.
   - Limit initial Sushi configs, allowlists, canary fixtures, and closeout to the
     Packet 3A `proceed` scope.
   - Reuse the shared aggregator core.
   - Add Sushi provider validation, canaries, and deployment/preflight policy.
   - Detailed gates: `docs/sushiswap-external-take-packet-3b.md`.
4. Optional broad LI.FI exchange policy.
   - Keep separate from Sushi.
   - Add only if broad LI.FI routing can preserve fail-closed route-shape and
     allowlist guarantees.
5. Future candidate: retire the `oneinch` execution family.
   - Not part of this roadmap's implementation; recorded so Packet 2B designs
     the shared contracts without foreclosing it.
   - See "Packet 5 Candidate" section below.

Packet 0 must land first so the hot-file gate is executable before Packet 1
touches `scripts/deploy-factory-system.ts` or other large central files. Packets
1 and 2A can then be reviewed independently. Packet 2B must not freeze the shared
execution quote contract until Packet 2A has proven Sushi can normalize without
provider-specific execution fields. Packet 3B must not start before Packet 3A
records `proceed`, and it must not start by copy-pasting LI.FI. Packet 4 should
not be smuggled into Sushi work.

## Roadmap-Wide Hot-File Gate

Packet 0 adds the hot-file growth checker. Any later packet that touches one of
these files must declare its exact target base ref and run that checker against
the ref:

- `src/config/validation.ts`
- `src/take/external-take/route.ts`
- `src/take/external-take/quote-approval.ts`
- `src/discovery/route-preflight.ts`
- `scripts/deploy-factory-system.ts`

The check must fail on per-file added-line growth, additions above 10 lines in
any hot file, `scripts/deploy-factory-system.ts` reaching 1000 lines, or a
wrong base ref.

This roadmap's meta-tooling ceiling is three checkers: the hot-file growth
checker (Packet 0), the resolved-policy boundary check (Packet 2B), and the
evidence schema checker (Packet 2A). Later packets extend these three; do not
add a fourth gate mechanism. Narrow deletion fallout, input-boundary compatibility shims, and
fail-closed guards may override the mechanical line-growth failure only when the
packet closeout lists the file, added lines, reason, and why a focused helper or
provider-neutral module cannot own the logic. Reject unrelated compensating
deletions and broad special-case branches even if the mechanical check passes.

## Current Evidence

The existing direct taker path is ABI-specific:

- `contracts/takers/SushiSwapKeeperTaker.sol` encodes
  `exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))`.
- `src/dex/sushiswap-router.ts` uses the same `exactInputSingle` router ABI.
- `src/discovery/route-preflight.ts` currently checks that configured Sushi
  addresses have bytecode, but does not prove that `swapRouterAddress` supports
  the selector that the taker will call.

Live checks against Sushi's current swap API returned executable calldata to
`0xac4c6e212a361c968f1725b4d055b47e63f80b75` with selector `0x5f3bd1c8` on:

- Ethereum mainnet
- Base
- Arbitrum
- Optimism
- Polygon
- Avalanche
- Hemi through Sushi's API

Those routes are not compatible with the direct taker, whose required selector
is `0x414bf389`.

The repo's Hemi direct-router example is not enough reason to keep the direct
path. Its configured `dex.sushiswap.swapRouterAddress`
`0x33d91116e0370970444B0281AB117e161fEbFcdD` was verified to contain
`0x414bf389`, with `factory()` returning
`0xCdBCd51a5E8728E0AF4895ce5771b7d17fF71959` and `WETH9()` returning
`0x4200000000000000000000000000000000000006`. That proves one legacy-style
router can work, but it does not match Sushi's current cross-chain API model and
keeps an operator footgun alive.

## Target Architecture

### Direct Sushi Policy

- Preserve the old enum slot:
  - TypeScript `LiquiditySource.SUSHISWAP = 3`
  - Solidity `IAjnaKeeperTaker.LiquiditySource.SushiSwap`
- Mark source id `3` deprecated and unsupported.
- Never reindex `CURVE`, `LIFI`, or any existing Solidity/TypeScript ids.
- New `AjnaKeeperTakerFactory` deployments must reject nonzero source id `3`
  registrations.
- Reused old factory deployments cannot gain this guard. For those, preflight
  and deployment audit must fail closed unless `takerContracts(3) ==
  address(0)`. If it is nonzero, the operator must clear it with
  `setTaker(3, address(0))` and verify the zero mapping before live use.
- Remove `dex.sushiswap` as a direct-router config surface.
- Remove `PostAuctionDex.SUSHISWAP`; first-class Sushi aggregator support does
  not automatically replace reward swaps.

### Aggregator Source Model

First-class Sushi aggregator support uses a new source, not source id `3`.

- New source name: `sushi_aggregator`.
- New appended liquidity source id: expected `SUSHI_AGGREGATOR = 6` when the
  implementation base still has `LIFI = 5`.
- New provider id: `sushi_aggregator`.
- New config key: `dex.sushiAggregator`.
- New taker contract key: `SushiAggregator`.
- New telemetry label: Sushi Aggregator.

Do not model this as "factory Sushi" and do not add a new top-level
provider-specific path. The code-judo move is to make `calldata_aggregator` the
reusable internal path/family, then model LI.FI and Sushi as providers/sources
under that path. The canonical model should distinguish:

- `ConfiguredExternalTakePathKind`: operator/config-facing path names, which may
  include legacy aliases such as `lifi`
- `ExternalTakePathKind`: canonical internal path names only:
  `oneinch`, `factory`, and `calldata_aggregator`
- liquidity source id: the Solidity/TypeScript enum value used by the factory
  and taker
- execution family: `factory`, `oneinch`, or `calldata_aggregator`
- `CalldataAggregatorProviderId`: provider ids active in the current packet;
  Packet 2B is only `lifi`, and Packet 3B extends the union with
  `sushi_aggregator`
- deployment type: generic `calldata_aggregator` carrying `providerId`
- route identity and execution candidate identity: `path + providerId` for
  calldata aggregators. Once more than one calldata provider exists, path-only
  dispatch is invalid.

Prefer the generic internal deployment shape:

- `deploymentType: 'calldata_aggregator'`
- `providerId: CalldataAggregatorProviderId`
- `requestedLiquiditySource`
- `resolvedTakerAddress`

Existing LI.FI-facing names may stay as compatibility aliases only at
operator/config input boundaries. They must normalize immediately to
`externalTakePath: 'calldata_aggregator'` plus `providerId: 'lifi'`. After
Packet 2B, route binding, quote approval, adapter `kind`, strategy kind,
deployment type, deployment resolution, manual/discovery adapter state, and
execution telemetry must not carry internal `lifi` path/kind/deployment
sentinels. New providers must not add sibling top-level paths such as
`sushi_aggregator`. Future aggregators should add provider identity metadata,
not another path full of one-off conditionals.

Provider dispatch must not stay path-only. Packet 2B must introduce a
calldata-aggregator route identity shape that carries `providerId`, and the
execution plan, provider registry, route selection, stats, and telemetry should
dispatch calldata routes by `{ path: 'calldata_aggregator', providerId }`.
Packet 2B is the implementation source of truth for this boundary. The config
contract must be:

- `allowedExternalTakePaths?: ConfiguredExternalTakePathKind[]` controls only
  execution families after normalization.
- `allowedCalldataAggregatorProviders?: CalldataAggregatorProviderId[]` controls
  which calldata providers may quote and compete.
- Legacy `allowedExternalTakePaths: ['lifi']` normalizes to family
  `calldata_aggregator` plus provider `lifi`.
- `allowedExternalTakePaths: ['calldata_aggregator']` without an explicit
  provider list resolves to provider `lifi` only. Adding a new provider must not
  silently enable it for an existing config.
- A non-empty provider list while the `calldata_aggregator` family is disabled is
  invalid. Empty, duplicate, unknown, or packet-inactive provider ids are invalid.

Packet 2B must also add one canonical post-validation policy object:
`ResolvedExternalTakePolicy`, produced by `resolveExternalTakePolicy(...)`
added to the existing `src/config/route-policy.ts` module (which already hosts
the raw helpers that become private). Raw compatibility parsing may still
happen in config/env/no-spend input code, but path/provider/default-source
interpretation must collapse into this single resolver:

- config/env/no-spend/operator inputs normalize once at the boundary
- the normalized object carries canonical execution families, calldata aggregator
  providers, factory route sources, default factory source, and route-selection
  policy
- downstream route preflight, discovery runtime, hybrid selection, execution
  planning, stats, and telemetry consume `ResolvedExternalTakePolicy` or exact
  subfields derived from it
- downstream modules must not re-read raw `allowedExternalTakePaths`,
  `allowedCalldataAggregatorProviders`, legacy `lifi` aliases, or default-source
  fallbacks
- `resolveExternalTakePaths(...)`, `resolveDefaultFactoryLiquiditySource(...)`,
  and provider-list defaulting remain private implementation details of
  `resolveExternalTakePolicy(...)`, except for tests of the resolver itself
- Packet 2B must add a static boundary check that fails if production runtime
  modules outside `src/config/route-policy.ts` import raw policy-resolution
  helpers or inspect raw path/provider/default-source fields for execution
  decisions, while allowing provider API payload parsing, provider labels,
  fixtures, and diagnostics

Packet 3B can then enable LI.FI, Sushi, or both under the same family with an
explicit `allowedCalldataAggregatorProviders` value, without adding a new
top-level path.

1inch is intentionally out of scope for `calldata_aggregator` in this roadmap.
It remains the existing `oneinch` execution family and path. Do not migrate 1inch
onto the shared calldata-aggregator core, add `providerId` requirements to
1inch, or change 1inch route binding/approval/execution behavior while doing
Packet 2B. Any future unification of 1inch with calldata aggregators must be a
separate design.

### Layered Aggregator Descriptors

Do not create one giant provider descriptor that gets threaded through every
layer, and do not replace it with five global registries that must stay manually
in sync. Start from one shared provider identity registry:

- `AggregatorProviderIdentity` keyed by `CalldataAggregatorProviderId`
  - provider id, canonical path, label, execution family, liquidity source id,
    taker contract key, and config key

Do not predeclare inactive provider descriptors. Packet 2B's provider union is
only `lifi`; Packet 3B extends that union with `sushi_aggregator` and adds the
Sushi identity in the same diff that adds Sushi support. Any packet-local shared
layer registry must be keyed by `CalldataAggregatorProviderId`, for example with
`satisfies Record<CalldataAggregatorProviderId, ...>`. This keeps source ids,
labels, taker keys, deployment profiles, and canary profiles from drifting
across files without forcing Packet 2B to add Sushi placeholders.

`AggregatorProviderIdentity` must stay inert. It must not own deployment
validation, canary behavior, allowlist policy, quote parsing, API clients, or
route-source semantics.

Then split behavior by ownership, preferring provider-local modules that colocate
their quote/deploy/canary capabilities. Do not add a second source/path identity
descriptor or parallel identity map with overlapping fields. A shared registry is
allowed only when the lookup is genuinely cross-provider and keyed by
`CalldataAggregatorProviderId` with compile-time coverage checks:

- provider quote adapter
  - API request construction, authentication, response parsing, route-shape
    normalization, fee/source-filter semantics, and provider-specific
    validations
- execution adapter
  - normalized quote freshness, current-liquidation revalidation, shared
    swap-details encoding, min-out checks, gas estimation, transaction
    submission, provider-id-aware dispatch, and shared telemetry
- deployment allowlist profile
  - production allowlist normalization, on-chain snapshot reads, reconciliation,
    post-config assertions, and factory registration ordering
- canary profile
  - route-shape canary command, fork execution canary command, required env, and
    provider-specific operator guidance

Each layer consumes only the descriptor or provider-local capability it owns. If
a helper needs fields from three descriptor types, it is probably in the wrong
layer. Packet 2B must not introduce a parallel set of quote, execution,
deployment, and canary maps unless each map has a single owner and a test or type
check proving it covers the active `CalldataAggregatorProviderId` set. Source,
path, taker-key, config-key, and factory identity stay in
`AggregatorProviderIdentity`.

### Shared Solidity Core

The merged base (PR #17) already ships the lower layers:
`contracts/base/KeeperTakerBase.sol` defines `KeeperTakerBase` (pool
validation, `_safeApproveWithReset`, `_approveQuoteForTake`,
`_settleAfterTake`, `_recoverToken`, reentrancy guard, shared errors, the
standard 4-arg `SwapExecuted` event) and `FactoryAuthorizedTakerBase`
(`IAjnaKeeperTaker` wiring getters, `onlyOwnerOrFactory`, `recover`). Every
taker, including `LifiKeeperTaker`, already inherits them. Packet 2B must not
re-extract those mechanics or add a sibling base beside them.

The remaining on-chain work is one aggregator-specific layer,
`BaseAggregatorCalldataTaker is FactoryAuthorizedTakerBase`, promoted out of
`LifiKeeperTaker`:

- per-deployment call-target, approval-spender, and selector allowlist
  storage, setters, getters, and enforcement
- the `_activeCallbackPool` / `_activeCallbackDataHash` callback binding set
  and cleared around `pool.take`. Today this lives only in `LifiKeeperTaker`;
  the direct DEX takers intentionally omit it, but every calldata-aggregator
  taker executes arbitrary allowlisted calldata and therefore requires it.
- the exact source-balance check (`UnexpectedSourceBalance`). Calldata
  aggregators are exact-fill by construction: opaque provider calldata cannot
  be re-sized on-chain, so off-chain sizing debt-clamps the take and the
  contract rejects any mismatch. Do not port the factory takers' partial-fill
  pro-rating into this layer.
- the allowlisted low-level call with raw revert bubbling, code-existence
  check, and the zero-value ERC20 route policy
- the output check `quoteReceived >= max(amountOutMinimum,
  TakerTakeScaling.quoteAmountDueCeiling(pool, quoteAmountDue))`. The ceiling
  (+1 token-wei when `quoteTokenScale > 1`) covers the pool's ceil-divided
  quote pull and is a merged audited invariant. A naive floor comparison
  reintroduces the failed-take bug PR #17 fixed for non-18-decimal quote
  tokens.

Do not share LI.FI and Sushi allowlists by accident: keep one isolated taker
deployment per supported calldata-aggregator source, each owning its own
call-target, approval-spender, and selector allowlists. Do not deploy one
multi-source, multi-provider taker unless shared allowlists are an explicit
product decision.

The default shape is thin provider wrappers: `LifiKeeperTaker` remains the
LI.FI concrete wrapper and `SushiAggregatorKeeperTaker` hardcodes the new
Sushi aggregator source id when Packet 3B is reached. The alternative generic
`AggregatorCalldataKeeperTaker` with an immutable supported source id
intrinsically forces `isSourceSupported(...)` (and `getSupportedSources()`)
from `pure` to `view` — immutables are not readable in `pure` — which is a
breaking `IAjnaKeeperTaker` change rippling through every existing taker, the
factory's registration staticcalls, and type generation. Choose it only if a
recorded decision proves it is still strictly cheaper after that cost.

Event rule: a calldata-aggregator taker that logs its call target needs a
provider-distinct event name. `LifiSwapExecuted` is the merged precedent;
Sushi uses `SushiAggregatorSwapExecuted`. Never overload the base
`SwapExecuted` name — same-name event overloads were removed in PR #17 because
they create ambiguous ABIs that ethers v5 warns on and indexers misdecode.

Provider-specific Solidity beyond the thin wrapper should not exist unless
Sushi needs a different callback data shape for a concrete reason. A
`SushiKeeperTaker` that is just a renamed copy of `LifiKeeperTaker` is not
acceptable.

### Factory Compatibility

Packet 1 old-factory handling is only for source id `3` cleanup. First-class
Sushi aggregator support in Packet 3B requires a newly compiled factory and
interface that append the new source id.

- Append the Solidity enum after `Lifi`; do not reindex existing values.
- Append the TypeScript enum in the same numeric position.
- Recompile the factory with the appended enum. `LAST_LIQUIDITY_SOURCE` derives
  from `uint8(type(IAjnaKeeperTaker.LiquiditySource).max)` and auto-extends; do
  not reintroduce a hand-maintained iteration cap — the merged factory removed
  one precisely because it could silently lag the enum.
- Re-point the merged last-source enumeration test in
  `tests/integration/factory-registration.test.ts` from `LIFI` to the appended
  Sushi aggregator id in the same diff, so it keeps guarding the boundary.
- Use the on-chain taker shape chosen and recorded in Packet 2B. Packet 3B must
  not reopen the generic immutable-source vs wrapper decision.
- Deployment/preflight must reject old factory bytecode or old ABI/runtime
  evidence when `sushi_aggregator` is enabled.
- Do not attempt to register the new Sushi aggregator source id through an old
  factory. Old factories are acceptable only for Packet 1 and Packet 2B
  deployments where the supported sources are already in the old enum.

### Shared Offchain Core

Move common calldata-aggregator offchain execution into a provider-neutral
module, such as `src/take/aggregator-calldata/`, before adding Sushi.

The shared offchain core should own:

- a normalized quote contract, for example `ApprovedCalldataAggregatorQuote`
- a typed telemetry/source-filter summary, for example
  `CalldataAggregatorRouteSummary`
- encoded swap-details construction for the shared on-chain calldata shape
- execution quote freshness checks
- quote/context revalidation against the current liquidation
- final min-out floor comparison, priced against the ceil-rounded Ajna quote
  due (the on-chain `quoteAmountDueCeiling` backstop), not the floored due
- debt-clamped exact-fill sizing: key the non-resizable classification on the
  registry's aggregator *category*, not the `calldata_aggregator` family alone
  — 1inch is intentionally outside that family but must keep exact-fill
  sizing. `src/config/external-take-registry.ts` already exports the correct
  category predicate (`isAggregatorExternalTakePath`, true for `oneinch` and
  `lifi`); Packet 2B must give the `calldata_aggregator` path descriptor
  `category: 'aggregator'` and delete `src/take/take-sizing.ts`'s divergent
  local copy of the predicate in favor of the registry one, so Packet 3B
  providers inherit exact-fill sizing without touching the sizing module and
  1inch sizing is provably unchanged
- gas estimation and pre-broadcast failure classification
- submission through the configured take write transport
- shared telemetry fields
- shared route-shape and fork-canary helpers where the provider response has
  already been normalized

`ApprovedCalldataAggregatorQuote` should be the only execution-facing quote
shape for LI.FI and Sushi. It should contain only normalized execution data:

- provider id
- quote timestamp
- input token, output token, recipient, and amount-in token units
- expected output and route-minimum output
- transaction target
- approval spender
- calldata and selector
- `tx.value`
- `CalldataAggregatorRouteSummary`

`CalldataAggregatorRouteSummary` should be typed and normalized. It may contain
only execution-independent telemetry and source-filter fields, such as:

- provider id
- provider route id or quote id, if available
- effective tool/exchange labels
- requested source filters and accepted source filters
- normalized fee/cost fields needed for comparison
- provider warnings as strings or stable codes

It must not contain raw provider response objects, untyped `unknown`, `any`,
provider-specific nested route blobs, or fields that execution approval needs to
interpret.

Raw provider responses must not be embedded in `ApprovedCalldataAggregatorQuote`.
Keep them in provider diagnostics, recorded fixtures, or telemetry envelopes that
do not cross into execution approval. This prevents downstream execution code
from depending on LI.FI- or Sushi-specific response structure.

`ExternalTakeQuoteEvaluation` should carry a shared `calldataQuote` field for
calldata aggregators. Do not add `sushiQuote?` next to the existing LI.FI shape.
Packet 2B must migrate LI.FI from `lifiQuote` to `calldataQuote` in shared route
binding, quote approval, execution, telemetry, and take-decision types. LI.FI
provider code may keep a parser-local provider response type, but it must
normalize into `ApprovedCalldataAggregatorQuote` before route binding or
approval. Do not keep a shared `lifiQuote?` compatibility accessor; that would
preserve the parallel internal state this refactor is meant to delete. Packet 3B
must not introduce provider-specific execution quote fields.

Quote approval should also be shared:

- replace LI.FI runtime approval with a generic
  `approveCalldataAggregatorQuoteForExecution(...)` or equivalent
  descriptor-driven approval helper
- the helper validates canonical path `calldata_aggregator`, expected provider
  id, expected source id, takeability, raw quote amount, min-out floor, and
  normalized `calldataQuote`
- do not keep `approveLifiQuoteForExecution(...)` as a runtime wrapper or public
  approval path; legacy compatibility ends at config/input parsing
- Sushi must not clone `approveLifiQuoteForExecution(...)` or add any equivalent
  provider-specific approval wrapper

Provider-specific code should own:

- API request construction
- API authentication and rate-limit policy
- response parsing
- route-shape normalization
- source-filter semantics
- fee/cost interpretation
- chain, token, amount, recipient, and `from` validation
- provider-labeled telemetry

Packet 2B must not build speculative generic API abstractions before Sushi's
response shape is known. It may extract only logic whose inputs are already
normalized. Packet 2A is the required precursor for freezing the shared quote
shape; if the LI.FI extraction would still require guessing Sushi's shape, stop
and expand the read-only spike instead.

### Packet 2A Read-Only Route-Shape Spike

Packet 2A is a required gate before Packet 2B shared-core extraction, before
first-class Sushi implementation, and before any speculative shared API design:

- request Sushi routes for representative same-chain pairs
- cover the minimum fixture matrix defined in
  `docs/sushiswap-external-take-packet-2a.md`
- normalize the route into the intended shared execution input
- verify target, spender, selector, amount, chain, token, recipient, and value
  fields are available on successful routes or fail closed
- verify Sushi's response can populate `ApprovedCalldataAggregatorQuote`
  without adding provider-specific execution fields
- document the normalized shape before changing the production LI.FI path
- keep any provisional normalized quote type in the read-only spike or tests;
  Packet 2B is where the production shared type is frozen

### Deployment And Preflight

Do not clone `scripts/deployment/lifi-factory-deployment.ts` for Sushi. Extract
provider-neutral deployment/preflight helpers first, then keep LI.FI wrappers for
backward compatibility.

The shared allowlist code must not live under `src/dex/lifi` once Sushi uses it.
Move generic taker allowlist primitives into a neutral module such as
`src/take/aggregator-calldata/allowlist.ts` or
`src/dex/aggregator-calldata/allowlist.ts`:

- allowlist ABI fragments and readers
- snapshot normalization
- reconciliation plan construction
- contains/exact assertion helpers
- selector normalization reusable by deployment and route preflight

LI.FI-specific files may reexport those helpers for compatibility, but the
canonical implementation must be provider-neutral before Sushi is added.

Shared helpers should cover:

- production allowlist normalization
- on-chain allowlist snapshot reads
- reconciliation plan construction
- enable/disable application order
- exact post-configuration assertion
- route deployment preflight
- factory registration after allowlists are configured and verified
- operator gate messages

Provider-specific wrappers should supply:

- artifact name
- source id
- taker contract key
- config reader
- allowlist policy normalizer
- canary command labels

This keeps LI.FI and Sushi aligned without making deployment scripts provider
ambiguous.

## Packet 1: Remove Direct Sushi

Remove active direct Sushi support in one deletion-focused PR. Detailed gates:
`docs/sushiswap-external-take-packet-1.md`.

Roadmap-level requirements:

- Reserve source id `3` as deprecated and unsupported without reindexing existing
  Solidity or TypeScript enum values.
- Before any deletion, migrate the merged audited test surface off Sushi: the
  `factory-registration` fixtures and `MockConfigurableTaker` registrations
  that use source id `3`, the Sushi-hosted invariant cases in
  `taker-hardening.test.ts`, the Sushi sections of the partial-fill and
  quote-guard suites, the `mock-taker-base.ts` Sushi helpers, and the factory
  route harness. Details and the coverage-mapping requirement:
  `docs/sushiswap-external-take-packet-1.md`.
- Remove direct Sushi from external-take registries (canonically
  `src/config/external-take-registry.ts`), route models, quote approval, stats,
  telemetry, deployment, policy artifacts, and docs.
- Remove direct Sushi from post-auction reward-swap config and router plumbing.
- Add fail-closed new-factory and reused-old-factory checks for nonzero source id
  `3` taker mappings.
- Do not replace direct Sushi reward swaps in Packet 1; design post-auction
  aggregator swaps separately if needed later.
- Keep Packet 1 deletion-focused. Do not scatter new Sushi rejection branches
  through hot files when supported registries and types can remove the path.

## Packet 2A: Prove Sushi Route Shape

Run a read-only Sushi route-shape spike before adding Sushi execution support or
guessing at Sushi-specific abstractions. This packet runs before the shared
core extraction so the production quote boundary is not accidentally
LI.FI-shaped.

Scope:

- Add no production execution path.
- Add no Sushi source id.
- Add no Sushi taker or deployment registration.
- Query Sushi's API for the minimum same-chain route fixture matrix defined in
  `docs/sushiswap-external-take-packet-2a.md`.
- Normalize each route into the proposed `ApprovedCalldataAggregatorQuote`
  fields.
- Record target, spender, selector, value, chain, token, amount, recipient, and
  output fields.
- Fail the spike if successful routes cannot provide required execution fields
  without provider-specific execution hacks. Chain-level unavailable routes should
  be classified with the shared Packet 2A/3A `FailureClassification` union.

Packet 2A must add committed recorded fixtures, offline normalizer tests, and the
repo-local tooling-only evidence schema/checker for Packet 2A and Packet 3A. Use
a tooling location such as `tools/external-take-evidence/` plus a command
entrypoint such as `scripts/check-calldata-aggregator-evidence.mjs`; production
`src/**` must not import this checker or its evidence-only types. The checker
owns the shared `ProviderResult`, `SampleRow`, and `FailureClassification`
components plus one discriminated artifact union: `artifactKind: 'route_shape'`
for Sushi-only route-shape evidence and `artifactKind: 'competitiveness'` for
Packet 3A comparison evidence. Packet 2A rows may include only Sushi provider
results; LI.FI/1inch comparison results and `proceed`/`defer` decisions belong
only in Packet 3A and must be rejected in `route_shape` artifacts. A live
read-only script is useful but not sufficient as the only evidence. The fixture
evidence must include the raw provider response, expected normalized fields, and
at least one fail-closed malformed or ambiguous route case. Packet 2A must prove
at least two successful normalized routes on distinct chains, or one successful
fixture for every observed Sushi target/selector response shape, before Packet
2B freezes the shared quote type. Packet 2A may define a provisional normalized
quote fixture for the spike, but it must not modify the live LI.FI runtime path
or freeze the production shared type.

## Packet 2B: Extract Shared Aggregator Core

Refactor LI.FI onto shared calldata aggregator primitives while preserving
behavior.

This packet is a refactor, not a design playground. The extraction must reduce
or isolate existing LI.FI complexity without introducing Sushi config, Sushi
source ids, Sushi execution, Sushi path parsing, or speculative provider
branches. The shared quote contract should be based on Packet 2A evidence.

Hot-file rule: do not add new broad branches to `src/config/validation.ts`,
`src/take/external-take/route.ts`, `src/take/external-take/quote-approval.ts`,
`src/discovery/route-preflight.ts`, or `scripts/deploy-factory-system.ts`.
Packet 2B should move logic out of these files when shared calldata-aggregator
behavior would otherwise make them larger.

Mechanical hot-file gate:

- each packet must declare its exact target base ref for the hot-file check
- fail on any per-file added-line growth in those five files
- fail on additions above 10 lines in any one hot file
- `scripts/deploy-factory-system.ts` must remain below 1000 lines
- add a mechanical check, such as
  `scripts/check-hot-file-growth.mjs` or an equivalent unit test, that compares
  the packet diff against that exact base and fails on per-file added-line
  growth, hot-file additions above 10 lines, final total-line violations, or the
  wrong base ref

Reviewer gate:

- narrow deletion fallout, input-boundary compatibility shims, or fail-closed
  guards may override a mechanical hot-file growth failure only when the packet
  explicitly lists the file, added lines, reason, and why a provider-neutral
  helper cannot own the logic
- reject unrelated compensating deletions
- reject broad branches in the five hot files even if the mechanical line-count
  gate passes

On-chain:

- Promote the aggregator-specific layer out of `LifiKeeperTaker` into
  `BaseAggregatorCalldataTaker is FactoryAuthorizedTakerBase` per the Shared
  Solidity Core section; do not re-extract the merged
  `KeeperTakerBase`/`FactoryAuthorizedTakerBase` mechanics or add a sibling
  base. The wrapper shape is the recorded default; the generic
  immutable-source taker may replace it only with a recorded decision that
  prices in its forced `pure`-to-`view` interface break.
- Keep `LifiKeeperTaker` behavior equivalent and preserve its concrete wrapper
  shape unless that approved generic path explicitly justifies replacing it.
- Preserve LI.FI source id, ownership model, factory authorization, allowlist
  semantics, and the `LifiSwapExecuted` event contract (provider-distinct
  names per the Shared Solidity Core event rule).
- Do not introduce Sushi execution in this packet.

Offchain:

- Extract common execution into provider-neutral calldata aggregator modules.
- Introduce `ApprovedCalldataAggregatorQuote` and shared `calldataQuote`
  plumbing for normalized provider output, using Packet 2A route-shape evidence.
- Introduce `CalldataAggregatorRouteSummary` as the only shared route-summary
  shape for source-filter and telemetry data.
- Introduce provider-id-aware calldata route identity and execution candidate
  identity. Route binding, execution plans, hybrid selection, provider registry
  lookup, stats, and telemetry must carry `providerId` for
  `calldata_aggregator`.
- Introduce `ResolvedExternalTakePolicy` via
  `resolveExternalTakePolicy(...)` in `src/config/route-policy.ts` and pass it
  through route preflight, discovery runtime, hybrid selection, execution
  planning, stats, and telemetry instead of reinterpreting raw config fields in
  each layer.
- Add the Packet 2B config contract for
  `allowedCalldataAggregatorProviders`. Packet 2B enables only provider `lifi`;
  Packet 3B may explicitly enable `lifi`, `sushi_aggregator`, or both.
- Replace shared `lifiQuote?` route/approval/execution fields with
  `calldataQuote`; any LI.FI-specific parsed response type must remain inside
  the LI.FI provider adapter before normalization.
- Replace LI.FI execution approval call sites with the generic
  calldata-aggregator approval helper; do not keep `approveLifiQuoteForExecution`
  or a LI.FI-specific runtime approval wrapper.
- Keep LI.FI provider modules responsible for LI.FI API requests, route-shape
  parsing, fee policy, exchange filters, and telemetry labels.
- Keep LI.FI config names, env inputs, no-spend policy labels, canary commands,
  and operator-facing `lifi` path compatibility intact at input boundaries.
- Internally normalize all LI.FI route binding, approval, adapter kind, strategy
  kind, deployment type, deployment resolution, manual/discovery adapter state,
  and telemetry paths to `calldata_aggregator` plus `providerId: 'lifi'`.
- Migrate external-take path-counter storage, summary-log route groups, and
  failure groups to the same canonical `calldata_aggregator` path plus provider
  id model. `lifi` may remain only as a display/provider label, not as the
  internal stats key.
- Keep LI.FI `allowExchanges` production policy unchanged.
- Shared modules should take normalized provider output. They should not know
  how LI.FI's raw API response is shaped.

Deployment/preflight:

- Extract provider-neutral allowlist deployment/preflight helpers.
- Move reusable allowlist ABI/snapshot/reconciliation/assertion helpers out of
  `src/dex/lifi`; keep LI.FI reexports only for compatibility.
- Rebuild LI.FI deployment/preflight wrappers on those helpers.
- Preserve current LI.FI route-shape and fork-canary gates.
- Preserve fail-closed validation before wallet/deployment writes.
- Keep the global provider identity registry small. Provider quote, deployment,
  allowlist, and canary capabilities should usually be colocated in
  provider-local modules; add a shared layer registry only when it removes real
  duplication and has compile-time `CalldataAggregatorProviderId` coverage
  checks.

Packet 2B is complete only if LI.FI behavior, tests, and deployment flows remain
equivalent after the extraction and the diff removes or isolates complexity
rather than adding generic indirection.

## Packet 3A: Decide Sushi Competitiveness

Decide whether Sushi is worth first-class keeper support before adding permanent
source-id, factory, config, deployment, or runtime surface.

Detailed gates: `docs/sushiswap-external-take-packet-3a.md`.

Packet 3A starts after Packet 2B has shipped the canonical calldata-aggregator
model. It produces a committed typed JSON `artifactKind: 'competitiveness'`
comparison artifact, validates that artifact with the shared Packet 2A/3A
evidence-component checker, and records either `proceed` or `defer`. The Packet
3A wrapper extends the shared `SampleRow` / `ProviderResult` /
`FailureClassification` core with Sushi, LI.FI, and 1inch results plus exactly
one decision/scope block. A `proceed` decision also requires objective
target/selector/spender stability proof for every scoped allowlist entry:
at least three successful samples with distinct timestamps and response hashes
for the same scoped chain/pair/source filter, or an explicit human-reviewed
route-processor allowlist model referenced by `modelDocRef`. `defer` stops
first-class Sushi work without adding permanent keeper surface. Incumbent
LI.FI/1inch failures must be classified, and a coverage-based `proceed` can rely
only on reproducible `unsupported_chain` or `no_route` outcomes, not missing
credentials, rate limits, transient errors, malformed responses, or unstable
allowlist evidence.

## Packet 3B: Add First-Class Sushi Aggregator

Add Sushi as an independent aggregator provider that competes with LI.FI and
1inch on net execution.

Detailed gates: `docs/sushiswap-external-take-packet-3b.md`.

Packet 3B starts only after Packet 3A records `proceed`. It starts from Packet
2B's already-canonical calldata-aggregator core and must not introduce the
canonical `calldata_aggregator` path itself; if Packet 2B has not shipped that
model, Packet 3B is blocked.

Roadmap-level requirements:

- Require the committed Packet 3A `proceed` artifact and inherit its eligible
  chains, pairs, source filters, and allowlist shape.
- Before appending the Sushi source, verify the implementation base still has
  `LIFI = 5`. If so, append `SUSHI_AGGREGATOR = 6`; if another source was
  appended first, append Sushi after the then-current last source and update the
  expected numeric id/tests in the same reviewed diff. Never reuse source id `3`
  or reindex existing ids.
- Require a newly compiled `AjnaKeeperTakerFactory` that knows the appended id.
- Use `deploymentType: 'calldata_aggregator'` with provider id
  `sushi_aggregator`.
- Use the Packet 2B chosen on-chain taker shape for the Sushi deployment.
- Add `dex.sushiAggregator`, `SushiAggregator`, the minimal provider identity
  entry, and Sushi provider-local API/validation modules without growing central
  switchboards.
- Normalize Sushi into `ApprovedCalldataAggregatorQuote`; do not add
  `sushiQuote?` or a provider-specific top-level path.
- Add fail-closed provider validation, allowlists, route-shape canaries, fork
  execution canaries, and provider-labeled telemetry.
- Limit initial Sushi config, allowlists, canary fixtures, and closeout to the
  Packet 3A `proceed` scope, including only target/selector/spender values with
  Packet 3A stability proof. Do not add runtime code that reads the planning
  artifact as a route-eligibility oracle.

## Packet 4: Optional Broad LI.FI Exchange Policy

LI.FI `allowExchanges` is a safety and reproducibility control, not a Sushi
strategy. Keep it explicit in production unless a separate broad-routing policy
is designed and reviewed.

Broad LI.FI exchange routing may improve liquidity discovery, but only if these
remain fail-closed for every resulting route:

- target allowlist
- approval spender allowlist
- selector allowlist
- chain and token validation
- zero-value ERC20 policy
- stale quote rejection
- actual balance-delta min-out checks
- route-shape canaries
- provider drift telemetry

Do not silently remove the production `allowExchanges` requirement while adding
Sushi. If broad routing is desired, add an explicit production mode with its own
tests, canaries, and operator docs.

## Packet 5 Candidate: Retire The `oneinch` Family (Future, Not This Roadmap)

`oneinch` is semantically a calldata aggregator: opaque exact-fill executor
calldata, a single approval target, and a balance-delta output guard. The
terminal architecture is two execution families (`factory`,
`calldata_aggregator`) with 1inch as a third provider — deleting a whole
family, the second approval path, and re-homing the standalone
`AjnaKeeperTaker` onto the shared base. This roadmap deliberately does NOT
implement that (the live 1inch path must not churn while Sushi lands), but it
constrains Packet 2B today:

- the frozen `ApprovedCalldataAggregatorQuote`, route identity, and approval
  helper must be reviewed against 1inch's request shape (router target +
  executor + opaque data, exact-fill) and must not structurally preclude a
  future `oneinch` provider id — without adding any 1inch support now
- the sizing classification is already category-based (covers `oneinch`), so
  no sizing change is needed at unification time

A future packet that performs the unification needs its own design review,
migration plan for live 1inch configs, and an equivalence test bar.

## Test Plan

### Packet 0 Tests

- Run the detailed test gates in `docs/sushiswap-external-take-packet-0.md`.
- The roadmap-level gate is executable hot-file protection before runtime work:
  the checker exists, requires an exact base ref, fails on hot-file growth and
  deploy-script 1000-line violations, and changes no runtime behavior.

### Packet 1 Tests

- Run the detailed test gates in `docs/sushiswap-external-take-packet-1.md`.
- The roadmap-level gate is direct Sushi deletion: source id `3` reserved and
  unsupported, direct Sushi route/reward/deployment/config/stat surfaces gone,
  old-factory checks fail closed, and no new direct Sushi fixtures are added.

### Packet 2A Tests

- Run the detailed test gates in `docs/sushiswap-external-take-packet-2a.md`.
- The roadmap-level gate is durable route-shape evidence:
  `artifactKind: 'route_shape'` fixtures with shared `ProviderResult`,
  `SampleRow`, and `FailureClassification` components from the Packet 2A-owned
  evidence checker, committed successful and classified unavailable-route rows,
  the objective successful-route floor, offline normalizer tests, fail-closed
  malformed cases, no production LI.FI runtime change, and no Sushi
  source/taker/factory registration.

### Packet 2B Tests

- Run the detailed test gates in `docs/sushiswap-external-take-packet-2b.md`.
- The roadmap-level gate is behavior-preserving LI.FI canonicalization:
  `calldata_aggregator` plus provider id `lifi` internally, no `lifiQuote?`, no
  `approveLifiQuoteForExecution`, no internal `lifi` path/kind/deployment
  sentinels or stats keys, `ResolvedExternalTakePolicy` consumed downstream,
  static guard against raw policy interpretation outside the canonical resolver,
  provider-id-aware calldata dispatch, wrapper/base on-chain sharing unless a
  lower-cost generic taker is explicitly approved, 1inch unchanged, no Sushi
  placeholders, and hot-file growth checks passing.

### Packet 3A Tests

- Run the detailed test gates in `docs/sushiswap-external-take-packet-3a.md`.
- The roadmap-level gate is a committed `artifactKind: 'competitiveness'`
  artifact with an explicit `proceed` or `defer` decision, classified incumbent
  failures, scoped Packet 3B eligibility, reuse of the shared Packet 2A/3A
  evidence checker, objective target/selector/spender stability proof for any
  `proceed` scope, and no permanent Sushi implementation surface.

### Packet 3B Tests

- Run the detailed test gates in `docs/sushiswap-external-take-packet-3b.md`.
- The roadmap-level gate is first-class Sushi on the already-shipped
  `calldata_aggregator` core: Packet 3A `proceed`, appended non-reindexed Sushi
  source id, new factory requirement, provider-specific validation,
  provider-id-aware dispatch, shared `calldataQuote`, no `sushiQuote?`, no
  provider-specific top-level path, scoped initial config/allowlists/canaries, no
  runtime artifact-scope dependency, Packet 3A stability proof for configured
  target/selector/spender allowlists, route-shape/fork canaries passing, and the
  roadmap-wide hot-file gate passing for any touched hot file.

### Packet 4 Tests

- Broad LI.FI exchange policy cannot be enabled accidentally in production.
- Broad mode still requires reviewed target/spender/selector policy.
- Broad mode still requires route-shape canaries.
- Broad mode telemetry identifies the effective LI.FI tool for every accepted
  route.

## Acceptance Criteria

### Packet 0

- Acceptance is defined in `docs/sushiswap-external-take-packet-0.md`.
- Packet 0 must land before Packet 1 and provide the hot-file checker without
  runtime/config/contract behavior changes.

### Packet 1

- Acceptance is defined in `docs/sushiswap-external-take-packet-1.md`.
- Packet 1 must remove direct Sushi from active external-take and post-auction
  surfaces while reserving source id `3`, preserving existing enum values, and
  failing closed on stale old-factory source id `3` mappings.

### Packet 2A

- Acceptance is defined in `docs/sushiswap-external-take-packet-2a.md`.
- The spike must produce durable committed route-shape evidence and must not
  change production LI.FI behavior.

### Packet 2B

- Acceptance is defined in `docs/sushiswap-external-take-packet-2b.md`.
- Packet 2B must preserve LI.FI behavior while deleting LI.FI-specific internal
  execution state, keeping 1inch unchanged, avoiding Sushi placeholders,
  introducing one canonical normalized policy boundary, and passing the
  mechanical hot-file gate.

### Packet 3A

- Acceptance is defined in `docs/sushiswap-external-take-packet-3a.md`.
- Packet 3A must record a `proceed` or `defer` decision without adding permanent
  Sushi source-id, factory, config, deployment, provider-id, or runtime surface.
  The validated typed artifact must classify incumbent failures and define the
  Packet 3B scope if the decision is `proceed`.

### Packet 3B

- Acceptance is defined in `docs/sushiswap-external-take-packet-3b.md`.
- Packet 3B must start from a Packet 3A `proceed` decision, reuse Packet 2B's
  canonical calldata-aggregator core, append Sushi as a new non-reindexed
  provider/source id after verifying the implementation base enum, require a
  newly compiled factory, and pass fail-closed provider validation plus
  route-shape/fork canaries. Initial config, allowlists, canary fixtures, and
  closeout must stay within the Packet 3A `proceed` scope without adding a
  runtime dependency on the planning artifact.

### Packet 4

- LI.FI `allowExchanges` remains an explicit production policy control unless a
  reviewed broad-exchange mode is added with equivalent fail-closed route-shape
  and allowlist guarantees.

## Documentation Size Guard

Keep this roadmap below 1000 lines. Future detail belongs in packet-specific
docs linked from this roadmap, such as
`docs/sushiswap-external-take-packet-1.md`,
`docs/sushiswap-external-take-packet-2b.md`, and
`docs/sushiswap-external-take-packet-3b.md`, rather than expanding this file. Do
not add new detailed test matrices or acceptance sublists here; add them to the
packet docs and keep this file as architecture plus packet index.

## Recommended Next Step

Land Packet 0 first to make the hot-file gate executable. Then land Packet 1.
After that, run Packet 2A to prove Sushi's route shape normalizes cleanly. Use
that evidence to extract the shared aggregator core in Packet 2B while
preserving LI.FI behavior and compatibility aliases. Only after that, complete
Packet 3A. Add Sushi as a first-class calldata-aggregator provider in Packet 3B
only if Packet 3A records `proceed`.
Keep broad LI.FI exchange routing as a separate Packet 4 policy decision.
