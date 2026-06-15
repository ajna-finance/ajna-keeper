# Calldata Aggregator Follow-Up Plan

## Purpose

This document preserves the future-work material from the Sushi aggregator
roadmap after the Sushi implementation PR is cleaned of planning docs.

The baseline assumed by these packets is the merged Sushi aggregator work:

- direct SushiSwap router support is removed;
- `LiquiditySource.SUSHISWAP = 3` remains reserved and unsupported;
- LI.FI and Sushi both use the canonical `calldata_aggregator` execution
  family;
- calldata providers dispatch by `{ path: 'calldata_aggregator', providerId }`;
- `ResolvedExternalTakePolicy` is the only post-validation policy boundary for
  external-take family/provider/default-source decisions;
- `ApprovedCalldataAggregatorQuote` is the only execution-facing quote shape for
  calldata aggregators;
- LI.FI and Sushi use thin provider takers over `BaseAggregatorCalldataTaker`;
- production calldata aggregator routes require fail-closed target, spender, and
  selector allowlists plus route-shape and fork canaries before live use.

## Packets

### Packet 4: Reviewed Broad LI.FI Exchange Policy

Packet 4 is a LI.FI policy expansion. It does not change Sushi behavior and does
not move 1inch into the calldata-aggregator family.

See `docs/calldata-aggregator-packet-4-lifi-broad-policy.md`.

### Packet 5: Retire The `oneinch` Execution Family And Factory Naming

Packet 5 is a future architecture migration. It turns 1inch into another
`calldata_aggregator` provider, migrates the factory-managed route family to the
canonical `direct_dex` path name, and renames the factory-managed execution
entrypoint to `TakerRouter`. The intended implementation PR should absorb the
legacy standalone `AjnaKeeperTaker` into the new 1inch calldata-aggregator taker
path and remove standalone production dispatch after the reviewed equivalence
bar passes inside that PR.

See `docs/calldata-aggregator-packet-5-oneinch-provider.md`.

## Shared Guardrails

- Do not add new top-level external-take paths for calldata providers.
- Do not add provider-specific execution approval helpers; normalize provider
  output into `ApprovedCalldataAggregatorQuote` and use the shared approval path.
- Do not add raw provider response payloads to shared execution types.
- Do not create a second or third route/provider identity registry. Packet 5
  should refactor the existing external-take registry into one canonical
  descriptor module, preferably `src/config/external-take-descriptors.ts`, and
  remove `src/config/aggregator-provider-identity.ts` as an exported terminal
  surface. Do not leave a thin identity wrapper around the same descriptor data.
- Do not implement runtime compatibility aliases for retired Packet 5 config
  names. Retired names should fail validation with explicit migration errors;
  after validation, production route identity should use canonical path/provider
  ids only. Because this is a single-operator cleanup, retire the legacy top-level
  `lifi` configured path alias too; operators must use `calldata_aggregator`
  plus provider id `lifi`.
- Manual/per-pool execution, autodiscovery, deployment resolution, preflight,
  approval, stats, and telemetry must all consume canonical route/provider
  identity. Do not preserve a source-only manual route selector or a separate
  `deploymentType` family enum after validation.
- Retired Packet 5 names are also retired from scripts, CLI flags, env vars,
  generated artifacts, and fixture docs. Do not keep compatibility flags or
  env aliases for `factory`, `factory_first`, `defaultFactoryLiquiditySource`,
  `keeperTakerFactory`, `takers.factory`, standalone `oneinch`, legacy top-level
  `lifi` path aliases, or `takers.oneInch`.
- Packet 5 must add and run an executable static boundary check, exposed as
  `npm run check-external-take-boundaries -- --base <ref>`. The checker may
  import or read the canonical route/provider descriptor for active names, but
  retired-term allow/deny contexts must live in the checker or its test fixtures,
  not in production descriptor metadata.
- Keep provider parsing, validation, and canaries in provider-local modules or
  narrowly owned shared modules. Shared route, preflight, approval, and telemetry
  code should consume canonical descriptor/router helpers instead of growing new
  source/path switch branches.
- Keep the canonical descriptor declarative. It should own route/provider/source,
  taker-key, deployment, manual-route, preflight-capability, stats, circuit-key,
  and telemetry-label metadata, but provider-local quote, execute, route-shape,
  canary, allowlist-reader, and preflight-hook behavior stays in provider-local
  adapters keyed by descriptor identity.
- Packet 5 must rename the production direct DEX module family, not only
  operator-facing labels: `src/take/factory/*`, factory-named exported symbols,
  and factory-named production tests should move to direct-DEX terminology unless
  the file is explicitly testing migration errors.
- Preserve exact-fill calldata-aggregator mechanics: route freshness, exact
  source amount, zero-value ERC20 policy, actual quote-token balance-delta
  checks, and allowance reset.
- Keep the hot-file checker active for changes to:
  - `src/config/validation.ts`
  - `src/take/external-take/route.ts`
  - `src/take/external-take/quote-approval.ts`
  - `src/discovery/route-preflight.ts`
  - `scripts/deploy-factory-system.ts`
  - `scripts/run-fixture-keeper-harness.ts`
  - `scripts/no-spend/harness-artifacts.ts`
  - `scripts/create-liquidatable-ajna-fixture.ts`

Packet 5 should be decomposed before adding net code to any hot file above.
Hot-file remediation must extract by domain ownership, not by line-count
appeasement. Moving code from a hot file into arbitrary wrappers is not a valid
fix if it creates a second route identity map, hides fail-closed validation, or
turns provider-specific behavior into generic shared utilities. The intended
ownership split is:

- provider policy, provider allowlists, provider route-shape validation, quote
  normalization, execution adapters, canaries, and provider-specific preflight
  hooks stay in provider-local modules keyed by canonical descriptor identity;
- canonical route/provider/source/taker/deployment/manual-route/stats/telemetry
  metadata stays declarative in the descriptor layer;
- shared route binding, quote approval, route preflight, discovery telemetry,
  and config validation stay thin and consume descriptor/provider helpers instead
  of adding new source/path switch branches;
- script CLI files stay thin and delegate reusable deployment, fixture, harness,
  and artifact materialization logic to named script helper modules.

Compatibility boundaries are not ownership boundaries. Old hot-file module paths
may remain as one-line re-export shims only to avoid breaking outside-tree import
paths during a packet, and operator-facing script filenames may remain as thin
CLI dispatchers because `package.json`, docs, and automation call those exact
paths. Repo-internal production code and tests must import the named ownership
module directly (`*-rules`, `*-binding`, focused provider modules, or focused
script helpers), not the compatibility shim. The hot-file checker enforces this
with a `compatibility-import` failure for repo imports from compatibility-only
hot modules.

The implementation PR must expand `scripts/check-hot-file-growth.ts` to cover the
Packet 5 script hot files before touching their factory/router naming, artifact,
or CLI/env parsing logic. Its closeout must run
`npm run check-hot-file-growth -- --base <ref>` and
`npm run check-external-take-boundaries -- --base <ref>` against the declared PR
base.
`src/config/validation.ts`, `src/take/external-take/quote-approval.ts`,
`src/discovery/route-preflight.ts`, `src/take/external-take/route.ts`, and
`scripts/deploy-factory-system.ts`, plus the fixture/no-spend scripts listed
above, are already large enough that more branching should be treated as a
design failure. Any hot-file exception must list the file, added lines, reason,
which extraction was attempted first, why the canonical descriptor, router
helper, provider-local module, provider-neutral helper, or focused script helper
cannot own the logic, and which focused tests prove the remaining hot-file logic
is still fail-closed.

## Suggested Implementation Order

1. Land the Sushi aggregator PR with planning docs removed.
2. Open a documentation plus guardrail PR from this branch, or squash these docs
   into the first follow-up implementation PR.
3. Implement Packet 4 first if the immediate goal is broader LI.FI liquidity
   discovery.
4. Implement Packet 5 as a single reviewed migration PR only after design
   review, because it changes live 1inch contracts/config/runtime semantics.
   The PR should include a rename inventory covering config, discovery,
   manual/per-pool routing, deployment resolution, execution, telemetry,
   production module paths, scripts, tests, and docs before code is merged. The
   PR should be internally staged as:
   1. canonical descriptor refactor with no behavior change;
   2. mechanical `factory` -> router and `direct_dex` rename with no 1inch
      execution change;
   3. 1inch provider migration into `calldata_aggregator`;
   4. standalone 1inch/runtime alias deletion.
