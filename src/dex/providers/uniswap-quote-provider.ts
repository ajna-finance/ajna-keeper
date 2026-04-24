// src/dex/providers/uniswap-quote-provider.ts
// OFFICIAL UNISWAP APPROACH: Using QuoterV2 contract with callStatic

import { BigNumber, ethers } from 'ethers';
import { logger } from '../../logging';
import { getDecimalsErc20 } from '../../erc20';
import {
  PoolExistenceCache,
  POOL_EXISTS_CACHE_TTL_MS,
  UNINITIALIZED_POOL_CACHE_TTL_MS,
} from './pool-existence-cache';

interface QuoteResult {
  success: boolean;
  dstAmount?: string;
  error?: string;
}

interface QuoteDecimals {
  inputDecimals: number;
  outputDecimals: number;
}

interface UniswapV3Config {
  universalRouterAddress: string;
  poolFactoryAddress: string;
  defaultFeeTier: number;
  wethAddress: string;
  quoterV2Address?: string; // NEW: QuoterV2 address from config
}

// QuoterV2 ABI - the official interface for getting quotes
const QUOTER_V2_ABI = [
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];

const UNISWAP_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
];
const UNISWAP_V3_POOL_ABI = [
  'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
];
/**
 * Official Uniswap V3 quote provider using QuoterV2 contract
 * Uses the configured QuoterV2 address per chain - clean and simple!
 */
export class UniswapV3QuoteProvider {
  private signer: ethers.Signer;
  private config: UniswapV3Config;
  private factoryContract?: ethers.Contract;
  private poolExistenceCache = new PoolExistenceCache();

  constructor(signer: ethers.Signer, config: UniswapV3Config) {
    this.signer = signer;
    this.config = config;
  }

  /**
   * Get a quote using the configured QuoterV2 contract
   * Simple and clean - just uses the address from config
   */
  async getQuote(
    srcAmount: BigNumber,
    srcToken: string,
    dstToken: string,
    feeTier?: number,
    decimals?: QuoteDecimals
  ): Promise<QuoteResult> {
    try {
      const tier = feeTier ?? this.config.defaultFeeTier;

      // Check if QuoterV2 address is configured
      if (!this.config.quoterV2Address) {
        return {
          success: false,
          error: 'QuoterV2 address not configured for this chain',
        };
      }

      // Create QuoterV2 contract instance
      const quoterContract = new ethers.Contract(
        this.config.quoterV2Address,
        QUOTER_V2_ABI,
        this.signer
      );

      // Prepare quote parameters
      const quoteParams = {
        tokenIn: srcToken,
        tokenOut: dstToken,
        amountIn: srcAmount,
        fee: tier,
        sqrtPriceLimitX96: 0, // No price limit
      };

      // Get correct decimals for proper formatting
      const inputDecimals =
        decimals?.inputDecimals ??
        (await getDecimalsErc20(this.signer, srcToken));
      const outputDecimals =
        decimals?.outputDecimals ??
        (await getDecimalsErc20(this.signer, dstToken));
      logger.debug(
        `Getting Uniswap V3 quote using QuoterV2 at ${this.config.quoterV2Address}: ${ethers.utils.formatUnits(srcAmount, inputDecimals)} ${srcToken} -> ${dstToken} (fee: ${tier})`
      );

      // CRITICAL: Use callStatic because QuoterV2 works by reverting with the result
      const result =
        await quoterContract.callStatic.quoteExactInputSingle(quoteParams);

      // QuoterV2 returns: (amountOut, sqrtPriceX96After, initializedTicksCrossed, gasEstimate)
      const [
        amountOut,
        sqrtPriceX96After,
        initializedTicksCrossed,
        gasEstimate,
      ] = result;

      if (amountOut.eq(0)) {
        return {
          success: false,
          error: 'Quote returned zero output amount',
        };
      }

      logger.debug(
        `Uniswap V3 quote result: ${ethers.utils.formatUnits(amountOut, outputDecimals)} ${dstToken} (gas: ${gasEstimate.toString()})`
      );

      return {
        success: true,
        dstAmount: amountOut.toString(),
      };
    } catch (error: any) {
      logger.error(`Uniswap V3 quote failed: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Check if this provider is available (has required configuration)
   */
  isAvailable(): boolean {
    return !!(
      this.config.universalRouterAddress &&
      this.config.poolFactoryAddress &&
      this.config.defaultFeeTier &&
      this.config.wethAddress &&
      this.config.quoterV2Address // NEW: Require QuoterV2 address
    );
  }

  /**
   * Check whether a V3 pool exists for a route before spending quote budget.
   */
  async poolExists(
    tokenA: string,
    tokenB: string,
    feeTier?: number
  ): Promise<boolean> {
    try {
      const fee = feeTier ?? this.config.defaultFeeTier;
      const cached = this.poolExistenceCache.get(tokenA, tokenB, fee);
      if (cached !== undefined) {
        logger.debug(
          `Uniswap V3 pool existence cache hit: ${tokenA}/${tokenB} fee=${fee} exists=${cached}`
        );
        return cached;
      }

      if (!this.factoryContract) {
        this.factoryContract = new ethers.Contract(
          this.config.poolFactoryAddress,
          UNISWAP_FACTORY_ABI,
          this.signer
        );
      }

      const poolAddress = await this.factoryContract.getPool(
        tokenA,
        tokenB,
        fee
      );
      let exists = false;
      if (poolAddress !== ethers.constants.AddressZero) {
        const poolContract = new ethers.Contract(
          poolAddress,
          UNISWAP_V3_POOL_ABI,
          this.signer
        );
        const slot0 = await poolContract.slot0();
        exists = BigNumber.from(slot0.sqrtPriceX96 ?? slot0[0]).gt(0);
      }
      this.poolExistenceCache.set(
        tokenA,
        tokenB,
        fee,
        exists,
        exists || poolAddress === ethers.constants.AddressZero
          ? POOL_EXISTS_CACHE_TTL_MS
          : UNINITIALIZED_POOL_CACHE_TTL_MS
      );

      if (exists) {
        logger.debug(
          `Uniswap V3 initialized pool found: ${tokenA}/${tokenB} fee=${fee} at ${poolAddress}`
        );
      } else if (poolAddress !== ethers.constants.AddressZero) {
        logger.debug(
          `Uniswap V3 pool is not initialized at the current slot0 price: ${tokenA}/${tokenB} fee=${fee} at ${poolAddress}`
        );
      } else {
        logger.debug(
          `Uniswap V3 pool NOT found: ${tokenA}/${tokenB} fee=${fee}`
        );
      }

      return exists;
    } catch (error) {
      logger.debug(`Error checking Uniswap V3 pool existence: ${error}`);
      throw error;
    }
  }

  /**
   * Get the configured QuoterV2 address for debugging
   */
  getQuoterAddress(): string | undefined {
    return this.config.quoterV2Address;
  }
}
