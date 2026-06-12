# Sushi Aggregator Packet 2A: Route-Shape Spike

## Purpose

Prove Sushi's current same-chain API responses can normalize into the proposed
calldata-aggregator execution quote before Packet 2B freezes shared LI.FI/Sushi
types.

## Scope

- Add no production execution path.
- Add no Sushi source id.
- Add no Sushi taker or deployment registration.
- Do not modify the live LI.FI runtime path.
- Query Sushi's API for the minimum same-chain route fixture matrix.
- Normalize each route into the proposed `ApprovedCalldataAggregatorQuote`
  fields.
- Record target, spender, selector, value, chain, token, amount, recipient, and
  output fields.
- Fail the spike if successful Sushi routes cannot provide required execution
  fields without provider-specific execution hacks. Chain-level `no_route` or
  `unsupported_chain` results should be recorded as classified fixtures, not
  treated as route-shape failures.

## Evidence Requirements

- Commit a typed JSON route-shape artifact with
  `artifactKind: 'route_shape'`.
- Add the repo-local tooling-only evidence schema/checker in Packet 2A. This is
  the single owner for the shared evidence components and artifact wrappers used
  by both Packet 2A and Packet 3A. Decide the validation mechanism once here:
  either a small schema-validation devDependency (e.g. `zod`) or hand-rolled
  checks — and record the choice; Packet 3A must not introduce a second
  mechanism.
- Place the checker in a tooling-only location such as
  `tools/external-take-evidence/`, with a command entrypoint such as
  `scripts/check-calldata-aggregator-evidence.mjs`.
- Production `src/**` must not import the checker, its evidence-only types, or
  recorded evidence fixtures. The checker may validate proposed production field
  names, but it must not freeze or export production
  `ApprovedCalldataAggregatorQuote` types before Packet 2B.
- The checker must define one discriminated artifact union:
  - `artifactKind: 'route_shape'`: Sushi-only route-shape rows with no
    competitiveness decision.
  - `artifactKind: 'competitiveness'`: comparison rows plus exactly one
    decision/scope block, for Packet 3A.
- The artifact must use the shared evidence components from that checker:
  - `ProviderResult`: a discriminated provider success/failure result.
  - `SampleRow`: chain, token pair, amount, timestamp, quote request parameters,
    and provider results.
  - `FailureClassification`: the failure union listed below.
- Packet 2A rows may contain only Sushi `ProviderResult` values. LI.FI/1inch
  provider results and `proceed`/`defer` decision fields are invalid in a
  `route_shape` artifact.
- The minimum matrix covers Ethereum mainnet, Base, Arbitrum, Optimism, Polygon,
  Avalanche, and Hemi. Each row must be either a successful normalized route or a
  classified unavailable-route fixture.
- Successful fixture coverage must meet an objective floor before Packet 2B can
  freeze the shared quote type: at least two successful normalized routes on
  distinct chains, or one successful fixture for every distinct Sushi
  target/selector response shape observed during the spike. If neither floor is
  met, Packet 2B is blocked or explicitly scope-limited to the proven shape.
  Packet 2A is not the all-chain coverage or competitiveness decision; Packet 3A
  owns that decision.
- Prefer wrapped-native or common collateral input into the chain's production
  quote/stable token. If that pair is unavailable, record the substituted
  keeper-relevant pair and why it was chosen.
- Classify unsuccessful rows with the same failure-classification union used by
  Packet 3A: `unsupported_chain`, `no_route`, `missing_credentials`,
  `rate_limited`, `transient_error`, `malformed_response`, or `other`, with
  summarized provider evidence.
- Commit at least one malformed or ambiguous Sushi route fixture that fails
  closed.
- Include raw provider response fixtures only in this spike evidence; raw
  responses must not cross into execution approval.
- Add offline normalizer tests over the recorded fixtures.
- A live read-only script is useful for refreshing evidence, but it is not
  sufficient as the only proof.
- A provisional normalized quote fixture is allowed in Packet 2A, but Packet 2B
  is where the production shared type is frozen.

## Tests

- Recorded Sushi route fixtures normalize into the proposed
  `ApprovedCalldataAggregatorQuote` fields.
- Recorded route-shape artifact has `artifactKind: 'route_shape'` and uses the
  shared `ProviderResult`, `SampleRow`, and `FailureClassification` components
  from the Packet 2A evidence checker.
- The Packet 2A checker rejects `route_shape` artifacts that include LI.FI/1inch
  provider results, comparison-only fields, or `proceed`/`defer` decisions.
- The checker includes the `competitiveness` artifact wrapper shape that Packet
  3A must reuse, but Packet 2A does not populate a competitiveness artifact.
- A boundary test or static check fails if production `src/**` imports the
  tooling-only evidence checker, its types, or recorded route-shape artifacts.
- Recorded fixture rows cover Ethereum mainnet, Base, Arbitrum, Optimism,
  Polygon, Avalanche, and Hemi as either successful normalized routes or
  classified unavailable-route fixtures.
- Successful route fixtures satisfy the objective floor: at least two distinct
  successful chains, or every observed Sushi target/selector response shape.
- Normalized Sushi routes include target, spender, selector, value, chain, input
  token, output token, amount-in, recipient, expected output, and minimum output.
- Missing or ambiguous required execution fields fail closed.
- Packet 2A contains no live Sushi source id, no taker deployment, and no
  factory registration.
- Packet 2A does not modify the production LI.FI runtime path.

## Acceptance

- Sushi route-shape evidence proves successful routes normalize into the proposed
  `ApprovedCalldataAggregatorQuote` fields, and records classified unavailable
  rows for the rest of the minimum matrix.
- Packet 3A can reuse Packet 2A `SampleRow`, `ProviderResult`, and
  `FailureClassification` data and the same repo-local checker without
  provider-result schema conversion or a second artifact model.
- Packet 2B freezes only response shapes proven by the objective successful-route
  floor.
- Evidence schema/checker code remains tooling-only; production `src/**` has no
  imports from the evidence tooling or recorded artifacts.
- Route-shape evidence includes committed fixtures and offline tests, not only a
  live API script.
- Required execution fields are present or the normalizer fails closed.
- No production LI.FI behavior changes in the spike.
