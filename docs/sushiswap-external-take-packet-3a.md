# Sushi Aggregator Packet 3A: Competitiveness Decision

## Purpose

Decide whether Sushi is worth first-class keeper support before adding permanent
source-id, factory, config, deployment, or runtime surface.

Packet 3A is evidence-only. It must not append a Sushi aggregator source id, extend
`CalldataAggregatorProviderId`, add `dex.sushiAggregator`, add a taker contract
key, deploy a Sushi taker, or change production route selection.

## Preconditions

- Packet 2A route-shape evidence is committed.
- Packet 2B has shipped `calldata_aggregator` plus provider id as the internal
  model.
- LI.FI and 1inch comparison paths can be queried or explicitly classified for
  the sampled chains.

## Minimum Sample Set

- Cover the Packet 2A minimum chain matrix: Ethereum mainnet, Base, Arbitrum,
  Optimism, Polygon, Avalanche, and Hemi.
- Use the same wrapped-native/common-collateral to production quote/stable-token
  preference as Packet 2A.
- Include at least one keeper-relevant live candidate or pinned liquidation pair
  if available. If unavailable, record why and use the closest keeper-relevant
  substituted pair.
- Declare the sample set before comparing quotes. Do not shrink it after seeing
  provider results.
- Keep every declared chain and pair row in the artifact even if Sushi, LI.FI,
  or 1inch is unavailable for that row.

## Artifact

The committed artifact must be a typed JSON artifact plus a concise markdown
summary. The JSON artifact is the source of truth for Packet 3B gating. It must
use `artifactKind: 'competitiveness'` and reuse the shared `ProviderResult`,
`SampleRow`, and `FailureClassification` components introduced by Packet 2A.
Packet 3A extends route-shape rows with LI.FI and 1inch provider results plus
exactly one decision/scope block; do not create a second provider-result model.

Reuse the tooling-only evidence schema/checker introduced by Packet 2A, such as
`tools/external-take-evidence/` plus
`scripts/check-calldata-aggregator-evidence.mjs`. Packet 3A may add
competitiveness-specific checker rules in the same owner module, but it must not
create a second comparison fixture checker or second provider-result model. The
checker must fail on missing sample rows, unknown failure classifications,
invalid success/failure shapes, placeholder success-only fields in failure rows,
multiple decisions, coverage-based `proceed` without reproducible
`unsupported_chain` or `no_route` incumbent failures, unstable or unproven
allowlist evidence, or a `proceed` decision without an explicit Packet 3B scope.
Production `src/**` must not import the evidence checker, evidence-only types, or
comparison artifacts.

The JSON artifact must include, for each sampled chain and pair:

- chain, token pair, amount, timestamp, and quote request parameters
- one discriminated provider result for each of Sushi, LI.FI, and 1inch
- whether Sushi adds a materially distinct successful route or better net
  execution than the incumbents
- the chains, token pairs, and route-source constraints that would be eligible
  for Packet 3B if the decision is `proceed`
- allowlist-stability evidence for every target, selector, and spender in the
  proposed Packet 3B scope

Each provider result must be one of:

- `status: success`: include expected output, gas estimate, net quote-token value
  after gas, execution target, selector, approval spender, route/source-filter
  evidence, and relevant provider warnings or route ids.
- `status: failure`: include one explicit classification, provider error code or
  summarized response evidence, and whether the failure was reproducible.
  Failure rows must not include placeholder output, gas, target, selector, or
  spender fields.

Failure classifications are:

- `unsupported_chain`
- `no_route`
- `missing_credentials`
- `rate_limited`
- `transient_error`
- `malformed_response`
- `other`

## Decision

Record exactly one decision:

- `proceed`: Sushi is non-dominated on at least one keeper-relevant route, or
  adds materially distinct successful coverage where LI.FI or 1inch has a
  reproducible `unsupported_chain` or `no_route` classification, and every
  target/selector/spender in the proposed Packet 3B scope has objective
  allowlist-stability evidence.
- `defer`: Sushi is unsafe, requires provider-specific execution quote fields,
  has unstable allowlist targets, needs route-shape exceptions, or is safe but
  not materially competitive. Apparent Sushi advantage from incumbent
  `missing_credentials`, `rate_limited`, `transient_error`,
  `malformed_response`, or unclassified comparison failures is not enough to
  proceed.

There is no bypass that permits first-class Sushi code after a `defer` decision.
If that becomes desirable, it needs a separate reviewed packet with explicit
surface area and cost justification.

A `proceed` decision does not authorize blanket Sushi enablement. It only
unlocks Packet 3B for the chains, pairs, source filters, and allowlist shape
that the Packet 3A artifact actually justified.

Allowlist-stability evidence must be one of:

- at least three successful route-shape samples for the same scoped
  chain/pair/source filter showing the same target, selector, and spender across
  independent refreshes. Each sample must record a distinct timestamp and
  response hash, and should include a provider request id when available; or
- an explicit human-reviewed route-processor allowlist model with `modelDocRef`
  that explains why the target, selector, and spender are stable for the scoped
  chain/pair/source filter.

If neither proof is available, the artifact must record `defer`.

## Tests

- Artifact covers the required sample set.
- Artifact records the sample set before result comparison.
- Artifact keeps every declared chain/pair row even when a provider is
  unavailable.
- JSON artifact has `artifactKind: 'competitiveness'`, passes the repo-local
  schema/checker, reuses the shared evidence components, and the markdown
  summary is derived from that checked artifact.
- Artifact uses the Packet 2A evidence checker owner; no second provider-result
  schema, comparison fixture checker, or local-only JSON model is added.
- Production `src/**` has no imports from the evidence checker, evidence-only
  types, or comparison artifacts.
- Artifact records one discriminated Sushi, LI.FI, and 1inch provider result for
  each sample.
- Successful provider results include output, gas, net value, target, selector,
  spender, route/source-filter evidence, and relevant warnings or route ids.
- Failed provider results include classification, provider error/response
  evidence, and reproducibility status, with no placeholder success-only fields.
- Coverage-based `proceed` is rejected if the incumbent failure is only
  credentials, rate limiting, transient provider behavior, malformed response,
  or an unclassified error.
- `proceed` artifact records the chains, pairs, source filters, and allowlist
  shape eligible for Packet 3B.
- `proceed` artifact records at least three matching route-shape samples with
  distinct timestamps and response hashes, or an explicit route-processor
  allowlist model with `modelDocRef`, for every target, selector, and spender in
  the Packet 3B scope.
- Decision is exactly `proceed` or `defer`.
- Artifact checker rejects malformed provider results, multiple decisions, and
  `proceed` artifacts without explicit Packet 3B scope or objective
  allowlist-stability evidence.
- Packet diff contains no source-id, factory, config, deployment, provider-id, or
  runtime Sushi aggregator surface.

## Acceptance

- Packet 3A closes with a committed artifact and explicit `proceed` or `defer`
  decision.
- Packet 3A closeout includes the passing artifact-checker command and result.
- `proceed` is the only condition that unlocks Packet 3B.
- Packet 3B scope is limited to the chains, pairs, source filters, and allowlist
  shape justified by the `proceed` artifact.
- `proceed` scope includes objective target/selector/spender stability proof;
  otherwise Packet 3A records `defer`.
- Evidence checker and comparison artifacts remain tooling-only and are not
  imported by production `src/**`.
- `defer` stops first-class Sushi work without adding permanent keeper surface.
