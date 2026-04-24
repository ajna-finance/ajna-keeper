# Combined Dynamic Route Selection Plan

## Goal

Build a safe, incremental route-selection stack for autodiscover external takes:

- express profit floors in native-token terms so they work across quote tokens
- select the best supported fee tier for UniV3-style routes
- select between UniswapV3, SushiSwap, and configured Curve routes for factory external takes
- bind execution to the quote-approved route without execution-time reselection
- rank viable routes by expected net profit, not gross quote output
- keep RPC growth bounded and observable

This plan combines:

- [NATIVE_PROFIT_FLOOR_PLAN.md](/home/mike/Projects-2026/ajna-keeper/NATIVE_PROFIT_FLOOR_PLAN.md)
- [DYNAMIC_FEE_TIER_SELECTION_PLAN.md](/home/mike/Projects-2026/ajna-keeper/DYNAMIC_FEE_TIER_SELECTION_PLAN.md)
- [DYNAMIC_LIQUIDITY_SOURCE_SELECTION_PLAN.md](/home/mike/Projects-2026/ajna-keeper/DYNAMIC_LIQUIDITY_SOURCE_SELECTION_PLAN.md)

## Guiding Invariants

- Evaluation and execution must use the same approved route.
- Execution must not silently switch DEXs or fee tiers.
- `amountOutMinimum` must come from the approved route quote and the exact execution floor approved during evaluation.
- Route-specific gas cost must be included before route ranking.
- Route ranking must optimize expected net profit after gas and slippage/risk buffers, after filtering routes that fail configured floors.
- New route selection applies only to factory external takes, not the legacy 1inch path.
- No keeper-level ERC20 pre-approvals to taker contracts are needed for this work.
- Curve participates through configured pool matching only. No registry lookup or execution-time Curve reselection is required.
- Candidate-level context should be computed once and passed through the selector and DEX adapters.
- Native-to-quote conversion rates should not be cached in v1. Quote fresh for each candidate/source where conversion is needed.

## Current Implementation Status

- Phase 1 is implemented for factory external takes.
- Phase 2 is implemented for UniswapV3 and SushiSwap fee-tier selection.
- Phase 3 is implemented for UniswapV3, SushiSwap, and configured Curve pool matching.
- Phase 4 is not implemented; it is reserved for registry-backed or multi-pool Curve discovery.

## Recommended Implementation Order

### Phase 1: Native Profit Floor

Implement `minProfitNative` first because both fee-tier and cross-DEX selection need a consistent quote-token profitability floor.

Changes:

- Add `AutoDiscoverTakePolicy.minProfitNative?: string` in wei.
- Extend validation for decimal-string BigInt parsing and non-negativity.
- Extend [src/discovery/gas-policy.ts](/home/mike/Projects-2026/ajna-keeper/src/discovery/gas-policy.ts) so native-to-quote conversion is requested when `minProfitNative` is set.
- Add a shared helper that quotes an exact native wei amount into quote-token raw units.
- Do not reuse a native-to-quote conversion ratio across different native input amounts.
- Reject a candidate if `minProfitNative` is set and conversion fails.
- Extend existing arb-take gating so arb takes remain disabled when any quote-denominated profit floor is active.

RPC impact:

- No new RPC infrastructure.
- If gas policy and `minProfitNative` both require conversion, quote each exact native input amount fresh.
- This may add a small number of liquidation-gated quote calls, but avoids stale or size-mismatched conversion risk.

### Phase 2: Dynamic Fee Tier Selection

Implement fee-tier selection next, using a route-shaped selector even though v1 only varies `feeTier`.

Changes:

- Add `candidateFeeTiers?: number[]` to UniswapV3 and SushiSwap router override config.
- Auto-include `defaultFeeTier` in the effective tier list.
- Add `selectedFeeTier?: number` to `ExternalTakeQuoteEvaluation`.
- Add a shared `selectBestFactoryRouteQuote(...)` helper in [src/take/factory/shared.ts](/home/mike/Projects-2026/ajna-keeper/src/take/factory/shared.ts).
- For this phase, every `RouteCandidate` has the same configured `liquiditySource` and only varies `feeTier`.
- Wire UniswapV3 and SushiSwap evaluation to probe configured tiers sequentially.
- Wire execution to require `quoteEvaluation.selectedFeeTier`; if it is missing, fail closed instead of falling back to a config default.

Execution invariant:

- Do not re-quote or reselect tiers at execution time.
- If the selected tier becomes stale, the protected transaction should fail rather than silently route elsewhere.

RPC impact:

- UniswapV3 with three tiers: up to three quote calls per candidate.
- SushiSwap with three tiers: up to three existence checks plus up to three quote calls on a cold path.
- Add a short TTL pair-tier existence cache for Sushi to avoid repeated missing-pool checks.

### Phase 3: Dynamic Liquidity Source Selection

Implement cross-source selection after the native floor and fee-tier selector exist.

v1 sources:

- `LiquiditySource.UNISWAPV3`
- `LiquiditySource.SUSHISWAP`
- `LiquiditySource.CURVE`, when `curveRouterOverrides.poolConfigs` contains a matching configured pool

Changes:

- Add `AutoDiscoverTakePolicy.allowedLiquiditySources?: LiquiditySource[]`.
- Add chain-level `dexGasOverrides?: Partial<Record<LiquiditySource, string>>`.
- Reject `LiquiditySource.ONEINCH` for factory external takes.
- Add `selectedLiquiditySource?: LiquiditySource` to `ExternalTakeQuoteEvaluation`.
- Generalize `RouteCandidate` to include `liquiditySource` and optional `feeTier`.
- Evaluate every allowed source and fee-tier route sequentially.
- For Curve, evaluate the configured pool selected by `CurveQuoteProvider` for the candidate token pair and bind the selected pool into the approved quote evaluation.
- Compute route-specific gas-adjusted profitability before ranking.
- Pick the best profitable route by expected net profit after route-specific floor checks.
- Dispatch execution through the selected source, not the configured default source.

Execution invariant:

- `selectedLiquiditySource` is binding.
- Every execution-time branch that currently reads `poolConfig.take.liquiditySource` must use the resolved selected source.
- This includes taker address selection, DEX-specific tx args, amount-out-minimum inputs, and logs.

RPC impact:

- With UniV3 and SushiSwap and three tiers each, cold path is up to six existence checks plus six route quote calls.
- Curve adds one configured-pool quote call for candidates where Curve is allowed.
- Native-to-quote conversion can be up to two fresh conversion quotes per source when both route execution cost and `minProfitNative` are active.
- Do not cache native-to-quote conversion rates in v1. The call volume is liquidation-gated, and fresh conversion is safer for profitability.

### Phase 4: Curve Registry Expansion

Configured Curve pool matching is implemented in Phase 3. A later Curve phase should only cover registry or multi-pool expansion.

Scope:

- Discover Curve pools from an explicit registry source if operators need routes beyond configured `curveRouterOverrides.poolConfigs`.
- Consider probing multiple matching Curve pools only after single configured-pool matching has enough production evidence.
- Keep the same approved-quote binding used by UniV3/Sushi/Curve v1: selected source, selected pool, approved min-out, and route profitability metadata must all be execution inputs.

Non-scope:

- No Curve registry lookup unless a separate registry-discovery plan is implemented.
- No multi-pool Curve optimization until configured-pool selection proves useful.

## Shared Data Model

Suggested internal route model:

```ts
type FactoryRouteCandidate = {
  liquiditySource: LiquiditySource;
  feeTier?: number;
};

type ApprovedCurvePoolSelection = {
  address: string;
  poolType: CurvePoolType;
  tokenInIndex: number;
  tokenOutIndex: number;
};
```

Unit rules:

- Use `ethers.BigNumber` for current-code compatibility unless the implementation migrates a whole module to `bigint`.
- `collateralAmountRaw` is collateral token raw units.
- `auctionPriceWad` and market prices are WAD-scaled unless explicitly named otherwise.
- Quote-token amounts with `Raw` suffix are quote token raw units.
- Human-readable `number` values are only for logs and operator messages, not route ranking.

Suggested per-candidate context:

```ts
type RouteEvaluationContext = {
  chainId: number;
  poolAddress: Address;
  borrower: Address;
  quoteToken: Address;
  collateralToken: Address;
  quoteTokenDecimals: number;
  collateralTokenDecimals: number;
  collateralAmountRaw: BigNumber;
  auctionPriceWad: BigNumber;
  auctionRepayRequirementQuoteRaw: BigNumber;
  referenceMarketPriceWad?: BigNumber;
  effectiveMarketPriceFactor: number;
  currentGasPriceWei: BigNumber;
  minExpectedProfitQuoteRaw?: BigNumber;
  minProfitNativeWei?: BigNumber;
  defaultLiquiditySource: LiquiditySource;
  defaultFeeTierBySource: Partial<Record<LiquiditySource, number>>;
};
```

Build this once per candidate. DEX adapters should not re-fetch token decimals, default tiers, market price, auction repay requirements, or gas inputs.

`referenceMarketPriceWad` is optional context for logs, defensive thresholds, and future non-route price checks. It must not replace route-specific quote output in profitability scoring. Route profitability is determined from the actual route quote because that is what determines execution proceeds.

Suggested selected quote fields:

```ts
type ExternalTakeQuoteEvaluation = {
  selectedFeeTier?: number;
  selectedLiquiditySource?: LiquiditySource;
  // existing quote, collateral, market price, and reason fields
};
```

Suggested approved route object:

```ts
type ApprovedFactoryRouteQuote = ExternalTakeQuoteEvaluation & {
  selectedLiquiditySource: LiquiditySource;
  selectedFeeTier?: number;
  quoteAmountRaw: BigNumber;
  approvedMinOutRaw: BigNumber;
  profitability: RouteProfitability;
};
```

`ApprovedFactoryRouteQuote` is the object execution should consume. It makes the selected route and execution floor explicit instead of requiring execution to recompute policy from loosely related fields.

`quoteAmountRaw` is required on `ApprovedFactoryRouteQuote`. Do not add a second route-output field such as `expectedQuoteOutRaw`; that creates two sources of truth.

### Follow-up TODO: type-split quote lifecycle

The current implementation relies on fail-closed runtime guards to ensure execution only consumes a fully approved route quote. A future maintainability refactor should split the quote lifecycle into distinct types, for example `RawFactoryRouteQuote` or `UnappliedFactoryQuoteEvaluation`, `PolicyAppliedFactoryRouteEvaluation`, and `ApprovedFactoryRouteQuote`.

The selector and execution paths should accept only the approved type. This is not required for the current PR because the runtime guards enforce the invariant, but it would reduce future drift risk by making half-populated or policy-unapplied evaluations unrepresentable.

Rules:

- Phase 2 writes `selectedFeeTier`.
- Phase 3 writes `selectedLiquiditySource`; UniV3/Sushi also write `selectedFeeTier`, and Curve writes `curvePool`.
- Phase 4 may add registry-derived Curve candidates, but execution should still consume the same selected `ApprovedCurvePoolSelection` shape on the approved quote evaluation.
- Do not introduce a separate execution-plan object unless the existing quote evaluation object becomes insufficient.

## Shared Abstractions

### Profitability policy

Create one shared profitability helper instead of duplicating floor math in Uniswap, Sushi, Curve, and autodiscover code:

```ts
type RouteProfitability = {
  routeExecutionCostQuoteRaw: BigNumber;
  nativeProfitFloorQuoteRaw: BigNumber;
  configuredProfitFloorQuoteRaw: BigNumber;
  slippageRiskBufferQuoteRaw: BigNumber;
  marketFactorFloorQuoteRaw: BigNumber;
  requiredProfitFloorQuoteRaw: BigNumber;
  requiredOutputFloorQuoteRaw: BigNumber;
  expectedNetProfitQuoteRaw: BigNumber;
  surplusOverFloorQuoteRaw: BigNumber;
  isProfitable: boolean;
};
```

Responsibilities:

- quote exact native gas and native profit floor amounts into quote-token raw units
- apply `minExpectedProfitQuote`
- preserve the existing `marketPriceFactor` floor
- apply route-specific gas estimates
- apply any configured slippage or risk buffer
- return both expected net profit and surplus over the required floor

This helper should be used by fee-tier selection, dynamic source selection, and future global `marketPriceFactor`/defensive-take work.

### Route adapters

Keep DEX-specific adapters narrow:

```ts
type FactoryRouteAdapter = {
  liquiditySource: LiquiditySource;
  exists(
    route: FactoryRouteCandidate,
    context: RouteEvaluationContext
  ): Promise<boolean>;
  quote(
    route: FactoryRouteCandidate,
    context: RouteEvaluationContext
  ): Promise<RouteQuote | null>;
  buildTakeArgs(args: {
    route: FactoryRouteCandidate;
    approvedQuote: ApprovedFactoryRouteQuote;
    context: RouteEvaluationContext;
    config: FactoryExecutionConfig;
  }): TakeArgs;
};
```

Adapters should not decide profitability or select routes. They only answer existence, quote, and transaction-construction questions for their DEX.

### Normalized route config

Normalize route config once per candidate:

- effective allowed sources
- effective fee tiers per source
- default source for tie-breaking
- default fee tier per source for tie-breaking
- rejected unsupported sources with validation reasons

This prevents each adapter from reimplementing config fallback behavior.

## Shared Selection Algorithm

The same selector should support fee-tier-only and cross-source selection.

Flow:

1. Build `RouteEvaluationContext` once for the candidate.
2. Normalize route config once into a bounded route list.
3. Order probes by configured default route, recent route success, then remaining routes.
4. Apply route existence pre-filtering.
5. Probe routes sequentially within the quote budget.
6. For each successful route quote, compute `RouteProfitability`.
7. Reject routes with non-positive `surplusOverFloorQuoteRaw`.
8. Rank profitable routes by highest `expectedNetProfitQuoteRaw`.
9. Break ties by configured default source, then default fee tier.
10. Compute `approvedMinOutRaw` from the selected route quote and approved execution floor.
11. Return `ApprovedFactoryRouteQuote` with selected route metadata and profitability details.

This avoids duplicating profitability rules in Uniswap and Sushi adapters.

Probe ordering is a latency optimization, not a correctness shortcut. When budget allows, the selector should still evaluate every viable route before choosing. If a quote budget is exhausted, the selector returns the best probed route, not the globally best route. Logs must say that the decision was budget-limited and list the skipped routes.

Use a per-candidate route quote budget for this selector. Any existing per-run autodiscover quote budget remains an outer limiter that can stop candidate processing before route selection starts.

## Gas And Profit Floor Handling

Route ranking must use route-specific gas cost before choosing the winner:

```text
routeGasCostNative = gasUsed[route.liquiditySource] * currentGasPrice
routeExecutionCostNative = routeGasCostNative + routeL1DataFeeNative + routeOtherNativeFees
routeExecutionCostQuoteRaw = nativeToQuote(routeExecutionCostNative, route.liquiditySource)
nativeProfitFloorQuoteRaw = nativeToQuote(minProfitNative, route.liquiditySource)
grossProfitQuoteRaw = quoteAmountRaw - auctionRepayRequirementQuoteRaw
expectedNetProfitQuoteRaw = grossProfitQuoteRaw - routeExecutionCostQuoteRaw - slippageRiskBufferQuoteRaw
marketFactorFloorQuoteRaw = auctionRepayRequirementQuoteRaw / effectiveMarketPriceFactor
requiredProfitFloorQuoteRaw = max(nativeProfitFloorQuoteRaw, configuredProfitFloorQuoteRaw)
requiredOutputFloorQuoteRaw = max(
  marketFactorFloorQuoteRaw,
  auctionRepayRequirementQuoteRaw
    + routeExecutionCostQuoteRaw
    + requiredProfitFloorQuoteRaw
    + slippageRiskBufferQuoteRaw
)
surplusOverFloorQuoteRaw = quoteAmountRaw - requiredOutputFloorQuoteRaw
```

The selector should not choose the highest gross quote and then apply gas afterward. That can choose the wrong route when a DEX has materially higher execution gas. First reject routes below the required floor, then select the viable route with the highest `expectedNetProfitQuoteRaw`; use gross quote only as a final tie-breaker if net profit is equal.

`marketFactorFloorQuoteRaw` must preserve the current factory invariant from `computeFactoryAmountOutMinimum`: roughly `auctionRepayRequirementQuoteRaw / marketPriceFactor`, with the same integer ceiling behavior as the current helper.

On Base, Optimism, Arbitrum, and other L2s, `routeExecutionCostNative` must include L1 data fee or any equivalent additional execution fee if the chain exposes it. If that fee is not available in v1, use a conservative configured buffer and log that the estimate excludes live L1 data fee.

`amountOutMinimum` remains execution protection, not the route-ranking score. It must be derived from the approved quote and approved route floor after route selection:

```text
approvedExecutionFloorQuoteRaw =
  requiredOutputFloorQuoteRaw

approvedMinOutRaw = max(existingSlippageFloorRaw, approvedExecutionFloorQuoteRaw)
```

Execution should consume `approvedMinOutRaw` from `ApprovedFactoryRouteQuote`. It should not recompute a weaker floor from only market factor and slippage.

`slippageRiskBufferQuoteRaw` is an explicit profitability/risk buffer. Do not also derive it from the same configured execution slippage used for `existingSlippageFloorRaw`, or the plan will double-count slippage.

## Caching And Reuse

Runtime caches that improve profitability and efficacy without changing behavior:

- Token decimals by `(chain, token)`.
- Quote providers, router helpers, and taker contract instances by `(chain, liquiditySource)`.
- Pool-existence checks by `(chain, liquiditySource, tokenA, tokenB, feeTier)`.
- Recent route success metadata by `(chain, liquiditySource, tokenA, tokenB, feeTier)` for probe ordering.

Cache rules:

- Existence cache can use a short TTL because pool existence rarely changes.
- Existence means the pool contract exists, not that it has viable liquidity.
- Quote failures should mark a route unusable only for the current candidate or a very short TTL. Do not permanently cache quote failure as pool absence.
- Native-to-quote conversions should be quoted fresh per candidate/source in v1. Do not cache conversion rates; stale or size-mismatched conversion can directly hurt route profitability.
- Recent-success cache is only for ordering; it must not skip a route that is still inside the quote budget.
- Provider and decimals caches can live for the process lifetime.

## Approval Model

Do not add keeper startup approval grants for this roadmap.

Current factory takers perform the relevant approvals inside the transaction:

- quote token approval to the Ajna pool around `pool.take`
- collateral approval to the router or Permit2 in the callback
- approval reset where already implemented

The keeper should validate configured taker addresses and router overrides at startup, but it should not grant broad ERC20 allowances from the keeper wallet to all possible takers.

## Operational Controls

Keep v1 conservative:

- sequential probing
- bounded candidate fee tiers; validation caps at eight, but production configs should prefer two or three
- UniV3, SushiSwap, and configured Curve pool matching only for dynamic source selection
- no same-cycle retry
- no parallel route fanout
- no cross-candidate quote cache beyond low-risk existence and metadata caches
- shared candidate context so adapters do not recompute decimals, market price, gas inputs, or floors
- default/recent-success routes probed first, with full evaluation when quote budget allows

Telemetry to add:

- selected route at evaluation time
- selected route at execution time
- per-route quote outcomes when no route is viable
- route-specific gas estimate used in the floor
- expected net profit, surplus over floor, and each floor component used for scoring
- routes skipped because quote budget was exhausted
- approved minimum output used for execution
- execution revert reason and selected route metadata
- observed gas divergence from configured route gas estimate

## Testing Plan

Unit tests:

- `minProfitNative` parsing, conversion, max-floor behavior, and failure-on-missing-conversion.
- `candidateFeeTiers` validation and default-tier auto-inclusion.
- route selector tie-breaking by default source and default fee tier.
- execution uses `selectedFeeTier`.
- execution dispatch uses `selectedLiquiditySource`.
- route-specific gas floor changes winner selection when gross quote and expected net profit differ.
- selector filters by `surplusOverFloorQuoteRaw` and ranks by `expectedNetProfitQuoteRaw`, not gross `quoteAmountRaw`.
- adapters receive shared `RouteEvaluationContext` and do not recompute token decimals or floor inputs.
- recent-success probe ordering changes probe order but not selected route when budget allows all routes.
- quote-budget exhaustion returns best probed route and logs skipped routes.
- `approvedMinOutRaw` preserves the market-factor floor and includes auction repayment, route execution cost, required profit floor, and slippage/risk buffer.
- 1inch is rejected from v1 `allowedLiquiditySources`.
- configured Curve pool matching selects `CurveKeeperTaker`.
- Curve route participates in the same route selector after config-driven matching.

Integration tests:

- factory take with selected Uniswap fee tier.
- factory take with selected Sushi fee tier.
- autodiscover candidate where UniV3 wins.
- autodiscover candidate where SushiSwap wins.
- autodiscover candidate where a configured Curve pool wins.
- stale selected route reverts safely under `amountOutMinimum` rather than reselecting.
- warm pool-existence cache reduces repeated missing-route checks.
- native-to-quote conversion is quoted fresh per candidate/source and is not reused as a cached conversion rate.

## Acceptance Criteria

Phase 1 is complete when autodiscover can enforce a native-denominated profit floor across multiple quote tokens and safely reject candidates when conversion is unavailable.

Phase 2 is complete when UniV3 and Sushi can choose the best configured fee tier and execution uses the approved selected tier.

Phase 3 is complete when autodiscover can choose between UniV3, Sushi, and configured Curve routes by expected net profit, account for route-specific gas before ranking, and dispatch execution through the selected source without execution-time reselection.

Phase 4 is complete only if registry-backed Curve discovery or multi-pool Curve probing is added without weakening the Phase 3 route-binding invariants.
