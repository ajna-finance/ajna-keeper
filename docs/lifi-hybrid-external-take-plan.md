# LI.FI Hybrid External Take Plan

Status: implementation under verification. The core LI.FI path, config validation, preflight, mock integration coverage, provider-keyed LI.FI route-quote and execution-refresh circuits, the no-broadcast route-shape canary command, and the Base callback-path fork execution canary harness are implemented. LI.FI production support for a chain/pair is not claimed until both production enablement gates pass with the reviewed production keeper config and the default LI.FI API: a required-live no-broadcast route-shape canary for the target chain, and a callback-path fork execution canary. The checked-in callback-path fork canary is Base-specific today; it verifies configured production factory/taker deployment and registration, then runs an isolated local callback harness under the reviewed production `dex.lifi` policy. Non-Base chains require an equivalent reviewed chain-specific fork harness before production support is claimed.

Last reviewed: 2026-05-28.

## Goal

Add LI.FI as an optional external-take route in hybrid discovery so the keeper can compare:

- existing single-contract 1inch atomic aggregator takes,
- factory direct-DEX takers for Uniswap V3, SushiSwap, and Curve routes,
- a new LI.FI-backed same-chain aggregator route through a factory-registered taker.

The target behavior is a secure alternative aggregator path for external takes when direct-DEX adapters do not find enough same-chain liquidity for a pool's collateral-to-quote pair.

## Non-Goals

- Do not add cross-chain external takes. Ajna `atomicSwapCallback` must synchronously receive quote tokens on the same chain before callback completion.
- Do not integrate LI.FI Intents or async solver order settlement. The keeper needs a same-transaction swap, not an order lifecycle.
- Do not replace existing factory routes. Factory direct-DEX routes remain the safest path when they have liquidity.
- Do not rely on API-provided calldata for repayment or profit enforcement. Contracts must enforce actual quote-token balance delta.
- Do not assume LI.FI is available on every Ajna chain. The implementation must fail closed when LI.FI does not support the chain, token, route, call target, or spender.

## Current LI.FI API Facts

Use LI.FI's standard REST API at `https://li.quest/v1`, specifically `GET /quote`, because it returns a single route with ready-to-execute `transactionRequest` calldata.

Relevant current API properties:

- `GET /quote` supports same-chain or cross-chain transfers. We must request same-chain only by setting `fromChain == toChain`.
- Quote requests require `fromChain`, `toChain`, `fromToken`, `toToken`, `fromAmount`, and `fromAddress`. `toAddress`, `slippage`, route filters, and `maxPriceImpact` are available.
- Quote responses include `estimate.toAmount`, `estimate.toAmountMin`, `estimate.approvalAddress`, `includedSteps`, and `transactionRequest`.
- Current same-chain public quotes may return a top-level `type: "lifi"` step with a concrete exchange `tool` such as `sushiswap`, plus a leading included `type: "protocol"`, `tool: "feeCollection"` step before the executable swap.
- `transactionRequest` includes `to`, `data`, `value`, `chainId`, and gas fields. For Ajna callback execution, `value` must be zero.
- `allowBridges`, `denyBridges`, `allowExchanges`, and `denyExchanges` are route filters. Bridge use must be disabled for this feature.
- `skipSimulation` is supported and may be necessary because the taker contract does not hold the collateral until Ajna invokes the callback. Gas must be estimated locally before submission.
- No API key is required for the API, but quote endpoints are rate-limited without a key. Add optional API-key support and provider-specific circuit breaking.
- Quote responses can become stale. Use a hard freshness limit for execution refresh, defaulting to 30 seconds or less.

Source docs:

- API overview and auth: https://docs.li.fi/api-reference/introduction
- Quote endpoint: https://docs.li.fi/api-reference/get-a-quote-for-a-token-transfer
- Quote fields and constraints: https://docs.li.fi/agents/reference/endpoint-specs
- Schema fields: https://docs.li.fi/agents/reference/schemas
- Rate limits: https://docs.li.fi/zh-hans-api-reference/rate-limits

## Assumption Packet

Invariant impact:

- Ajna pool repayment remains enforced by the pool.
- Keeper profit and gas floors remain enforced before submission and again by taker-side quote balance delta checks.
- Callback execution must leave no reusable collateral allowance for LI.FI targets or downstream spenders after successful execution.
- Any external path that cannot prove same-chain synchronous quote delivery must be rejected.

Actor and incentive impact:

- Keeper owner wants broader liquidity without giving arbitrary aggregators custody over funds beyond the exact callback collateral amount.
- LI.FI API, downstream DEXs, and route providers are untrusted external actors. They may return stale calldata, calldata for the wrong chain/token/receiver, calldata with a weak minimum output, nonzero native value, bridge steps, misplaced fee-collection steps, or unexpected approval spenders.
- Borrowers and lenders should not depend on keeper profitability, but failed callbacks can delay liquidation progress and burn keeper gas.
- MEV searchers can move route prices between quote and submission. Final quote refresh and on-chain actual balance-delta enforcement are required.

Implementation plan:

- Add LI.FI as a distinct external take path rather than overloading 1inch code.
- Add a dedicated LI.FI taker contract with strict call-target and approval-spender allowlists.
- Add a typed LI.FI API client and route validator.
- Generalize hybrid discovery from a two-path `oneinch`/`factory` switch into provider-aware external routes.
- Reuse existing external-take route policy for profitability and min-out selection.

Verification plan:

- Unit-test LI.FI API parsing, validation failures, slippage/min-out policy, and circuit breaking.
- Contract-test all callback invariants with malicious mock LI.FI targets.
- Integration-test hybrid discovery and execution against mock LI.FI calldata.
- Add a no-broadcast LI.FI route-shape canary command for configured production chains; local runs may skip when live config is absent, but LI.FI production enablement gate runs must set `AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE=true` and pass `--config` so missing production config, non-production `dex.lifi`, missing `takers.contracts.Lifi`, incomplete production chain policy, custom API base URLs, LI.FI policy env overrides including API-base overrides, or route-level taker-address overrides exit non-zero. The canary uses `AJNA_AGENT_LIFI_CANARY_CHAIN_ID` when set, infers the chain from a single-chain production LI.FI allowlist, and fails closed for multi-chain configs until the target chain is explicit. Non-Base route-shape canaries require `AJNA_AGENT_LIFI_CANARY_ROUTES_JSON` because only the Base default route is checked in. A successful required-live no-broadcast route-shape canary using the reviewed production keeper config and the default LI.FI API is the first LI.FI production enablement gate for the target chain.
- Add a Base fork execution canary harness that verifies the configured production factory and `takers.contracts.Lifi` are deployed and registered, then runs real LI.FI calldata from the default LI.FI API through an isolated local `LifiKeeperTaker` callback harness with collateral only appearing during the Ajna callback; a successful callback-path fork execution canary using the reviewed production config policy, verified production registration, and the default LI.FI API is the second LI.FI production enablement gate for Base. Non-Base chains require an equivalent reviewed chain-specific callback-path fork canary before LI.FI production support is claimed.

Open assumptions:

- LI.FI same-chain `GET /quote` can produce calldata callable by a contract sender whose collateral balance appears only during callback execution. A successful required-live no-broadcast route-shape canary using the reviewed production keeper config is only the first LI.FI production enablement gate for the target chain and proves default-API calldata for the production `takers.contracts.Lifi` receiver. The second gate is a successful callback-path fork execution canary that verifies the configured production registration, then proves real default-API calldata succeeds through an isolated local taker callback path under the reviewed production `dex.lifi` policy. The checked-in fork canary proves this only for Base today; non-Base chains require an equivalent reviewed chain-specific fork canary before LI.FI production support is claimed.
- Some LI.FI routes may use `tool: "1inch"` internally. If the product requirement is "no direct 1inch account/API dependency", that is acceptable. If the requirement is "never route through 1inch liquidity", configure `denyExchanges` to exclude it and accept reduced breadth.
- The exact LI.FI call target and approval spender addresses vary by chain and route. Production config needs explicit allowlists, not dynamic trust in API responses.

## Architecture

### 1. Config Surface

Extend `LiquiditySource` and external take paths:

```ts
export enum LiquiditySource {
  NONE = 0,
  ONEINCH = 1,
  UNISWAPV3 = 2,
  SUSHISWAP = 3,
  CURVE = 4,
  LIFI = 5,
}

export type ExternalTakePathKind = 'oneinch' | 'factory' | 'lifi';
```

Add `dex.lifi` as a mode-based config. `production` is the only mode that may be used by the live liquidation hot path. `canary` is for no-broadcast route-shape discovery, selector observation, and local fork validation only.

```ts
interface LifiDexBaseConfig {
  apiBaseUrl?: string; // default: https://li.quest/v1
  apiKeyEnvVar?: string; // optional; do not store secrets in config
  integrator?: string; // 1-23 chars; letters, numbers, hyphens, underscores, or dots
  defaultSlippage?: number; // LI.FI decimal format, e.g. 0.005
  quoteTimeoutMs?: number;
  quoteFailureCooldownMs?: number;
  quoteFailureThreshold?: number;
  maxPriceImpact?: number;
  feeCostPolicy?: 'included_only' | 'reject_all'; // default included_only
  maxQuoteAgeMs?: number; // default: 30000
}

interface LifiCanaryDexConfig extends LifiDexBaseConfig {
  mode: 'canary';
  allowExchanges?: string[];
  denyExchanges?: string[];
  preferExchanges?: string[];
  allowBroadExchangeFilters?: boolean; // allowed only for no-broadcast exploration
  callTargetAllowlist?: { [chainId: number]: string[] };
  approvalSpenderAllowlist?: { [chainId: number]: string[] };
  observedSelectorAllowlist?: {
    [chainId: number]: { [callTarget: string]: string[] };
  };
}

interface LifiProductionDexConfig extends LifiDexBaseConfig {
  mode: 'production';
  allowExchanges: string[];
  denyExchanges?: string[];
  preferExchanges?: string[];
  callTargetAllowlist: { [chainId: number]: string[] };
  approvalSpenderAllowlist: { [chainId: number]: string[] };
  selectorAllowlist: {
    [chainId: number]: { [callTarget: string]: string[] };
  };
  observedSelectorAllowlist?: {
    [chainId: number]: { [callTarget: string]: string[] };
  };
}

type LifiDexConfig = LifiCanaryDexConfig | LifiProductionDexConfig;
```

Add `takers.contracts.Lifi` for the factory-registered LI.FI taker. Do not add compatibility aliases; this deployment is operator-controlled and can migrate explicitly to the canonical key.

Validation requirements:

- `dex.lifi` and `takers.contracts.Lifi` are required when `LiquiditySource.LIFI` or path `lifi` is enabled.
- Live discovery/execution requires `dex.lifi.mode='production'`; `canary` mode must not submit live external take transactions.
- In production, `allowExchanges`, `callTargetAllowlist[chainId]`, `approvalSpenderAllowlist[chainId]`, and `selectorAllowlist[chainId]` must be non-empty for every target chain and call target.
- `apiBaseUrl`, when configured, must be an http(s) URL without credentials, query, or fragment. Production requires HTTPS.
- `defaultSlippage` must be LI.FI decimal format and bounded, for example `0 < x <= 0.5`, with production guidance far lower.
- `integrator`, when configured or supplied by a route canary, must match LI.FI's documented query-parameter shape: 1-23 characters containing only letters, numbers, hyphens, underscores, or dots.
- `maxPriceImpact` must be bounded and should default to a conservative value.
- `maxQuoteAgeMs` must be a positive integer. Prefer a 15-30 second production value, and cap it to any provider-documented quote-expiry window if LI.FI exposes one for the endpoint.
- `allowExchanges`, `denyExchanges`, and `preferExchanges` entries should be validated against `GET /v1/tools` during startup preflight or an explicit route-shape canary command. Typoed filters must not silently broaden route selection.
- Broad or reserved LI.FI filter keywords such as `all`, `default`, `none`, `[]`, and empty-list semantics must be rejected for production exchange filters. `allowBroadExchangeFilters=true` is canary-only and must never be accepted by the live liquidation hot path.
- Exchange filter entries should be normalized to canonical LI.FI tool keys, deduplicated, and rejected if the same key appears in conflicting allow/deny/prefer sets.
- `discovery.take.dexGasOverrides[LiquiditySource.LIFI]` is required when LI.FI is enabled. Do not trust LI.FI simulation-derived gas when `skipSimulation=true`; quote-time ranking needs a conservative local gas model.
- `observedSelectorAllowlist` is telemetry-only for canary discovery. It must not be treated as production enforcement policy.
- `selectorAllowlist[chainId][callTarget]` is the production enforcement policy. In production, every configured selector must also be registered on-chain in the LI.FI taker for that call target.
- `allowBridges` should not be user-configurable for this feature. Always force bridge denial in the LI.FI client, using LI.FI's bridge-deny keyword only for that hard-coded bridge policy.
- `feeCostPolicy` defaults to `included_only`: allow LI.FI-reported included fees only when `estimate.toAmountMin` already reflects them and the keeper's local repayment, gas, and profit floors still pass. Output-token fees are accepted when included in the post-fee minimum output. Source-token fees are accepted only as top-level and/or leading included `feeCollection` metadata on a route with the approved leading included `feeCollection` step before the swap, and each reported source-token fee amount must equal the feeCollection source-token delta. Source-token fee metadata on the executable swap step is rejected. `reject_all` is available for operators who want zero reported LI.FI fees.
- `skipSimulation` should not be a shared config field. Callback-path quotes must send `skipSimulation=true`; any non-callback simulation experiment belongs to an explicit no-broadcast canary command option.

Default path behavior:

- Treat `LiquiditySource.LIFI` as a first-class external path, not only as a hybrid add-on. `resolveExternalTakePaths({ defaultLiquiditySource: LIFI })` should resolve to `['lifi']` when `allowedExternalTakePaths` is omitted.
- `allowedExternalTakePaths` remains authoritative when present. Mixed paths such as `['factory', 'lifi']` or `['factory', 'oneinch', 'lifi']` should be explicit.
- Do not add `LIFI` to `FACTORY_DYNAMIC_SOURCES`. In keeper terminology, the `factory` path means typed direct-DEX adapters; LI.FI uses a factory-registered taker but remains an aggregator provider.

### 2. LI.FI API Client

Create a small `src/dex/lifi/` module tree rather than expanding the monolithic `DexRouter` or creating a new monolithic `lifi.ts`.

Recommended module split:

- `index.ts`: public exports and a thin composition layer only.
- `client.ts`: HTTP request construction, timeout handling, API-key header injection, rate-limit header parsing, and raw response retrieval.
- `schema.ts`: typed LI.FI response/request models and narrow parsing helpers.
- `filters.ts`: exchange filter normalization, broad-filter rejection, and `GET /v1/tools` validation helpers.
- `fee-policy.ts`: `feeCostPolicy` parsing and post-fee min-output validation.
- `validate-route.ts`: pure same-chain route-shape validation, target/spender/selector checks, and approved quote construction.
- `fixtures/`: checked-in response fixtures used by unit tests.

The top-level LI.FI API entrypoint should compose these pieces and stay small. Do not let the response validation matrix below accumulate in one file; every validation category should live in the focused module that owns it.

Responsibilities:

- Build a same-chain `GET /quote` request:
  - `fromChain = chainId`
  - `toChain = chainId`
  - `fromToken = pool.collateralAddress`
  - `toToken = pool.quoteAddress`
  - `fromAmount = collateralAmountTokenDecimals`
  - `fromAddress = lifiTakerAddress`
  - `toAddress = lifiTakerAddress`
  - `slippage = configured decimal slippage`
  - `allowBridges = none` or equivalent bridge-deny filter
  - `allowDestinationCall = false`
  - `skipSimulation = true`
  - configured exchange filters and `maxPriceImpact`
- Before constructing the URL or contacting LI.FI, reject any request whose `chainId` is not a positive integer, whose token or taker fields are malformed or zero addresses, whose `fromAmount` is not a positive decimal integer string, or whose `fromAddress` and `toAddress` are not the same LI.FI taker address.
- Send optional `x-lifi-api-key` from `apiKeyEnvVar`.
- Parse rate-limit headers when present.
- Return typed quote fields only after full validation.
- Stamp `quotedAtMs = Date.now()` locally immediately after validation succeeds. Do not rely on LI.FI returning a quote timestamp; carry any provider expiry timestamp only as an optional extra if it appears in a future response.

Amount units:

- LI.FI `fromAmount`, `estimate.fromAmount`, and `LifiSwapDetails.amountInTokenUnits` are token smallest units.
- Ajna callback `collateral` is WAD precision for ERC20 pools. Do not compare that raw callback value directly to LI.FI `fromAmount` unless the collateral token is known to be 18 decimals and the helper proves equivalence.
- Convert candidate collateral WAD to token units with the same rounding policy used by the existing external-take quote path. The helper must be centralized and tested for 6, 8, and 18 decimal collateral.
- At execution time, prefer the actual callback source-token balance available to the taker as the final exact-input source of truth. The expected token-unit amount passed to LI.FI must match that actual balance.

Response validation must reject:

- top-level `type` unless it is exactly `"swap"`, or exactly `"lifi"` as orchestration around one same-chain executable swap,
- top-level `"lifi"` wrappers that contain zero executable swap steps, multiple executable swap steps, nested `lifi`, unsupported `protocol`, `cross`, destination calls, or feeCollection outside the approved leading included step,
- top-level `tool` that is missing, blank, or neither `"lifi"` nor in the configured/validated exchange allowlist; a safe top-level `"lifi"` wrapper may use `tool: "lifi"` only when it delegates the concrete exchange tool to its single included swap step,
- any nested swap `tool` that is missing or not in the configured/validated exchange allowlist,
- mismatched `action.fromChainId` or `action.toChainId`,
- missing or mismatched `transactionRequest.chainId`,
- mismatched collateral or quote token addresses,
- mismatched `action.fromAmount`,
- mismatched top-level `action.fromAddress`, top-level `action.toAddress`, or `transactionRequest.from` when present,
- native-token placeholder addresses for `action.fromToken` or `action.toToken`; Ajna pools here are ERC20 pools and wrapped native tokens must be represented by their ERC20 address,
- zero or malformed `estimate.toAmount` / `estimate.toAmountMin`,
- `estimate.toAmountMin > estimate.toAmount`,
- nonzero `transactionRequest.value`,
- missing or malformed calldata,
- missing or non-allowlisted `transactionRequest.to`,
- missing or non-allowlisted `estimate.approvalAddress`,
- zero-address `estimate.approvalAddress`,
- non-empty top-level or nested `estimate.feeCosts` when `feeCostPolicy='reject_all'`,
- malformed, non-included, wrong-chain, unexpected-token, or unaccounted top-level or nested `estimate.feeCosts` when `feeCostPolicy='included_only'`,
- source-token `estimate.feeCosts` unless they appear as top-level and/or leading included `feeCollection` metadata on a route with the approved leading included `feeCollection` step, the executable swap consumes the post-fee source amount, and each reported source-token fee amount equals the feeCollection source-token delta,
- source-token `estimate.feeCosts` attached to the executable swap step, even when the route also has a valid leading `feeCollection` step,
- missing executable swap step, multiple executable swap steps, or any included step shape other than one swap step or one leading `feeCollection` step followed by one swap step,
- any executable included swap whose action chain, token, amount, or output minimum conflicts with same-chain collateral-to-quote swap semantics.

Do not accept top-level or nested `cross` steps, nested `lifi` steps, destination calls, arbitrary protocol steps, or fee-collection anywhere except a single leading included `feeCollection` protocol step. Accept top-level `lifi` only as orchestration around one same-chain executable swap, with all top-level transaction fields still matching the taker, transaction target, spender, chain, token, amount, sender, receiver, and zero-native-value rules. Validate the executable included swap's chain, token, amount, tool, and output floor. Enforce included-swap `estimate.approvalAddress` only when it is part of the executable approval policy, such as plain swap routes and non-feeCollection wrappers. For approved leading-feeCollection wrappers, current LI.FI same-chain routes may report spender-oriented nested metadata in the included swap; the top-level `estimate.approvalAddress`, TypeScript approval-spender allowlist, and on-chain `LifiSwapDetails.approvalSpender` are the only approval policy inputs. Do not treat included swap `action.fromAddress` or `action.toAddress` as the sender/receiver source of truth; current LI.FI same-chain fee-collection routes may report spender-oriented metadata there while the top-level transaction still executes from the taker. `/quote` returns a populated top-level `Step`; validate both that top-level step and every nested included step. Broader LI.FI Composer or protocol actions expand the trusted execution surface beyond the reviewed same-chain swap plus feeCollection shape and should require a separate reviewed allowlist, mocks, fork canary, and explicit production approval.

Fee-cost handling:

- Parse `estimate.feeCosts` into typed telemetry for the top-level step, leading included `feeCollection` step, and executable swap step.
- Under `included_only`, accept fee costs only when they are represented as included route costs and `estimate.toAmountMin` remains the post-fee minimum output.
- Reject fees charged in the source collateral token unless they are top-level and/or leading included `feeCollection` metadata tied to the approved leading included `feeCollection` step, the executable swap's input is reduced to the post-fee source amount, and each reported source-token fee amount equals the feeCollection source-token delta. Always reject source-token fees attached to the executable swap step.
- Reject fee tokens outside the expected route assets or configured route chain unless explicitly reviewed.
- Profitability must use the post-fee `estimate.toAmountMin`; a route with included fees is still rejected if it misses `quoteAmountDueRaw`, gas cost, or `profitMinOutRaw`.

Do not mutate LI.FI calldata. Unlike decoded 1inch `SwapDescription`, the generic LI.FI transaction payload is provider-owned calldata. Raising min-out must be done by requesting a fresh quote with tighter slippage and by enforcing the approved floor on-chain after the call.

Selector observation:

- Log `transactionRequest.to`, top-level `tool`, effective included swap tool, and `transactionRequest.data.slice(0, 10)` for every accepted LI.FI quote.
- In canary mode, record observed selectors per chain/tool/call target in the route-shape canary summary, and emit a target-to-selector `observedSelectorAllowlist` shape that can be reviewed and promoted into production `selectorAllowlist`.
- In production mode, reject unknown selectors in the TypeScript validator and require the taker to enforce the same selector allowlist on-chain. This does not replace call-target and spender allowlists; it narrows allowed behavior within an already allowlisted target.

### 3. Taker Contract

Add `contracts/takers/LifiKeeperTaker.sol`.

Keep the deployed contract surface focused even if it lives in one file. The implementation should split the flow into small internal units rather than one large callback:

- `_validateSwapDetails`
- `_preparePoolTakeApproval`
- `_executeLifiCall`
- `_resetExternalAllowance`
- `_assertQuoteDelta`
- `_assertExactSourceConsumption`
- focused allowlist helpers for target, spender, and selector checks

Recommended ABI payload:

```solidity
struct LifiSwapDetails {
    address approvalSpender;
    address srcToken;
    address dstToken;
    address dstReceiver;
    uint256 amountInTokenUnits;
    uint256 amountOutMinimum;
    bytes callData;
}
```

Use the factory `takeWithAtomicSwap(..., address swapRouter, bytes swapDetails)` `swapRouter` parameter as the single LI.FI call target. `LifiProvider` must pass the validated `transactionRequest.to` as `swapRouter`; `LifiSwapDetails` must not duplicate it. The taker should use `swapRouter` for call-target allowlist checks, selector allowlist lookup, and the low-level external call.

Contract checks:

- Only authorized factory/owner can enter `takeWithAtomicSwap`, following existing taker patterns.
- Pool must validate against configured Ajna pool factory.
- Source must be `IAjnaKeeperTaker.LiquiditySource.Lifi`.
- Callback must be `nonReentrant`, matching the direct factory taker pattern.
- Callback `msg.sender` must be a valid Ajna pool.
- Callback must match the active factory-started `takeWithAtomicSwap` context and exact encoded callback data.
- `srcToken == pool.collateralAddress()`.
- `dstToken == pool.quoteTokenAddress()`.
- `dstReceiver == address(this)`.
- `amountInTokenUnits` is token smallest units and must equal the actual collateral token balance available to the taker for this callback.
- `amountOutMinimum >= quoteAmountDue` or compute `requiredQuoteReceived = max(amountOutMinimum, quoteAmountDue)`.
- `swapRouter` is nonzero and allowlisted as the LI.FI transaction target.
- `approvalSpender` is allowlisted.
- `callData.length >= 4`.
- `bytes4(callData)` is allowlisted for `swapRouter` when production selector allowlisting is enabled.
- Native value is always zero.
- The LI.FI taker must not expose a generic external-call method outside the Ajna callback path.

Execution:

Outer `takeWithAtomicSwap` flow:

- Decode and validate `LifiSwapDetails` before calling the pool.
- For v1, require the taker has zero `srcToken` balance before `pool.take`; any stale collateral inventory should be recovered before enabling LI.FI for that pool.
- Compute the quote-token approval for Ajna using the existing factory-taker pattern, for example `ceilWmul(maxAmount, auctionPrice) / pool.quoteTokenScale()`.
- Approve only the computed quote-token amount to the Ajna pool before `pool.take`.
- Call `pool.take(borrowerAddress, maxAmount, address(this), data)`.
- Clear the active callback context immediately after `pool.take` returns.
- Reset the quote-token allowance to the Ajna pool to zero immediately after `pool.take` returns.
- Recover quote-token surplus to owner after the pool allowance reset, consistent with existing takers.
- For v1, assert the post-take `srcToken` balance is zero; do not silently retain or recover callback collateral in production execution.

Callback swap flow:

- Record quote token balance before external call.
- Record collateral token balance before external call.
- Require collateral token balance before external call equals `amountInTokenUnits`.
- Approve exact `amountInTokenUnits` of collateral to `approvalSpender`, using reset-to-zero handling for USDT-style tokens.
- Call `swapRouter.call(callData)` with value zero.
- Check the low-level call `success` flag. Bubble or wrap the revert reason; do not treat returned bytes as proof of output.
- Reset collateral allowance to zero immediately after successful external-call return and before post-call output checks. If the taker reverts, the whole transaction rolls back, including the prior approval.
- Require actual quote-token balance delta to be at least `max(amountOutMinimum, quoteAmountDue)`.
- Require all callback collateral to be consumed by the external call in v1. Reject leftover source collateral before returning from the callback.

Use actual balance delta, not router return values. This preserves the invariant added for Uniswap/Sushi/Curve and avoids trusting arbitrary aggregator return data. V1 exact-consumption avoids silent source-token inventory drift; if live canaries show legitimate LI.FI dust refunds, add an explicit v2 recovery policy with separate tests and operator approval.

Allowlist management options:

- Simpler: immutable arrays at deploy time. This is safest but requires redeploy when LI.FI changes targets.
- More maintainable: owner-managed mappings with events. If used, require deploy scripts and startup validation to reconcile config with chain state.

Prefer owner-managed mappings for production maintainability, but keep the contract fail-closed: an unlisted LI.FI target or spender must revert. Allowlist mutation is owner policy, not factory execution authority. Production selector allowlisting should also be enforced on-chain per call target, with startup preflight reconciling configured selectors against taker contract state. Canary deployments may run selector observation off-chain first, but production should not rely only on TypeScript selector checks for generic calldata.

Operational update workflow:

- Do not mutate production target, spender, or selector allowlists one-by-one while LI.FI live execution is enabled.
- Preferred workflow: disable LI.FI live execution for the affected chain, batch apply owner-only allowlist changes with a deploy/script command, run startup preflight reconciliation, run the route-shape and callback-path canaries, then re-enable LI.FI.
- If batching is not implemented in the first contract version, deployment scripts must still treat the update as an atomic operational runbook: apply all changes, verify exact config/on-chain agreement, and refuse production enablement on any mismatch.
- Tests should cover partial allowlist update failure and prove production preflight keeps LI.FI disabled until every target, spender, and selector matches config.

Recommended on-chain allowlist surface:

```solidity
event CallTargetUpdated(address indexed target, bool allowed);
event ApprovalSpenderUpdated(address indexed spender, bool allowed);
event CallSelectorUpdated(address indexed target, bytes4 indexed selector, bool allowed);

function setCallTarget(address target, bool allowed) external onlyOwner;
function setApprovalSpender(address spender, bool allowed) external onlyOwner;
function setCallSelector(address target, bytes4 selector, bool allowed) external onlyOwner;
function isCallTargetAllowed(address target) external view returns (bool);
function isApprovalSpenderAllowed(address spender) external view returns (bool);
function isCallSelectorAllowed(address target, bytes4 selector) external view returns (bool);
```

Startup preflight should read these views and require exact agreement with `callTargetAllowlist`, `approvalSpenderAllowlist`, and `selectorAllowlist` in production.

### 4. Factory and Enum Changes

Update `contracts/interfaces/IAjnaKeeperTaker.sol`:

```solidity
enum LiquiditySource {
    None,
    OneInch,
    UniswapV3,
    SushiSwap,
    Curve,
    Lifi
}
```

Update `src/config/schema.ts` with the same numeric value.

Update factory source iteration. `AjnaKeeperTakerFactory.getConfiguredTakers()` currently loops `i < 5`, which excludes any source after `Curve`. Replace magic bounds with a named max source constant or loop through an explicit source list so `Lifi` is returned and tested.

Do not add LI.FI to the legacy direct `AjnaKeeperTaker.sol` unless direct non-factory LI.FI execution is explicitly needed. A separate factory taker keeps the generic-call risk isolated.

### 5. Quote Evaluation

Add `getLifiPathQuoteEvaluation(...)` analogous to the 1inch path, but with LI.FI-specific validation.

Evaluation flow:

1. Resolve chain ID and verify signer chain matches configured chain.
2. Resolve token decimals and convert candidate collateral WAD to token decimals.
3. Request a LI.FI quote for exact collateral input.
4. Validate response.
5. Retain `estimate.toAmount` as LI.FI expected-output telemetry on the approved provider quote.
6. Use `estimate.toAmountMin` as the executable/economic quote amount and route minimum output for approval, ranking, and final min-out checks. The keeper cannot raise LI.FI's opaque calldata min-out, so approving from the provider floor avoids accepting routes whose expected output is above the keeper floor while provider-enforced slippage protection is below it.
7. Compute `quoteAmountDueRaw`, market-factor floor, gas/profit floor, and effective min-out with the existing `applyExternalTakeRoutePolicy`.
8. Return:
   - `externalTakePath: 'lifi'`
   - `selectedLiquiditySource: LiquiditySource.LIFI`
   - provider quote telemetry keeps `lifiQuote.quoteAmountRaw = estimate.toAmount`
   - route evaluation uses `quoteAmountRaw = estimate.toAmountMin`
   - `routeMinOutRaw = estimate.toAmountMin`
   - `approvedMinOutRaw` from route policy
   - `amountInTokenUnits` from the centralized collateral WAD-to-token-unit conversion helper
   - `quotedAtMs` from the local validated-response timestamp
   - validated `transactionRequest`, `transactionTarget`, `approvalSpender`, `tool`, `selector`, and parsed `feeCosts`

Do not approve a LI.FI path unless `approvedMinOutRaw <= estimate.toAmountMin` at final refresh. If the provider-calldata slippage floor is weaker than the keeper's approved floor, execution may still revert safely, but it wastes gas. Prefer rejecting before submission.

Gas and profit modeling:

- Quote-time evaluation must include a conservative route gas estimate for `LiquiditySource.LIFI`.
- Prefer `discovery.take.dexGasOverrides[LiquiditySource.LIFI]` as the required production input, seeded from measured fork/canary execution gas plus the existing L2 buffer policy.
- Do not use LI.FI `transactionRequest.gasLimit` or simulation fields as authoritative when `skipSimulation=true`.
- If no LI.FI gas model is configured, reject LI.FI for `maximize_profit` ranking rather than treating route execution cost as zero.
- Final local gas estimation before submission remains mandatory and must fail closed, but it is too late to be the only profitability gate.

### 6. Execution Refresh

Before submission:

1. Refresh auction state as the current hybrid path does.
2. Recompute expected actual collateral token amount.
3. Request a fresh LI.FI quote with conservative slippage.
4. Validate that:
   - `action.fromAmount` still equals the expected collateral token amount,
   - `estimate.toAmount >= approvedMinOutRaw`,
   - `estimate.toAmountMin >= approvedMinOutRaw`,
   - call target and approval spender remain allowlisted,
   - `Date.now() - quotedAtMs <= maxQuoteAgeMs` using the keeper-stamped validated-response timestamp.
5. If `estimate.toAmount >= approvedMinOutRaw` but `estimate.toAmountMin < approvedMinOutRaw`, optionally retry once with a tighter computed slippage cap. If LI.FI still returns a weak minimum, reject before submission.
6. Encode `LifiSwapDetails` with `amountInTokenUnits = validated exact collateral token units` and `amountOutMinimum = approvedMinOutRaw`.
7. Use local `estimateGasWithBuffer` on the final factory `takeWithAtomicSwap` transaction and fail closed if gas cannot be estimated.

If actual collateral can differ from the quoted amount, skip LI.FI for that candidate. Generic calldata is not safely patchable.

LI.FI exact-input `/quote` exposes slippage, not an explicit min-out override. Treat `estimate.toAmountMin` as a provider-enforced floor and `amountOutMinimum` as the keeper-enforced floor. If those floors disagree, prefer skipping over submitting a transaction that is expected to revert.

Do not attempt the `/quote/toAmount` endpoint for callback execution. It solves the opposite problem by finding the input needed for a desired output, while Ajna gives the taker an exact callback collateral amount that cannot be increased after the take starts.

### 7. Hybrid Discovery Refactor

The current discovery path has several binary assumptions around `oneinch` and `factory`. Refactor to route providers:

```ts
interface ExternalTakeRouteProvider {
  path: ExternalTakePathKind;
  supportedSources(): readonly LiquiditySource[];
  supportedCircuitPurposes(): readonly ExternalTakeCircuitPurpose[];
  quote(params): Promise<ExternalTakeQuoteEvaluation>;
  prepareExecution(params): Promise<PreparedExternalTakeExecution>;
  execute(params): Promise<ExternalTakeExecutionAttemptResult>;
}
```

Provider list:

- oneinch provider,
- lifi provider,
- factory provider with dynamic factory sources.

The LI.FI taker can still be registered in `AjnaKeeperTakerFactory`, but `lifi` should not be added to `FACTORY_DYNAMIC_SOURCES`. In keeper terminology, `factory` means the typed direct-DEX adapters; `lifi` is a separate aggregator path that happens to use the factory dispatcher.

Provider-keyed state model:

- New providers must not require a new flat stat field for every approved, executed, dry-run, or failure counter. Existing oneinch/factory compatibility counters may remain during migration, but new provider counters should be recorded through provider-keyed records.
- Do not add `approvedLifi...`, `executedLifi...`, `dryRunLifi...`, or `lifi...Failure` fields to `DiscoveredTakeTargetStats`. Use `externalTakeByPath[path]` counters, with optional source breakdowns inside the factory provider.
- Provider circuit state should move toward a typed nested map, for example `providerCircuits[path][purpose]`, not string-concatenated keys such as `providerCircuits['lifi:route_quote']`. Each provider should declare its supported circuit purposes so typos are rejected at compile time.
- Selection, fallback, and logging should consume provider metadata from the selected provider instead of branching over every path in shared discovery code.

Ownership boundary:

- The hybrid executor only knows about `ExternalTakeRouteProvider` instances.
- `FactoryProvider` owns typed direct-DEX adapters only: Uniswap V3, SushiSwap, and Curve.
- `LifiProvider` owns every LI.FI-specific detail, including factory registration checks, final quote refresh, `LifiSwapDetails` encoding, local gas estimation, submission through the factory dispatcher, and LI.FI-specific failure classification.
- Shared discovery code must not branch on "factory but LI.FI" mechanics. Any factory-dispatched aggregator detail belongs behind `LifiProvider`.

Execution dispatch:

- The hybrid executor must dispatch through the selected provider. Do not implement `if oneinch else factory` fallback logic once LI.FI is added.
- Each provider owns its final refresh, calldata preparation, local gas estimation, submission, and pre-broadcast failure classification.
- LI.FI pre-submit failures, including stale quote, weak `toAmountMin`, non-allowlisted target/spender, unknown selector, and gas-estimation failure, should be classified as pre-broadcast failures so the hybrid executor can try the next approved fallback path.
- Once a transaction submission is accepted by the configured write transport, or the transport reports a nonce-consumed/maybe-accepted submission outcome, do not try a fallback for the same candidate in the same cycle. Fallback is only safe before transport acceptance or when the path is provably dry-run/no-broadcast.

Selection rules:

- `maximize_profit`: probe enabled providers within per-provider and global budgets, then pick the approved route with highest net profit.
- `factory_first`: probe factory first, then continue to aggregators only when factory is rejected or subsidized.
- Existing `hybridGasQuoteFailureFallbackMode: factory_first` remains factory-only. Do not use LI.FI as the fallback when native-to-quote gas conversion is unavailable, because aggregator routes add more calldata and off-chain failure modes.

Circuit breaking:

- Replace one-inch-only circuit state with typed provider-keyed circuit state:
  - `providerCircuits.oneinch.route_quote`
  - `providerCircuits.oneinch.swap_data`
  - `providerCircuits.lifi.route_quote`
  - `providerCircuits.lifi.execution_refresh`
- Keep provider failures isolated so LI.FI rate limits do not disable 1inch and 1inch failures do not suppress LI.FI.
- Treat an open `providerCircuits.lifi.execution_refresh` circuit as a LI.FI pre-broadcast failure so hybrid execution can use the next approved route without repeatedly refreshing stale or failing LI.FI calldata.

Telemetry:

- Emit selected path, selected source, LI.FI tool key, expected output, min output, approved min output, transaction target, approval spender, and rejection reason.
- Emit LI.FI top-level step type, top-level tool, call selector, route gas model, configured gas override, and configured LI.FI mode.
- Do not log API keys.

### 8. Startup Preflight

Update `src/discovery/route-preflight.ts` and related config extraction:

- Add `LiquiditySource.LIFI` to the taker contract key map with only the canonical `Lifi` key; do not add compatibility aliases.
- Ensure `resolveExternalTakePaths` maps default `LiquiditySource.LIFI` to `['lifi']` when `allowedExternalTakePaths` is omitted.
- When resolved external take paths include `lifi`, require `validateRouteDeployments=true`.
- When resolved external take paths include `lifi`, require a conservative `discovery.take.dexGasOverrides[LiquiditySource.LIFI]` or an explicitly documented LI.FI gas model.
- Check code exists at `takers.factory`.
- Check code exists at `takers.contracts.Lifi`.
- Verify `AjnaKeeperTakerFactory.takerContracts(LiquiditySource.LIFI)` equals `takers.contracts.Lifi`.
- Check code exists at every configured LI.FI call target allowlist entry.
- Check code exists at every configured LI.FI approval spender allowlist entry.
- In production, verify configured LI.FI call selectors are also registered on-chain for each call target.
- Optionally validate configured `allowExchanges`, `denyExchanges`, and `preferExchanges` against `GET /v1/tools` in an env-gated startup or canary path, not every hot loop.
- Reject broad or reserved exchange filters such as `all`, `default`, `none`, `[]`, and empty-list broadening in production. Permit them only in explicit no-broadcast canary commands with `allowBroadExchangeFilters=true`.
- Reject conflicting exchange filter config, such as the same tool key in both allow and deny sets.
- In production, validate `selectorAllowlist` entries are present for every configured call target.

### 9. Tests

Unit tests:

- Phase 2 provider-refactor gate: prove existing 1inch-only, factory-only, 1inch-plus-factory hybrid, `maximize_profit`, `factory_first`, and gas-quote fallback behavior is unchanged before LI.FI exists as an enabled provider.
- Phase 2 provider-refactor gate: prove new provider stats are provider-keyed and do not require adding source-specific fields for a new provider; existing oneinch/factory compatibility counters may remain until a broader stats migration.
- Config accepts valid LI.FI path and rejects missing taker, missing allowlists, invalid slippage, invalid max price impact, and malformed API base URL.
- Config rejects live `lifi` execution unless `dex.lifi.mode='production'`.
- Config accepts `canary` mode only for no-broadcast/fork validation commands and rejects canary mode in the live discovery hot path.
- No-broadcast canary tests prove the exact `npm run lifi-route-canary` command path cannot call `sendTransaction`, `verifyAndSubmit`, contract write methods, or allowance cleanup writes.
- Config rejects missing `validateRouteDeployments=true` when LI.FI is enabled for discovered hybrid takes.
- Config rejects invalid `maxQuoteAgeMs` and malformed exchange-filter entries.
- Config rejects broad production `allowExchanges` keywords such as `all` and `default`.
- Config rejects `allowBroadExchangeFilters=true` in production and accepts it only for no-broadcast canary mode.
- Config rejects duplicate or conflicting tool keys across allow/deny/prefer exchange filters.
- Config rejects missing or malformed LI.FI route gas override when LI.FI is enabled for ranked discovered takes.
- Config rejects production LI.FI config without `selectorAllowlist` entries for every configured call target.
- `resolveExternalTakePaths` resolves default `LiquiditySource.LIFI` to `['lifi']` when no explicit path list is present.
- `resolveExternalTakePaths` respects explicit mixed path lists and does not treat `LIFI` as a `FACTORY_DYNAMIC_SOURCES` member.
- Route policy preserves profit floor for LI.FI exactly as it does for 1inch and factory.
- Collateral WAD-to-token-unit conversion is centralized and tested for 6, 8, and 18 decimal collateral with rounding behavior matching the existing external-take quote path.
- LI.FI API client rejects every malformed response listed in the validation section.
- LI.FI API client accepts a top-level `"lifi"` wrapper only when it contains one same-chain executable swap step, optionally preceded by the approved leading included `feeCollection` step, and all top-level transaction fields match keeper policy.
- LI.FI API client rejects top-level `"lifi"` wrappers with zero executable swap steps, multiple executable swap steps, nested `lifi`, unsupported `protocol`, `cross`, destination calls, fee-collection steps outside the approved leading position, or conflicting transaction fields.
- LI.FI API client rejects any accepted quote whose `includedSteps` shape is not exactly one swap step or one leading `feeCollection` step followed by one swap step.
- LI.FI API client rejects any non-`swap` executable step, including unsupported `protocol`, `lifi`, and `cross` steps.
- LI.FI API client rejects disallowed top-level or nested tools, missing tools, and unknown production selectors.
- LI.FI API client rejects unaccounted `estimate.feeCosts`, malformed fee data, fee token or fee-token-chain mismatches, source-token fees that are not top-level and/or leading included `feeCollection` metadata tied to the approved leading included `feeCollection` step with amounts matching the feeCollection source-token delta, and source-token fees attached to the executable swap step.
- LI.FI API client accepts included `feeCosts` only when `estimate.toAmountMin` is post-fee and still satisfies the approved repayment/profit floor.
- LI.FI API client stamps `quotedAtMs` locally after validation and rejects stale quotes based on that local timestamp.
- LI.FI API client rejects typoed route-filter keys in canary/preflight mode.
- LI.FI API client handles 429, timeout, retryable network failures, and non-retryable schema failures.
- Provider-keyed circuit breaker isolates LI.FI from 1inch.
- Provider dispatch tests prove LI.FI does not fall through into factory execution.
- Provider fallback tests prove LI.FI pre-acceptance failures try the next approved route, while accepted and nonce-consumed/maybe-accepted submission outcomes do not fall back or double-submit.
- Hybrid selection ranks LI.FI, 1inch, and factory by net profit.
- `factory_first` preserves the current behavior and only probes LI.FI after factory rejection/subsidy.
- Provider-refactor tests prove existing 1inch-only, factory-only, and 1inch-plus-factory hybrid behavior is unchanged before LI.FI is added.
- Type tests cover `ApprovedLifiQuoteEvaluation`, `ApprovedExternalTakeQuoteEvaluation`, `DiscoveryExecutionConfig`, provider stats, and provider circuit state, and prove `ExternalTakeStrategyKind` remains unchanged.

Contract tests:

- Phase 4 contract gate: every contract test uses a mock target and proves the callback never trusts router return values for output accounting.
- Successful LI.FI mock route repays quote due, meets min-out, resets allowance, and recovers surplus.
- Successful LI.FI mock route consumes all callback collateral exactly for v1.
- Revert when quote balance delta is below `amountOutMinimum`.
- Revert when quote balance delta repays Ajna but misses keeper profit floor.
- Revert when quote balance delta is below `quoteAmountDue`.
- Revert when mock target returns success but transfers wrong token.
- Revert when call target is not allowlisted.
- Revert when approval spender is not allowlisted.
- Revert when calldata selector is not allowlisted for the call target in production.
- Revert when LI.FI calldata tries to spend a different amount than callback collateral.
- Revert when callback source-token balance differs from `amountInTokenUnits`.
- Revert when a valid Ajna pool calls the callback outside an active factory-started take, even with valid LI.FI calldata and stale collateral on the taker.
- Revert when the taker has stale source-token balance before `pool.take`.
- Revert when mock target leaves collateral dust.
- Revert and leave no lasting allowance when the low-level LI.FI target call reverts.
- Revert on reentrant callback attempts.
- Revert on nonzero value attempt at the encoded details/config level.
- Verify no collateral allowance remains after success.
- Verify no quote-token allowance to the Ajna pool remains after success.

Integration tests:

- Phase 5 provider-execution gate: LI.FI provider dispatch, ranking, pre-acceptance fallback, and accepted-or-maybe-accepted no-fallback behavior are all tested before LI.FI is enabled in route selection.
- Startup preflight rejects missing LI.FI taker code, missing factory registry entry, wrong factory registry entry, unlisted call target code, and unlisted approval spender code.
- Factory registers `LifiKeeperTaker` and reports it from `getConfiguredTakers`.
- Hybrid route selection executes LI.FI when factory has no pool and 1inch is disabled or rejected.
- Hybrid route selection chooses factory when factory has higher net profit.
- Hybrid route selection chooses 1inch when 1inch has higher net profit and LI.FI is lower.
- Hybrid route selection rejects LI.FI when the configured gas model is missing and `maximize_profit` would otherwise rank it.
- LI.FI timeout falls back to another approved path.
- LI.FI stale refresh quote rejects before submission.
- LI.FI underdelivery reverts atomically and does not leave allowances.
- Env-gated no-broadcast route-shape canary fetches LI.FI same-chain routes for known token pairs, validates response shape and allowlists, and proves no live transaction submission path is reachable. Local runs may skip when live config is absent, but LI.FI production enablement gate runs must set `AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE=true` and pass `--config` so missing production config, non-production `dex.lifi`, missing `takers.contracts.Lifi`, incomplete production chain policy, custom API base URLs, LI.FI policy env overrides including API-base overrides, route-level taker-address overrides, or ambiguous multi-chain production config exit non-zero and cannot count as passing evidence. A successful required-live no-broadcast route-shape canary using the reviewed production keeper config is the first LI.FI production enablement gate for the target chain.
- Env-gated Base fork execution canary verifies the configured production factory and `takers.contracts.Lifi` are deployed and registered, then runs real LI.FI calldata from the default LI.FI API through an isolated local `LifiKeeperTaker` from an Ajna callback path where the taker has no pre-existing collateral balance before callback entry. It must load the reviewed production keeper config from `AJNA_AGENT_LIFI_FORK_CANARY_CONFIG` or `AJNA_AGENT_LIFI_CANARY_CONFIG`, require `takers.contracts.Lifi`, and reject custom or mocked API base URLs and LI.FI policy env overrides. This is optional for ordinary local/unit runs but a successful callback-path fork execution canary using the reviewed production config policy, verified production registration, and the default LI.FI API is the second LI.FI production enablement gate for Base. Non-Base chains require an equivalent reviewed chain-specific callback-path fork canary before LI.FI production support is claimed.

Invariant-style assertions:

- Phase 6 fork/canary gate: no production config should claim LI.FI production support for a chain/pair until both LI.FI production enablement gates have passed for representative pairs: a required-live no-broadcast route-shape canary for the target chain using the reviewed production keeper config, and a callback-path fork execution canary that verifies production registration and executes real default-API LI.FI calldata through an isolated local callback harness under the reviewed production config policy. The checked-in fork canary covers Base only; non-Base chains require an equivalent reviewed chain-specific fork canary.
- For every approved external path: `approvedMinOutRaw >= quoteAmountDueRaw`.
- For every non-subsidized approved path: `approvedMinOutRaw >= profitMinOutRaw`.
- For every executed path: actual quote delta is the only output source of truth.
- For every failed external call: no successful take transaction is submitted.
- For every successful LI.FI execution: collateral allowance to approval spender is zero afterward.
- For every successful LI.FI execution: quote-token allowance to the Ajna pool is zero afterward.
- For every successful LI.FI execution: callback collateral is consumed exactly and source-token balance is zero afterward.
- For every LI.FI quote request: source chain equals destination chain, source and destination token addresses are valid nonzero ERC20 addresses, source amount is a positive raw token-unit integer, and `fromAddress`/`toAddress` both equal the LI.FI taker before any external quote request is sent.
- For every LI.FI quote: top-level action source chain, top-level action destination chain, transaction chain, pool collateral, pool quote, top-level action sender/receiver, and optional transaction sender all match; included swap `action.fromAddress` / `action.toAddress` are not treated as sender/receiver source of truth for approved same-chain fee-collection routes.
- For every LI.FI ranked quote: route profitability includes nonzero LI.FI execution gas cost from the configured local gas model.

### 10. Rollout

Phase 1: document and fixtures.

- Land this plan.
- Add LI.FI API response fixtures for valid same-chain route, bridge route, wrong chain, wrong token, nonzero value, unlisted target, unlisted spender, weak min-out, and 429.
- Add fixtures for valid top-level `lifi` wrapper with one included same-chain swap, valid top-level `lifi` wrapper with a leading feeCollection step plus one included same-chain swap, and invalid wrappers with zero executable swaps, multiple executable swaps, nested `lifi`, unsupported `protocol`, `cross`, destination call, misplaced feeCollection, conflicting transaction fields, and missing nested tool.
- Add fixtures for included output-token fees, approved top-level and leading feeCollection source-token fee metadata, feeCollection source-token delta mismatches, executable-swap source-token fee rejection, unaccounted fees, unapproved source-token fees, wrong-chain fee costs, malformed fee costs, unknown selector, stale local quote timestamp, broad exchange filters, typoed exchange filter, stale pre-take source collateral, and leftover-collateral mock behavior.

Phase 2: provider abstraction and compatibility counters.

- Generalize discovery providers around the existing oneinch and factory paths only.
- Introduce provider-keyed stats/failure counters at the shared external-take extension points before enabling LI.FI in route selection. Preserve existing oneinch/factory fields as compatibility outputs while ensuring LI.FI does not add flat LI.FI-specific stat fields.
- Keep factory's Uniswap V3, SushiSwap, and Curve source breakdown inside the factory provider instead of exposing each direct-DEX adapter as a top-level shared-executor branch.
- Preserve current oneinch-only, factory-only, hybrid maximize-profit, hybrid factory-first, and gas-quote fallback behavior.
- Keep `ExternalTakePathKind` at `oneinch | factory` until this phase is green.

Phase 3: API client and config.

- Add the `src/dex/lifi/` module tree: `index.ts`, `client.ts`, `schema.ts`, `filters.ts`, `fee-policy.ts`, `validate-route.ts`, and `fixtures/`.
- Add config schema and validation.
- Add route-preflight extraction for LI.FI config and allowlists.
- Add typed LI.FI quote/evaluation types, including `ApprovedLifiQuoteEvaluation`.
- Extend `ExternalTakePathKind`, `ApprovedExternalTakeQuoteEvaluation`, and provider-aware config/stats/telemetry plumbing with `lifi`.
- Do not add `lifi` to `ExternalTakeStrategyKind`; LI.FI is a provider/path inside hybrid external takes, not a new execution strategy.
- Do not add LI.FI-specific stats fields to `DiscoveredTakeTargetStats`; use `externalTakeByPath[path]` counters.
- Add local `quotedAtMs`, `amountInTokenUnits`, optional future provider expiry, parsed `feeCosts`, selected tool, selector, transaction target, approval spender, and transaction request to `ApprovedLifiQuoteEvaluation`.
- Add centralized collateral WAD-to-token-unit conversion helper coverage for 6, 8, and 18 decimal collateral.
- Add unit tests.
- No contract changes yet.

Phase 4: contract and factory.

- Add `LifiKeeperTaker.sol`.
- Update source enums and factory iteration.
- Update `src/discovery/route-preflight.ts` for LI.FI taker and allowlist code checks.
- Add mock target contracts and focused contract tests.
- Run `npx hardhat compile`.

Phase 5: enable LI.FI provider in hybrid discovery.

- Add LI.FI provider.
- Replace binary hybrid execution dispatch with provider-owned dispatch before enabling LI.FI in route selection.
- Preserve all existing 1inch-plus-factory tests.
- Add hybrid route ranking and fallback tests.

Phase 6: fork/canary validation.

- Add `npm run lifi-route-canary` as an env-gated no-broadcast LI.FI route-shape canary. Local runs may skip when live config is absent; LI.FI production enablement gate runs must set `AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE=true` and pass `--config` so missing production config, non-production `dex.lifi`, missing `takers.contracts.Lifi`, incomplete production chain policy, custom API base URLs, LI.FI policy env overrides including API-base overrides, route-level taker-address overrides, ambiguous multi-chain config without `AJNA_AGENT_LIFI_CANARY_CHAIN_ID`, or non-Base runs without `AJNA_AGENT_LIFI_CANARY_ROUTES_JSON` exit non-zero.
- Reuse the existing discovery dry-run/write-submission guardrails for the canary command and keep a regression that fails if the route-shape canary can broadcast, submit a contract write, or run allowance cleanup writes.
- Treat the required-live no-broadcast route-shape canary and the callback-path fork execution canary using the reviewed production keeper config and the default LI.FI API as the two LI.FI production enablement gates, not general test-suite requirements. The required-live route-shape canary is target-chain evidence for the production `takers.contracts.Lifi` receiver; the checked-in callback-path fork canary is Base-only evidence for configured production registration plus isolated local callback execution under the reviewed production config policy, so non-Base chains require an equivalent reviewed chain-specific fork canary. They remain env-gated so local/unit runs do not require live LI.FI access.
- Validate `GET /v1/tools` exchange-filter keys when configured.
- Record call selectors per route target and promote reviewed selectors into the production allowlist before live enablement.
- Add `npm run lifi-fork-execution-canary` as an env-gated Base fork execution canary that loads the reviewed production keeper config from `AJNA_AGENT_LIFI_FORK_CANARY_CONFIG` or `AJNA_AGENT_LIFI_CANARY_CONFIG`, rejects custom or mocked API base URLs and LI.FI policy env overrides, verifies the configured production factory and `takers.contracts.Lifi` are deployed and registered, fetches a real same-chain LI.FI quote from the default LI.FI API for the local harness taker address, seeds the local harness taker only through the Ajna callback flow, executes `takeWithAtomicSwap` on a local fork, and verifies repayment, approved min-out equal to route min-out plus the configured raw-unit surplus floor, allowance resets, exact collateral consumption, and surplus policy.
- Run Base fork integration tests.
- Only enable production config after allowlists are confirmed for the target chain.

Phase 7: production enablement.

- Start with `allowedExternalTakePaths: ['factory', 'lifi']` or `['factory', 'oneinch', 'lifi']` depending on whether 1inch remains allowed.
- Keep `externalTakeRouteSelectionMode: 'factory_first'` initially if API rate limits are a concern.
- Monitor LI.FI rejection reasons, circuit state, quote latency, and underdelivery reverts.
