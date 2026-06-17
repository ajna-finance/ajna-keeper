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
- `src/config/lifi-policy.ts`: top-level production LI.FI policy validation
- `src/dex/lifi/chain-policy.ts`: per-chain target, spender, selector, and
  production exchange-filter policy validation
- `src/dex/lifi/filters.ts`: exchange filter normalization and broad-keyword
  rejection
- `src/dex/lifi/route-shape.ts`: fail-closed LI.FI route-shape validation
- `src/dex/lifi/route-canary.ts`: no-broadcast route-shape canary
- `src/take/lifi/*`: provider-local quote and execution wrappers
- `tests/unit/lifi-validation*.test.ts`
- `tests/unit/lifi-config-validation.test.ts`
- `tests/unit/route-preflight.test.ts`

New implementation surface:

- `src/dex/lifi/exchange-policy.ts`: intended owner for the normalized
  `LifiExchangePolicy` value.

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

`exchangePolicy` is the discriminator for production LI.FI exchange policy.
Do not make `allowExchanges` generically optional on a single broad
`LifiProductionDexConfig` shape. The config type should become a discriminated
union:

```ts
type LifiProductionDexConfig =
  | LifiConcreteAllowlistProductionDexConfig
  | LifiReviewedBroadProductionDexConfig;
```

`LifiConcreteAllowlistProductionDexConfig` keeps today's requirement that
`allowExchanges` is present and non-empty. Its omitted `exchangePolicy` value
normalizes to `concrete_allowlist` so current production behavior stays
unchanged. `LifiReviewedBroadProductionDexConfig` requires
`exchangePolicy: 'reviewed_broad'` and does not accept `allowExchanges`; it uses
reviewed target, spender, selector, and optional deny/prefer controls instead.
That exclusion must be enforced by runtime config validation as well as by
TypeScript types, because operator config can arrive through non-fresh objects or
JavaScript-loaded files.

The important contract is:

- `concrete_allowlist` requires non-empty concrete `allowExchanges`, as today;
- `reviewed_broad` is explicit and production-only, and the reviewed-broad
  production variant omits `allowExchanges` by type instead of relying on loose
  optionality;
- `reviewed_broad` cannot be enabled without reviewed target, spender, and
  selector allowlists for the active chain;
- broad canary controls such as `allowBroadExchangeFilters` remain canary-only.

## Reviewed-Broad Validation Contract

`reviewed_broad` changes only how LI.FI is asked to search exchange liquidity.
It does not mean "accept any LI.FI route." The route validator needs an explicit
policy object, not scattered `exchangePolicy === 'reviewed_broad'` branches.
Normalize production config once into a `LifiExchangePolicy` value consumed by
request building, quote validation, chain-policy validation, canaries, and
telemetry.

That normalized policy must enforce:

- allow `allowedExchangeTools` to be empty only when
  `exchangePolicy === 'reviewed_broad'`;
- keep validating `denyExchanges` and `preferExchanges` against LI.FI `/tools`
  when those filters are configured;
- keep rejecting known unsupported or broad filter tokens in production config;
- keep enforcing call target, approval spender, selector, chain, token,
  recipient, native-value, quote-age, fee-shape, and nested-route checks;
- require the returned top-level tool and executable step tool to be captured in
  the approved quote/canary result, even though they are not allowlisted by name;
- update require-live route canaries so they can run reviewed-broad production
  configs without falling back to canary-only broad controls.

## Reviewed Scope Artifact

The broad-policy approval must leave a durable source of truth in production
config or operator docs. It should record:

- reviewed chain ids and token pairs;
- reviewed target and approval-spender allowlists for each chain;
- reviewed selector allowlists keyed by target;
- optional denied or preferred LI.FI tools;
- observed LI.FI top-level tool, executable step tool, transaction target,
  approval spender, and selector for each accepted route;
- route-shape canary command, timestamp, and result for each reviewed
  chain/pair;
- callback-path fork canary command, timestamp, and result where applicable;
- explicit no-route results when LI.FI cannot produce a reviewed route.

Implementation-only evidence scripts are not required to stay in the repo after
the policy is implemented. The retained artifact is the reviewed production
config plus canary output needed to justify enabling `reviewed_broad`.

## Implementation

- Replace the monolithic production LI.FI config shape with a discriminated
  production union: concrete-allowlist production config requires non-empty
  `allowExchanges`, while reviewed-broad production config requires
  `exchangePolicy: 'reviewed_broad'` and omits `allowExchanges`.
- Add a single normalized LI.FI exchange-policy model owned by
  `src/dex/lifi/exchange-policy.ts`, for example `LifiExchangePolicy`, with
  explicit concrete-allowlist and reviewed-broad variants. Downstream callers
  should consume this model instead of re-checking raw config fields.
- Update both LI.FI production validation gates so concrete `allowExchanges`
  remains required unless the explicit reviewed-broad mode is set:
  - `src/config/lifi-policy.ts`
  - `src/dex/lifi/chain-policy.ts`
- Reject reviewed-broad production config when `allowExchanges` is present,
  before request building or route canaries can normalize it away.
- Keep `src/dex/lifi/chain-policy.ts` responsible for requiring non-empty
  `callTargetAllowlist`, `approvalSpenderAllowlist`, and `selectorAllowlist`
  for each reviewed production chain.
- Keep `denyExchanges` and `preferExchanges` normalized and conflict-checked.
- Update `validateLifiQuote(...)` and route-shape normalization so an empty
  concrete exchange-tool allowlist is rejected in `concrete_allowlist` mode but
  accepted in `reviewed_broad` mode.
- Keep reviewed-broad branching in the normalized policy helpers. Do not scatter
  raw `exchangePolicy` conditionals across request building, route validation,
  route canary config, and telemetry.
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
- Concrete production validation still rejects missing `allowExchanges`.
- Reviewed-broad production validation accepts omitted `allowExchanges` only
  when the reviewed target, spender, selector, and route-shape policies are
  present.
- Compile-time tests cover the production discriminated union under the existing
  `npm run typecheck` gate. Add a checked TypeScript fixture, for example under
  `tests/type/`, that uses `satisfies LifiProductionDexConfig` for valid
  concrete-allowlist and reviewed-broad examples plus `// @ts-expect-error`
  cases proving concrete-allowlist config without `allowExchanges` is invalid
  and reviewed-broad config with `allowExchanges` is invalid.
- Runtime config-validation tests prove `exchangePolicy: 'reviewed_broad'` with
  any `allowExchanges` field fails validation, even if the object reaches
  validation through an untyped or non-fresh config path.
- `src/dex/lifi/chain-policy.ts` tests prove reviewed-broad still requires
  chain-specific target, spender, and selector allowlists while allowing omitted
  `allowExchanges`.
- The route canary proves at least one reviewed broad route per target
  chain/pair, or records an explicit no-route result.
- Telemetry tests assert the effective LI.FI tool is captured for accepted
  reviewed-broad routes.
- Existing concrete `allowExchanges` behavior remains unchanged.

## Acceptance

- Broad LI.FI exchange routing is opt-in and production-explicit.
- Existing LI.FI production configs keep their current safety contract.
- Reviewed-broad configs with `allowExchanges` fail runtime validation.
- Broad mode does not bypass route-shape validation or taker allowlists.
- Broad mode has route-shape canary coverage and operator documentation.
- No Sushi or 1inch runtime behavior changes.
