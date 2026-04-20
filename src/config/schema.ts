import { Address } from '@ajna-finance/sdk';
import { FeeAmount } from '@uniswap/v3-sdk';

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

export interface KickSettings {
  minDebt: number;
  priceFactor: number;
}

export enum LiquiditySource {
  NONE = 0,
  ONEINCH = 1,
  UNISWAPV3 = 2,
  SUSHISWAP = 3,
  CURVE = 4,
}

export enum CurvePoolType {
  STABLE = 'stable',
  CRYPTO = 'crypto',
}

export interface TakeSettings {
  minCollateral?: number;
  hpbPriceFactor?: number;
  liquiditySource?: LiquiditySource;
  marketPriceFactor?: number;
}

export interface CollectSettings {
  collectLiquidity: boolean;
  collectBonds: boolean;
}

interface DexConfig {
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
  SUSHISWAP = 'sushiswap',
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

interface CollectLpRewardSettings {
  redeemFirst?: TokenToCollect;
  minAmountQuote: number;
  minAmountCollateral: number;
  rewardActionQuote?: RewardAction;
  rewardActionCollateral?: RewardAction;
}

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
  minExpectedProfitQuote?: number;
  takeQuoteBudgetPerRun?: number;
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

export interface PoolConfig {
  name?: string;
  address: string;
  kick?: KickSettings;
  take?: TakeSettings;
  collect?: CollectSettings;
  collectBond?: boolean;
  collectLpReward?: CollectLpRewardSettings;
  settlement?: SettlementConfig;
  price: PriceOrigin;
  dex?: DexConfig;
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
  poolFactoryAddress?: string;
  defaultFeeTier?: number;
  defaultSlippage?: number;
  quoterV2Address?: string;
  wethAddress?: string;
}

export interface SushiswapRouterOverrides {
  swapRouterAddress?: string;
  quoterV2Address?: string;
  factoryAddress?: string;
  defaultFeeTier?: number;
  defaultSlippage?: number;
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

export interface KeeperConfig {
  ethRpcUrl: string;
  takeWriteRpcUrl?: string;
  takeWrite?: TakeWriteConfig;
  readRpcUrls?: string[];
  logLevel: string;
  subgraphUrl: string;
  subgraphFallbackUrls?: string[];
  keeperKeystore: string;
  keeperTaker?: string;
  keeperTakerFactory?: string;
  takerContracts?: {
    [source: string]: string;
  };
  dryRun?: boolean;
  multicallAddress?: string;
  multicallBlock?: number;
  ajna: AjnaConfigParams;
  coinGeckoApiKey?: string;
  pools: PoolConfig[];
  autoDiscover?: AutoDiscoverConfig;
  discoveredDefaults?: DiscoveredDefaultsConfig;
  uniswapOverrides?: UniswapV3Overrides;
  delayBetweenActions: number;
  delayBetweenRuns: number;
  oneInchRouters?: { [chainId: number]: string };
  tokenAddresses?: { [tokenSymbol: string]: string };
  connectorTokens?: Array<string>;
  universalRouterOverrides?: UniversalRouterOverrides;
  sushiswapRouterOverrides?: SushiswapRouterOverrides;
  curveRouterOverrides?: CurveRouterOverrides;
  // Seconds subtracted from the LP-reward subgraph cursor before each query,
  // so late-indexed events that land just below the previous cursor are still
  // re-fetched. Raise on chains where subgraph indexing lag exceeds the
  // default (e.g. heavily congested L2s). The in-memory dedupe set is scoped
  // to this window, so larger values grow per-pool memory roughly linearly
  // with event rate × window. Defaults to 60.
  lpRewardLookbackSeconds?: number;
}
