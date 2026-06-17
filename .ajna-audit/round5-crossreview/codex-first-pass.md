Findings:

- id: AK-CAL-01
  title: Deploy output still tells operators to configure `takers.factory`
  severity: Low
  confidence: High
  file:line: `scripts/deploy-factory-system-cli.ts:615`
  invariant/property: Router authorization/config integrity. The keeper must configure the same router address that takers authorize.
  actor/fund impact: An operator following the generated post-deploy snippet sets `takers.factory`, but the live config type expects `takers.router` at `src/config/schema.ts:660`. External takes then lack `keeperTakerRouter` and fail/skip; no direct fund loss, but missed liquidation execution.
  source evidence: `generateConfigUpdate` prints `factory: '${addresses.factory}'` at `scripts/deploy-factory-system-cli.ts:617-619`; `TakersConfig` exposes only `router?: string` and `contracts?` at `src/config/schema.ts:660-663`.
  minimal failure sequence: deploy with `scripts/deploy-factory-system.ts`; paste the emitted config; start keeper with an external-take source; runtime has no `config.takers.router`; calldata/direct-DEX execution cannot route through `TakerRouter`.
  required test or proof: Add a unit/golden test for generated deployment output asserting `takers.router`, and extend the boundary checker to catch `takers: { factory: ... }`, not only `takers.factory`.
  residual risk: Existing docs/env names still use “factory” in some migration/fixture contexts, so operator-facing naming needs a final pass.

- id: AK-CAL-02
  title: Main deployment script does not deploy/register the new OneInch/Sushi aggregator takers
  severity: Medium
  confidence: Medium-High
  file:line: `scripts/deploy-factory-system-cli.ts:36`
  invariant/property: Router registry completeness. Every enabled taker source must be deployed, authorized to the router, allowlisted where applicable, and registered before execution.
  actor/fund impact: Operators can enable `LiquiditySource.ONEINCH` or `SUSHI_AGGREGATOR`, but the standard deployment path only handles Uniswap, Curve, and LI.FI. Result: `TakerRouter.takerContracts(source)` remains unset and external takes revert/skip with `TakerNotSet`, causing liquidation liveness loss.
  source evidence: `DeploymentAddresses` has only `factory`, `uniswapTaker`, `curveTaker`, `lifiTaker` at `scripts/deploy-factory-system-cli.ts:36-41`; deploy flow only deploys Uniswap/Curve/LI.FI at `scripts/deploy-factory-system-cli.ts:768-805`; registry config only registers Uniswap/Curve there, with LI.FI handled separately at `scripts/deploy-factory-system-cli.ts:436-459`. The source descriptor requires `OneInchAggregator` and `SushiAggregator` taker keys at `src/config/external-take-descriptors.ts:11-16` and maps those sources at `src/config/external-take-descriptors.ts:89-103`.
  minimal failure sequence: configure a pool for `ONEINCH` or `SUSHI_AGGREGATOR`; run the deployment script; generated deployment lacks the corresponding taker and `setTaker`; execution through `TakerRouter.takeWithAtomicSwap` hits an unset source.
  required test or proof: Add deployment-script tests for OneInchAggregator and SushiAggregator paths, including router authorization, allowlist application for Sushi, `setTaker`, and `hasConfiguredTaker(source)` verification.
  residual risk: Manual deployment can work, but the repo’s primary deployment path is incomplete for the new PR surface.

I did not find a concrete fund-loss issue in the reviewed taker callback path. `BaseAggregatorCalldataTaker` binds callback pool plus calldata hash, validates pool/source/dst/receiver, requires actual source balance to match quoted input, enforces target/spender/selector allowlists and target code existence, resets approvals, measures quote-token balance delta, and uses `quoteAmountDueCeiling` for non-18-decimal quote pulls. I did not run tests in this read-only first-pass review.