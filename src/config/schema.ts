import { Address } from '@ajna-finance/sdk';
import { FeeAmount } from '@uniswap/v3-sdk';
import type { ExternalTakeTakerContractKey } from './external-take-descriptors';
import type { LifiFeeCostPolicy } from '../dex/lifi/schema';
import type { LifiProductionExchangePolicyKind } from '../dex/lifi/exchange-policy';

export type { LifiFeeCostPolicy } from '../dex/lifi/schema';

export interface AjnaConfigParams {
  erc20PoolFactory: Address;
  erc721PoolFactory: Address;
  poolUtils: Address;
  positionManager: Address;
  ajnaToken: Address;
  grantFund?: Address;
  burnWrapper?: Address;
  lenderHelper?: Address;
}

export enum PriceOriginSource {
  FIXED = 'fixed',
  COINGECKO = 'coingecko',
  POOL = 'pool',
}

export enum PriceOriginPoolReference {
  HPB = 'hpb',
  HTP = 'htp',
  LUP = 'lup',
  LLB = 'llb',
}

interface PriceOriginFixed {
  source: PriceOriginSource.FIXED;
  value: number;
}

export interface PriceOriginCoinGeckoQuery {
  source: PriceOriginSource.COINGECKO;
  query: string;
}

export interface PriceOriginCoinGeckoTokenIds {
  source: PriceOriginSource.COINGECKO;
  quoteId: string;
  collateralId: string;
}

export type PriceOriginCoinGecko =
  | PriceOriginCoinGeckoQuery
  | PriceOriginCoinGeckoTokenIds;

interface PriceOriginPool {
  source: PriceOriginSource.POOL;
  reference: PriceOriginPoolReference;
}

export type PriceOrigin = (
  | PriceOriginFixed
  | PriceOriginCoinGecko
  | PriceOriginPool
) & {
  invert?: boolean;
};

export interface EnabledKickSettings {
  /**
   * Explicit per-pool kick toggle. Keep the kick block present with
   * `enabled: false` to retain thresholds without scanning the pool.
   */
  enabled: true;
  minDebt: number;
  priceFactor: number;
}

export interface DisabledKickSettings {
  enabled: false;
  minDebt?: number;
  priceFactor?: number;
}

export type KickSettings = EnabledKickSettings | DisabledKickSettings;

export enum LiquiditySource {
  NONE = 0,
  ONEINCH = 1,
  UNISWAPV3 = 2,
  SUSHISWAP = 3,
  CURVE = 4,
  LIFI = 5,
  SUSHI_AGGREGATOR = 6,
}

export type LiquiditySourceMap<T> = Partial<Record<LiquiditySource, T>>;
/**
 * Canonical internal execution families. `calldata_aggregator` is the shared
 * family for opaque-calldata aggregator providers; provider identity travels
 * separately as CalldataAggregatorProviderId.
 */
export type ExternalTakePathKind = 'direct_dex' | 'calldata_aggregator';
export type ConfiguredExternalTakePathKind =
  | 'direct_dex'
  | 'calldata_aggregator';
/**
 * Calldata-aggregator providers active in the current packet. Packet 3B
 * extended the union with `sushi_aggregator` in the same diff that added
 * Sushi support; an omitted allowedCalldataAggregatorProviders list follows
 * source-derived defaults, so Sushi is never silently enabled.
 */
export type CalldataAggregatorProviderId =
  | 'lifi'
  | 'sushi_aggregator'
  | 'oneinch';
export type ExternalTakeRouteSelectionMode =
  | 'maximize_profit'
  | 'direct_dex_first';
export type HybridGasQuoteFailureFallbackMode = 'disabled' | 'direct_dex_first';
export type ExternalTakeTransportPolicy =
  | 'allow_public'
  | 'prefer_private_or_relay'
  | 'require_private_or_relay';

export enum CurvePoolType {
  STABLE = 'stable',
  CRYPTO = 'crypto',
}

export interface TakeSettings {
  minCollateral?: number;
  hpbPriceFactor?: number;
  liquiditySource?: LiquiditySource;
  marketPriceFactor?: number;
  /**
   * Permit defensive external takes that repay the auction but do not cover the
   * route-derived gas/profit floor. Keep false unless the operator explicitly
   * accepts keeper P&L spend to protect a reviewed pool or borrower.
   */
  allowSubsidy?: boolean;
}

export interface CollectSettings {
  collectLiquidity: boolean;
  collectBonds: boolean;
}

interface PoolDexConfig {
  fee: FeeAmount;
}

export enum TokenToCollect {
  QUOTE = 'quote',
  COLLATERAL = 'collateral',
}

export enum RewardActionLabel {
  TRANSFER = 'transfer',
  EXCHANGE = 'exchange',
}

export enum PostAuctionDex {
  ONEINCH = 'oneinch',
  UNISWAP_V3 = 'uniswap_v3',
  CURVE = 'curve',
}

export interface TransferReward {
  action: RewardActionLabel.TRANSFER;
  to: string;
}

export interface ExchangeReward {
  action: RewardActionLabel.EXCHANGE;
  address: string;
  targetToken: string;
  slippage: number;
  dexProvider: PostAuctionDex;
  fee?: number;
}

export type RewardAction = TransferReward | ExchangeReward;

export interface CollectLpRewardSettings {
  redeemFirst?: TokenToCollect;
  minAmountQuote: number;
  minAmountCollateral: number;
  rewardActionQuote?: RewardAction;
  rewardActionCollateral?: RewardAction;
}

/**
 * Per-pool override shape. All fields optional at the type level because the
 * `resolveCollectLpRewardForPool` merger fills required fields from
 * `rewards.defaultLpReward` when it's set.
 *
 * **Runtime contract (legacy mode only):** when
 * `KeeperConfig.rewards.defaultLpReward` is NOT set, a per-pool
 * `collectLpReward` entry must still supply
 * `minAmountQuote` AND `minAmountCollateral`. The startup validator
 * (`assertIsValidConfig` in `config/load.ts`) rejects any legacy-mode entry
 * missing these fields. The type stays `Partial` to keep chain-wide mode
 * ergonomic; if TypeScript flagged missing fields here, operators running
 * chain-wide would have to spell out the override with needless repetition.
 */
export type CollectLpRewardOverride = Partial<CollectLpRewardSettings>;

export interface SettlementConfig {
  enabled: boolean;
  minAuctionAge?: number;
  maxBucketDepth?: number;
  maxIterations?: number;
  checkBotIncentive?: boolean;
}

export interface AutoDiscoverActionPolicy {
  enabled?: boolean;
  maxPoolsPerRun?: number;
  maxGasPriceGwei?: number;
  maxGasCostNative?: number;
  maxGasCostQuote?: number;
}

export interface AutoDiscoverTakePolicy extends AutoDiscoverActionPolicy {
  /**
   * Quote-token profit floor in human token units. When both this and
   * minProfitNative are set, the effective floor is the stricter of this
   * quote-denominated floor and the freshly converted native floor.
   *
   * Prefer minProfitNative for cross-token keeper operations where quote assets
   * differ across discovered pools.
   */
  minExpectedProfitQuote?: number;
  /**
   * Native-token profit floor in wei. Quoted fresh into each candidate's quote
   * token for external takes; arb-takes are skipped when this is set because
   * they do not produce quote-normalized profit.
   */
  minProfitNative?: string;
  takeQuoteBudgetPerRun?: number;
  /**
   * Milliseconds to keep already-seen liquidation candidates eligible for
   * probing even if the next subgraph refresh omits them. Set to 0 to disable.
   */
  hotAuctionCandidateTtlMs?: number;
  /**
   * Maximum hot-auction candidates retained in memory across take cycles.
   */
  maxHotAuctionCandidates?: number;
  /**
   * External take execution paths eligible for discovered liquidation takes.
   * When omitted, autodiscover preserves the single-path behavior from
   * discovery.defaults.take.liquiditySource unless
   * allowedCalldataAggregatorProviders explicitly enables multiple providers
   * inside the derived calldata_aggregator family.
   */
  allowedExternalTakePaths?: ConfiguredExternalTakePathKind[];
  /**
   * Calldata-aggregator providers allowed to quote and compete inside the
   * `calldata_aggregator` family. Omitted follows source-derived defaults
   * such as ONEINCH -> oneinch and otherwise falls back to LI.FI when the
   * family is enabled. An explicit multi-provider list engages hybrid
   * provider selection even when allowedExternalTakePaths is omitted. A
   * non-empty list requires the family to be enabled; empty lists, duplicates,
   * and unknown or packet-inactive ids are invalid.
   */
  allowedCalldataAggregatorProviders?: CalldataAggregatorProviderId[];
  /**
   * Direct DEX path to use when discovery.defaults.take.liquiditySource is an
   * aggregator source but allowedExternalTakePaths also enables direct_dex.
   */
  defaultDirectDexLiquiditySource?: LiquiditySource;
  /**
   * Freshness windows for gas prices used in discovered external-take
   * profitability checks. L2 defaults are intentionally longer than L1.
   */
  l1GasPriceFreshnessTtlMs?: number;
  l2GasPriceFreshnessTtlMs?: number;
  /**
   * Basis-point multiplier applied to estimated L2 gas costs to cover L1 data
   * fees and sequencer-specific cost drift. 13000 means 1.3x.
   */
  l2GasCostBufferBasisPoints?: number;
  /**
   * Optional maximum allowed absolute gas-price drift between quote evaluation
   * and final pre-submission approval. Only upward drift rejects; lower gas is
   * favorable. 2000 means 20%. When omitted, freshness TTLs still apply but
   * drift does not reject otherwise-fresh quotes.
   */
  gasPriceDriftToleranceBasisPoints?: number;
  /**
   * Maximum time to wait for a 1inch quote while probing hybrid external-take
   * paths and for the matching 1inch swap-data request before submission.
   * Defaults to 2000ms. Must be between 1ms and 10000ms.
   */
  oneInchQuoteTimeoutMs?: number;
  /**
   * Cooldown after repeated retryable 1inch quote failures. Defaults to 30000ms.
   */
  oneInchQuoteFailureCooldownMs?: number;
  /**
   * Retryable 1inch quote failures before cooldown opens. Defaults to 2.
   */
  oneInchQuoteFailureThreshold?: number;
  /**
   * Maximum time to wait for each external-take path probe in hybrid mode.
   * Defaults to oneInchQuoteTimeoutMs plus a 1000ms RPC preflight budget,
   * capped at 5000ms. Must be between 1ms and 10000ms when configured.
   */
  externalTakeProbeTimeoutMs?: number;
  /**
   * Hybrid route selection mode. maximize_profit probes all enabled paths and
   * picks the best net-profit route. direct_dex_first probes direct DEX routes
   * before aggregator providers and stops at the first non-subsidized approved
   * path; subsidized approvals keep probing remaining paths.
   */
  externalTakeRouteSelectionMode?: ExternalTakeRouteSelectionMode;
  /**
   * Disabled-by-default escape hatch for hybrid maximize_profit discovery when
   * collateral->quote direct DEX execution is viable but native gas cannot be
   * quoted into the pool quote token. When enabled, fallback approval uses only
   * native gas caps and rejects quote-denominated policy fields at runtime.
   */
  hybridGasQuoteFailureFallbackMode?: HybridGasQuoteFailureFallbackMode;
  /**
   * Controls whether discovered external takes may fall back to public RPC
   * submission, or must use private RPC / relay write transport.
   */
  externalTakeTransportPolicy?: ExternalTakeTransportPolicy;
  /**
   * Optional startup preflight that checks enabled route contracts have code
   * and router taker registry entries match configured taker addresses.
   */
  validateRouteDeployments?: boolean;
  /**
   * Maximum direct DEX quote probes per liquidation candidate. Only applies
   * when discovery.defaults.take.liquiditySource is a direct DEX route source.
   */
  takeRouteQuoteBudgetPerCandidate?: number;
  /**
   * Opt-in bounded parallel liquidation candidate evaluation. Defaults to 1,
   * which preserves sequential evaluation and execution behavior.
   */
  maxConcurrentCandidateEvaluations?: number;
  /**
   * Maximum successful borrower/candidate decisions for one discovered pool in
   * a single take cycle. A candidate that executes both an external take and a
   * follow-up arbTake counts once. Defaults to 1 so same-pool cascades are
   * retried on the next cycle unless explicitly opted into deeper per-cycle
   * execution. Values above 1 force sequential same-pool candidate evaluation.
   */
  maxExecutionsPerPoolPerRun?: number;
  /**
   * Global cap on concurrent route/API/RPC probes used only when candidate
   * evaluation concurrency is greater than 1.
   */
  maxInFlightRouteProbes?: number;
  /**
   * Direct DEX sources eligible for dynamic route selection. Aggregator sources
   * are selected through allowedCalldataAggregatorProviders.
   */
  allowedLiquiditySources?: LiquiditySource[];
  dexGasOverrides?: LiquiditySourceMap<string>;
}

export interface AutoDiscoverSettlementPolicy
  extends AutoDiscoverActionPolicy {}

export interface AutoDiscoverConfig {
  enabled: boolean;
  take?: boolean | AutoDiscoverTakePolicy;
  settlement?: boolean | AutoDiscoverSettlementPolicy;
  kick?: boolean;
  allowPools?: Address[];
  denyPools?: Address[];
  dryRunNewPools?: boolean;
  hydrateCooldownSec?: number;
  logSkips?: boolean;
}

function normalizeAutoDiscoverActionPolicy<T extends AutoDiscoverActionPolicy>(
  value?: boolean | T
): T | undefined {
  if (!value) {
    return undefined;
  }
  if (value === true) {
    return { enabled: true } as T;
  }
  if (value.enabled === false) {
    return undefined;
  }
  return {
    ...value,
    enabled: value.enabled ?? true,
  };
}

export function getAutoDiscoverTakePolicy(
  autoDiscover?: AutoDiscoverConfig
): AutoDiscoverTakePolicy | undefined {
  return normalizeAutoDiscoverActionPolicy(autoDiscover?.take);
}

export function getAutoDiscoverSettlementPolicy(
  autoDiscover?: AutoDiscoverConfig
): AutoDiscoverSettlementPolicy | undefined {
  return normalizeAutoDiscoverActionPolicy(autoDiscover?.settlement);
}

export function hasExternalTakeSettings(config: TakeSettings): boolean {
  return (
    config.liquiditySource !== undefined &&
    config.marketPriceFactor !== undefined
  );
}

export function hasNonEmptyObject(
  value: Record<string, unknown> | undefined
): value is Record<string, unknown> {
  return value !== undefined && Object.keys(value).length > 0;
}

export interface DiscoveredDefaultsConfig {
  take?: TakeSettings;
  settlement?: SettlementConfig;
}

export interface DiscoveryConfig extends AutoDiscoverConfig {
  defaults?: DiscoveredDefaultsConfig;
}

export interface PoolConfig {
  name?: string;
  address: string;
  kick?: KickSettings;
  take?: TakeSettings;
  collect?: CollectSettings;
  collectBond?: boolean;
  // When `rewards.defaultLpReward` is set at the KeeperConfig level, per-pool
  // entries act as overrides and can omit any field. When there's no
  // default, the per-pool entry must still supply `minAmountQuote` and
  // `minAmountCollateral` — enforced by `resolveCollectLpRewardForPool`.
  collectLpReward?: CollectLpRewardOverride;
  settlement?: SettlementConfig;
  price: PriceOrigin;
  dex?: PoolDexConfig;
}

export interface ManualConfig {
  pools: PoolConfig[];
}

export interface UniswapV3Overrides {
  uniswapV3Router?: string;
  positionManagerAddress?: string;
  quoterAddress?: string;
  quoterV2Address?: string;
  wethAddress?: string;
}

export interface UniversalRouterOverrides {
  universalRouterAddress?: string;
  permit2Address?: string;
  wethAddress?: string;
  poolFactoryAddress?: string;
  defaultFeeTier?: number;
  defaultSlippage?: number;
}

export interface UniswapV3RouterOverrides {
  swapRouter02Address?: string;
  poolFactoryAddress?: string;
  defaultFeeTier?: number;
  candidateFeeTiers?: number[];
  defaultSlippage?: number;
  quoterV2Address?: string;
  wethAddress?: string;
}

export interface CurveRouterOverrides {
  poolConfigs?: {
    [tokenPair: string]: {
      address: string;
      poolType: CurvePoolType;
    };
  };
  wethAddress?: string;
  defaultSlippage?: number;
  /**
   * Optional millisecond delay before submitting Curve direct DEX takes. Leave unset
   * or 0 for the lowest-latency path; set only if a target chain/provider needs
   * extra state propagation time. Values above 60,000ms are rejected because
   * they can stall hot take loops.
   */
  executionDelayMs?: number;
}

export enum TakeWriteTransportMode {
  PUBLIC_RPC = 'public_rpc',
  PRIVATE_RPC = 'private_rpc',
  RELAY = 'relay',
}

export interface TakeWriteRelayConfig {
  url: string;
  sendMethod?: string;
  headers?: Record<string, string>;
  maxBlockNumberOffset?: number;
  requestTimeoutMs?: number;
  receiptTimeoutMs?: number;
}

export interface TakeWriteConfig {
  mode: TakeWriteTransportMode;
  rpcUrl?: string;
  relay?: TakeWriteRelayConfig;
  receiptTimeoutMs?: number;
}

export interface NetworkConfig {
  rpcUrl: string;
  readRpcUrls?: string[];
  subgraph: {
    url: string;
    fallbackUrls?: string[];
  };
  multicall?: {
    address: string;
    block: number;
  };
  tokenAddresses?: { [tokenSymbol: string]: string };
}

export interface SignerConfig {
  keystore: string;
}

export interface RuntimeConfig {
  logLevel: string;
  delayBetweenRuns: number;
  dryRun?: boolean;
}

export interface WritesConfig {
  take?: TakeWriteConfig;
}

export interface OneInchDexConfig {
  routers?: { [chainId: number]: string };
  /** Default 1inch external-take slippage percentage. Defaults to 1.0 when unset. */
  defaultSlippage?: number;
  /**
   * Optional per-chain allowlist for decoded 1inch aggregationExecutor
   * addresses. When omitted, executors are logged but not hard-rejected.
   * Each chain may list up to 64 executor addresses.
   */
  aggregationExecutorAllowlist?: { [chainId: number]: string[] };
  connectorTokens?: Array<string>;
}

export type LifiDexMode = 'canary' | 'production';

export type ChainAddressAllowlist = {
  [chainId: number]: string[];
};

export type ChainTargetSelectorAllowlist = {
  [chainId: number]: {
    [callTarget: string]: string[];
  };
};

interface LifiDexBaseConfig {
  apiBaseUrl?: string;
  apiKeyEnvVar?: string;
  integrator?: string;
  defaultSlippage?: number;
  quoteTimeoutMs?: number;
  quoteFailureCooldownMs?: number;
  quoteFailureThreshold?: number;
  maxPriceImpact?: number;
  feeCostPolicy?: LifiFeeCostPolicy;
  maxQuoteAgeMs?: number;
}

export interface LifiCanaryDexConfig extends LifiDexBaseConfig {
  mode: 'canary';
  allowExchanges?: string[];
  denyExchanges?: string[];
  preferExchanges?: string[];
  allowBroadExchangeFilters?: boolean;
  callTargetAllowlist?: ChainAddressAllowlist;
  approvalSpenderAllowlist?: ChainAddressAllowlist;
  observedSelectorAllowlist?: ChainTargetSelectorAllowlist;
}

export interface LifiConcreteAllowlistProductionDexConfig
  extends LifiDexBaseConfig {
  mode: 'production';
  exchangePolicy?: 'concrete_allowlist';
  allowExchanges: string[];
  denyExchanges?: string[];
  preferExchanges?: string[];
  allowBroadExchangeFilters?: false;
  callTargetAllowlist: ChainAddressAllowlist;
  approvalSpenderAllowlist: ChainAddressAllowlist;
  selectorAllowlist: ChainTargetSelectorAllowlist;
  observedSelectorAllowlist?: ChainTargetSelectorAllowlist;
}

export interface LifiReviewedBroadProductionDexConfig
  extends LifiDexBaseConfig {
  mode: 'production';
  exchangePolicy: Extract<LifiProductionExchangePolicyKind, 'reviewed_broad'>;
  allowExchanges?: never;
  denyExchanges?: string[];
  preferExchanges?: string[];
  allowBroadExchangeFilters?: false;
  callTargetAllowlist: ChainAddressAllowlist;
  approvalSpenderAllowlist: ChainAddressAllowlist;
  selectorAllowlist: ChainTargetSelectorAllowlist;
  observedSelectorAllowlist?: ChainTargetSelectorAllowlist;
}

export type LifiProductionDexConfig =
  | LifiConcreteAllowlistProductionDexConfig
  | LifiReviewedBroadProductionDexConfig;

export type LifiDexConfig = LifiCanaryDexConfig | LifiProductionDexConfig;

/**
 * Sushi same-chain aggregator provider config (Packet 3B). Entirely separate
 * from the removed direct-router surface: validated, allowlisted, fail-closed.
 * Initial production scope is bounded by the Packet 3A proceed artifact;
 * enabling a new chain or route requires a new reviewed evidence artifact
 * before the config/allowlist change.
 */
export interface SushiAggregatorDexConfig {
  mode: 'production';
  apiBaseUrl?: string;
  defaultSlippage?: number;
  quoteTimeoutMs?: number;
  maxQuoteAgeMs?: number;
  maxPriceImpact?: number;
  callTargetAllowlist: ChainAddressAllowlist;
  approvalSpenderAllowlist: ChainAddressAllowlist;
  selectorAllowlist: ChainTargetSelectorAllowlist;
}

export interface UniswapV3DexConfig {
  legacy?: UniswapV3Overrides;
  router?: UniswapV3RouterOverrides;
  universalRouter?: UniversalRouterOverrides;
}

export interface DexConfig {
  oneInch?: OneInchDexConfig;
  lifi?: LifiDexConfig;
  sushiAggregator?: SushiAggregatorDexConfig;
  uniswapV3?: UniswapV3DexConfig;
  curve?: CurveRouterOverrides;
}

export interface TakersConfig {
  router?: string;
  contracts?: Partial<Record<ExternalTakeTakerContractKey, string>>;
}

export interface PricingConfig {
  coinGeckoApiKey?: string;
}

export interface RewardsConfig {
  // Seconds subtracted from the LP-reward subgraph cursor before each query,
  // so late-indexed events that land just below the previous cursor are still
  // re-fetched. Raise on chains where subgraph indexing lag exceeds the
  // default (e.g. heavily congested L2s). The in-memory dedupe set is scoped
  // to this window, so larger values grow per-pool memory roughly linearly
  // with event rate × window. Defaults to 60.
  lpLookbackSeconds?: number;
  // Default LP-reward redemption settings applied to every pool the signer
  // has activity in (including auto-discovered pools), unless a per-pool
  // `collectLpReward` entry overrides it. Setting this enables chain-wide
  // LP reward coverage; omitting it keeps the legacy per-pool-only mode.
  defaultLpReward?: CollectLpRewardSettings;
}

export interface KeeperConfig {
  network: NetworkConfig;
  signer: SignerConfig;
  runtime: RuntimeConfig;
  writes?: WritesConfig;
  ajna: AjnaConfigParams;
  manual: ManualConfig;
  discovery?: DiscoveryConfig;
  dex?: DexConfig;
  takers?: TakersConfig;
  pricing?: PricingConfig;
  rewards?: RewardsConfig;
}

export function getManualPools(
  config: Pick<KeeperConfig, 'manual'>
): PoolConfig[] {
  return config.manual.pools;
}
