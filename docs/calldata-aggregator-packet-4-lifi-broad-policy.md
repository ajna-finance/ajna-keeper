# Packet 4: Reviewed Broad LI.FI Exchange Policy

## Purpose

Allow a deliberately reviewed production LI.FI mode that can search broader
exchange liquidity without weakening execution safety.

This packet is not Sushi work. Sushi support remains an independent
`calldata_aggregator` provider with its own allowlists and canaries. Packet 4
does not add providers and does not change 1inch.

## Current Baseline

Production LI.FI config currently requires concrete `allowExchanges`. Broad
filter keywords are canary-only, and production validation fails closed when
`allowExchanges` is missing.

Relevant current surfaces:

- `src/config/schema.ts`: `LifiProductionDexConfig`
- `src/config/lifi-policy.ts`: production LI.FI policy validation
- `src/dex/lifi/filters.ts`: exchange filter normalization and broad-keyword
  rejection
- `src/dex/lifi/route-shape.ts`: fail-closed LI.FI route-shape validation
- `src/dex/lifi/route-canary.ts`: no-broadcast route-shape canary
- `src/take/lifi/*`: provider-local quote and execution wrappers
- `tests/unit/lifi-validation*.test.ts`
- `tests/unit/lifi-config-validation.test.ts`
- `tests/unit/route-preflight.test.ts`

## Non-Goals

- Do not delete LI.FI exchange policy controls.
- Do not make broad routing the default.
- Do not accept routes only because LI.FI returned them.
- Do not relax target, approval-spender, selector, chain, token, native-value,
  quote-age, or balance-delta checks.
- Do not add a new external-take path or provider id.

## Proposed Config Contract

Add an explicit production mode separate from canary broad filters. Example
shape:

```ts
dex: {
  lifi: {
    mode: 'production',
    exchangePolicy: 'reviewed_broad',
    callTargetAllowlist: { [chainId]: [...] },
    approvalSpenderAllowlist: { [chainId]: [...] },
    selectorAllowlist: { [chainId]: { [target]: [...] } },
    denyExchanges?: string[],
    preferExchanges?: string[],
  }
}
```

`exchangePolicy` names are illustrative. The important contract is:

- omitted value preserves today's concrete-allowlist behavior;
- `reviewed_broad` is explicit and production-only;
- `reviewed_broad` cannot be enabled without reviewed target, spender, and
  selector allowlists for the active chain;
- broad canary controls such as `allowBroadExchangeFilters` remain canary-only.

## Implementation

- Extend `LifiProductionDexConfig` with an explicit broad-production policy
  field.
- Update LI.FI config validation so concrete `allowExchanges` remains required
  unless the explicit reviewed-broad mode is set.
- Keep `denyExchanges` and `preferExchanges` normalized and conflict-checked.
- Keep broad LI.FI tool labels out of accepted execution allowlists. Route
  acceptance is still based on the returned target, spender, selector, chain,
  token, value, and quote-shape checks.
- Extend LI.FI quote request building so reviewed-broad mode omits
  `allowExchanges` only through the explicit policy path.
- Extend route-shape canaries to run against broad mode for each reviewed
  production chain/pair.
- Add provider-drift telemetry that records the effective LI.FI top-level tool,
  executable step tool, and whether the route came from reviewed-broad mode.
- Update production docs with the exact operator gate:
  1. reviewed production config;
  2. route-shape canary for the target chain/pair;
  3. callback-path fork execution canary where applicable;
  4. startup preflight against the reviewed deployed taker.

## Security Contract

Every accepted broad LI.FI route must still prove:

- same-chain execution;
- expected input and output tokens;
- expected taker/recipient where the API supports those fields;
- zero native value for ERC20 collateral routes;
- allowlisted transaction target;
- allowlisted approval spender;
- allowlisted calldata selector for the target;
- bounded quote age;
- route minimum output above the approved execution floor;
- actual quote-token balance delta in the callback path;
- no unsupported feeCollection or nested route shape;
- telemetry identifies the effective LI.FI tool.

## Tests

- Existing production configs without `exchangePolicy` still require
  non-empty concrete `allowExchanges`.
- `reviewed_broad` cannot be enabled accidentally by omitting `allowExchanges`.
- `reviewed_broad` rejects missing target, spender, or selector policy.
- Canary broad controls remain rejected in production.
- Broad route validation rejects:
  - unallowlisted target;
  - unallowlisted approval spender;
  - unallowlisted selector;
  - wrong chain;
  - wrong token;
  - non-zero native value;
  - stale quote;
  - unsupported fee/nested/destination-call shapes.
- The route canary proves at least one reviewed broad route per target
  chain/pair, or records an explicit no-route result.
- Telemetry tests assert the effective LI.FI tool is captured for accepted
  reviewed-broad routes.
- Existing concrete `allowExchanges` behavior remains unchanged.

## Acceptance

- Broad LI.FI exchange routing is opt-in and production-explicit.
- Existing LI.FI production configs keep their current safety contract.
- Broad mode does not bypass route-shape validation or taker allowlists.
- Broad mode has route-shape canary coverage and operator documentation.
- No Sushi or 1inch runtime behavior changes.

