# Hermes Ajna Liquidation Fixture Runbook

This guide is scoped to one goal:

> A Hermes agent creates a Base Ajna ERC20 fixture pool, seeds Uniswap V3 liquidity for the fixture token pair, shapes one borrower into a liquidatable state, kicks the borrower into an active auction, waits for the configured Base subgraph to index that auction, and lets the already-running `ajna-keeper` autodiscover and take it through its Uniswap external-take path.

The live Hermes command is:

```bash
npm run create-liquidatable-uniswap-fixture
```

That command runs [scripts/create-liquidatable-ajna-fixture.ts](scripts/create-liquidatable-ajna-fixture.ts) with Uniswap V3 fixture setup enabled. The guide assumes the live keeper is already running and already configured for discovered Uniswap external takes.

## Success Criteria

The run is successful when all of these are true:

- the fixture script exits successfully and writes a summary JSON
- `summary.uniswapV3ExternalTake.liquidity.poolAddress` is present
- `summary.liquidationCheck.keeperKickEligibleByCurrentCode` is `true`
- `summary.finalKick.status` is `kicked` or `already_active`
- `summary.finalKick.auction.isActive` is `true`
- the same pool/borrower appears in the keeper's configured subgraph under unsettled `liquidationAuctions`
- the live keeper logs show the auction entering discovered take evaluation with `dryRun=false`
- if the auction is profitable under current policy, keeper logs show Uniswap/factory external-take execution

Discovery and execution are separate. The keeper can discover the auction before taking it if the auction price is still too high, gas caps reject it, route liquidity is missing, or profit floors are not met.

## Required Inputs

Run from this repo:

```bash
cd /home/mike/Projects-2026/ajna-keeper
```

Required environment:

```bash
export AJNA_AGENT_RPC_URL="https://base-mainnet.example/rpc"
export AJNA_AGENT_KEEPER_KEY="0x..."
export AJNA_AGENT_OUTPUT_PATH="/tmp/ajna-live-liquidation-fixture-summary.json"
```

The keeper key is the fixture operator. It deploys test ERC20s, funds the generated lender/borrower wallets, creates the Ajna pool, seeds Uniswap V3 liquidity, performs the final kick, and must have enough Base ETH for live gas.

Reuse the live keeper's already-configured factory/taker contracts:

```bash
export AJNA_AGENT_DEPLOY_EXTERNAL_TAKE=no
export AJNA_AGENT_KEEPER_TAKER_FACTORY_ADDRESS="0x..."
export AJNA_AGENT_UNISWAP_V3_TAKER_ADDRESS="0x..."
```

Do not deploy a new factory/taker for this run unless the already-running keeper is configured to use those new contracts. The fixture script can seed Uniswap liquidity, but the running keeper only uses the contracts and route settings from its own loaded config.

Repo defaults:

- `AJNA_AGENT_TOKEN_DEPLOYER_REPO` defaults to `../token-deployer`
- `AJNA_AGENT_AJNA_SKILLS_REPO` defaults to `../ajna-skills`
- `AJNA_AGENT_KEY_FILE` defaults to `./.fixture-keys.json`

The script auto-generates lender and borrower keys if `AJNA_AGENT_LENDER_KEY` and `AJNA_AGENT_BORROWER_KEY` are unset. The key file is plaintext and written with mode `0600`; do not commit it.

## Live Base Safety Settings

For live Base, always make the live-safe settings explicit:

```bash
export AJNA_AGENT_FINAL_KICK=yes
export AJNA_AGENT_MAX_TIME_WARPS=0
unset AJNA_AGENT_TARGET_KICK_DELAY_DAYS
unset AJNA_AGENT_ALLOW_EVM_TIME_TRAVEL
unset AJNA_AGENT_PROFILE
```

Leave tuning profiles unset on live Base. The live run must reach kick eligibility without time travel.

The script funds generated lender and borrower wallets with native gas by default. The default is deliberately large, so set a live-sized value:

```bash
export AJNA_AGENT_FUND_NATIVE_GAS=yes
export AJNA_AGENT_NATIVE_GAS_FUND_WEI=1000000000000000
```

Use a larger value only if the generated lender/borrower need more gas for the live transaction set.

The Uniswap wrapper seeds the standard candidate fee tiers by default:

```bash
export AJNA_AGENT_UNISWAP_FEE_TIERS=3000,500,10000
```

Override that only if the live keeper's Uniswap route policy probes a different fee tier set.

## Live Run

```bash
export AJNA_AGENT_FINAL_KICK=yes
export AJNA_AGENT_DEPLOY_EXTERNAL_TAKE=no
export AJNA_AGENT_KEEPER_TAKER_FACTORY_ADDRESS="0x..."
export AJNA_AGENT_UNISWAP_V3_TAKER_ADDRESS="0x..."

npm run create-liquidatable-uniswap-fixture
```

The script will:

1. deploy two simple ERC20s on Base
2. create or reuse the Ajna ERC20 pool for the token pair
3. fund the lender and borrower actors
4. seed a live Uniswap V3 pool for the fixture collateral/quote pair
5. validate and record the existing keeper factory/taker contracts
6. seed one dominant Ajna quote bucket
7. open borrower debt
8. remove quote from the dominant bucket until Ajna reaches the `LUPBelowHTP()` boundary
9. require `thresholdPrice >= lup`
10. approve quote from the keeper key for the kick bond
11. call `kick(address,uint256)` on the Ajna pool
12. clear leftover quote allowance
13. write the summary JSON

The relevant Ajna handoff invariant is:

```text
borrower.thresholdPrice >= pool.prices.lup
```

The final kick only runs after that condition is true.

## Live Parameter Tuning

Live Base cannot time-warp. If the script cannot reach `thresholdPrice >= lup` after quote removal, it fails before final kick and no auction is handed off.

For the live path, use a borrow plan that becomes kick-eligible in the same run. The most relevant tuning variables are:

- `AJNA_AGENT_INTEREST_RATE`
- `AJNA_AGENT_BUCKET_INDEX`
- `AJNA_AGENT_LIMIT_INDEX`
- `AJNA_AGENT_LEND_AMOUNT_WAD`
- `AJNA_AGENT_BORROW_AMOUNT_WAD`
- `AJNA_AGENT_COLLATERAL_AMOUNT_WAD`
- `AJNA_AGENT_MAX_REMOVE_ATTEMPTS`

Recommended workflow:

1. Pick a parameter set that reaches `keeperKickEligibleByCurrentCode=true` without EVM time travel.
2. Confirm the summary records a seeded Uniswap V3 pool.
3. Reuse the same parameter set on live Base.

## Final Kick Controls

Final kick is required for the live autodiscovery handoff. A kickable loan is not enough because the discovered take path reads active `liquidationAuctions` from the configured subgraph.

Enable it with either:

```bash
export AJNA_AGENT_FINAL_KICK=yes
```

or:

```bash
npm run create-liquidatable-uniswap-fixture -- --final-kick
```

Optional final-kick tuning:

- `AJNA_AGENT_KICK_LIMIT_INDEX` defaults to `7388`
- `AJNA_AGENT_KICK_BOND_APPROVAL_RAW` defaults to `AJNA_AGENT_KEEPER_QUOTE_BUFFER_RAW`

The summary records:

```json
{
  "finalKick": {
    "enabled": true,
    "status": "kicked",
    "kicker": "0x...",
    "borrower": "0x...",
    "npLimitIndex": 7388,
    "quoteApprovalRaw": "...",
    "submitted": {
      "txHash": "0x..."
    },
    "auction": {
      "borrower": "0x...",
      "isActive": true,
      "kickTime": "...",
      "bondSize": "..."
    }
  }
}
```

`status: already_active` is also acceptable on reruns.

## Summary Fields Hermes Must Check

After the script exits, Hermes should parse `AJNA_AGENT_OUTPUT_PATH` and persist at least:

```json
{
  "network": "base",
  "rpcUrl": "...",
  "actors": {
    "keeper": "0x...",
    "lender": "0x...",
    "borrower": "0x..."
  },
  "pool": {
    "address": "0x...",
    "dominantBucketIndex": 4600,
    "prices": {
      "lup": "...",
      "htp": "..."
    }
  },
  "borrower": {
    "debt": "...",
    "collateral": "...",
    "thresholdPrice": "...",
    "poolDebtInAuction": "..."
  },
  "liquidationCheck": {
    "keeperKickEligibleByCurrentCode": true,
    "strictlyAboveLup": true,
    "keeperCondition": "thresholdPrice >= lup"
  },
  "finalKick": {
    "status": "kicked",
    "auction": {
      "isActive": true
    }
  },
  "uniswapV3ExternalTake": {
    "liquidity": {
      "poolAddress": "0x...",
      "feeTier": 3000
    },
    "deployment": {
      "mode": "reused",
      "keeperTakerFactory": "0x...",
      "uniswapV3Taker": "0x..."
    }
  }
}
```

If `summary.status` is `failed`, the same output path contains the failure checkpoint and error message.

## Subgraph Handoff Check

The keeper's discovered take path scans chainwide unsettled `liquidationAuctions`. Hermes should query the exact subgraph URL used by the live keeper, not a different indexer.

Example query:

```bash
curl -sS "$AJNA_KEEPER_SUBGRAPH_URL" \
  -H 'content-type: application/json' \
  --data '{"query":"query { liquidationAuctions(first: 20, orderBy: kickTime, orderDirection: desc, where: { settled: false, borrower: \"0xBORROWER_LOWERCASE\" }) { id borrower kickTime debtRemaining collateralRemaining pool { id } } }"}'
```

Accept the handoff only when one returned row has:

- `borrower` equal to `summary.actors.borrower`
- `pool.id` equal to `summary.pool.address`
- `settled` excluded by the query
- positive `collateralRemaining`

If the summary says the auction is active but the subgraph query does not return it yet, wait for indexing. Until the subgraph has the auction row, the live keeper's discovery loop cannot see it.

## Live Keeper Assumptions

The live keeper must already be configured for real discovered takes:

- `runtime.dryRun` is `false`
- `discovery.enabled` is `true`
- `discovery.take.enabled` is `true`
- `discovery.defaults.take` exists
- `discovery.defaults.take.liquiditySource` is the Uniswap V3 factory route, for example `LiquiditySource.UNISWAPV3`
- `discovery.kick` is unset because kick discovery is not supported
- `discovery.dryRunNewPools` is `false` for newly discovered pools
- `discovery.allowPools`, when non-empty, includes the new pool
- `discovery.denyPools` does not include the new pool
- gas caps, profit floors, route policies, and token/liquidity support allow the take path being tested
- the configured Uniswap candidate fee tiers include the tier seeded by the fixture

The live keeper must also have the matching DEX and taker/factory configuration already active. The fixture script can seed Uniswap V3 liquidity, but the running keeper only uses the contracts and routes from its own loaded config.

## Keeper Log Markers

Useful discovery-cycle markers:

```text
Discovery take cycle summary: ... auctionCount=... targets=... discoveredTargets=...
```

Useful per-pool markers:

```text
Discovered take target summary: pool=0x... name="discovered:0x..." dryRun=false candidates=...
```

Execution success should show the external/factory counters increasing in the per-pool summary:

```text
executedExternalTakes=1
executedFactoryTakes=1
executedFactorySources=uniswapV3:1
```

For factory external takes, execution logs may also include:

```text
Factory: Executing ... take for pool ...
```

If the pool appears with `dryRun=true`, check `runtime.dryRun` and `discovery.dryRunNewPools`.

## Common Failure Modes

### Script does not reach kick eligibility

The live run cannot time-warp. Tune the borrow plan until quote removal alone reaches `thresholdPrice >= lup`, then rerun.

### Summary is kickable but `finalKick.status` is `skipped`

Final kick was not enabled. Rerun `npm run create-liquidatable-uniswap-fixture` with `AJNA_AGENT_FINAL_KICK=yes` or `--final-kick`.

### Final kick succeeded but keeper does not discover it

Check the exact keeper subgraph. The new auction must appear in unsettled `liquidationAuctions`. If it is not indexed yet, wait. If it never appears, the test has found a subgraph/indexing problem rather than a keeper take problem.

### Keeper discovers but does not execute

Check:

- `runtime.dryRun`
- `discovery.dryRunNewPools`
- `allowPools` and `denyPools`
- `discovery.defaults.take`
- gas caps
- profit floors
- auction price versus configured take policy
- Uniswap V3 route liquidity and fee tier
- taker/factory addresses loaded by the live keeper

### External-take fixture deploys contracts the live keeper does not use

The running keeper does not automatically learn about newly deployed factory/taker contracts. Reuse the already-configured live contracts with `AJNA_AGENT_DEPLOY_EXTERNAL_TAKE=no` and the two address env vars.

## Hermes Task Contract

Hermes should report these artifacts after each run:

- command and env profile used, excluding private keys
- fixture summary path
- pool address
- borrower address
- final-kick transaction hash
- subgraph query result showing the active unsettled auction
- keeper log lines showing discovery evaluation
- take transaction hash, or the exact keeper skip reason if no take executed yet
