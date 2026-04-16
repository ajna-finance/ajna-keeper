# Autonomous Agent Guide: Create an Ajna Pool, Force Liquidation, and Test Keeper Functionality

This guide is for running an autonomous agent such as Hermes or OpenClaw against three local repos:

- `../token-deployer` for deploying simple DeFi-compatible ERC20 tokens
- `../ajna-skills` for Ajna pool creation, lend, borrow, inspection, and gated unsupported Ajna-native actions
- this repo for exercising keeper behavior against the resulting pool state

The goal is to make the flow deterministic:

1. deploy quote and collateral tokens
2. create a new Ajna ERC20 pool
3. seed quote liquidity
4. create a borrower position
5. remove enough quote liquidity to push the loan to the `LUPBelowHTP()` boundary
6. on a local fork, fast-forward time until interest accrual makes the borrower liquidatable
7. verify the keeper functionality you care about against that state

## What This Guide Does and Does Not Assume

This guide assumes:

- you want a Base-shaped environment because `ajna-skills` ships built-in `base` support and its fork tests preserve Base chain ID `8453`
- you are comfortable using a local Anvil fork for repeatable testing
- you want the agent to use repo-local skills where possible, with CLI fallback where runtime-specific skill registration is inconvenient

This guide does not assume:

- a specific Hermes or OpenClaw installer command
- a live subgraph indexer for your brand-new local pool

That second point matters. In `ajna-keeper`, both manual `kick` / `take` flows and autodiscovery depend on subgraph reads. A freshly created local fork pool will not appear in the production subgraph by itself. That means:

- pool creation and liquidation shaping are fully automatable today with `token-deployer` and `ajna-skills`
- keeper testing against the fresh pool requires either:
  - a subgraph indexer that includes the new pool, or
  - a keeper-side test harness that overrides subgraph reads from onchain state

The current lightweight helper in [subgraph-mock.ts](/home/mike/Projects-2026/ajna-keeper/src/integration-tests/subgraph-mock.ts) covers loans, liquidation auctions, and highest meaningful bucket. It is enough for `kick` / `take` style tests, but not a full substitute for unsettled-auction settlement discovery.

## Recommended Architecture

Use a four-phase agent workflow.

### Phase 1: Token deployment

Use `token-deployer` to deploy two boring ERC20s on a local Base fork:

- one quote token
- one collateral token

Keep both as 18-decimal, mintable test tokens unless you specifically need quote-scale edge cases.

### Phase 2: Ajna pool creation and state setup

Use `ajna-skills` to:

- create the ERC20 pool
- approve quote and lend into one dominant bucket
- approve collateral and borrow a small amount against oversized collateral

### Phase 3: Liquidation shaping

Use `ajna-skills inspect-*` plus the gated `prepare-unsupported-ajna-action` escape hatch to remove quote from the lender bucket until the pool reaches the `LUPBelowHTP()` boundary. On a local fork, then advance time so interest accrual raises `thresholdPrice` the rest of the way to:

- borrower `thresholdPrice >= pool.prices.lup`

That is the keeper-relevant kick condition in the current code. In practice the wrapper now does both steps: adaptive quote removal first, then `evm_increaseTime` / `evm_mine` if needed.

### Phase 4: Keeper validation

Use `ajna-keeper` in one of two modes:

- subgraph-backed mode: real subgraph or local indexer includes the new pool
- harness mode: import keeper code and override subgraph reads from SDK/onchain state

If you only need to prove protocol state, Phase 3 is sufficient. If you need to test keeper logic, you need Phase 4.

## Repo Roles

### `token-deployer`

Use it for:

- normalized ERC20 deployment requests
- deterministic Foundry-based deploy/mint flow
- manifest-based minting after deployment

Canonical working pattern from that repo:

```bash
./bin/token-deployer deploy request.json --broadcast --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY"
cast send 0x<TOKEN_ADDRESS> 'transfer(address,uint256)' 0x<RECIPIENT> 1000000000000000000 --rpc-url "$RPC_URL" --private-key "$OWNER_PRIVATE_KEY"
```

The verified fixture wrapper in this repo does not rely on `token-deployer mint`. It deploys with large initial supply to the deployer and then uses plain ERC20 `transfer(...)` calls to fund the lender, borrower, keeper, and optional Uniswap LP inventory.

### `ajna-skills`

Use it for:

- `inspect-pool`
- `inspect-position`
- `prepare-create-erc20-pool`
- `prepare-lend`
- `prepare-borrow`
- `prepare-unsupported-ajna-action`
- `execute-prepared`

Runtime requirements from that repo:

```bash
export AJNA_RPC_URL_BASE="http://127.0.0.1:9545"
export AJNA_SKILLS_MODE="execute"
export AJNA_SIGNER_PRIVATE_KEY="0x..."
```

Unsafe Ajna-native actions are gated behind:

```bash
export AJNA_ENABLE_UNSAFE_SDK_CALLS=1
```

and require the exact acknowledgement string:

```text
I understand this bypasses the stable skill surface
```

### `ajna-keeper`

Use it to validate the keeper path you actually changed:

- `kick`
- `take`
- `arbTake`
- `settlement`
- discovery behavior
- gas / transport / runtime behavior around those actions

## Actor Model

Use separate actors so the agent can reason about ownership and later hand the state off cleanly.

- `DEPLOYER`: owns both test tokens and broadcasts token deployment
- `LENDER`: receives quote tokens and provides Ajna quote liquidity
- `BORROWER`: receives collateral tokens and opens the loan
- `KEEPER`: the keeper signer used for `ajna-keeper`

On a local Anvil fork, the easiest approach is to use funded default test accounts and derive addresses from their keys.

Example address derivation:

```bash
export DEPLOYER_KEY="0x..."
export LENDER_KEY="0x..."
export BORROWER_KEY="0x..."
export KEEPER_KEY="0x..."

export DEPLOYER_ADDRESS=$(cast wallet address --private-key "$DEPLOYER_KEY")
export LENDER_ADDRESS=$(cast wallet address --private-key "$LENDER_KEY")
export BORROWER_ADDRESS=$(cast wallet address --private-key "$BORROWER_KEY")
export KEEPER_ADDRESS=$(cast wallet address --private-key "$KEEPER_KEY")
```

If you want to run the keeper itself, create a JSON keystore for `KEEPER_KEY` inside this repo and point `keeperKeystore` at it.

## Environment Setup

### 1. Clone and build the repos

```bash
cd /home/mike/Projects-2026/token-deployer
npm install

cd /home/mike/Projects-2026/ajna-skills
npm install
npm run build

cd /home/mike/Projects-2026/ajna-keeper
npm install
```

### 2. Start a Base fork that preserves chain ID `8453`

This matches `ajna-skills` built-in Base configuration.

```bash
export BASE_RPC_URL="https://base-mainnet.g.alchemy.com/v2/<key>"
anvil --fork-url "$BASE_RPC_URL" --port 9545 --chain-id 8453 --silent
```

### 3. Point `ajna-skills` at the fork

```bash
export AJNA_RPC_URL_BASE="http://127.0.0.1:9545"
```

### Optional wrapper

This repo now includes two wrapper entry points:

```bash
npm run create-liquidatable-fixture
npm run create-liquidatable-uniswap-fixture
```

- `create-liquidatable-fixture` drives phases 1 through 5 and writes a machine-readable liquidation summary.
- `create-liquidatable-uniswap-fixture` does the same, then also:
  - mints extra local tokens to seed a direct Uniswap V3 pool for the pair
  - creates and initializes the Uniswap V3 pool on the Base fork
  - adds full-range liquidity
  - deploys a keeper-owned `AjnaKeeperTakerFactory` and `UniswapV3KeeperTaker`
  - writes a ready-to-paste keeper config snippet path into the summary
  - tops up lender, borrower, and optional keeper native gas by default so non-deployer actors can execute prepared actions on a fresh fork

In Uniswap external-take mode, `AJNA_AGENT_KEEPER_KEY` is required because the deployed factory and taker must be owned by the signer that will execute the keeper take path.

Use the plain wrapper when you only need a liquidatable Ajna fixture. Use the Uniswap wrapper when you want the DEX and keeper-contract side of a manual external-take test bootstrapped too.

## Phase 1: Deploy Two Test ERC20s

Create two requests. Keep them simple and mintable.

### Quote token request

```json
{
  "standard": "erc20",
  "name": "Quote Test Token",
  "symbol": "QTEST",
  "chainId": 8453,
  "chainName": "base",
  "owner": "${DEPLOYER_ADDRESS}",
  "initialRecipient": "${DEPLOYER_ADDRESS}",
  "initialSupply": "200000000000000000000000",
  "decimals": 18,
  "mintable": true
}
```

### Collateral token request

```json
{
  "standard": "erc20",
  "name": "Collateral Test Token",
  "symbol": "CTEST",
  "chainId": 8453,
  "chainName": "base",
  "owner": "${DEPLOYER_ADDRESS}",
  "initialRecipient": "${DEPLOYER_ADDRESS}",
  "initialSupply": "200000000000000000000000",
  "decimals": 18,
  "mintable": true
}
```

Broadcast both deployments:

```bash
cd /home/mike/Projects-2026/token-deployer
./bin/token-deployer deploy quote-request.json --broadcast --rpc-url "$AJNA_RPC_URL_BASE" --private-key "$DEPLOYER_KEY"
./bin/token-deployer deploy collateral-request.json --broadcast --rpc-url "$AJNA_RPC_URL_BASE" --private-key "$DEPLOYER_KEY"
```

Capture the manifest paths and deployed token addresses from the deploy output.

For the verified local-fixture path, fund actors with standard ERC20 transfers from the deployer:

```bash
cast send 0x<QTEST_ADDRESS> \
  'transfer(address,uint256)' "$LENDER_ADDRESS" 100000000000000000000000 \
  --rpc-url "$AJNA_RPC_URL_BASE" --private-key "$DEPLOYER_KEY"

cast send 0x<CTEST_ADDRESS> \
  'transfer(address,uint256)' "$BORROWER_ADDRESS" 100000000000000000000000 \
  --rpc-url "$AJNA_RPC_URL_BASE" --private-key "$DEPLOYER_KEY"
```

If you are also bootstrapping the Uniswap V3 external-take path, fund the keeper and the future LP inventory from the deployer in the same way. The wrapper script does this automatically.

## Phase 2: Create the Ajna Pool

Use `ajna-skills` to create an ERC20 pool.

Example prepare payload:

```json
{
  "network": "base",
  "actorAddress": "${DEPLOYER_ADDRESS}",
  "collateralAddress": "0x<CTEST_ADDRESS>",
  "quoteAddress": "0x<QTEST_ADDRESS>",
  "interestRate": "50000000000000000",
  "maxAgeSeconds": 600
}
```

Prepare and execute:

```bash
cd /home/mike/Projects-2026/ajna-skills
export AJNA_SKILLS_MODE=execute
export AJNA_SIGNER_PRIVATE_KEY="$DEPLOYER_KEY"

node dist/cli.js prepare-create-erc20-pool '{"network":"base","actorAddress":"'"$DEPLOYER_ADDRESS"'","collateralAddress":"0x<CTEST_ADDRESS>","quoteAddress":"0x<QTEST_ADDRESS>","interestRate":"50000000000000000","maxAgeSeconds":600}'
```

Take the resulting `preparedAction` and pass it into:

```bash
node dist/cli.js execute-prepared '{"preparedAction":{...}}'
```

Capture `resolvedPoolAddress` from the execute result. That becomes the canonical pool identifier for everything that follows.

Immediately inspect the new pool:

```bash
node dist/cli.js inspect-pool '{"network":"base","poolAddress":"0x<POOL_ADDRESS>","detailLevel":"full"}'
```

## Phase 3: Seed One Dominant Lending Bucket

Use one dominant quote bucket so the later liquidity removal predictably moves `lup`.

Recommended starting bucket index for the default wrapper numbers (`borrow=10`, `collateral=100`):

- `4600`

That bucket price is close to the borrower threshold produced by the default borrow plan, which is what makes the later quote-removal + time-warp path converge. `3232` is far too high-priced for this specific local-fixture workflow.

First approve the quote token explicitly. This is the working path the wrapper uses today:

```bash
node dist/cli.js prepare-approve-erc20 '{"network":"base","actorAddress":"'"$LENDER_ADDRESS"'","tokenAddress":"0x<QTEST_ADDRESS>","poolAddress":"0x<POOL_ADDRESS>","amount":"1000000000000000000000","approvalMode":"exact","maxAgeSeconds":600}'
node dist/cli.js execute-prepared '{"preparedAction":{...}}'
```

Then prepare the lend from `LENDER_ADDRESS`:

```json
{
  "network": "base",
  "poolAddress": "0x<POOL_ADDRESS>",
  "actorAddress": "${LENDER_ADDRESS}",
  "amount": "1000000000000000000000",
  "bucketIndex": 4600,
  "ttlSeconds": 600,
  "approvalMode": "exact"
}
```

Execute it with `AJNA_SIGNER_PRIVATE_KEY="$LENDER_KEY"`.

Then inspect the lender bucket position:

```bash
node dist/cli.js inspect-position '{"network":"base","poolAddress":"0x<POOL_ADDRESS>","owner":"'"$LENDER_ADDRESS"'","positionType":"lender","bucketIndex":4600}'
```

The agent should persist:

- pool address
- lender bucket index
- lender LP position result

## Phase 4: Open a Small Borrower Position

Now create a borrower position that is healthy at first.

The exact economic numbers are less important than the structure:

- large quote liquidity concentrated in one bucket
- comparatively small borrow amount
- oversized collateral

First approve the collateral token explicitly:

```bash
node dist/cli.js prepare-approve-erc20 '{"network":"base","actorAddress":"'"$BORROWER_ADDRESS"'","tokenAddress":"0x<CTEST_ADDRESS>","poolAddress":"0x<POOL_ADDRESS>","amount":"100000000000000000000","approvalMode":"exact","maxAgeSeconds":600}'
node dist/cli.js execute-prepared '{"preparedAction":{...}}'
```

Then prepare the borrow payload:

```json
{
  "network": "base",
  "poolAddress": "0x<POOL_ADDRESS>",
  "actorAddress": "${BORROWER_ADDRESS}",
  "amount": "10000000000000000000",
  "collateralAmount": "100000000000000000000",
  "limitIndex": 5000,
  "approvalMode": "exact",
  "maxAgeSeconds": 600
}
```

Execute with `AJNA_SIGNER_PRIVATE_KEY="$BORROWER_KEY"`.

Then inspect the borrower:

```bash
node dist/cli.js inspect-position '{"network":"base","poolAddress":"0x<POOL_ADDRESS>","owner":"'"$BORROWER_ADDRESS"'","positionType":"borrower"}'
node dist/cli.js inspect-pool '{"network":"base","poolAddress":"0x<POOL_ADDRESS>"}'
```

The important fields to capture are:

- borrower `debt`
- borrower `collateral`
- borrower `thresholdPrice`
- borrower `neutralPrice`
- borrower `poolDebtInAuction`
- pool `prices.lup`
- pool `prices.lupIndex`

At this point the borrower should normally still be healthy.

## Phase 5: Force the Pool Into a Liquidatable State

This is the deterministic part.

The easiest way to make the borrower liquidatable without changing external prices is:

1. keep almost all quote liquidity in one lender bucket
2. remove as much of that bucket's quote liquidity as Ajna allows without tripping `LUPBelowHTP()`
3. re-inspect until you are sitting on the boundary
4. on a local fork, advance time and mine blocks until `thresholdPrice >= lup` and preferably `thresholdPrice > lup`

### Why this works

`ajna-keeper` treats a borrower as kickable once borrower `thresholdPrice` is no lower than pool `lup`. Concentrated quote liquidity makes `lup` sensitive to that bucket. Pulling quote from the dominant bucket is still the cleanest way to move `lup` down in a self-contained local test, but Ajna itself will stop you at `LUPBelowHTP()`. That means quote removal alone usually gets you to the boundary, not through it. The final step on a local fork is time-forward interest accrual.

### Unsupported action payload

`ajna-skills` allows `erc20-pool.removeQuoteToken(uint256,uint256)` through the gated escape hatch.

The method arguments are:

- `maxAmount`
- `index`

Example payload:

```json
{
  "network": "base",
  "actorAddress": "${LENDER_ADDRESS}",
  "contractKind": "erc20-pool",
  "contractAddress": "0x<POOL_ADDRESS>",
  "methodName": "removeQuoteToken",
  "args": ["1000000000000000000000", "4600"],
  "acknowledgeRisk": "I understand this bypasses the stable skill surface",
  "notes": "Remove quote from dominant bucket to drop LUP below borrower threshold price"
}
```

Set:

```bash
export AJNA_ENABLE_UNSAFE_SDK_CALLS=1
export AJNA_SKILLS_MODE=execute
export AJNA_SIGNER_PRIVATE_KEY="$LENDER_KEY"
```

Then prepare and execute that action.

### Verification loop

After each removal, re-run:

```bash
node dist/cli.js inspect-position '{"network":"base","poolAddress":"0x<POOL_ADDRESS>","owner":"'"$BORROWER_ADDRESS"'","positionType":"borrower"}'
node dist/cli.js inspect-pool '{"network":"base","poolAddress":"0x<POOL_ADDRESS>"}'
```

The keeper-valid stop condition is:

```text
borrower.thresholdPrice >= pool.prices.lup
```

The safer shaping target is:

```text
borrower.thresholdPrice > pool.prices.lup
```

In practice, expect this sequence on the local fork:

1. quote removal drives the pool to the `LUPBelowHTP()` boundary
2. `lup` stops moving because further `removeQuoteToken` calls revert
3. time-forward interest accrual raises `thresholdPrice` until the borrower becomes kickable

Once the first condition is true, the borrower is kickable under the current keeper code. If the second condition is also true, the fixture has some margin against equality edge cases.

## Phase 5B: Optional Uniswap V3 External-Take Bootstrap

If the new functionality you want to test is the factory-based Uniswap V3 take path, do not use 1inch for fork-local custom tokens. The live 1inch backend will not know about pools you created only on your local fork.

Use the Uniswap-enabled wrapper instead:

```bash
npm run create-liquidatable-uniswap-fixture
```

That mode keeps the Ajna fixture flow the same, but also bootstraps the external-take prerequisites the keeper needs:

- a direct Uniswap V3 pool for the custom collateral/quote pair
- seeded liquidity on that pool
- a keeper-owned `AjnaKeeperTakerFactory` deployment
- a keeper-owned `UniswapV3KeeperTaker` deployment
- a generated config snippet that enables manual `LiquiditySource.UNISWAPV3` for the fresh Ajna pool

This does not remove the subgraph requirement. It only solves the DEX-side and contract-side prerequisites for external takes. Keeper execution against the fresh pool still needs either:

- a subgraph/indexer that includes the new pool, or
- a repo-local subgraph override harness

## What the Agent Should Emit Before Keeper Testing

Before handing off to `ajna-keeper`, the agent should emit a machine-readable state summary.

Minimum handoff shape. The wrapper script emits a superset of this, including repo paths, temp paths, borrow plan, and removal history:

```json
{
  "network": "base",
  "rpcUrl": "http://127.0.0.1:9545",
  "quoteToken": {
    "address": "0x...",
    "manifestPath": "deployments/base/quote-test-token.json"
  },
  "collateralToken": {
    "address": "0x...",
    "manifestPath": "deployments/base/collateral-test-token.json"
  },
  "pool": {
    "address": "0x...",
    "interestRate": "50000000000000000",
    "dominantBucketIndex": 4600,
    "lup": "...",
    "lupIndex": 7388
  },
  "actors": {
    "deployer": "0x...",
    "lender": "0x...",
    "borrower": "0x...",
    "keeper": "0x..."
  },
  "borrower": {
    "debt": "...",
    "collateral": "...",
    "thresholdPrice": "...",
    "neutralPrice": "...",
    "poolDebtInAuction": "..."
  },
  "liquidationCheck": {
    "keeperKickEligibleByCurrentCode": true,
    "strictlyAboveLup": true,
    "keeperCondition": "thresholdPrice >= lup",
    "shapingTarget": "thresholdPrice > lup"
  },
  "constraints": {
    "needsSubgraphOrHarnessForKeeper": true
  },
  "uniswapV3ExternalTake": {
    "routerConfig": {
      "universalRouterAddress": "0x...",
      "permit2Address": "0x...",
      "poolFactoryAddress": "0x...",
      "quoterV2Address": "0x...",
      "wethAddress": "0x...",
      "positionManagerAddress": "0x...",
      "defaultFeeTier": 3000,
      "defaultSlippage": 0.5
    },
    "liquidity": {
      "poolAddress": "0x...",
      "feeTier": 3000
    },
    "deployment": {
      "keeperTakerFactory": "0x...",
      "uniswapV3Taker": "0x...",
      "owner": "0x<KEEPER_ADDRESS>"
    },
    "keeperConfigSnippet": {
      "path": "/tmp/.../keeper-uniswap-v3-config-snippet.ts"
    }
  }
}
```

That summary is the handoff contract between the setup agent and the keeper-test agent.

## Phase 6: Test `ajna-keeper`

This is where the guide splits.

## Path A: Real keeper run with a subgraph that knows about the pool

Use this if you are willing to stand up a local indexer or otherwise surface the new pool to the keeper's subgraph queries.

This is required for:

- manual `kick` runs against the fresh pool without local overrides
- manual `take` runs against the fresh pool without local overrides
- autodiscovery against the fresh pool
- settlement discovery against the fresh pool

A minimal keeper config can be based on [example-base-config.ts](/home/mike/Projects-2026/ajna-keeper/examples/example-base-config.ts), but you must replace at least:

- `ethRpcUrl` with your local fork RPC, for example `http://127.0.0.1:9551`
- `subgraphUrl` with your local or test indexer URL
- `keeperKeystore` with a keystore built from `KEEPER_KEY`
- `pools[0].address` with the new pool address

If you used `npm run create-liquidatable-uniswap-fixture`, also merge the emitted `keeperConfigSnippet` into that config. That snippet already includes the deployed `keeperTakerFactory`, `takerContracts.UniswapV3`, and the correct Base `universalRouterOverrides` for the local external-take path.

For fresh local-pool tests, prefer a single manual `pools[]` entry instead of autodiscovery first. Once the manual flow is stable, add autodiscovery only if your subgraph indexing path is also stable.

## Path B: Direct keeper harness with overridden subgraph reads

Use this if you want fast local validation without building a full subgraph pipeline.

The repo now includes a direct harness entry point at [run-fixture-keeper-harness.ts](/home/mike/Projects-2026/ajna-keeper/scripts/run-fixture-keeper-harness.ts):

```bash
AJNA_AGENT_KEEPER_KEY=0x... npm run run-fixture-keeper-harness -- --summary /tmp/ajna-fixture-summary.json --auto-warp-to-take --take-warp-seconds 86400 --max-take-warps 3
```

This harness:

1. connects to the fresh pool through the Ajna SDK
2. overrides `getLoans` and `getLiquidations` from onchain state for the single borrower fixture
3. calls the real keeper `handleKicks(...)` and `handleTakes(...)` paths
4. can optionally auto-warp the fork between take attempts until the auction becomes profitable
5. emits a machine-readable report of kick/take results

This is the most practical route for testing new `kick`, `take`, or factory-based Uniswap V3 external-take behavior against a brand-new local pool.

The current working sequence on the local Base fork is:

1. run `AJNA_AGENT_TARGET_KICK_DELAY_DAYS=3 npm run create-liquidatable-uniswap-fixture`
2. let the wrapper remove quote up to the `LUPBelowHTP()` boundary and time-warp the fork until `thresholdPrice >= lup`
3. run `AJNA_AGENT_KEEPER_KEY=0x... npm run run-fixture-keeper-harness -- --summary /tmp/ajna-fixture-summary.json --auto-warp-to-take --take-warp-seconds 86400 --max-take-warps 3`

On the verified local fork run, the borrower kicked immediately from the 3-day fixture, then the harness needed one additional 86400-second warp and a second take attempt before the Uniswap V3 external take executed successfully.

### Important limitation

The harness is intentionally narrow. It overrides loan and liquidation reads for a single borrower fixture, but it does not cover settlement scanning or chainwide autodiscovery. If the new functionality you want to test is settlement discovery, settlement execution, or autodiscovery, use Path A or extend the harness first.

## How to Choose the Keeper Test Mode

Use this rule set.

- If you changed `kick`, `take`, or `arbTake` logic and want fast local iteration: use Path B.
- If you changed autodiscovery or chainwide discovery logic: use Path A.
- If you changed settlement scanning or settlement discovery: use Path A, or extend the mock helper first.
- If you only need to prove the pool is liquidatable onchain: stop after Phase 5.

## Example Agent Task Breakdown

A Hermes or OpenClaw agent should split the work into bounded tasks and persist artifacts between them.

### Task 1: Deploy tokens

Inputs:

- fork RPC
- deployer key
- token request JSONs

Outputs:

- quote token address
- collateral token address
- deployment manifest paths

### Task 2: Create and inspect the Ajna pool

Inputs:

- token addresses
- deployer key

Outputs:

- `resolvedPoolAddress`
- initial pool inspect result

### Task 3: Seed lender bucket

Inputs:

- pool address
- lender key
- bucket index
- lend amount

Outputs:

- lender bucket position
- confirmed dominant bucket index

### Task 4: Create borrower debt

Inputs:

- pool address
- borrower key
- collateral amount
- borrow amount
- limit index

Outputs:

- borrower position before liquidation shaping

### Task 5: Force liquidation

Inputs:

- pool address
- lender key
- dominant bucket index

Loop:

- remove quote from dominant bucket
- inspect borrower
- inspect pool
- stop when `thresholdPrice >= lup`, preferably `thresholdPrice > lup`

Outputs:

- final borrower inspect result
- final pool inspect result
- liquidation-ready summary JSON

### Task 6: Optional Uniswap V3 external-take bootstrap

Inputs:

- keeper key
- quote and collateral token manifests
- local Base fork RPC

Outputs:

- Uniswap V3 pool address for the custom pair
- keeper-owned `AjnaKeeperTakerFactory` address
- keeper-owned `UniswapV3KeeperTaker` address
- generated keeper config snippet

### Task 7: Keeper validation

Inputs:

- liquidation-ready summary JSON
- keeper config or keeper test harness

Outputs:

- action-specific pass/fail result
- transaction hashes or dry-run decisions
- logs showing the new functionality behaved as expected

## Failure Modes and Sharp Edges

### 1. Wrong chain ID

`ajna-skills` is built around named network presets. Use a Base fork that preserves chain ID `8453`. Do not use a generic local chain ID if you expect the built-in Base Ajna addresses to work.

### 2. No subgraph means no keeper discovery

This is the biggest practical trap.

Even manual keeper `kick` / `take` flows read borrowers or auctions from the configured subgraph adapter. A fresh local pool created only on your fork is invisible until you provide either:

- a real subgraph/indexer, or
- a keeper-side test override

### 3. Settlement needs more than the current mock helper

The current helper covers loans, liquidations, and highest meaningful bucket. Settlement discovery still needs either a real subgraph or an extra mock implementation.

### 4. Prepared payloads are one-shot

`ajna-skills` binds executable payloads to the actor nonce. If the actor sends any other transaction, re-prepare before calling `execute-prepared`.

### 5. Unsafe Ajna calls are intentionally awkward

The escape hatch is gated for a reason. The agent should only use it for deterministic test shaping, and it should record exactly which unsupported method it invoked.

### 6. Do not spread lender quote over many buckets if your goal is easy liquidation shaping

A single dominant bucket is a feature in this workflow, not a bug. Distributed quote makes LUP harder to move deterministically.

## Practical Recommendation

If the objective is to validate newly added keeper behavior quickly, do not start with autodiscovery.

The fastest stable path is:

1. Base fork with chain ID `8453`
2. deploy boring ERC20 quote and collateral tokens with `token-deployer`
3. create pool, lend, borrow, and force liquidation with `ajna-skills`
4. if external takes matter, bootstrap the local Uniswap V3 pair and keeper contracts with `npm run create-liquidatable-uniswap-fixture`
5. test keeper logic with a manual pool config plus a subgraph override harness

Only add real subgraph indexing when you specifically need to validate:

- autodiscovery behavior
- settlement scanning
- full discovery/runtime orchestration against newly created pools

That ordering gives the agent a clean progression from protocol-state proof to keeper-runtime proof instead of mixing both problems at once.
