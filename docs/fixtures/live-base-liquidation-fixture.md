# Live Base Liquidation Fixture

This is advanced fixture tooling for validating keeper discovery and external
take execution against a deliberately created Ajna ERC20 pool on Base.

The scripts are intended for controlled operator testing, not routine keeper
operation. They can deploy test tokens, create a pool, seed Uniswap V3
liquidity, open borrower debt, kick a borrower into liquidation, and then
verify that the keeper discovery path can evaluate or take the auction.

## When To Use

Use this fixture when you need to prove one of these paths end to end:

- a keeper can discover a live Base liquidation through its configured subgraph
- a Uniswap V3 factory external take can execute against fixture liquidity
- hybrid route selection behaves correctly when 1inch and factory paths are both enabled
- the factory-first gas quote fallback behaves as expected when native gas cannot be converted into quote token terms

Use normal unit, integration, and fork-backed production verification tests for
ordinary development. This fixture spends live gas when pointed at Base mainnet.

## Safety Notes

- Use a dedicated operator key with limited funds.
- Do not use a production keeper hot wallet unless you intend it to fund and
  operate the fixture.
- Generated lender and borrower private keys are persisted to
  `AJNA_AGENT_KEY_FILE`, defaulting to `./.fixture-keys.json`.
- `.fixture-keys.json` is ignored by Git and written with mode `0600`, but it is
  still plaintext key material.
- Keep `AJNA_AGENT_ALLOW_EVM_TIME_TRAVEL=no` for live Base.
- Keep `AJNA_AGENT_FINAL_KICK=no` while preparing or testing dry runs.
- Use `--dry-run` with the harness whenever you only want to inspect behavior.

## Commands

Create or reuse a fixture with Uniswap V3 external-take support:

```bash
npm run create-liquidatable-uniswap-fixture
```

Run the local keeper harness against a fixture summary:

```bash
npm run run-fixture-keeper-harness -- \
  --summary /tmp/ajna-liquidation-fixture-summary.json \
  --mode discovery \
  --dry-run
```

The fixture script writes a summary JSON to `AJNA_AGENT_OUTPUT_PATH`, or to a
temporary directory when that variable is unset.

## Environment

Start from the public template:

```bash
cp examples/liquidation-fixture.env.example .env.fixture
```

Load the values in your shell or through your secret manager. At minimum, live
Base runs need:

```bash
export AJNA_AGENT_RPC_URL="https://base-mainnet.example/rpc"
export AJNA_AGENT_KEEPER_KEY="0x..."
export AJNA_AGENT_OUTPUT_PATH="/tmp/ajna-liquidation-fixture-summary.json"
```

The fixture script also shells out to helper CLIs for token deployment and Ajna
pool actions. By default it looks for sibling checkouts at `../token-deployer`
and `../ajna-skills`. If your checkout layout differs, set:

```bash
export AJNA_AGENT_TOKEN_DEPLOYER_REPO="/path/to/token-deployer"
export AJNA_AGENT_AJNA_SKILLS_REPO="/path/to/ajna-skills"
```

To hand the auction to an already-running keeper, reuse the external-take
contracts from that keeper config:

```bash
export AJNA_AGENT_DEPLOY_EXTERNAL_TAKE=no
export AJNA_AGENT_KEEPER_TAKER_FACTORY_ADDRESS="0x..."
export AJNA_AGENT_UNISWAP_V3_TAKER_ADDRESS="0x..."
```

## Liquidity Modes

Choose one fixture liquidity mode.

### Strict Hybrid

Use strict hybrid mode to validate normal hybrid `maximize_profit` behavior:

```bash
export AJNA_AGENT_UNISWAP_LIQUIDITY_MODE=strict_hybrid
```

The script seeds and verifies both route shapes:

- fixture collateral to fixture quote
- WETH to fixture quote

If either route cannot quote, the script exits before the final kick.

### Fallback Regression

Use fallback regression mode to validate
`hybridGasQuoteFailureFallbackMode: 'factory_first'`:

```bash
export AJNA_AGENT_UNISWAP_LIQUIDITY_MODE=fallback_regression
```

The script verifies:

- fixture collateral to fixture quote succeeds
- WETH to fixture quote does not quote

Run the same fixture in two keeper configurations when proving the fallback:

1. Fallback disabled: the keeper should discover the auction and skip with
   `native_to_quote_conversion_unavailable`.
2. Fallback enabled: the keeper should execute the Uniswap V3 factory route if
   the native gas cap and route policy allow it.

For local harness validation:

```bash
npm run run-fixture-keeper-harness -- \
  --summary /tmp/ajna-fallback-fixture-summary.json \
  --mode discovery \
  --hybrid-gas-quote-fallback disabled \
  --auto-warp-to-take \
  --max-take-warps 1 \
  --dry-run

npm run run-fixture-keeper-harness -- \
  --summary /tmp/ajna-fallback-fixture-summary.json \
  --mode discovery \
  --hybrid-gas-quote-fallback factory_first \
  --auto-warp-to-take \
  --max-take-warps 0 \
  --dry-run
```

Remove `--dry-run` only when you intentionally want the harness to submit
transactions on the target network.

## Fee-Tier Coverage

The fixture can seed and probe multiple Uniswap V3 candidate fee tiers:

```bash
export AJNA_AGENT_UNISWAP_FEE_TIER_TEST_MODE=all_configured
export AJNA_AGENT_UNISWAP_FEE_TIERS=3000,500,10000
```

Supported modes:

- `all_configured`: seed every configured candidate tier.
- `default_only`: seed only `AJNA_AGENT_UNISWAP_FEE_TIER`.
- `single_non_default`: seed one configured non-default tier.
- `best_tier_selection`: reserved until per-tier liquidity profiles are implemented.

For `single_non_default`, configure the expected tier explicitly:

```bash
export AJNA_AGENT_UNISWAP_EXPECTED_EXECUTION_FEE_TIER=500
```

## Successful Summary Checks

The summary JSON should show that the fixture reached the intended handoff:

```json
{
  "liquidationCheck": {
    "keeperKickEligibleByCurrentCode": true,
    "keeperCondition": "thresholdPrice >= lup"
  },
  "finalKick": {
    "status": "kicked",
    "auction": {
      "isActive": true
    }
  },
  "uniswapV3ExternalTake": {
    "routeShapeVerification": {
      "status": "passed"
    }
  }
}
```

`finalKick.status: "already_active"` is acceptable on reruns.

For strict hybrid mode, require:

- `routeShapeVerification.strictHybridGasQuoteReady` is `true`
- at least one collateral-to-quote fee tier quoted successfully
- at least one WETH-to-quote fee tier quoted successfully

For fallback regression mode, require:

- `routeShapeVerification.fallbackRegressionGasQuoteOmitted` is `true`
- at least one collateral-to-quote fee tier quoted successfully
- every WETH-to-quote fee tier failed to quote

## Subgraph Handoff

The live keeper discovers auctions from its configured subgraph. A live fixture
is not ready for keeper discovery until that same subgraph indexes the auction.

Query the keeper subgraph for the fixture borrower:

```bash
curl -sS "$AJNA_KEEPER_SUBGRAPH_URL" \
  -H 'content-type: application/json' \
  --data '{"query":"query { liquidationAuctions(first: 20, orderBy: kickTime, orderDirection: desc, where: { settled: false, borrower: \"0xBORROWER_LOWERCASE\" }) { id borrower kickTime debtRemaining collateralRemaining pool { id } } }"}'
```

Accept handoff only when the returned row has:

- `borrower` equal to the summary borrower address
- `pool.id` equal to the summary pool address
- positive `collateralRemaining`

If the summary says the auction is active but the subgraph has not indexed it,
wait. If it never appears, the run found a subgraph/indexing issue rather than
a keeper execution issue.

## Evidence To Capture

Capture these artifacts for a live validation:

- fixture command and non-secret environment profile
- fixture summary JSON
- pool address
- borrower address
- final kick transaction hash
- subgraph row for the active unsettled auction
- keeper logs showing discovered take evaluation with `dryRun=false`
- take transaction hash, or the exact structured skip reason

Useful keeper log markers:

```text
Discovery take cycle summary: ... auctionCount=... targets=... discoveredTargets=...
Discovered take target summary: pool=0x... name="discovered:0x..." dryRun=false candidates=...
executedExternalTakes=1
executedFactoryTakes=1
executedFactorySources=uniswapV3:1
```

For fallback-disabled controls, useful evidence includes:

```text
native_to_quote_conversion_unavailable
Hybrid gas quote fallback skipped
```

For fallback-enabled runs, useful evidence includes:

```text
Hybrid external take max-profit ranking unavailable
factory_gas_quote_fallback
hybridGasQuoteFallbackAttempts=1
hybridGasQuoteFallbackSuccesses=1
Factory: Executing
```

## Common Failures

`finalKick.status` is `skipped`: final kick was not enabled. Rerun with
`AJNA_AGENT_FINAL_KICK=yes` if you intentionally want to create a live auction.

The keeper discovers but does not execute: check auction price, gas caps, profit
floors, fallback eligibility, dry-run flags, allow/deny pool filters, and that
the configured Uniswap candidate fee tiers include a seeded tier.

The fixture deployed new external-take contracts: a running keeper will not
learn those addresses automatically. Use `AJNA_AGENT_DEPLOY_EXTERNAL_TAKE=no`
and reuse the factory and taker addresses already loaded by the running keeper.
