# Sushi Aggregator Packet 3B: First-Class Provider

## Purpose

Add Sushi as an independent calldata-aggregator provider only after Packet 3A
records `proceed`.

Packet 3B is blocked until Packet 2B has shipped `calldata_aggregator` plus
provider id as the internal model, and Packet 3A has committed a `proceed`
decision. Do not implement first-class Sushi after a Packet 3A `defer`
decision.

Packet 3B must use the Packet 3A `proceed` scope as an initial config,
allowlist, canary, and closeout bound. The Packet 3A artifact is not a runtime
oracle; live code must enforce typed config, allowlists, chain/token checks,
source-filter validation, and canaries.

Before appending Sushi, Packet 3B must verify the implementation base enum. If
`LiquiditySource.LIFI` / `IAjnaKeeperTaker.LiquiditySource.Lifi` is still the
last source at numeric value `5`, Sushi should append as `SUSHI_AGGREGATOR = 6`.
If another source has already been appended, Sushi must append after the
then-current last source and update the expected numeric id/tests in the same
reviewed diff. It must never reuse source id `3` or reindex existing sources.

## Implementation

- Append the new Sushi aggregator liquidity source id after the current last
  source. The expected id is `SUSHI_AGGREGATOR = 6` only when the implementation
  base still has `LIFI = 5`.
- Append the Solidity enum and TypeScript enum; do not reuse source id `3` or
  reindex existing ids.
- Deploy or require an `AjnaKeeperTakerFactory` compiled with the appended enum
  and updated source-iteration cap.
- Reuse Packet 2B's canonical `calldata_aggregator` path. Do not add path
  support in this packet.
- Extend `CalldataAggregatorProviderId` with `sushi_aggregator` and use the
  provider-level enablement model from Packet 2B. The operator must be able to
  enable LI.FI only, Sushi only, or both under the same `calldata_aggregator`
  family by setting `allowedCalldataAggregatorProviders`. Existing configs with
  the provider list omitted remain LI.FI-only; adding Sushi must not silently
  enable Sushi.
- Route deployment resolution uses `deploymentType: 'calldata_aggregator'` with
  provider id `sushi_aggregator`.
- LI.FI compatibility aliases continue to normalize into the same model.
- Add `dex.sushiAggregator`.
- Add `SushiAggregator` as a taker contract key.
- Use the on-chain taker shape chosen and recorded in Packet 2B. If Packet 2B
  kept the default wrapper/base shape, add `SushiAggregatorKeeperTaker` as a thin
  wrapper over the shared on-chain core. If Packet 2B explicitly approved the
  generic immutable-source taker, deploy it with the Sushi source id.
- Add a Sushi API client and provider validator.
- Add Sushi route-shape normalization into the provider-specific layer.
- Normalize Sushi responses into `ApprovedCalldataAggregatorQuote`; do not add
  `sushiQuote?` or a Sushi-only approval type.
- Limit initial Sushi deployment config, allowlists, and canary fixtures to the
  Packet 3A `proceed` scope. Do not add runtime code that reads a planning
  artifact to decide route eligibility. Enabling Sushi on a new chain or route
  requires a new reviewed evidence artifact before the config/allowlist change.
- Add Sushi canary and fork execution configuration using the shared canary
  infrastructure.
- Add provider-labeled telemetry while preserving shared execution telemetry.
- Reject old factory deployments before any wallet/deployment writes when
  provider id `sushi_aggregator` is enabled.
- Do not grow `src/config/validation.ts` or `scripts/deploy-factory-system.ts`
  with Sushi-specific branches. Add focused provider modules and descriptor
  entries instead.
- The Packet 2B hot-file gate still applies; Packet 3B should add provider-local
  modules and only the minimal identity/registry entries needed for cross-provider
  dispatch, not expand central switchboards or parallel provider maps.
- Do not put Sushi deployment validation, allowlist policy, route-source
  semantics, API parsing, or canary behavior into `AggregatorProviderIdentity`.
- The roadmap-wide hot-file gate applies to any Packet 3B changes in
  `src/config/validation.ts`, `src/take/external-take/route.ts`,
  `src/take/external-take/quote-approval.ts`, `src/discovery/route-preflight.ts`,
  or `scripts/deploy-factory-system.ts`.

## Security Contract

- route request pins same-chain execution
- `tx.to` is allowlisted per chain
- approval spender is allowlisted per chain
- calldata selector is allowlisted per target
- `tx.value` policy is explicit; ERC20 collateral routes should default to
  zero-value only
- route freshness is bounded by max quote age
- output floor is based on Sushi's minimum output, the Ajna quote due, and the
  keeper's profitability policy
- taker approves only the exact received collateral amount
- taker verifies actual quote-token balance delta, ignoring optimistic return
  data
- taker clears allowance after the call
- gas estimation happens before broadcast and failure is classified as
  pre-broadcast
- route-shape canary and fork execution canary pass before live use

## Offchain Validations

- chain ID in route response matches keeper chain ID
- `from` and recipient are the taker contract where the API supports those
  fields
- input token equals pool collateral token
- output token equals pool quote token
- amount in token units equals the actual callback collateral amount or an
  approved bounded conversion
- Sushi route target selector stays stable for the configured allowlist
- any source-filtering or route-source metadata is validated before claiming
  "SushiSwap-only" liquidity

## Tests

- Packet 3A artifact exists, records `proceed`, and defines the chains, pairs,
  source filters, and allowlist shape eligible for Packet 3B.
- Base enum precondition is recorded before edits: either `LIFI = 5` and Sushi
  appends as `SUSHI_AGGREGATOR = 6`, or the packet updates the expected Sushi id
  after proving another source was already appended.
- New Sushi aggregator source id is appended after the current last source and
  does not reuse source id `3` or reindex existing ids.
- Solidity `IAjnaKeeperTaker.LiquiditySource` and TypeScript `LiquiditySource`
  append the same Sushi aggregator numeric id.
- `AjnaKeeperTakerFactory` source iteration includes the new Sushi aggregator id,
  and `getConfiguredTakers()` can surface it.
- Deployment/preflight rejects an old factory when provider id
  `sushi_aggregator` is enabled.
- Config/operator path parsing accepts `lifi` as a compatibility alias, but
  internal route binding and execution use canonical `calldata_aggregator` plus
  provider id `lifi`.
- Deployment resolution identifies the route as
  `deploymentType: 'calldata_aggregator'` with provider id `sushi_aggregator`.
- `dex.sushiAggregator` validation is separate from `dex.sushiswap`.
- The chosen on-chain taker shape supports only the Sushi aggregator source id
  for the Sushi deployment.
- If Packet 2B kept the default wrapper/base shape,
  `SushiAggregatorKeeperTaker` is a thin source-id wrapper and `IAjnaKeeperTaker`
  mutability remains unchanged.
- If Packet 2B approved the generic immutable-source taker, Packet 3B proves the
  deployed Sushi instance's immutable source id is the appended Sushi aggregator
  source.
- Sushi allowlists are isolated from LI.FI allowlists.
- Packet closeout proves Sushi deployment config, allowlists, and canary fixtures
  match the Packet 3A `proceed` scope, and no runtime artifact-scope dependency
  was added.
- Packet closeout proves every configured target, selector, and spender is within
  the Packet 3A allowlist-stability evidence.
- Sushi API response with wrong chain ID is rejected.
- Sushi API response with unallowlisted `tx.to` is rejected.
- Sushi API response with unallowlisted approval spender is rejected.
- Sushi API response with unallowlisted selector is rejected.
- Sushi quote expires after max quote age.
- Fork canary executes a Sushi route and verifies actual quote-token balance
  delta.
- Sushi aggregator execution reuses the shared aggregator calldata core and the
  shared `calldataQuote` approval path.
- Provider registry lookup and hybrid selection dispatch Sushi and LI.FI by
  `{ path: 'calldata_aggregator', providerId }`, so enabling both providers does
  not create path-key collisions.
- Provider-level enablement tests cover LI.FI only, Sushi only, and LI.FI plus
  Sushi under the same `calldata_aggregator` family.
- Provider-level enablement tests prove an omitted provider list remains
  LI.FI-only after Sushi is added.
- No `sushiQuote?` execution field or Sushi-only approval clone is added.
- No provider-specific top-level path, `lifiQuote?`, or raw provider metadata
  backdoor is added while integrating Sushi.
- Provider-specific tests cover only Sushi parsing, source-filter semantics, fee
  interpretation, and telemetry labels.
- Any roadmap hot-file edits pass the roadmap-wide hot-file check against the
  exact packet base ref.

## Acceptance

- Packet 3B starts only from a committed Packet 3A `proceed` decision.
- Packet 3B initial config, allowlists, canary fixtures, and closeout are limited
  to the chains, pairs, source filters, and allowlist shape justified by the
  Packet 3A `proceed` artifact.
- First-class Sushi support is implemented as aggregator calldata.
- Sushi uses new config key `dex.sushiAggregator` plus an appended, non-reindexed
  Sushi aggregator source id.
- Sushi uses the canonical `calldata_aggregator` path/family with provider id
  `sushi_aggregator`; no provider-specific top-level path is added.
- Sushi and LI.FI dispatch through provider-id-aware calldata aggregation; they
  do not compete for a single path-keyed provider slot.
- Sushi requires a newly compiled factory that supports the appended source id;
  old factories are rejected for Packet 3B.
- Sushi uses an isolated taker deployment over the shared on-chain core.
- Sushi provider validation, allowlists, route-shape canary, and fork canary are
  fail-closed before live use.
- Sushi allowlists are limited to target/selector/spender values with Packet 3A
  stability proof.
- Sushi execution uses shared `calldataQuote` approval and execution plumbing;
  provider-specific code is limited to API validation, normalization,
  source-filter semantics, fee interpretation, and telemetry labels.
- Sushi does not add `sushiQuote?`, revive `lifiQuote?`, or add raw provider
  response payloads to shared execution types.
