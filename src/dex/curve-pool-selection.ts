import { Signer } from 'ethers';
import { CurvePoolType } from '../config';
import { logger } from '../logging';
import { pruneMapToMaxSize } from '../utils';
import { defaultDexContractServices, DexContractServices } from './contracts';

export const CURVE_NATIVE_ETH_ADDRESS =
  '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

const MAX_CURVE_TOKEN_INDEX_PROBES = 16;
const CURVE_POOL_SELECTION_CACHE_TTL_MS = 5 * 60 * 1000;
const CURVE_POOL_SELECTION_NEGATIVE_CACHE_TTL_MS = 30 * 1000;
const MAX_CURVE_POOL_SELECTION_CACHE_ENTRIES = 512;

const STABLESWAP_ABI = [
  'function coins(uint256 i) external view returns (address)',
  'function balances(uint256 i) external view returns (uint256)',
  'function get_dy(int128 i, int128 j, uint256 dx) external view returns (uint256)',
  'function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) external returns (uint256)',
  'function fee() external view returns (uint256)',
];

const CRYPTOSWAP_ABI = [
  'function coins(uint256 i) external view returns (address)',
  'function balances(uint256 i) external view returns (uint256)',
  'function get_dy(uint256 i, uint256 j, uint256 dx) external view returns (uint256)',
  'function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) returns (uint256)',
  'function fee() external view returns (uint256)',
];

export interface CurvePoolConfig {
  address: string;
  poolType: CurvePoolType;
}

export interface CurvePoolSelection {
  address: string;
  poolType: CurvePoolType;
  tokenInIndex: number;
  tokenOutIndex: number;
}

export interface CurvePoolSelectorConfig {
  poolConfigs: Record<string, CurvePoolConfig>;
  // Only needed to map the native-ETH sentinel onto its wrapped form; pure
  // ERC20 flows (e.g. post-auction reward swaps) work without it.
  wethAddress?: string;
  tokenAddresses?: Record<string, string>;
}

export interface CurvePoolResolutionOptions {
  // When true, a missed symbol-keyed lookup falls back to probing every
  // configured pool on-chain and selects the first one holding both tokens.
  // Quote paths opt in (pre-existing behavior); execution paths stay
  // fail-closed so a swap can never route through a pool the operator did
  // not key for the pair.
  allowFallbackPoolScan?: boolean;
}

interface CurvePoolSelectionCacheEntry {
  selection?: CurvePoolSelection;
  expiresAt: number;
}

export function getCurvePoolAbi(poolType: CurvePoolType): string[] {
  switch (poolType) {
    case CurvePoolType.STABLE:
      return STABLESWAP_ABI;
    case CurvePoolType.CRYPTO:
      return CRYPTOSWAP_ABI;
    default:
      throw new Error(`Unsupported Curve pool type: ${String(poolType)}`);
  }
}

export function getCurveTokenSymbolFromAddress(
  address: string,
  tokenAddresses?: Record<string, string>
): string | undefined {
  if (!tokenAddresses) {
    return undefined;
  }

  for (const [symbol, tokenAddress] of Object.entries(tokenAddresses)) {
    // JSON-loaded configs bypass the Record<string, string> type, so coerce
    // stray non-string values instead of throwing on .toLowerCase().
    if (String(tokenAddress).toLowerCase() === address.toLowerCase()) {
      return symbol;
    }
  }
  return undefined;
}

function normalizeCurveLookupToken(tokenAddress: string, wethAddress?: string) {
  return wethAddress &&
    tokenAddress.toLowerCase() === CURVE_NATIVE_ETH_ADDRESS.toLowerCase()
    ? wethAddress
    : tokenAddress;
}

async function discoverCurvePoolTokenIndices(params: {
  poolAddress: string;
  poolType: CurvePoolType;
  tokenIn: string;
  tokenOut: string;
  wethAddress?: string;
  signer: Signer;
  contracts?: DexContractServices;
}): Promise<{ tokenInIndex?: number; tokenOutIndex?: number }> {
  const contracts = params.contracts ?? defaultDexContractServices;
  const tokenInForLookup = normalizeCurveLookupToken(
    params.tokenIn,
    params.wethAddress
  );
  const tokenOutForLookup = normalizeCurveLookupToken(
    params.tokenOut,
    params.wethAddress
  );

  const poolContract = contracts.makeContract(
    params.poolAddress,
    getCurvePoolAbi(params.poolType),
    params.signer
  );

  let tokenInIndex: number | undefined;
  let tokenOutIndex: number | undefined;

  for (let i = 0; i < MAX_CURVE_TOKEN_INDEX_PROBES; i++) {
    try {
      const tokenAddr = await poolContract.coins(i);
      if (tokenAddr.toLowerCase() === tokenInForLookup.toLowerCase()) {
        tokenInIndex = i;
      }
      if (tokenAddr.toLowerCase() === tokenOutForLookup.toLowerCase()) {
        tokenOutIndex = i;
      }
      if (tokenInIndex !== undefined && tokenOutIndex !== undefined) {
        break;
      }
    } catch {
      break;
    }
  }

  return { tokenInIndex, tokenOutIndex };
}

export class CurvePoolSelector {
  private poolSelectionCache = new Map<string, CurvePoolSelectionCacheEntry>();

  constructor(
    private signer: Signer,
    private config: CurvePoolSelectorConfig,
    private contracts: DexContractServices = defaultDexContractServices,
    private nowMs: () => number = Date.now
  ) {}

  hasPoolConfigs(): boolean {
    return Object.keys(this.config.poolConfigs).length > 0;
  }

  getConfiguredPools(): string[] {
    return Object.values(this.config.poolConfigs).map(
      (config) => config.address
    );
  }

  async resolvePoolSelection(
    tokenIn: string,
    tokenOut: string,
    options: CurvePoolResolutionOptions = {}
  ): Promise<CurvePoolSelection | undefined> {
    const allowFallbackPoolScan = options.allowFallbackPoolScan ?? false;
    const cacheKey = this.getPoolSelectionCacheKey(
      tokenIn,
      tokenOut,
      allowFallbackPoolScan
    );
    const cachedSelection = this.getCachedPoolSelection(cacheKey);
    if (cachedSelection.hit) {
      return cachedSelection.selection;
    }

    const selection = await this.findPoolForTokenPair(
      tokenIn,
      tokenOut,
      allowFallbackPoolScan
    );
    this.setCachedPoolSelection(cacheKey, selection);
    return selection;
  }

  private async findPoolForTokenPair(
    tokenA: string,
    tokenB: string,
    allowFallbackPoolScan: boolean
  ): Promise<CurvePoolSelection | undefined> {
    for (const poolConfig of this.getCandidatePoolConfigs(
      tokenA,
      tokenB,
      allowFallbackPoolScan
    )) {
      // One malformed pool entry (e.g. an unrecognized poolType) must not
      // abort the scan for pairs served by other configured pools.
      try {
        const selection = await this.selectConfiguredPool(
          poolConfig,
          tokenA,
          tokenB
        );
        if (selection) {
          return selection;
        }
      } catch (error) {
        logger.debug(
          `Error checking Curve pool ${poolConfig.address} for tokens ${tokenA}/${tokenB}: ${error}`
        );
      }
    }

    return undefined;
  }

  private getCandidatePoolConfigs(
    tokenA: string,
    tokenB: string,
    allowFallbackPoolScan: boolean
  ): CurvePoolConfig[] {
    const prioritizedConfigs: CurvePoolConfig[] = [];
    const tokenASymbol = getCurveTokenSymbolFromAddress(
      tokenA,
      this.config.tokenAddresses
    );
    const tokenBSymbol = getCurveTokenSymbolFromAddress(
      tokenB,
      this.config.tokenAddresses
    );

    if (tokenASymbol && tokenBSymbol) {
      const poolConfig =
        this.config.poolConfigs[`${tokenASymbol}-${tokenBSymbol}`] ??
        this.config.poolConfigs[`${tokenBSymbol}-${tokenASymbol}`];
      if (poolConfig) {
        prioritizedConfigs.push(poolConfig);
      }
    }

    if (!allowFallbackPoolScan) {
      return prioritizedConfigs;
    }

    for (const poolConfig of Object.values(this.config.poolConfigs)) {
      if (
        !prioritizedConfigs.some(
          (candidate) =>
            candidate.address.toLowerCase() ===
              poolConfig.address.toLowerCase() &&
            candidate.poolType === poolConfig.poolType
        )
      ) {
        prioritizedConfigs.push(poolConfig);
      }
    }

    return prioritizedConfigs;
  }

  private async selectConfiguredPool(
    poolConfig: CurvePoolConfig,
    tokenIn: string,
    tokenOut: string
  ): Promise<CurvePoolSelection | undefined> {
    const { tokenInIndex, tokenOutIndex } = await discoverCurvePoolTokenIndices(
      {
        poolAddress: poolConfig.address,
        poolType: poolConfig.poolType,
        tokenIn,
        tokenOut,
        wethAddress: this.config.wethAddress,
        signer: this.signer,
        contracts: this.contracts,
      }
    );

    if (tokenInIndex === undefined || tokenOutIndex === undefined) {
      return undefined;
    }
    // Both tokens can resolve to the same coin slot (e.g. the native-ETH
    // sentinel and WETH both normalize to wethAddress); that is not a
    // swappable pair on this pool.
    if (tokenInIndex === tokenOutIndex) {
      return undefined;
    }

    return {
      address: poolConfig.address,
      poolType: poolConfig.poolType,
      tokenInIndex,
      tokenOutIndex,
    };
  }

  private getPoolSelectionCacheKey(
    tokenIn: string,
    tokenOut: string,
    allowFallbackPoolScan: boolean
  ): string {
    return `${allowFallbackPoolScan ? 'scan' : 'keyed'}:${tokenIn.toLowerCase()}:${tokenOut.toLowerCase()}`;
  }

  private getCachedPoolSelection(cacheKey: string): {
    hit: boolean;
    selection?: CurvePoolSelection;
  } {
    const cached = this.poolSelectionCache.get(cacheKey);
    if (!cached) {
      return { hit: false };
    }
    if (cached.expiresAt <= this.nowMs()) {
      this.poolSelectionCache.delete(cacheKey);
      return { hit: false };
    }
    return { hit: true, selection: cached.selection };
  }

  private setCachedPoolSelection(
    cacheKey: string,
    selection: CurvePoolSelection | undefined
  ): void {
    this.poolSelectionCache.delete(cacheKey);
    this.poolSelectionCache.set(cacheKey, {
      selection,
      expiresAt:
        this.nowMs() +
        (selection
          ? CURVE_POOL_SELECTION_CACHE_TTL_MS
          : CURVE_POOL_SELECTION_NEGATIVE_CACHE_TTL_MS),
    });
    pruneMapToMaxSize(
      this.poolSelectionCache,
      MAX_CURVE_POOL_SELECTION_CACHE_ENTRIES
    );
  }
}
