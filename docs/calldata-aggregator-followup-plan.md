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

### Packet 5: Retire The `oneinch` Execution Family

Packet 5 is a future architecture migration. It turns 1inch into another
`calldata_aggregator` provider and removes the standalone `oneinch` execution
family only after a reviewed migration and equivalence test bar. The intended
terminal state also removes the legacy standalone `AjnaKeeperTaker` contract and
renames the factory-managed execution entrypoint from "factory" terminology to
router terminology.

See `docs/calldata-aggregator-packet-5-oneinch-provider.md`.

## Shared Guardrails

- Do not add new top-level external-take paths for calldata providers.
- Do not add provider-specific execution approval helpers; normalize provider
  output into `ApprovedCalldataAggregatorQuote` and use the shared approval path.
- Do not add raw provider response payloads to shared execution types.
- Keep behavior out of `AggregatorProviderIdentity`; it remains inert metadata.
- Keep provider parsing, validation, and canaries in provider-local modules or
  narrowly owned shared modules.
- Preserve exact-fill calldata-aggregator mechanics: route freshness, exact
  source amount, zero-value ERC20 policy, actual quote-token balance-delta
  checks, and allowance reset.
- Keep the hot-file checker active for changes to:
  - `src/config/validation.ts`
  - `src/take/external-take/route.ts`
  - `src/take/external-take/quote-approval.ts`
  - `src/discovery/route-preflight.ts`
  - `scripts/deploy-factory-system.ts`

Any hot-file exception must list the file, added lines, reason, and why a
provider-local or provider-neutral helper cannot own the logic.

## Suggested Implementation Order

1. Land the Sushi aggregator PR with planning docs removed.
2. Open a documentation-only PR from this branch, or squash these docs into the
   first follow-up implementation PR.
3. Implement Packet 4 first if the immediate goal is broader LI.FI liquidity
   discovery.
4. Implement Packet 5 only after a separate design review and migration plan,
   because it changes live 1inch contracts/config/runtime semantics.
