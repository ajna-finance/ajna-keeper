# Ajna keeper live operational patches — 2026-06-04

Repo: `/home/clawuser/repos/ajna-keeper`
Branch: `master`
Remote baseline checked: `origin/master` at `660b7f6`
Created: `2026-06-04T05:33:54Z`

## Purpose

This note documents the two local tracked source patches currently needed for the live Base `ajna-keeper` runtime after pulling latest remote `master`.

These patches are intentionally narrow and do **not** include local secrets, keystores, `.env`, tmux wrapper scripts, or untracked operational files.

## Current tracked patch set

```text
src/discovery/types.ts      | 3 +++
src/take/factory/uniswap.ts | 9 ++++++++-
2 files changed, 11 insertions(+), 1 deletion(-)
```

## Patch 1 — propagate `takers.contracts` into discovery execution config

### Problem

`base-config.ts` can correctly contain:

```ts
takers: {
  factory: '...',
  contracts: {
    UniswapV3: '...',
  },
}
```

…but on `origin/master` the runtime adapter `getDiscoveryExecutionConfig()` did not return `takerContracts` in the execution config used by discovery/manual take execution.

That means raw config validation can pass, while route execution later sees:

```ts
{
  keeperTakerFactory: '...',
  takerContracts: undefined,
}
```

Then `resolveExternalTakeDeployment()` resolves the Uniswap V3 factory route as unavailable with:

```text
takerContracts.UniswapV3 is not configured
```

### Local fix

Add `ExternalTakeTakerContractKey`, include `takerContracts` in `DiscoveryExecutionConfig`, and return `config.takers?.contracts` from `getDiscoveryExecutionConfig()`.

```diff
diff --git a/src/discovery/types.ts b/src/discovery/types.ts
index 1fde7d2..fecf414 100644
--- a/src/discovery/types.ts
+++ b/src/discovery/types.ts
@@ -3,6 +3,7 @@ import {
   AutoDiscoverConfig,
   CurveRouterOverrides,
   DiscoveredDefaultsConfig,
+  ExternalTakeTakerContractKey,
   KeeperConfig,
   LifiDexConfig,
   LiquiditySource,
@@ -27,6 +28,7 @@ export interface DiscoveryExecutionConfig {
   discoveredDefaults?: DiscoveredDefaultsConfig;
   keeperTaker?: string;
   keeperTakerFactory?: string;
+  takerContracts?: Partial<Record<ExternalTakeTakerContractKey, string>>;
   lifi?: LifiDexConfig;
   lifiTaker?: string;
   oneInchAggregationExecutorAllowlist?: { [chainId: number]: string[] };
@@ -58,6 +60,7 @@ export function getDiscoveryExecutionConfig(
     discoveredDefaults: config.discovery?.defaults,
     keeperTaker: config.takers?.oneInch,
     keeperTakerFactory: config.takers?.factory,
+    takerContracts: config.takers?.contracts,
     lifi: config.dex?.lifi,
     lifiTaker:
       lifiDeployment.deploymentType === 'lifi'
```

### Verification performed

A local `ts-node` probe showed:

```json
{
  "configHasUniswapTaker": true,
  "returnedByExecutionConfig": true,
  "withContracts": { "deploymentType": "factory" },
  "withoutContracts": {
    "deploymentType": "none",
    "unavailableReason": "takerContracts.UniswapV3 is not configured"
  }
}
```

## Patch 2 — use Ajna repayment floor as router `amountOutMinimum`

### Problem

On `origin/master`, `executeUniswapV3FactoryTake()` used `computeFactoryAmountOutMinimum()` as the on-chain SwapRouter02 `amountOutMinimum`.

That value is the approved/profit min-out. It is useful for offchain route approval, but it can over-constrain the on-chain router swap. The route can still be a valid Ajna take if it repays the auction quote due, but revert if the router output is below the stricter offchain profit floor.

The intended split is:

- Offchain: keep `computeFactoryAmountOutMinimum()` to validate the route clears profitability / policy floors.
- Onchain router min-out: use the exact Ajna quote repayment floor from `getQuoteAmountDueRaw()`.

This preserves the profitability guard before submission while avoiding unnecessary `Too little received` router reverts for otherwise valid takes.

### Local fix

Import `getQuoteAmountDueRaw`, keep `computeFactoryAmountOutMinimum()` as a validation call, then use `getQuoteAmountDueRaw()` for `routerAmountOutMinimum` passed into SwapRouter02 details.

```diff
diff --git a/src/take/factory/uniswap.ts b/src/take/factory/uniswap.ts
index 591bb7a..76308dc 100644
--- a/src/take/factory/uniswap.ts
+++ b/src/take/factory/uniswap.ts
@@ -29,6 +29,7 @@ import {
   buildFactoryQuoteEvaluation,
   computeFactoryAmountOutMinimum,
   DEFAULT_FACTORY_ROUTE_RPC_TIMEOUT_MS,
+  getQuoteAmountDueRaw,
   formatFactoryExecutionLog,
   formatFactoryPriceCheckLog,
   formatFactoryQuoteRequestLog,
@@ -262,11 +263,17 @@ export async function executeUniswapV3FactoryTake({
       throw new Error(message);
     }
     const swapRouterAddress = routerConfig.swapRouter02Address;
-    const routerAmountOutMinimum = await computeFactoryAmountOutMinimum({
+    await computeFactoryAmountOutMinimum({
       pool,
       liquidation,
       quoteEvaluation,
     });
+    const routerAmountOutMinimum = await getQuoteAmountDueRaw(
+      pool,
+      liquidation.auctionPrice,
+      liquidation.collateral,
+      config.runtimeCache
+    );
     const deadline = await getSwapDeadlineCached({
       signer,
       runtimeCache: config.runtimeCache,
```

## Upstream status as checked

As of `origin/master` commit `660b7f6`:

- `src/discovery/types.ts` contains a LI.FI-specific temporary call with `takerContracts: config.takers?.contracts`, but does **not** propagate `takerContracts` in the returned `DiscoveryExecutionConfig` object.
- `src/take/factory/uniswap.ts` still assigns `routerAmountOutMinimum = await computeFactoryAmountOutMinimum(...)`.

So both local patches remain necessary on current `master`.

`origin/skills-integration` has an older/different version of the propagation shape, but that is not the active live branch and is not directly applicable without reconciling surrounding schema/config changes.

## Runtime verification after patches

After patching and restarting with the 1Password tmux wrapper, runtime checks showed:

- tmux session: `ajna-keeper`
- repo cwd: `/home/clawuser/repos/ajna-keeper`
- wallet loaded successfully
- private RPC take transport configured on Base chain `8453`
- route deployment preflight passed
- take loop healthy with latest `targetFailures=0`
- settlement loop healthy with latest `targetFailures=0`
- no password prompt left open
- no fresh error/failure lines in recent `info.log` tail

## Revert guidance

Only revert these local tracked patches after verifying upstream `master` contains equivalent behavior.

Minimum checks before reverting:

1. `getDiscoveryExecutionConfig()` must return `takerContracts: config.takers?.contracts` or otherwise guarantee Uniswap V3 factory taker addresses are available to manual/discovery execution.
2. Uniswap V3 factory execution must still validate offchain profitability but pass the Ajna quote repayment floor, not the stricter profit-floor min-out, as the on-chain router `amountOutMinimum`.
3. Compile must pass.
4. A startup/restart probe must show `Route deployment preflight passed` and healthy take/settlement summaries.

## Files intentionally not documented here

The following are operational/local and were not included in this patch document:

- keystore files
- `.env` or secret material
- 1Password secret values
- untracked tmux/restart helper scripts
- runtime logs containing any sensitive endpoints
