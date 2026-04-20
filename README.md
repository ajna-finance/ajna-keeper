# ajna-keeper

## Purpose

A bot to automate liquidations on the Ajna platform.

## Design

- Each instance of the keeper targets exactly one chain. The same keeper instance may interact with multiple pools on that chain.
- Reads use a primary RPC plus optional read-RPC and subgraph failover endpoints. Take submission can optionally use a dedicated take-write transport.
- Pools may be configured manually, and V1 autodiscovery can also discover chain-wide `take` and `settlement` targets. `kick` remains manual.
- Each instance of the keeper may unlock only a single wallet using a JSON keystore file. As such, if running multiple keepers on the same chain, different accounts should be used for each keeper to avoid nonce conflicts.
- Kick, ArbTake, Take, Bond Collection, Reward LP Collection, and Settlement can all be enabled or disabled through the provided config. Manual per-pool config still overrides discovery defaults for the same action.

## Quick Setup

You must setup one bot per-chain, per-signer.

### Installation and Prerequisites

You'll need `node` and related tools (`npm`, `yarn`). This was developed with node v22 but should work with later versions.

Download node here: https://nodejs.org/en Downloading `node` also installs `npm`.

#### Quick Setup (using Makefile)

The easiest way to get started:

```bash
# Install yarn globally
npm install --global yarn

# Complete setup (installs dependencies, compiles contracts, creates .env)
make setup

# View all available commands
make help
```

#### Manual Setup

Install `yarn` and dependencies:

```bash
npm install --global yarn
yarn --frozen-lockfile
```

Note: If you encounter dependency conflicts or version mismatches, try:

```bash
rm yarn.lock
yarn install
```

Compile to generate types using TypeChain:

```bash
yarn compile
```

## Production Deployment

**For production deployments**, see the **[Production Setup Guide](production_setup_guide.md)**.

The production guide covers the recommended approach using hosted services:
- Hosted RPC setup (Alchemy/QuickNode) vs local nodes
- Hosted subgraph deployment (BuiltByMom fork + Goldsky) vs local Graph Node  
- Verified contract addresses for major chains (Avalanche, Hemi, Base, Arbitrum)
- Multiple DEX integration options (1inch, Uniswap V3, SushiSwap, Curve)
- API rate limits and service tier recommendations
- Real-world configuration examples
- Production monitoring and troubleshooting
- See `examples/example-avalanche-config.ts` and `examples/example-hemi-config.ts` for chain-specific examples.

*The production approach is more reliable and easier to maintain than running everything locally.*

### Setup Environment Variables

Create a `.env` file in the `ajna-keeper/` folder by copying `.env.example`:

```bash
cp .env.example .env
```

Then edit `.env` to add your API keys:

#### Required API Keys

**1. Alchemy API Key** (Required for RPC and price fallback)
- Go to [Alchemy](https://alchemy.com) and create an account
- Create an app with your desired network enabled (Base, Ethereum, Avalanche, etc.)
- Copy your API key from the Apps > Networks tab
- Add to `.env`: `ALCHEMY_API_KEY="your_key_here"`

**2. The Graph API Key** (Required for subgraph queries)
- Go to [The Graph Studio](https://thegraph.com/studio/)
- Create a free account
- Generate an API key from your dashboard
- Add to `.env`: `GRAPH_API_KEY="your_key_here"`

**3. CoinGecko API Key** (Optional but recommended)
- Create an account at [CoinGecko](https://www.coingecko.com/en/developers/dashboard)
- Click "Add New Key" to generate a new API key
- Add to `.env`: `COINGECKO_API_KEY="CG-your_key_here"`
- **Note**: CoinGecko is optional as the keeper will fallback to Alchemy Prices API if CoinGecko is unavailable

#### Optional API Keys

**4. 1inch API Key** (Optional - for DEX integration)
- Get from [1inch Developer Portal](https://portal.1inch.dev/)
- Add to `.env`: `ONEINCH_API_KEY="your_key_here"`

Your `.env` file should look like:
```env
ALCHEMY_API_KEY="????????????????????????????????"
GRAPH_API_KEY="????????????????????????????????????"
COINGECKO_API_KEY="CG-????????????????????????????????????"
ONEINCH_API="https://api.1inch.dev/swap/v6.0"
ONEINCH_API_KEY="????????????????????????????????????"
```

### Create a new config file

Create a new `config.ts` file in the `ajna-keeper/` folder and copy the contents from `examples/example-config.ts` or `examples/example-base-config.ts`.

All example configs are now set up to automatically use environment variables from `.env`, so you don't need to manually replace API keys in your config file.

### Configure ajna

In `config.ts` for the section `ajna`, you will need to provide addresses for all the ajna specific contracts. These addresses can be found here: https://faqs.ajna.finance/info/deployment-addresses-and-bridges

### Configure multicall

In `config.ts` you may need to provide an address for `multicallAddress` for your specific chain. These addresses can be found here https://www.multicall3.com/deployments
If you add `multicallAddress`, then you will also need to add `multicallBlock` which is the block that multicall was added.

### Subgraph Setup

**Recommended**: Use The Graph's hosted gateway (already configured in example configs)
- The keeper uses The Graph's hosted subgraph gateway
- Your `GRAPH_API_KEY` from `.env` is automatically used
- No local subgraph setup needed

**Alternative**: Run local subgraph (advanced)
If you need to run your own subgraph:

```bash
git clone https://github.com/ajna-finance/subgraph.git
cd subgraph
git checkout develop
```

Update `ajna-subgraph/.env`:
```env
ETH_RPC_URL=https://avax-mainnet.g.alchemy.com/v2/YOUR_ALCHEMY_KEY
ETH_NETWORK=avalanche:https://avax-mainnet.g.alchemy.com/v2/YOUR_ALCHEMY_KEY
```

[Install docker](https://www.docker.com/) and follow setup instructions in ajna-subgraph/README.

### Setting up a keystore.

Keeper uses ethers [Encrypted JSON Wallet](https://docs.ethers.org/v5/api/signer/#Wallet-fromEncryptedJson), which is encrypted using a password.

The easiest way to create an encrypted JSON wallet is to use the create-keystore script provided in keeper:
Run the script with `yarn create-keystore`. Then follow the onscreen prompts.
Ensure that the generated wallet is saved in the directory specified by the `keeperKeystore` property in `config.ts`.

### Execution

#### Using Makefile (Recommended)

```bash
# Start keeper with your config
make start config.ts

# Or use a specific config
make start examples/example-base-config.ts

# Dry-run mode (no transactions)
make start-dry config.ts

# Alternative syntax (also works)
make start CONFIG=config.ts
```

#### Using Yarn

```bash
yarn start --config config.ts
```

### Common Makefile Commands

```bash
make help           # Show all available commands
make setup          # First-time setup
make env-check      # Verify .env configuration
make test-unit      # Run unit tests
make test-prices    # Test price APIs
make keystore       # Create new keystore
make format         # Format code
```

## Requirements

For each desired chain:

- A JSON-RPC endpoint is needed to query pool data and submit transactions. Optional read fallbacks and a dedicated take-write transport can be added on top.
- A subgraph connection is needed for liquidation discovery, bucket/liquidation reads, and chain-wide autodiscovery.
- Funds used to pay gas on that chain.
- Funds (quote token) to post liquidation bonds in each pool configured to kick.

## Features

### Kick

Starts a liquidation when a loan's threshold price exceeds the lowest utilized price in the pool by a configurable percentage.

### Take

When auction price drops below a configured external-price threshold, the keeper can execute an external take by swapping collateral for quote token and repaying debt. Current external take paths support the legacy 1inch flow plus factory-based Uniswap V3, SushiSwap, and Curve integrations.

External takes usually require contract deployment. Take submission can also be routed through an optional dedicated private/write transport. See the contract deployment section below.

### ArbTake

When auction price drops a configurable percentage below the highest price bucket, exchanges quote token in that bucket for collateral, earning a share of that bucket.

Note if keeper is configured to both `take` and `arbTake`, and prices are appropriate for both, the keeper will attempt to execute both strategies. Whichever transaction is included in a block first will "win", with the other strategy potentially reverting onchain. To conserve gas when using both, ensure one is configured at a more aggressive price than the other.

### Collect Liquidation Bond

Collects liquidation bonds (which were used to kick loans) once they are fully claimable. Note: This does not settle auctions.

### Collect Reward LP

Redeems rewarded LP for either Quote or Collateral based on config.

Discovery is subgraph-based: each cycle the keeper queries the Ajna subgraph for `BucketTake` entities where the keeper's signer was taker or kicker, dedupes against an in-memory set, and sweeps the resulting LP rewards. On process start the cursor is reset so the first ingest replays the full `BucketTake` history for the configured pool+signer — this reclaims LP rewards that accrued before the keeper was started or during downtime.

**Dedicated keeper key required.** The redemption step is bounded by the signer's on-chain `lpBalance` in each bucket; if the same signer also deposits LP into these pools as a lender, history replay can redeem principal to satisfy stale reward entries. Use a keeper-only signer that never deposits directly. The keeper does not move existing deposits — only the LP accumulated from acting as taker or kicker. Both roles on a given BucketTake mint LP into the same `bucketIndex`, so the on-chain `lpBalance` cap applies uniformly whether the signer was taker, kicker, or both.

**Operational notes:**

- **Cold-start replay cost.** The first ingest after a restart queries from `blockTimestamp=0` and paginates up to 100 pages × 1000 events = 100,000 `BucketTake`s in the worst case (typical keeper signers have much less history). The LP collection loop iterates pools sequentially, so the first cycle across `N` pools blocks for roughly `N × per-pool-replay-time` before any pool's LP tokens are swept; subsequent cycles only query the small delta past the last observed timestamp and are fast.
- **Subgraph-down at startup.** If the subgraph is unreachable on the first cycle, the cursor stays at `0` and the next cycle re-runs the full historical query. The keeper does not persist cursor state to disk — reachability of the subgraph on first use matters. If you run against a flaky endpoint, configure `subgraphFallbackUrls` in `KeeperConfig`.
- **Indexing-lag tolerance.** Each query is shifted back by `lpRewardLookbackSeconds` (default 60s) so late-indexed events that land just under the previous cursor are still re-seen. Dedupe is handled in-memory by an event-id set scoped to that window. Chains where Goldsky lag regularly exceeds 60s should raise this; the tunable lives on `KeeperConfig`.
- **Subgraph-ahead-of-RPC race.** If the read RPC is lagging the subgraph at the moment a newly-ingested BucketTake is swept (uncommon — subgraph usually trails chain head, not leads it — but possible on load-balanced RPC pools that temporarily route to a stale node), the keeper can see `lpBalance=0` on-chain for a bucket the subgraph has already credited. The lpMap entry is then dropped and the event's id stays in the dedupe set, so the keeper won't re-discover it in the current process. **The LP itself is safe on-chain** — Ajna LP doesn't expire and the signer's claim persists. The keeper will redeem it on either (a) a subsequent BucketTake on the same bucket (the fresh credit triggers a sweep that reads the accumulated balance) or (b) the next process restart (cursor resets to `0` and replay re-credits everything). No fund loss; worst case is a deferred redemption.

### Settlement

Automatically settles completed auctions to unlock kicker bonds and handle bad debt scenarios. Settlement is triggered when:

- Auctions have ended with remaining bad debt (collateral = 0, debt > 0)
- Kicker bonds are locked and preventing normal operations
- Auctions meet the configured minimum age requirement

Settlement processes auctions in multiple iterations if needed, settling debt against available buckets in the pool. The keeper can be configured to only settle auctions where the bot has bond rewards to claim, ensuring profitability.

**Key Benefits:**
- **Automated bond recovery**: Unlocks kicker bonds automatically when auctions complete
- **Bad debt handling**: Processes auctions with remaining debt that need settlement
- **Reactive operation**: Triggers settlement when bond collection or LP collection fails due to locked bonds
- **Configurable timing**: Respects minimum auction age before attempting settlement

**Settlement Configuration:**
- `enabled` - Enable/disable settlement for this pool
- `minAuctionAge` - Minimum time (seconds) to wait before settling an auction
- `maxBucketDepth` - Number of buckets to process per settlement transaction
- `maxIterations` - Maximum settlement iterations per auction
- `checkBotIncentive` - 'true' means only settle if bot is the kicker with bond rewards, 'false' means you are altruistically protecting the pool.

Settlement integrates seamlessly with other keeper operations - when bond collection or LP reward collection fails due to locked bonds, the keeper automatically attempts settlement before retrying the operation.

### Chain-Wide Auto-Discovery

V1 autodiscovery can discover chain-wide `take` and `settlement` opportunities without listing every pool in `pools[]`.

- `take` and `settlement` have independent discovery policies and per-run limits.
- Manual per-pool `take` and `settlement` config still wins over discovery defaults for the same pool.
- `dryRunNewPools` keeps newly discovered pools in dry-run until you explicitly trust them.
- `kick` autodiscovery is intentionally not part of V1.





## Configuration

### Configuration file

While `*.json` config files are supported, it is recommended to use `*.ts` config files so that you get the benefits of type checking.
See `examples/example-config.ts` for reference.

### Price sources

The keeper supports multiple price sources with automatic fallback:

- **[CoinGecko](https://www.coingecko.com/)** - Primary source using their [simple price](https://docs.coingecko.com/v3.0.1/reference/simple-price) API
  - Recommended for all tokens
  - Requires `COINGECKO_API_KEY` in `.env`

- **[Alchemy Prices API](https://www.alchemy.com/docs/data/prices-api)** - Automatic fallback
  - Used automatically if CoinGecko API key is missing or CoinGecko request fails
  - Supports a wide range of tokens (WETH, USDC, USDT, WBTC, and more)
  - No additional API key needed (uses your existing `ALCHEMY_API_KEY`)

- **fixed** - Hardcoded number, useful for stable pools or testing

- **pool** - Uses pool's internal price (_lup_ or _htp_)

**Price Fallback Chain**: CoinGecko → Alchemy Prices API → Error

If the price source only has quote token priced in collateral, you may add `"invert": true` to `price` config to invert the configured price.

**Example**: For a pool using CoinGecko price source:
```typescript
price: {
  source: PriceOriginSource.COINGECKO,
  query: 'price?ids=ethereum&vs_currencies=usd',
}
```
The keeper will try CoinGecko first, then automatically fallback to Alchemy if needed.

### DEX Integration

The keeper supports four DEX integration approaches for external takes and LP reward swapping:

| DEX Integration | External Takes | LP Rewards | Contract Required | Best For |
|-----------------|----------------|------------|-------------------|----------|
| **1inch** | ✅ | ✅ | Yes (Single) | Major chains (Ethereum, Avalanche, Base, Arbitrum) |
| **Uniswap V3** | ✅ | ✅ | Yes (Factory) | All chains with Uniswap V3 |
| **SushiSwap** | ✅ | ✅ | Yes (Factory) | Chains with SushiSwap V3 |
| **Curve** | ✅ | ✅ | Yes (Factory) | Chains with Curve pools (stablecoin/crypto pairs) |


#### Configuring for 1inch

To enable 1inch swaps, you need to set up environment variables and add specific fields to config.ts. Also be sure to set `delayBetweenActions` to 1 second or greater to avoid 1inch API rate limiting.

If you want take transactions to go through a dedicated private/write path, set
`takeWrite` in your keeper config:

```ts
takeWrite: {
  mode: 'private_rpc',
  rpcUrl: 'https://your-private-rpc',
}
```

Or for JSON-RPC relay/private orderflow endpoints:

```ts
takeWrite: {
  mode: 'relay',
  relay: {
    url: 'https://your-relay-endpoint',
    sendMethod: 'eth_sendPrivateTransaction',
    maxBlockNumberOffset: 25,
    receiptTimeoutMs: 120000,
  },
}
```

`takeWriteRpcUrl` remains supported as a shorthand for the same `private_rpc`
mode. This write path is currently scoped to `take` only; the rest of the
keeper still uses `ethRpcUrl` for transaction submission. Relay mode persists
accepted take nonces under `local/take-write-relay-state.json` so a process
restart does not accidentally reuse a private nonce before the public provider
can observe it.

##### Environment Variables

Create a .env file in your project root with:

```
ONEINCH_API=https://api.1inch.dev/swap/v6.0
ONEINCH_API_KEY=[your-1inch-api-key-here]
```

A 1inch API key may be obtained from their [developer portal](https://portal.1inch.dev/).

## Contract Deployment (Required for External Takes)

**External takes** connect Ajna liquidation auctions to external DEX liquidity with Atomic Swaps. This requires deploying smart contracts to atomically take collateral and swap it.

### Critical Fee Tier Configuration for External Takes

For Uniswap V3 and SushiSwap external takes, the keeper currently chooses one runtime `defaultFeeTier` per DEX per keeper instance. That value is passed into quote evaluation and execution for each external take. It is not baked into deployed bytecode, so changing it is a config-and-restart decision, not a redeploy.

**Fee Tier Value → Percentage → Common Use:**
- `500` = 0.05% = 5 basis points (stablecoins)
- `3000` = 0.3% = 30 basis points (most common)
- `10000` = 1.0% = 100 basis points (exotic pairs)

**External Takes vs Post-Auction Swaps:**

**For External Takes (Time-Sensitive):**
- Uses `universalRouterOverrides.defaultFeeTier` or `sushiswapRouterOverrides.defaultFeeTier`
- One global default per DEX per keeper instance
- Applies to both quote evaluation and execution
- No per-pool external-take fee override today
- Change requires updating config and restarting the keeper

**For Post-Auction LP Rewards (Flexible):**
- Can override per pool using `fee: FeeAmount.MEDIUM` in `rewardAction`
- Falls back to the same global default if no override is specified
- Flexible and changeable without redeploying contracts

### Pre-Deployment Fee Tier Research (REQUIRED)

Before enabling Uniswap V3 or SushiSwap external takes:

**Step 1: List all token pairs from your pools**
**Step 2: Check Uniswap Info or SushiSwap Analytics for each pair's fee-tier liquidity**
**Step 3: Weight by expected liquidation value and frequency, not just TVL**
**Step 4: Set `defaultFeeTier` in config**
**Step 5: Revisit periodically as liquidity shifts**

Example research process:
```
Pools: USDC/WETH (high value), DAI/USDC (medium), RARE/WETH (low)

Research Results:
- USDC/WETH: 500 tier has $50M TVL, 3000 tier has $200M TVL
- DAI/USDC: 500 tier has $100M TVL, 3000 tier has $30M TVL
- RARE/WETH: Only exists in 10000 tier

Decision: Use defaultFeeTier: 3000
Rationale: Optimizes highest-value pair (USDC/WETH)
Plan: LP rewards can override per pool, while uncommon pairs may be better handled with 1inch, arbTake, or a separate keeper config
```

### Choose Your Deployment Approach

**Option A: 1inch Integration (Major Chains)**
- For chains with 1inch support (Ethereum, Avalanche, Base, Arbitrum)
- Single contract deployment
- Uses 1inch aggregator for best pricing

```bash
# Compile contracts first
yarn compile

# Deploy 1inch connector contract
yarn ts-node scripts/query-1inch.ts --config your-config.ts --action deploy

# Update your config with the deployed address
# keeperTaker: '0x[deployed-address]'
```

**Option B: Factory System (Multi-DEX Chains)**  
- For chains with Uniswap V3 and/or SushiSwap V3 and/or Curve
- Multi-DEX factory pattern supporting multiple DEXs
- Direct DEX integration via router contracts

```bash
# Compile contracts first  
yarn compile

# Deploy factory system
yarn ts-node scripts/deploy-factory-system.ts your-config.ts

# Update your config with deployed addresses:
# keeperTakerFactory: '0x[factory-address]'
# takerContracts: { 'UniswapV3': '0x[taker-address]', 'SushiSwap': '0x[taker-address]' }
```

**Option C: No External Takes**
- Skip contract deployment
- Use arbTake and settlement only
- Still supports LP reward swapping (no contracts needed for LP rewards)

> **Note**: LP reward swapping works with all approaches and doesn't require contracts for Uniswap V3 or SushiSwap (only 1inch requires contracts for LP rewards).

---

## Chain-Wide Auto-Discovery (V1)

V1 can auto-discover `take` and `settlement` opportunities across a chain while keeping `kick` manual.

- `autoDiscover` defines shared discovery controls like allow/deny lists, dry-run behavior for pools not already listed in `pools[]`, and hydration cooldowns.
- `autoDiscover.take` and `autoDiscover.settlement` carry independent per-action limits.
- `discoveredDefaults` defines the default `take` and `settlement` behavior for discovered pools.
- `pools[]` still works for manual `kick`, LP collection, bond collection, and per-action overrides.
- If a pool has a manual `take`, that whole `take` block wins over discovery defaults.
- If a pool has a manual `settlement`, that whole `settlement` block wins over discovery defaults.

For a conservative first live rollout on Base, start from [`examples/example-base-rollout-config.ts`](./examples/example-base-rollout-config.ts).

```typescript
const config: KeeperConfig = {
  dryRun: true,
  autoDiscover: {
    enabled: true,
    take: {
      enabled: true,
      maxPoolsPerRun: 10,
      takeQuoteBudgetPerRun: 5,
      maxGasPriceGwei: 5,
      maxGasCostNative: 0.0001,
    },
    settlement: {
      enabled: true,
      maxPoolsPerRun: 10,
      maxGasPriceGwei: 5,
      maxGasCostNative: 0.0001,
    },
    dryRunNewPools: true,
    logSkips: true,
    denyPools: [
      '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    ],
  },
  discoveredDefaults: {
    take: {
      minCollateral: 0.01,
      hpbPriceFactor: 0.9,
    },
    settlement: {
      enabled: true,
      minAuctionAge: 18000,
      maxBucketDepth: 50,
      maxIterations: 10,
      checkBotIncentive: true,
    },
  },
  pools: [
    {
      name: 'wstETH / WETH',
      address: '0x...',
      price: { source: PriceOriginSource.FIXED, value: 1.15 },
      kick: {
        minDebt: 0.07,
        priceFactor: 0.9,
      },
      // Manual take override for this pool only. If omitted,
      // discoveredDefaults.take will be used when the pool is discovered.
      take: {
        minCollateral: 0.02,
        hpbPriceFactor: 0.97,
      },
    },
  ],
};
```

Discovery is auction-first, not pool-enumeration-first. The keeper queries chain-wide liquidation activity from the subgraph, groups live work by pool, hydrates only the pools that matter, and then runs the existing `take` and `settlement` execution paths behind the new policy checks.

At runtime, discovered `take` refreshes the shared chain-wide auction snapshot when `autoDiscover.take` is enabled. Discovered `settlement` reuses that in-memory snapshot instead of issuing its own chain-wide fetch, so settlement no longer doubles discovery traffic in the common case. If you run settlement-only discovery, the settlement loop refreshes the snapshot on its own slower cadence. The snapshot is not persisted across restarts; after process restart, discovered settlement resumes after the next discovery refresh for the actions you enabled.

Chain-wide discovery paginates automatically in 100-auction pages, up to 100 pages per refresh. No extra operator action is needed to discover 101 active auctions.

`minExpectedProfitQuote` applies only under `autoDiscover.take`, and only for discovered external `take` decisions. Do not combine it with arb-only discovered take defaults. `maxGasCostNative`, `maxGasCostQuote`, and `maxGasPriceGwei` are action-specific under `autoDiscover.take` and `autoDiscover.settlement`.

Prefer `maxGasCostNative` on L2s and mixed-quote deployments. It uses the RPC gas price directly and does not require an extra native-to-quote conversion fetch. `maxGasCostQuote` remains available as an explicit quote-denominated mode; when it is enabled the keeper may need to convert native gas cost into the pool quote token. If the pool collateral is already wrapped native, the keeper reuses the existing take quote instead of fetching a second conversion quote. All quote-denominated thresholds are per-pool quote token amounts.

`kick` auto-discovery is intentionally not part of V1.

---

## DEX Router Configuration:

### Configuring for External Takes

External takes require contract deployment and specific configuration:

#### 1inch Integration (Single Contract)

**IMPORTANT:** 1inch contract deployment is required for 1inch external takes, and only required for LP reward swaps when `rewardActionQuote` or `rewardActionCollateral` uses `PostAuctionDex.ONEINCH`.

**Contract Deployment:**
```bash
yarn ts-node scripts/query-1inch.ts --config your-config.ts --action deploy
```

**Config.ts Setup:**
```typescript
const config: KeeperConfig = {
  // Required for 1inch external takes; only needed for LP rewards when they also use PostAuctionDex.ONEINCH
  keeperTaker: '0x[deployed-address]',
  oneInchRouters: {
    1: '0x1111111254EEB25477B68fb85Ed929f73A960582',    // Ethereum
    43114: '0x111111125421ca6dc452d289314280a0f8842a65', // Avalanche  
    8453: '0x1111111254EEB25477B68fb85Ed929f73A960582',  // Base
  },
  
  pools: [{
    take: {
      liquiditySource: LiquiditySource.ONEINCH,
      marketPriceFactor: 0.98, // Take when auction < market * 0.98
    }
  }]
}
```

**Important: 1inch Fee Tier Considerations**
1inch automatically routes through optimal fee tiers, so you don't need to worry about fee tier selection for 1inch integration. The API handles routing optimization.

#### Uniswap V3 Integration (Factory System)

**Contract Deployment:**
```bash  
yarn ts-node scripts/deploy-factory-system.ts your-config.ts
```

**Config.ts Setup:**
```typescript
const config: KeeperConfig = {
  // Required for Uniswap V3 external takes
  keeperTakerFactory: '0x[factory-address]',
  takerContracts: {
    'UniswapV3': '0x[taker-address]'
  },
  universalRouterOverrides: {
    universalRouterAddress: '0x533c7A53389e0538AB6aE1D7798D6C1213eAc28B',
    wethAddress: '0x4200000000000000000000000000000000000006',
    permit2Address: '0xB952578f3520EE8Ea45b7914994dcf4702cEe578',
    poolFactoryAddress: '0x346239972d1fa486FC4a521031BC81bFB7D6e8a4',
    quoterV2Address: '0xcBa55304013187D49d4012F4d7e4B63a04405cd5',
    defaultFeeTier: 3000, // Global default for Uniswap external takes
    defaultSlippage: 0.5,
  },
  
  pools: [{
    take: {
      liquiditySource: LiquiditySource.UNISWAPV3,
      marketPriceFactor: 0.99, // Take when auction < market * 0.99
    }
  }]
}
```

**⚠️ Important: Uniswap V3 Pool Selection and Fee Tier Configuration**

Uniswap external takes currently quote and execute against the configured `defaultFeeTier` only (`500` = 0.05%, `3000` = 0.3%, `10000` = 1%). The keeper does not dynamically probe alternative fee tiers per take, so choose the default that best matches your highest-value pairs.

To check liquidity:
1. Visit [Uniswap Info](https://info.uniswap.org/#/pools) for your network
2. Search for your token pair (e.g., USDC/WETH)
3. Compare TVL across different fee tiers
4. Set `defaultFeeTier` to the most liquid option for your most important pairs
5. Monitor and update as liquidity shifts over time

Low-liquidity pools can cause swap failures or poor pricing that impacts liquidation profitability.

#### SushiSwap Integration (Factory System)

**Contract Deployment:**
```bash  
yarn ts-node scripts/deploy-factory-system.ts your-config.ts
```

**Config.ts Setup:**
```typescript
const config: KeeperConfig = {
  // Required for SushiSwap external takes
  keeperTakerFactory: '0x[factory-address]',
  takerContracts: {
    'SushiSwap': '0x[taker-address]'
  },
  sushiswapRouterOverrides: {
    swapRouterAddress: '0x33d91116e0370970444B0281AB117e161fEbFcdD',  //addresses for Hemi Chain
    quoterV2Address: '0x1400feFD6F9b897970f00Df6237Ff2B8b27Dc82C',
    factoryAddress: '0xCdBCd51a5E8728E0AF4895ce5771b7d17fF71959',
    wethAddress: '0x4200000000000000000000000000000000000006',
    defaultFeeTier: 500, // Global default for SushiSwap external takes
    defaultSlippage: 10.0,
  },
  
  pools: [{
    take: {
      liquiditySource: LiquiditySource.SUSHISWAP,
      marketPriceFactor: 0.99, // Take when auction < market * 0.99
    }
  }]
}
```

**⚠️ Important: SushiSwap Pool Selection and Fee Tier Configuration**

SushiSwap external takes currently quote and execute against the configured `defaultFeeTier` only (typically `500` = 0.05% or `3000` = 0.3%). The keeper does not dynamically probe alternative fee tiers per take, so choose the default that best matches your highest-value pairs.

To verify optimal pools:
1. Check [SushiSwap Analytics](https://sushi.com/pool) for your network
2. Compare liquidity across fee tiers for your token pairs
3. Set `defaultFeeTier` to the highest-liquidity option for your most important pairs
4. Test with small amounts before production deployment
5. Revisit the setting as market conditions change

Using low-liquidity pools may result in failed swaps or unfavorable pricing.

#### Curve Integration (Factory System)

**Contract Deployment:**
```bash  
yarn ts-node scripts/deploy-factory-system.ts your-config.ts
```

**Config.ts Setup:**
```typescript
const config: KeeperConfig = {
  // Required for Curve external takes
  keeperTakerFactory: '0x[factory-address]',
  takerContracts: {
    'Curve': '0x[curve-taker-address]'
  },
  curveRouterOverrides: {
    poolConfigs: {
      // Stablecoin pools (use STABLE pool type)
      'usdc-usdt': {
        address: '0x[CURVE_STABLE_POOL_ADDRESS]',
        poolType: CurvePoolType.STABLE
      },
      // Crypto pools (use CRYPTO pool type)
      'weth-wbtc': {
        address: '0x[CURVE_CRYPTO_POOL_ADDRESS]', 
        poolType: CurvePoolType.CRYPTO
      }
    },
    defaultSlippage: 1.0,
    wethAddress: '0x4200000000000000000000000000000000000006',
  },
  // Required: Token symbol to address mapping
  tokenAddresses: {
    weth: '0x4200000000000000000000000000000000000006',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    usdt: '0x[USDT_ADDRESS]',
    wbtc: '0x[WBTC_ADDRESS]',
  },
  
  pools: [{
    take: {
      liquiditySource: LiquiditySource.CURVE,
      marketPriceFactor: 0.99, // Take when auction < market * 0.99
    }
  }]
}
```

#### Curve Configuration Guide

**Step 1: Find Curve Pool Addresses**
- Visit [Curve.fi](https://curve.finance) or use block explorers to find pool addresses for your network
- Look for pools containing your desired token pairs (e.g., 3Pool for USDC/USDT/DAI)
- Note: One pool address can serve multiple token pairs

**Step 2: Determine Pool Type**
- **STABLE pools**: Stablecoin pools (USDC/DAI/USDT) - use `CurvePoolType.STABLE`
- **CRYPTO pools**: Volatile asset pools (ETH/BTC/tricrypto) - use `CurvePoolType.CRYPTO`
- Check pool contract on block explorer: STABLE pools use `int128` indices, CRYPTO pools use `uint256`

**Step 3: Configure Token Address Mapping**
```typescript
tokenAddresses: {
  usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Must match exact addresses
  dai: '0x[DAI_ADDRESS]',
  usdt: '0x[USDT_ADDRESS]',
  weth: '0x4200000000000000000000000000000000000006',
}
```

**Step 4: Set Up Pool Configurations**
```typescript
curveRouterOverrides: {
  poolConfigs: {
    // Use token symbols from tokenAddresses above
    'usdc-dai': {
      address: '0x[3POOL_ADDRESS]', // Same pool can serve multiple pairs
      poolType: CurvePoolType.STABLE
    },
    'usdc-usdt': {
      address: '0x[3POOL_ADDRESS]', // Same address if tokens are in same pool
      poolType: CurvePoolType.STABLE  
    }
  },
  defaultSlippage: 1.0, // 1% for stable, 2-4% for crypto pairs
  wethAddress: '0x4200000000000000000000000000000000000006',
}
```

### Automatic Detection

The keeper automatically detects your configuration:
- **Single**: Uses existing 1inch integration (`src/take/index.ts`)
- **Factory**: Uses multi-DEX system (`src/take/factory/index.ts`) 
- **None**: ArbTake and settlement only

No manual selection needed - the bot chooses based on your config.

### Enhanced Configuration Examples

**Major Chain Example (1inch):**
```typescript
// examples/example-avalanche-config.ts shows 1inch external takes
const config: KeeperConfig = {
  keeperTaker: '0x[deployed-1inch-contract]',
  oneInchRouters: { 43114: '0x111111125421ca6dc452d289314280a0f8842a65' },
  
  pools: [{
    take: {
      liquiditySource: LiquiditySource.ONEINCH,
      marketPriceFactor: 0.98
    }
  }]
}
```

**Multi-DEX Chain Example (Factory):**  
```typescript
// examples/example-hemi-config.ts shows factory external takes
const config: KeeperConfig = {
  keeperTakerFactory: '0x[factory-address]',
  takerContracts: { 
    'UniswapV3': '0x[taker-address]',
    'SushiSwap': '0x[taker-address]'
  },
  universalRouterOverrides: { 
    defaultFeeTier: 3000, // Global default for Uniswap external takes
    /* other addresses */ 
  },
  sushiswapRouterOverrides: { 
    defaultFeeTier: 3000, // Global default for SushiSwap external takes  
    /* other addresses */ 
  },
  
  pools: [{
    take: {
      liquiditySource: LiquiditySource.SUSHISWAP, // or UNISWAPV3
      marketPriceFactor: 0.99
    }
  }]
}
```

**See `examples/example-avalanche-config.ts`, `examples/example-hemi-config.ts`, for complete examples.**

### Detailed LP Reward Configuration

The following sections provide comprehensive examples for configuring LP reward swapping:

##### 1inch LP Reward Configuration

**IMPORTANT:** 1inch LP reward swaps require smart contract deployment, but LP rewards can also use Uniswap V3, SushiSwap, or Curve without the 1inch contract.

```bash
# Deploy 1inch contract first (REQUIRED)
yarn ts-node scripts/query-1inch.ts --config your-config.ts --action deploy
```

Edit config.ts to include these fields:

`oneInchRouters`:

A dictionary of 1inch router addresses for each chain ID you want to support.

- Format: `{ [chainId]: "router-address" }`
- Example:

```
oneInchRouters: {
  1: "0x1111111254EEB25477B68fb85Ed929f73A960582",    // Ethereum Mainnet
  8453: "0x1111111254EEB25477B68fb85Ed929f73A960582", // Base
  43114: "0x1111111254EEB25477B68fb85Ed929f73A960582" // Avalanche
},
```

`tokenAddresses`:
A dictionary of token addresses for swaps (required for Avalanche, optional otherwise).

- Format: `{ [tokenName]: "token-address" }`
- Example:

```
tokenAddresses: {
  weth: "0x4200000000000000000000000000000000000006", // WETH on Base
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC on Base
  avax: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"  // Native AVAX
},
```

`connectorTokens` (Optional):
An array of token addresses used as intermediate connectors in 1inch swap routes. These tokens can facilitate multi-hop trades to optimize the swap path between the input and output tokens.

- Format: `Array<string>`
- Example:

```
connectorTokens: [
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC on Ethereum
  "0x6B175474E89094C44Da98b954EedeAC495271d0F"  // DAI on Ethereum
],
```

`pools.collectLpReward.rewardAction`:
LP in buckets can be reedemed for quote token and/or collateral, depending on what the bucket holds at time of redemption. `redeemFirst` controls the redemption strategy, favoring either quote token (most situations) or collateral (useful in shorting pools). To defer redeeming the second token, it's `minAmount` can be set to a sufficiently high value that manually swapping tokens on an exchange becomes practical.

Separate reward actions may be assigned to quote token and collateral, allowing tokens to be swapped out as desired. For pools where you want to swap rewards with 1inch, set `dexProvider: PostAuctionDex.ONEINCH` in the `rewardAction`.

- Example: Volatile-to-volatile pool, swap both tokens for stables

```
pools: [
  {
    name: "wstETH / WETH",
    address: "0x63a366fc5976ff72999c89f69366f388b7d233e8",
    ...
    collectLpReward: {
      redeemFirst: TokenToCollect.QUOTE, // favor redeeming LP for WETH before redeeming for wstETH
      minAmountQuote: 0.001,             // don't redeem LP for dust amount of WETH
      minAmountCollateral: 0.005,        // ensure we're redeeming enough to cover swapping fees
      rewardActionQuote: {
        action: RewardActionLabel.EXCHANGE,
        address: "0x4200000000000000000000000000000000000006", // Token to swap (WETH)
        targetToken: "DAI",                                    // Desired token
        slippage: 1,                                           // Slippage percentage (0-100)
        dexProvider: PostAuctionDex.ONEINCH                    // Use enum
      }
      rewardActionCollateral: {
        action: RewardActionLabel.EXCHANGE,
        address: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", // Token to swap (wstETH)
        targetToken: "DAI",                                    // Desired token
        slippage: 1,                                           // Slippage percentage (0-100)
        dexProvider: PostAuctionDex.ONEINCH                    // Use enum
      },
    },
  }
],
```

- Example: Stablecoin pool, swap collateral for quote token

```
pools: [
  {
      name: 'savUSD / USDC',
      address: '0x936e0fdec18d4dc5055b3e091fa063bc75d6215c',
      ...
      collectLpReward: {
        redeemFirst: TokenToCollect.QUOTE,
        minAmountQuote: 0.01,       // don't redeem LP for less than a penny
        minAmountCollateral: 0.05,  // don't redeem LP for less than what it may cost to swap collateral for USDC
        rewardActionCollateral: {
          action: RewardActionLabel.EXCHANGE,
          address: "0x06d47F3fb376649c3A9Dafe069B3D6E35572219E", // Token to swap (savUSD)
          targetToken: "usdc",                                   // Target token (USDC)
          slippage: 1,                                           // Slippage percentage (0-100)
          dexProvider: PostAuctionDex.ONEINCH                    // Use enum
        },
      },
  }
],
```

- Example: Shorting pool, no automated swapping

```
pools: [
  {
    name: "DAI / wSOL",
    address: "0x63a366fc5976ff72999c89f69366f388b7d233e8",
    ...
    collectLpReward: {
      redeemFirst: TokenToCollect.COLLATERAL, // favor redeeming LP for DAI
      minAmountQuote: 200,                    // don't exchange LP for an amount of wSOL not worth manually swapping
      minAmountCollateral: 0.15,              // don't redeem LP for less than transaction fees
    },
  }
],

```

##### Notes

- **Contract deployment is only required** for LP reward swaps that use `PostAuctionDex.ONEINCH`
- If `dexProvider: PostAuctionDex.ONEINCH` but `keeperTaker` is missing, the script will fail.
- Ensure the `.env` file is loaded (via `dotenv/config`) in your project.

##### Uniswap V3 LP Reward Configuration

Edit `config.ts` to include these optional fields:

`universalRouterOverrides`:
Required for Uniswap V3 swaps. Provides addresses for Universal Router integration.

- Format:

```
universalRouterOverrides: {
  universalRouterAddress: "0x533c7A53389e0538AB6aE1D7798D6C1213eAc28B",
  wethAddress: "0x4200000000000000000000000000000000000006",
  permit2Address: "0xB952578f3520EE8Ea45b7914994dcf4702cEe578",
  poolFactoryAddress: "0x346239972d1fa486FC4a521031BC81bFB7D6e8a4",
  defaultFeeTier: 3000,
  defaultSlippage: 0.5,
}
```

`tokenAddresses` (Optional):
Useful for specifying target tokens (e.g., WETH) if not using `universalRouterOverrides`.

- Example:

```
tokenAddresses: {
  weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH on Ethereum
  usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"  // USDC on Ethereum
},
```

`pools.collectLpReward.rewardAction`:
For pools where you want to swap rewards with Uniswap V3, set `dexProvider: PostAuctionDex.UNISWAP_V3` and optionally add a `fee`.

- Format:

```
{
  name: "Your Pool Name",
  address: "0xpoolAddress",
  // Other pool settings...
  collectLpReward: {
    redeemFirst: "QUOTE", // or "COLLATERAL"
    minAmount: 0.001,
    rewardAction: {
      action: "EXCHANGE",
      address: "0xtokenAddress", // Token to swap
      targetToken: "weth",      // Target token (e.g., "weth", "usdc")
      slippage: 1,             // Slippage (ignored for Uniswap)
      dexProvider: PostAuctionDex.UNISWAP_V3, // Use enum
      fee: 3000               // Fee tier (500, 3000, 10000)
    }
  }
}
```

- Example:

```
pools: [
  {
    name: "WETH / USDC",
    address: "0x0b17159f2486f669a1f930926638008e2ccb4287",
    collectLpReward: {
      redeemFirst: "COLLATERAL",
      minAmount: 0.001,
      rewardActionCollateral: {
        action: RewardActionLabel.EXCHANGE,
        address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        targetToken: "usdc",
        slippage: 1,
        dexProvider: PostAuctionDex.UNISWAP_V3, // Use enum
        fee: FeeAmount.MEDIUM // Can use different fee tier than external takes!
      }
    }
  }
],
```

Note: LP reward swaps can use **different fee tiers** than external takes by specifying `fee: FeeAmount.LOW` (500), `fee: FeeAmount.MEDIUM` (3000), or `fee: FeeAmount.HIGH` (10000).

##### SushiSwap LP Reward Configuration

For SushiSwap integration, add the `sushiswapRouterOverrides` configuration:

`sushiswapRouterOverrides`:
Required for SushiSwap swaps. Provides addresses for SushiSwap router integration.

- Format:

```
sushiswapRouterOverrides: {
  swapRouterAddress: "0x33d91116e0370970444B0281AB117e161fEbFcdD",
  quoterV2Address: "0x1400feFD6F9b897970f00Df6237Ff2B8b27Dc82C",
  factoryAddress: "0xCdBCd51a5E8728E0AF4895ce5771b7d17fF71959",
  wethAddress: "0x4200000000000000000000000000000000000006",
  defaultFeeTier: 500,
  defaultSlippage: 10.0,
}
```

- Example:

```
pools: [
  {
    name: "USD_T1 / USD_T2",
    address: "0x600ca6e0b5cf41e3e4b4242a5b170f3b02ce3da7",
    collectLpReward: {
      redeemFirst: "COLLATERAL",
      minAmount: 0.001,
      rewardActionCollateral: {
        action: RewardActionLabel.EXCHANGE,
        address: "0x1f0d51a052aa79527fffaf3108fb4440d3f53ce6",
        targetToken: "usd_t2",
        slippage: 10,
        dexProvider: PostAuctionDex.SUSHISWAP, // SushiSwap option
        fee: FeeAmount.LOW // Can use different fee tier than external takes!
      }
    }
  }
],
```

Note: Like Uniswap V3, LP reward swaps can use **different fee tiers** than external takes for optimal routing.

##### Notes

- `fee` is the fee tier (e.g., `500` for 0.05%, `3000` for 0.3%, `10000` for 1%).
- `slippage` is respected for all DEX providers.
- If `targetToken` isn't WETH, ensure it matches the configured WETH address.

## Testing

Follow instructions for [Installation and Prerequisites](#installation-and-prerequisites).

### Setup .env for Testing

Create a `.env` file with your API keys (see [Setup Environment Variables](#setup-environment-variables) above):

```env
ALCHEMY_API_KEY="your_alchemy_key"
COINGECKO_API_KEY="your_coingecko_key"
```

**Note**: You will need to enable Ethereum mainnet in your Alchemy app since hardhat queries from mainnet for integration tests.

### Running tests

#### Unit tests

Using Makefile:
```bash
make test-unit
```

Or using yarn:
```bash
yarn unit-tests
```

#### Integration tests

In one terminal run a hardhat fork (defaults to Ethereum mainnet):

```bash
make fork-base
# Or: npx hardhat node
```

To fork a different network, set the `FORK_NETWORK` environment variable:

```bash
FORK_NETWORK=base npx hardhat node    # fork Base
FORK_NETWORK=avalanche npx hardhat node  # fork Avalanche
```

Or use the shorthand:

```bash
yarn fork-base
```

In a second terminal run:

```bash
make test-integration
# Or: yarn integration-tests
```

#### Price API tests

Test the Alchemy and CoinGecko price integrations:

```bash
make test-prices
```

## Disclaimer

User assumes all risk of data presented and transactions placed by this keeper; see license for more details.

## DeepWiki

You can ask an AI about this GitHub repo on DeepWiki. It is indexed weekly, so it may lag the current branch.

[https://deepwiki.com/mitakash/ajna-keeper](https://deepwiki.com/mitakash/ajna-keeper)

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/mitakash/ajna-keeper)
