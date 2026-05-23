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

Note: If you encounter dependency conflicts or version mismatches, first reinstall from the committed lockfile:

```bash
yarn install --frozen-lockfile
```

Only regenerate `yarn.lock` intentionally when you are updating dependencies.

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

_The production approach is more reliable and easier to maintain than running everything locally._

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

Optional read/write routing and non-interactive unlock variables are listed in `.env.example`. Leave them unset unless you are configuring read failover, subgraph failover, private take submission, relay submission, or password-file based keystore unlock.

Read RPC failover is configured with `network.readRpcUrls`; when set, it is the complete dedicated read endpoint list, so include `network.rpcUrl` there too if you want the primary RPC in the read rotation. Subgraph failover is configured separately with `network.subgraph.fallbackUrls`.

### Create a new config file

Create a new `config.ts` file in the `ajna-keeper/` folder and copy the contents from `examples/example-config.ts` or `examples/example-base-config.ts`.

All example configs are now set up to automatically use environment variables from `.env`, so you don't need to manually replace API keys in your config file.

### Configure ajna

In `config.ts` for the section `ajna`, you will need to provide addresses for all the ajna specific contracts. These addresses can be found here: https://faqs.ajna.finance/info/deployment-addresses-and-bridges

### Configure multicall

In `config.ts` you may need to provide `network.multicall.address` for your specific chain. These addresses can be found here https://www.multicall3.com/deployments
If you add `network.multicall.address`, then you will also need to add `network.multicall.block` which is the block that multicall was added.

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
Ensure that the generated wallet is saved in the directory specified by the `signer.keystore` property in `config.ts`.

#### Supplying the keystore password

The keeper resolves the keystore password from the first of:

1. **`KEYSTORE_PASSWORD_FILE`** (recommended for automation) — path to a file whose contents are the password. Trailing newlines are stripped so `echo "…" > pwd.txt` and `op read 'op://Vault/item/password' > pwd.txt` both work. The file is read once at startup; permissions loose enough to let other users read it (anything beyond `0600`) trigger a startup WARN.
2. **`KEYSTORE_PASSWORD`** — password directly in an env var. Useful for container platforms that inject secrets via `env:` references (Kubernetes, Docker `--env-file`, `op run --env-file=…`). More leak-prone than the file path (visible in `/proc/$PID/environ` for processes sharing the user), but works in any deployment.
3. **Interactive prompt** — the existing behavior. Used when neither env var is set. Fine for tmux / screen sessions with a human attendant.

Setting both `KEYSTORE_PASSWORD_FILE` and `KEYSTORE_PASSWORD` is refused to avoid stale-rotation bugs (you rotate the file but forget to clear the env var). Empty-string env vars are treated as unset.

**systemd recipe** (the cleanest non-interactive path — systemd handles the secret lifecycle, the keeper never sees the literal secret on the process command line):

```ini
# /etc/systemd/system/ajna-keeper.service
[Service]
WorkingDirectory=/opt/ajna-keeper
LoadCredential=keystore-password:/etc/ajna-keeper/keystore-password
Environment=KEYSTORE_PASSWORD_FILE=%d/keystore-password
ExecStart=/usr/bin/env yarn start --config /etc/ajna-keeper/config.ts
```

`%d` expands to `/run/credentials/ajna-keeper.service/` at runtime; the credential file is owned by root and only readable by the service user, and is unmounted when the service stops.

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
make test-integration  # Run Hardhat integration tests
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

When auction price drops below a configured external-price threshold, the keeper can execute an external take by swapping collateral for quote token and repaying debt. Current external take paths support the 1inch atomic taker flow plus factory-based Uniswap V3, SushiSwap, and Curve integrations.

External takes usually require contract deployment. Take submission can also be routed through an optional dedicated private/write transport. See the contract deployment section below.

### ArbTake

When auction price drops a configurable percentage below the highest price bucket, exchanges quote token in that bucket for collateral, earning a share of that bucket.

Note if keeper is configured to both `take` and `arbTake`, and prices are appropriate for both, the keeper will attempt to execute both strategies. Whichever transaction is included in a block first will "win", with the other strategy potentially reverting onchain. To conserve gas when using both, ensure one is configured at a more aggressive price than the other.

### Collect Liquidation Bond

Collects liquidation bonds (which were used to kick loans) once they are fully claimable. Note: This does not settle auctions.

### Collect Reward LP

Redeems rewarded LP for either Quote or Collateral based on config. Works chain-wide: any pool where your signer acted as taker or kicker is covered, including pools that the static config doesn't enumerate (auto-discovered takes are included).

Discovery is subgraph-based: each cycle the keeper runs ONE chain-wide subgraph query for `BucketTake` entities where the signer was taker or kicker across every Ajna pool, dedupes against an in-memory set, and dispatches each event to a per-pool redemption state (materialized on-demand). On process start the cursor is reset so the first ingest replays the full `BucketTake` history for this signer — this reclaims LP rewards that accrued before the keeper was started or during downtime.

**Enabling LP collection.** Two modes:

1. **Chain-wide** (recommended): set `rewards.defaultLpReward` in `KeeperConfig`. Every pool the signer has activity in uses these defaults. Per-pool overrides via `manual.pools[i].collectLpReward` are merged on top.
2. **Legacy per-pool**: set `collectLpReward` on each pool in `manual.pools[]` without `rewards.defaultLpReward`. Only those pools are covered; auto-discovered pools are ignored.

Example (chain-wide with one override):

```ts
const config: KeeperConfig = {
  // ...
  rewards: {
    defaultLpReward: {
      redeemFirst: TokenToCollect.QUOTE,
      minAmountQuote: 10,
      minAmountCollateral: 0,
      rewardActionQuote: {
        action: RewardActionLabel.EXCHANGE,
        dexProvider: PostAuctionDex.UNISWAP_V3,
        address: '0xquoteTokenAddress',
        targetToken: 'weth',
        slippage: 2,
        fee: 3000,
      },
    },
  },
  manual: {
    pools: [
    { address: '0xabc…', price: { … } }, // uses defaults
    {
      address: '0xdef…',
      price: { … },
      collectLpReward: { minAmountQuote: 100 }, // override: higher threshold for this pool
    },
  ],
  },
};
```

**Keeper signer must not also be a lender in the same pools.** The redemption step is bounded by the signer's on-chain `lpBalance` in each bucket. That bound is safe when every LP the signer holds came from being a taker or kicker — which is exactly what this module redeems. Sharing one signer across the take keeper, the kick keeper, and this LP-reward keeper is fine; they're all writing reward LP that we're collecting back.

The conflict is with a signer that _also_ deposits quote as a lender. After a restart the keeper replays history from cursor `0`, and the on-chain `lpBalance` includes both unredeemed reward LP and principal LP — the code can't tell them apart, so it may burn principal to satisfy a stale reward entry. If the operator both runs a keeper and provides liquidity to the same pools, use **separate keys** for the two roles. If the keeper signer never calls `addQuoteToken` directly, one key is fine.

**ERC20 only.** The redemption path uses the Ajna `FungiblePoolFactory` to materialize pool handles, which only supports ERC20 pools. If your signer ever takes on an ERC721 pool, the event is skipped and the LP sits on-chain (same outcome as if the keeper were off for that pool).

**Operational notes:**

- **Cold-start replay cost.** The first ingest after a restart queries from `blockTimestamp=0` and paginates up to 100 pages × 1000 events = 100,000 `BucketTake`s in the worst case (typical keeper signers have much less history). Subsequent cycles only query the small delta past the last observed timestamp and are fast. The first cycle also pays 2–3 RPC reads per unique pool the signer has activity in (one-time pool-handle construction + deployment validation, cached thereafter).
- **Subgraph-down at startup.** If the subgraph is unreachable on the first cycle, the cursor stays at `0` and the next cycle re-runs the full historical query. The keeper does not persist cursor state to disk — reachability of the subgraph on first use matters. If you run against a flaky endpoint, configure `network.subgraph.fallbackUrls` in `KeeperConfig`.
- **Indexing-lag tolerance.** Each query is shifted back by `rewards.lpLookbackSeconds` (default 60s, max 86 400s) so late-indexed events that land just under the previous cursor are still re-seen. Dedupe is handled in-memory by an event-id set scoped to that window. Chains where Goldsky lag regularly exceeds 60s should raise this.
- **Subgraph-ahead-of-RPC race.** If the read RPC is lagging the subgraph at the moment a newly-ingested BucketTake is swept (uncommon — subgraph usually trails chain head, not leads it — but possible on load-balanced RPC pools that temporarily route to a stale node), the keeper can see `lpBalance=0` on-chain for a bucket the subgraph has already credited. The lpMap entry is then dropped and the event's id stays in the dedupe set, so the keeper won't re-discover it in the current process. **The LP itself is safe on-chain** — Ajna LP doesn't expire and the signer's claim persists. The keeper will redeem it on either (a) a subsequent BucketTake on the same bucket (the fresh credit triggers a sweep that reads the accumulated on-chain balance) or (b) the next process restart (cursor resets to `0` and replay re-credits everything). No fund loss; worst case is a deferred redemption.

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

V1 autodiscovery can discover chain-wide `take` and `settlement` opportunities without listing every pool in `manual.pools[]`.

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

| DEX Integration | External Takes | LP Rewards | Contract Required | Best For                                           |
| --------------- | -------------- | ---------- | ----------------- | -------------------------------------------------- |
| **1inch**       | ✅             | ✅         | Yes (Single)      | Major chains (Ethereum, Avalanche, Base, Arbitrum) |
| **Uniswap V3**  | ✅             | ✅         | Yes (Factory)     | All chains with Uniswap V3                         |
| **SushiSwap**   | ✅             | ✅         | Yes (Factory)     | Chains with SushiSwap V3                           |
| **Curve**       | ✅             | ✅         | Yes (Factory)     | Chains with Curve pools (stablecoin/crypto pairs)  |

#### Configuring for 1inch

To enable 1inch swaps, set up environment variables and add the 1inch router fields to `dex.oneInch` in `config.ts`. `dex.oneInch.defaultSlippage` controls the external-take min-out slippage percentage for 1inch routes and defaults to `1.0` when unset. For discovered external takes, use `discovery.take.oneInchQuoteTimeoutMs`, `oneInchQuoteFailureThreshold`, and `oneInchQuoteFailureCooldownMs` to bound API latency and back off after repeated retryable failures. Defaults are a 2000ms 1inch request timeout, 2 retryable failures before cooldown, and a 30000ms cooldown.

Atomic 1inch takes validate the decoded swap payload before submission. The payload must swap the pool collateral token to the pool quote token, send output to the keeper taker, use the requested collateral amount, have positive `minReturnAmount`, and use `flags = 0`. The decoded `srcReceiver` may be either the configured 1inch router or the decoded aggregation executor. The aggregation executor is decoded from the 1inch API response and is not allowlisted by default; startup warns when 1inch discovered takes are enabled without an allowlist, and every atomic take logs the decoded executor. Use `dex.oneInch.aggregationExecutorAllowlist` per chain to hard-restrict executors. If 1inch starts returning required non-zero flags for a target pair, use factory routing for that pool or open an issue before loosening this guard.

If you want take transactions to go through a dedicated private/write path, set
`writes.take` in your keeper config:

```ts
writes: {
  take: {
    mode: 'private_rpc',
    rpcUrl: 'https://your-private-rpc',
  },
},
```

Or for JSON-RPC relay/private orderflow endpoints:

```ts
writes: {
  take: {
    mode: 'relay',
    relay: {
      url: 'https://your-relay-endpoint',
      sendMethod: 'eth_sendPrivateTransaction',
      maxBlockNumberOffset: 25,
      receiptTimeoutMs: 120000,
    },
  },
},
```

This write path is currently scoped to `take` only; the rest of the keeper
still uses `network.rpcUrl` for transaction submission. Relay mode persists
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

### Factory Fee-Tier Configuration for External Takes

For Uniswap V3 and SushiSwap external takes, the deployed taker contracts accept the fee tier as call data. The keeper uses `defaultFeeTier` as the preferred/fallback route, as a deterministic tie-breaker among otherwise equal routes, and carries the selected fee tier into execution. When `candidateFeeTiers` is unset, both V3 factory sources automatically probe standard `[100, 500, 3000, 10000]` tiers, ordered with the default first. A non-standard `defaultFeeTier` is also kept first, then the standard tiers are probed. Configure `candidateFeeTiers` only when you want an explicit narrower or custom tier set; use `candidateFeeTiers: [defaultFeeTier]` for default-tier-only probing.

**Fee Tier Value → Percentage → Common Use:**

- `100` = 0.01% = 1 basis point (where deployed)
- `200`, `300`, `400` = newer low-fee tiers on supported deployments
- `500` = 0.05% = 5 basis points (stablecoins)
- `3000` = 0.3% = 30 basis points (most common)
- `10000` = 1.0% = 100 basis points (exotic pairs)

**External Takes vs Post-Auction Swaps:**

**For External Takes (Time-Sensitive):**

- Uses `dex.uniswapV3.universalRouter.defaultFeeTier` or `dex.sushiswap.defaultFeeTier` as the preferred route
- Auto-probes standard Uniswap V3 and SushiSwap fee tiers when `candidateFeeTiers` is unset
- Applies the selected quote route to execution, including the selected fee tier
- Skips unavailable pools before applying `takeRouteQuoteBudgetPerCandidate`, so missing fee tiers do not consume quote budget
- Quotes budget-approved factory routes with bounded parallelism, then ranks them deterministically by expected net profit
- Treats `allowedLiquiditySources`, when set, as the complete factory route allowlist. Include the default source in that list if it should remain eligible.
- Can compare the best factory route against 1inch when `discovery.take.allowedExternalTakePaths` includes both `'oneinch'` and `'factory'`.
- In hybrid mode, `externalTakeProbeTimeoutMs` bounds each 1inch/factory path probe so one slow route cannot block another viable route. When unset, it defaults to `oneInchQuoteTimeoutMs + 1000ms`, capped at 5000ms. Explicit values from 1ms to 10000ms are allowed for slow infrastructure, but values above 5000ms directly trade hot-auction latency for provider tolerance.
- Hybrid mode defaults to `externalTakeRouteSelectionMode: 'maximize_profit'`, which probes all enabled paths and ranks by expected net profit. Use `'factory_first'` to probe factory first and skip 1inch when the factory path is approved without subsidy; subsidized factory approvals keep probing so a self-funding 1inch path can still win.
- `hybridGasQuoteFailureFallbackMode: 'factory_first'` is an explicit opt-in escape hatch for hybrid `maximize_profit` when the factory route quotes but native gas cannot be converted into the pool quote token. It requires `maxGasCostNative`, is skipped when quote-denominated gas/profit fields are configured, and only approves non-subsidized factory routes.
- `npm run oneinch-route-canary` is an env-gated, no-broadcast route check for Base CADC/USDC and WETH/USDC. It loads `.env` and uses `AJNA_AGENT_RPC_URL`, `AJNA_RPC_URL_BASE`, `BASE_RPC_URL`, or `ALCHEMY_API_KEY` for Base RPC. With RPC access, it validates Uniswap V3 WETH/USDC QuoterV2 coverage across the configured fee tiers. With 1inch credentials and `AJNA_AGENT_ONEINCH_CANARY_TAKER_ADDRESS`, it also validates CADC/USDC 1inch quotes, WETH/USDC 1inch gas conversion, and decoded CADC/USDC swap-data shape.
- Advanced live/fork liquidation fixture tooling is documented in [Live Base Liquidation Fixture](docs/fixtures/live-base-liquidation-fixture.md). These scripts are intended for controlled validation of discovery and external-take behavior, not routine keeper operation.
- `marketPriceFactor` remains the operator-facing early-take threshold. Use values below 1 for normal operation, for example `0.99` means take when auction price is below roughly 99% of market. Config validation rejects non-positive values and values above 2; this catches common typos like `99` instead of `0.99`.
- `allowSubsidy` defaults to `false`. In that mode, an external take must clear the route-derived non-subsidized floor before execution. Set `discovery.take.minExpectedProfitQuote: 0` if you want quote-normalized gas coverage with no extra profit floor.
- Use `allowSubsidy: true` only for manually reviewed defensive pools where the keeper may intentionally spend P&L to repay an auction earlier. Subsidized takes still enforce auction repayment and swap min-out safety, but they may execute below the gas/profit floor.
- A low `takeRouteQuoteBudgetPerCandidate` reduces quote latency but can miss a more profitable route that was not probed.
- No per-pool external-take fee override today
- Change requires updating config and restarting the keeper

**For Post-Auction LP Rewards (Flexible):**

- Can override per pool using `fee: FeeAmount.MEDIUM` in `rewardAction`
- Falls back to the same global default if no override is specified
- Flexible and changeable without redeploying contracts
- Not affected by dynamic external-take route selection

### Factory Route Liquidity Research

Before enabling Uniswap V3 or SushiSwap external takes:

**Step 1: List all token pairs from your pools**
**Step 2: Check Uniswap Info or SushiSwap Analytics for each pair's route liquidity**
**Step 3: Weight by expected liquidation value and frequency, not just TVL**
**Step 4: Set `defaultFeeTier`; use `candidateFeeTiers` only to narrow or customize the probed tier set**
**Step 5: Revisit periodically as liquidity shifts**

Example research process:

```
Pools: USDC/WETH (high value), DAI/USDC (medium), RARE/WETH (low)

Research Results:
- USDC/WETH: 500 tier has $50M TVL, 3000 tier has $200M TVL
- DAI/USDC: 500 tier has $100M TVL, 3000 tier has $30M TVL
- RARE/WETH: Only exists in 10000 tier

Decision: Use defaultFeeTier: 3000 and leave candidateFeeTiers unset
Rationale: Prefer the highest-value pair (USDC/WETH), while letting the keeper probe standard V3 tiers when auctions appear
Plan: Keep the candidate list small enough for quote latency; LP rewards can still override per pool
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
# takers: { oneInch: '0x[deployed-address]' }
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
# takers: {
#   factory: '0x[factory-address]',
#   contracts: { UniswapV3: '0x[taker-address]', SushiSwap: '0x[taker-address]' },
# }
```

**Option C: No External Takes**

- Skip contract deployment
- Use arbTake and settlement only
- Still supports LP reward swapping (no contracts needed for LP rewards)

> **Note**: LP reward swapping does not use taker contracts. 1inch LP rewards need `dex.oneInch.routers` plus the 1inch API environment variables, while Uniswap V3, SushiSwap, and Curve use direct DEX routing.

---

## Chain-Wide Auto-Discovery (V1)

V1 can auto-discover `take` and `settlement` opportunities across a chain while keeping `kick` manual.

- `discovery` defines shared discovery controls like allow/deny lists, dry-run behavior for pools not already listed in `manual.pools[]`, and hydration cooldowns.
- `discovery.take` and `discovery.settlement` carry independent per-action limits.
- `discovery.defaults` defines the default `take` and `settlement` behavior for discovered pools.
- `manual.pools[]` still works for manual `kick`, LP collection, bond collection, and per-action overrides.
- If a pool has a manual `take`, that whole `take` block wins over discovery defaults.
- If a pool has a manual `settlement`, that whole `settlement` block wins over discovery defaults.
- `allowedExternalTakePaths: ['oneinch', 'factory']` enables top-level comparison between the 1inch aggregator path and the best factory path. If omitted, autodiscover preserves the single-path behavior from `discovery.defaults.take.liquiditySource`.
- `allowedLiquiditySources` remains factory-only. Use it to restrict factory route selection to `UNISWAPV3`, `SUSHISWAP`, and/or `CURVE`; when set, it is the complete factory route allowlist and cannot include `ONEINCH`.
- If `allowedExternalTakePaths` includes both `'oneinch'` and `'factory'`, set `defaultFactoryLiquiditySource` and `validateRouteDeployments: true` so the factory selector has a default source and startup verifies the factory taker path before hot loops begin.
- Hybrid 1inch-plus-factory ranking requires a configured native-to-quote gas conversion path and wrapped native token address, because the keeper compares route net profit instead of gross quote output.
- Set `hybridGasQuoteFailureFallbackMode: 'factory_first'` only when you intentionally want a viable factory route to execute after strict hybrid ranking fails solely because native-to-quote gas conversion is unavailable. The fallback is disabled by default, requires `maxGasCostNative`, does not run with `maxGasCostQuote`, `minExpectedProfitQuote`, or `minProfitNative`, and rejects subsidized factory routes.
- `externalTakeProbeTimeoutMs` bounds each hybrid path probe. When unset, it defaults to `oneInchQuoteTimeoutMs` plus a 1000ms RPC preflight budget, capped at 5000ms so slow 1inch settings do not stall hot loops. Explicit values from 1ms to 10000ms are accepted, but values above 5000ms should only be used when avoiding provider false-negatives is more important than tight take-loop latency. `externalTakeRouteSelectionMode: 'maximize_profit'` preserves best-route ranking; `'factory_first'` reduces 1inch API use by trying factory first and stopping once a non-subsidized factory path is approved. Subsidized factory approvals continue probing remaining paths.
- `maxConcurrentCandidateEvaluations` is opt-in and defaults to `1`, preserving sequential candidate evaluation. Values up to `4` evaluate a same-pool candidate window concurrently but still execute one decision at a time with fresh final revalidation. When this is greater than `1`, `maxInFlightRouteProbes` caps combined 1inch and factory route/API/RPC probes across the window; when unset it defaults to `3`. If `maxExecutionsPerPoolPerRun` is above `1`, same-pool candidate evaluation is forced back to sequential mode so each additional execution starts from fresh post-take state.
- `maxExecutionsPerPoolPerRun` defaults to `1` and counts successful borrower/candidate decisions, not raw transaction count. A borrower that executes both an external take and a follow-up arbTake counts once.
- `discovery.defaults.take.allowSubsidy` should normally stay unset or `false`. Setting it to `true` permits subsidized external takes on every discovered pool that matches the defaults; reserve that for intentionally defensive deployments with a known blast radius.
- Route-derived subsidy policy is evaluated from the actual selected quote. Non-subsidized external takes must clear auction repayment plus route gas/profit floors when quote-normalized gas/profit inputs are configured or available; subsidized takes may skip that economic floor but never the repayment/min-out floor.
- `marketPriceFactor` must be positive and no greater than 2. Values above 1 weaken market-factor protection and should be intentional; normal defensive settings are usually below 1.
- `minProfitNative` is expressed in wei of the chain native gas token. To target an approximate USD floor, use `minProfitNative_wei = desired_usd_profit / native_price_usd * 1e18` and recalibrate as the native token price moves.
- Once an auction has appeared in subgraph discovery, the keeper keeps it in a short-lived hot-auction cache so fast take loops can keep probing it even if a later subgraph refresh temporarily omits it. Tune with `discovery.take.hotAuctionCandidateTtlMs` and `discovery.take.maxHotAuctionCandidates`; set the TTL to `0` to disable the cache.
- On Base, Optimism, and Arbitrum-style L2s, quote-denominated gas policy applies a conservative 30% buffer to native gas cost to account for L1 data fees before converting into the pool quote token. Override with `discovery.take.l2GasCostBufferBasisPoints` only after measuring observed gas costs.
- Gas-price freshness defaults are short for take profitability checks: 5 seconds on L1 and 15 seconds on common L2s. Override with `discovery.take.l1GasPriceFreshnessTtlMs` and `discovery.take.l2GasPriceFreshnessTtlMs` if your RPC conditions require it.
- `discovery.take.gasPriceDriftToleranceBasisPoints` optionally rejects final pre-submission approval when current gas is higher than the evaluation snapshot by more than the configured tolerance. Lower gas is favorable and does not reject.
- `discovery.take.oneInchQuoteTimeoutMs` defaults to 2000ms and applies to discovered 1inch quote and swap-data requests. `oneInchQuoteFailureThreshold` defaults to 2 retryable failures before cooldown; `oneInchQuoteFailureCooldownMs` defaults to 30000ms and is capped at 1 hour.
- For live discovered external takes, `discovery.take.externalTakeTransportPolicy` can be `allow_public`, `prefer_private_or_relay`, or `require_private_or_relay`. Use `require_private_or_relay` only when `writes.take` is configured for `private_rpc` or `relay`; dry runs skip write submission but still warn if no private/relay transport is configured.
- `discovery.take.validateRouteDeployments: true` enables startup preflight checks for enabled external-take routers, takers, factory registry entries, and configured Curve pools.
- `dexGasOverrides` values are route execution gas estimates. Example: on Base, `dexGasOverrides: { [LiquiditySource.UNISWAPV3]: '450000' }` uses 450k as the DEX execution estimate, then the keeper applies its 30% L2 buffer separately.
- Uniswap V3 and SushiSwap automatically probe standard fee tiers when `candidateFeeTiers` is unset. This adds up to three extra pool-existence checks per V3 factory candidate when the default is standard, or four when the default is non-standard. Existing pools may add quote calls when quote budget allows. Quote-denominated gas conversion uses the same tier set independently of `takeRouteQuoteBudgetPerCandidate`. Set `candidateFeeTiers: [defaultFeeTier]` to opt out of automatic standard-tier probing.

For a conservative first live rollout on Base, start from [`examples/example-base-rollout-config.ts`](./examples/example-base-rollout-config.ts).

```typescript
const config: KeeperConfig = {
  runtime: {
    dryRun: true,
    logLevel: 'info',
    delayBetweenRuns: 10,
  },
  discovery: {
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
    denyPools: ['0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'],
    defaults: {
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
  },
  manual: {
    pools: [
      {
        name: 'wstETH / WETH',
        address: '0x...',
        price: { source: PriceOriginSource.FIXED, value: 1.15 },
        kick: {
          enabled: true,
          minDebt: 0.07,
          priceFactor: 0.9,
        },
        // Manual take override for this pool only. If omitted,
        // discovery.defaults.take will be used when the pool is discovered.
        take: {
          minCollateral: 0.02,
          hpbPriceFactor: 0.97,
        },
      },
    ],
  },
};
```

Discovery is auction-first, not pool-enumeration-first. The keeper queries chain-wide liquidation activity from the subgraph, groups live work by pool, hydrates only the pools that matter, and then runs the existing `take` and `settlement` execution paths behind the new policy checks.

At runtime, discovered `take` refreshes the shared chain-wide auction snapshot when `discovery.take` is enabled. Discovered `settlement` reuses that in-memory snapshot instead of issuing its own chain-wide fetch, so settlement no longer doubles discovery traffic in the common case. If you run settlement-only discovery, the settlement loop refreshes the snapshot on its own slower cadence. The snapshot is not persisted across restarts; after process restart, discovered settlement resumes after the next discovery refresh for the actions you enabled.

Chain-wide discovery paginates automatically in 100-auction pages, up to 100 pages per refresh. No extra operator action is needed to discover 101 active auctions.

`minExpectedProfitQuote` applies only under `discovery.take`, and only for discovered external `take` decisions. Do not combine it with arb-only discovered take defaults. Set it to `0` when you want the route-derived policy to require quote-normalized gas coverage without adding an extra profit floor. `maxGasCostNative`, `maxGasCostQuote`, and `maxGasPriceGwei` are action-specific under `discovery.take` and `discovery.settlement`.

Prefer `maxGasCostNative` on L2s and mixed-quote deployments. It uses the RPC gas price directly and does not require an extra native-to-quote conversion fetch. `maxGasCostQuote` remains available as an explicit quote-denominated mode; when it is enabled the keeper may need to convert native gas cost into the pool quote token. If the pool collateral is already wrapped native, the keeper reuses the existing take quote instead of fetching a second conversion quote. All quote-denominated thresholds are per-pool quote token amounts.

`kick` auto-discovery is intentionally not part of V1.

---

## DEX Router Configuration:

### Configuring for External Takes

External takes require contract deployment and specific configuration:

#### 1inch Integration (Single Contract)

**IMPORTANT:** 1inch contract deployment is required for 1inch external takes only. LP reward swaps that use `PostAuctionDex.ONEINCH` use `dex.oneInch.routers` and the 1inch API directly; they do not require `takers.oneInch`.

**Contract Deployment:**

```bash
yarn ts-node scripts/query-1inch.ts --config your-config.ts --action deploy
```

**Config.ts Setup:**

```typescript
const config: KeeperConfig = {
  // Required for 1inch external takes only
  takers: {
    oneInch: '0x[deployed-address]',
  },
  dex: {
    oneInch: {
      routers: {
        1: '0x1111111254EEB25477B68fb85Ed929f73A960582', // Ethereum
        43114: '0x111111125421ca6dc452d289314280a0f8842a65', // Avalanche
        8453: '0x1111111254EEB25477B68fb85Ed929f73A960582', // Base
      },
    },
  },

  manual: {
    pools: [
      {
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.98, // Take when auction < market * 0.98
          allowSubsidy: false, // Default: route must cover repayment plus configured gas/profit floors
        },
      },
    ],
  },
};
```

**1inch Routing Note**
1inch routes dynamically through its API, so `defaultFeeTier` and `candidateFeeTiers` do not apply to 1inch external takes. Use the 1inch timeout and cooldown settings above to control hot-loop latency and API cost.

#### Uniswap V3 Integration (Factory System)

**Contract Deployment:**

```bash
yarn ts-node scripts/deploy-factory-system.ts your-config.ts
```

**Config.ts Setup:**

```typescript
const config: KeeperConfig = {
  // Required for Uniswap V3 external takes
  takers: {
    factory: '0x[factory-address]',
    contracts: {
      UniswapV3: '0x[taker-address]',
    },
  },
  dex: {
    uniswapV3: {
      universalRouter: {
        universalRouterAddress: '0x533c7A53389e0538AB6aE1D7798D6C1213eAc28B',
        wethAddress: '0x4200000000000000000000000000000000000006',
        permit2Address: '0xB952578f3520EE8Ea45b7914994dcf4702cEe578',
        poolFactoryAddress: '0x346239972d1fa486FC4a521031BC81bFB7D6e8a4',
        quoterV2Address: '0xcBa55304013187D49d4012F4d7e4B63a04405cd5',
        defaultFeeTier: 3000, // Preferred/default Uniswap external-take route
        // Omit candidateFeeTiers to auto-probe standard V3 tiers; uncomment only to narrow/customize.
        // candidateFeeTiers: [500, 10000],
        defaultSlippage: 0.5,
      },
    },
  },

  manual: {
    pools: [
      {
        take: {
          liquiditySource: LiquiditySource.UNISWAPV3,
          marketPriceFactor: 0.99, // Take when auction < market * 0.99
          allowSubsidy: false, // Set true only for intentionally defensive subsidized takes
        },
      },
    ],
  },
};
```

**Uniswap V3 Route Selection**

Uniswap external takes use `defaultFeeTier` as the preferred route and automatically probe standard V3 tiers when `candidateFeeTiers` is unset. The keeper checks whether a pool exists before spending quote budget, then quotes viable routes and executes with the selected fee tier.

To check liquidity:

1. Visit [Uniswap Info](https://info.uniswap.org/#/pools) for your network
2. Search for your token pair (e.g., USDC/WETH)
3. Compare TVL across different fee tiers
4. Set `defaultFeeTier` to your preferred/common route; add `candidateFeeTiers` only to narrow or customize the automatic standard set
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
  takers: {
    factory: '0x[factory-address]',
    contracts: {
      SushiSwap: '0x[taker-address]',
    },
  },
  dex: {
    sushiswap: {
      swapRouterAddress: '0x33d91116e0370970444B0281AB117e161fEbFcdD', //addresses for Hemi Chain
      quoterV2Address: '0x1400feFD6F9b897970f00Df6237Ff2B8b27Dc82C',
      factoryAddress: '0xCdBCd51a5E8728E0AF4895ce5771b7d17fF71959',
      wethAddress: '0x4200000000000000000000000000000000000006',
      defaultFeeTier: 500, // Preferred/default SushiSwap external-take route
      // Omit candidateFeeTiers to auto-probe standard V3 tiers; uncomment only to narrow/customize.
      // candidateFeeTiers: [3000],
      defaultSlippage: 10.0,
    },
  },

  manual: {
    pools: [
      {
        take: {
          liquiditySource: LiquiditySource.SUSHISWAP,
          marketPriceFactor: 0.99, // Take when auction < market * 0.99
          allowSubsidy: false,
        },
      },
    ],
  },
};
```

**SushiSwap Route Selection**

SushiSwap external takes use `defaultFeeTier` as the preferred route and automatically probe standard V3 tiers when `candidateFeeTiers` is unset. Missing pools are skipped before quote-budgeting; viable routes are ranked by profitability and executed with the selected fee tier.

To verify optimal pools:

1. Check [SushiSwap Analytics](https://sushi.com/pool) for your network
2. Compare liquidity across fee tiers for your token pairs
3. Set `defaultFeeTier` to your preferred/common route; add `candidateFeeTiers` only to narrow or customize the automatic standard set
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
  takers: {
    factory: '0x[factory-address]',
    contracts: {
      Curve: '0x[curve-taker-address]',
    },
  },
  dex: {
    curve: {
      poolConfigs: {
        // Stablecoin pools (use STABLE pool type)
        'usdc-usdt': {
          address: '0x[CURVE_STABLE_POOL_ADDRESS]',
          poolType: CurvePoolType.STABLE,
        },
        // Crypto pools (use CRYPTO pool type)
        'weth-wbtc': {
          address: '0x[CURVE_CRYPTO_POOL_ADDRESS]',
          poolType: CurvePoolType.CRYPTO,
        },
      },
      defaultSlippage: 1.0,
      wethAddress: '0x4200000000000000000000000000000000000006',
      // Optional: leave unset/0 for lowest-latency execution.
      // Set only if a chain/provider needs extra Curve state propagation time.
      executionDelayMs: 0,
    },
  },
  // Required: Token symbol to address mapping
  network: {
    tokenAddresses: {
      weth: '0x4200000000000000000000000000000000000006',
      usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      usdt: '0x[USDT_ADDRESS]',
      wbtc: '0x[WBTC_ADDRESS]',
    },
  },

  manual: {
    pools: [
      {
        take: {
          liquiditySource: LiquiditySource.CURVE,
          marketPriceFactor: 0.99, // Take when auction < market * 0.99
          allowSubsidy: false,
        },
      },
    ],
  },
};
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
network: {
  tokenAddresses: {
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Must match exact addresses
    dai: '0x[DAI_ADDRESS]',
    usdt: '0x[USDT_ADDRESS]',
    weth: '0x4200000000000000000000000000000000000006',
  },
}
```

**Step 4: Set Up Pool Configurations**

```typescript
dex: {
  curve: {
    poolConfigs: {
      // Use token symbols from network.tokenAddresses above
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
    executionDelayMs: 0, // Optional; keep 0 unless production testing shows a Curve propagation delay is needed
  },
}
```

### Automatic Detection

The keeper automatically detects your configuration:

- **Single-contract 1inch**: Uses the manual 1inch execution path (`src/take/one-inch-execution.ts`)
- **Factory**: Uses the multi-DEX factory execution path (`src/take/factory/index.ts`)
- **None**: ArbTake and settlement only

No manual selection needed - the bot chooses based on your config.

### Enhanced Configuration Examples

**Major Chain Example (1inch):**

```typescript
// examples/example-avalanche-config.ts shows 1inch external takes
const config: KeeperConfig = {
  takers: {
    oneInch: '0x[deployed-1inch-contract]',
  },
  dex: {
    oneInch: {
      routers: { 43114: '0x111111125421ca6dc452d289314280a0f8842a65' },
    },
  },

  manual: {
    pools: [
      {
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.98,
          allowSubsidy: false,
        },
      },
    ],
  },
};
```

**Multi-DEX Chain Example (Factory):**

```typescript
// examples/example-hemi-config.ts shows factory external takes
const config: KeeperConfig = {
  takers: {
    factory: '0x[factory-address]',
    contracts: {
      UniswapV3: '0x[taker-address]',
      SushiSwap: '0x[taker-address]',
    },
  },
  dex: {
    uniswapV3: {
      universalRouter: {
        defaultFeeTier: 3000, // Preferred/default Uniswap external-take route
        candidateFeeTiers: [500, 10000], // Optional: narrow/customize probed tiers; defaultFeeTier is always included
        /* other addresses */
      },
    },
    sushiswap: {
      defaultFeeTier: 3000, // Preferred/default SushiSwap external-take route
      candidateFeeTiers: [500], // Optional: narrow/customize probed tiers; defaultFeeTier is always included
      /* other addresses */
    },
  },

  manual: {
    pools: [
      {
        take: {
          liquiditySource: LiquiditySource.SUSHISWAP, // or UNISWAPV3
          marketPriceFactor: 0.99,
          allowSubsidy: false,
        },
      },
    ],
  },
};
```

**See `examples/example-avalanche-config.ts`, `examples/example-hemi-config.ts`, for complete examples.**

### Detailed LP Reward Configuration

The following sections provide comprehensive examples for configuring LP reward swapping:

##### 1inch LP Reward Configuration

**IMPORTANT:** 1inch LP reward swaps do not require smart contract deployment. Configure `dex.oneInch.routers` and the 1inch API environment variables; `takers.oneInch` is only for 1inch external takes.

Edit `config.ts` to include these fields:

`dex.oneInch.routers`:

A dictionary of 1inch router addresses for each chain ID you want to support.

- Format: `{ [chainId]: "router-address" }`
- Example:

```
dex: {
  oneInch: {
    routers: {
      1: "0x1111111254EEB25477B68fb85Ed929f73A960582",    // Ethereum Mainnet
      8453: "0x1111111254EEB25477B68fb85Ed929f73A960582", // Base
      43114: "0x1111111254EEB25477B68fb85Ed929f73A960582" // Avalanche
    },
  },
},
```

`network.tokenAddresses`:
A dictionary of token addresses for swaps (required for Avalanche, optional otherwise).

- Format: `{ [tokenName]: "token-address" }`
- Example:

```
network: {
  tokenAddresses: {
    weth: "0x4200000000000000000000000000000000000006", // WETH on Base
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC on Base
    avax: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"  // Native AVAX
  },
},
```

`dex.oneInch.connectorTokens` (Optional):
An array of token addresses used as intermediate connectors in 1inch swap routes. These tokens can facilitate multi-hop trades to optimize the swap path between the input and output tokens.

- Format: `Array<string>`
- Example:

```
dex: {
  oneInch: {
    connectorTokens: [
      "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC on Ethereum
      "0x6B175474E89094C44Da98b954EedeAC495271d0F"  // DAI on Ethereum
    ],
  },
},
```

`manual.pools.collectLpReward.rewardAction`:
LP in buckets can be reedemed for quote token and/or collateral, depending on what the bucket holds at time of redemption. `redeemFirst` controls the redemption strategy, favoring either quote token (most situations) or collateral (useful in shorting pools). To defer redeeming the second token, it's `minAmount` can be set to a sufficiently high value that manually swapping tokens on an exchange becomes practical.

Separate reward actions may be assigned to quote token and collateral, allowing tokens to be swapped out as desired. For pools where you want to swap rewards with 1inch, set `dexProvider: PostAuctionDex.ONEINCH` in the `rewardAction`.

- Example: Volatile-to-volatile pool, swap both tokens for stables

```
manual: {
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
      },
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
},
```

- Example: Stablecoin pool, swap collateral for quote token

```
manual: {
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
},
```

- Example: Shorting pool, no automated swapping

```
manual: {
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
},

```

##### Notes

- 1inch LP reward swaps require `dex.oneInch.routers` and the 1inch API environment variables, not `takers.oneInch`.
- `takers.oneInch` is only required for 1inch external takes.
- Ensure the `.env` file is loaded (via `dotenv/config`) in your project.

##### Uniswap V3 LP Reward Configuration

Edit `config.ts` to include these optional fields:

`dex.uniswapV3.universalRouter`:
Required for Uniswap V3 swaps. Provides addresses for Universal Router integration.

- Format:

```
dex: {
  uniswapV3: {
    universalRouter: {
      universalRouterAddress: "0x533c7A53389e0538AB6aE1D7798D6C1213eAc28B",
      wethAddress: "0x4200000000000000000000000000000000000006",
      permit2Address: "0xB952578f3520EE8Ea45b7914994dcf4702cEe578",
      poolFactoryAddress: "0x346239972d1fa486FC4a521031BC81bFB7D6e8a4",
      defaultFeeTier: 3000,
      defaultSlippage: 0.5,
    },
  },
}
```

`network.tokenAddresses` (Optional):
Useful for specifying target tokens (e.g., WETH) if not using `dex.uniswapV3.universalRouter`.

- Example:

```
network: {
  tokenAddresses: {
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH on Ethereum
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"  // USDC on Ethereum
  },
},
```

`manual.pools.collectLpReward.rewardAction`:
For pools where you want to swap rewards with Uniswap V3, set `dexProvider: PostAuctionDex.UNISWAP_V3` and optionally add a `fee`.

- Format:

```
{
  name: "Your Pool Name",
  address: "0xpoolAddress",
  // Other pool settings...
  collectLpReward: {
    redeemFirst: TokenToCollect.QUOTE, // or TokenToCollect.COLLATERAL
    minAmountQuote: 0.001,
    minAmountCollateral: 0.001,
    rewardActionQuote: {
      action: RewardActionLabel.EXCHANGE,
      address: "0xtokenAddress", // Token to swap (quote token here)
      targetToken: "weth",       // Target token (e.g., "weth", "usdc")
      slippage: 1,               // Slippage percentage
      dexProvider: PostAuctionDex.UNISWAP_V3,
      fee: 3000                  // Fee tier (500, 3000, 10000)
    }
  }
}
```

- Example:

```
manual: {
  pools: [
  {
    name: "WETH / USDC",
    address: "0x0b17159f2486f669a1f930926638008e2ccb4287",
    collectLpReward: {
      redeemFirst: TokenToCollect.COLLATERAL,
      minAmountQuote: 0.001,
      minAmountCollateral: 0.001,
      rewardActionCollateral: {
        action: RewardActionLabel.EXCHANGE,
        address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        targetToken: "usdc",
        slippage: 1,
        dexProvider: PostAuctionDex.UNISWAP_V3,
        fee: FeeAmount.MEDIUM // Can use different fee tier than external takes!
      }
    }
  }
],
},
```

Note: LP reward swaps can use **different fee tiers** than external takes by specifying `fee: FeeAmount.LOW` (500), `fee: FeeAmount.MEDIUM` (3000), or `fee: FeeAmount.HIGH` (10000).

##### SushiSwap LP Reward Configuration

For SushiSwap integration, add the `dex.sushiswap` configuration:

`dex.sushiswap`:
Required for SushiSwap swaps. Provides addresses for SushiSwap router integration.

- Format:

```
dex: {
  sushiswap: {
    swapRouterAddress: "0x33d91116e0370970444B0281AB117e161fEbFcdD",
    quoterV2Address: "0x1400feFD6F9b897970f00Df6237Ff2B8b27Dc82C",
    factoryAddress: "0xCdBCd51a5E8728E0AF4895ce5771b7d17fF71959",
    wethAddress: "0x4200000000000000000000000000000000000006",
    defaultFeeTier: 500,
    defaultSlippage: 10.0,
  },
}
```

- Example:

```
manual: {
  pools: [
  {
    name: "USD_T1 / USD_T2",
    address: "0x600ca6e0b5cf41e3e4b4242a5b170f3b02ce3da7",
    collectLpReward: {
      redeemFirst: TokenToCollect.COLLATERAL,
      minAmountQuote: 0.001,
      minAmountCollateral: 0.001,
      rewardActionCollateral: {
        action: RewardActionLabel.EXCHANGE,
        address: "0x1f0d51a052aa79527fffaf3108fb4440d3f53ce6",
        targetToken: "usd_t2",
        slippage: 10,
        dexProvider: PostAuctionDex.SUSHISWAP,
        fee: FeeAmount.LOW // Can use different fee tier than external takes!
      }
    }
  }
],
},
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
GRAPH_API_KEY="your_graph_key"
COINGECKO_API_KEY="your_coingecko_key"
```

**Note**: Enable Ethereum mainnet and Base in your Alchemy app. The fork-backed tests use pinned mainnet/Base blocks depending on `FORK_NETWORK`.

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

Hardhat integration tests run against an in-process fork; you do not need to start a separate node for the normal suite.

```bash
make test-integration
# Or: yarn integration-tests
```

To fork a specific network, set `FORK_NETWORK`:

```bash
FORK_NETWORK=base yarn integration-tests
FORK_NETWORK=avalanche yarn integration-tests
```

Use `make fork-base` only when you want a long-running local Base fork for manual debugging.

#### Production verification

```bash
npm run production-verification:mainnet
npm run production-verification:base
npm run production-verification
```

The live-liquidity E2E sweep is opt-in because it performs pinned fork executions through real DEX liquidity. It covers the single pinned Uniswap route and automatic Uniswap V3 fee-tier probing against multiple initialized real pools:

```bash
npm run production-verification:live-liquidity:mainnet
```

#### Price API tests

Test the Alchemy and CoinGecko price integrations:

```bash
make test-prices
npx ts-node scripts/price-diagnostics.ts alchemy
npx ts-node scripts/price-diagnostics.ts fallback
npx ts-node scripts/price-diagnostics.ts cana
```

## Disclaimer

User assumes all risk of data presented and transactions placed by this keeper; see license for more details.

## DeepWiki

You can ask an AI about this GitHub repo on DeepWiki. It is indexed weekly, so it may lag the current branch.

[https://deepwiki.com/ajna-finance/ajna-keeper](https://deepwiki.com/ajna-finance/ajna-keeper)

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/ajna-finance/ajna-keeper)
