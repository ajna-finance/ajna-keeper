// src/dex/providers/curve-quote-provider.ts
// Curve Quote Provider for accurate price discovery during external takes
// FIXED: Uses tokenAddresses mapping for reliable pool discovery

import { ethers, BigNumber, Signer } from 'ethers';
import { logger } from '../../logging';
import { defaultDexContractServices, DexContractServices } from '../contracts';
import {
  CurvePoolSelection,
  CurvePoolSelector,
  CurvePoolSelectorConfig,
  getCurvePoolAbi,
} from '../curve-pool-selection';

interface CurveQuoteConfig extends CurvePoolSelectorConfig {
  defaultSlippage: number;
}

interface QuoteResult {
  success: boolean;
  dstAmount?: BigNumber;
  error?: string;
  gasEstimate?: BigNumber;
  selectedPool?: CurvePoolSelection;
}

interface QuoteDecimals {
  inputDecimals: number;
  outputDecimals: number;
}

/**
 * Curve Quote Provider for External Take Profitability Analysis
 *
 * Uses Curve pool contracts directly for accurate pricing
 * FIXED: Now uses tokenAddresses mapping like DexRouter for reliable pool discovery
 */
export class CurveQuoteProvider {
  private signer: Signer;
  private config: CurveQuoteConfig;
  private contracts: DexContractServices;
  private selector: CurvePoolSelector;
  private isInitialized: boolean = false;

  constructor(
    signer: Signer,
    config: CurveQuoteConfig,
    contracts: DexContractServices = defaultDexContractServices
  ) {
    this.signer = signer;
    this.config = config;
    this.contracts = contracts;
    this.selector = new CurvePoolSelector(signer, config, contracts);
  }

  /**
   * Initialize and validate the quote provider
   */
  async initialize(): Promise<boolean> {
    if (this.isInitialized) {
      return true;
    }

    if (!this.config.poolConfigs || !this.selector.hasPoolConfigs()) {
      logger.warn(`Curve quote provider has no pool configurations`);
      return false;
    }

    // Keep initialization cheap for hot liquidation loops; per-pool RPC
    // validation is deferred to poolExists/quote calls for the selected pair.
    this.isInitialized = true;
    logger.debug(
      `Curve quote provider initialized with ${Object.keys(this.config.poolConfigs).length} configured pools`
    );
    return true;
  }

  /**
   * Check if quote provider is available and ready
   */
  isAvailable(): boolean {
    return this.isInitialized && this.selector.hasPoolConfigs();
  }

  async resolvePoolSelection(
    tokenIn: string,
    tokenOut: string
  ): Promise<CurvePoolSelection | undefined> {
    if (!this.isInitialized) {
      const initialized = await this.initialize();
      if (!initialized) {
        return undefined;
      }
    }

    // Quotes keep the historical fallback scan across all configured pools;
    // swap execution (DexRouter) stays fail-closed on symbol-keyed lookups.
    return await this.selector.resolvePoolSelection(tokenIn, tokenOut, {
      allowFallbackPoolScan: true,
    });
  }

  /**
   * Check if pool exists and tokens are available
   */
  async poolExists(tokenA: string, tokenB: string): Promise<boolean> {
    try {
      const selectedPool = await this.resolvePoolSelection(tokenA, tokenB);
      const exists = selectedPool !== undefined;

      if (selectedPool) {
        logger.debug(
          `Curve pool tokens found: ${tokenA}@${selectedPool.tokenInIndex}, ${tokenB}@${selectedPool.tokenOutIndex}`
        );
      } else {
        logger.debug(`Curve pool tokens NOT found for ${tokenA}/${tokenB}`);
      }

      return exists;
    } catch (error) {
      logger.debug(`Error checking Curve pool existence: ${error}`);
      return false;
    }
  }

  /**
   * Get accurate quote from Curve pool contract
   */
  async getQuote(
    amountIn: BigNumber,
    tokenIn: string,
    tokenOut: string,
    decimals?: QuoteDecimals
  ): Promise<QuoteResult> {
    try {
      if (!this.isInitialized) {
        const initialized = await this.initialize();
        if (!initialized) {
          return { success: false, error: 'Quote provider not available' };
        }
      }

      const selectedPool = await this.resolvePoolSelection(tokenIn, tokenOut);
      if (!selectedPool) {
        return {
          success: false,
          error: `No Curve pool configured for ${tokenIn}/${tokenOut}`,
        };
      }

      const poolContract = this.contracts.makeContract(
        selectedPool.address,
        getCurvePoolAbi(selectedPool.poolType),
        this.signer
      );

      const amountOut: BigNumber = await poolContract.get_dy(
        selectedPool.tokenInIndex,
        selectedPool.tokenOutIndex,
        amountIn
      );

      if (amountOut.isZero()) {
        return { success: false, error: 'Zero output from Curve pool' };
      }

      // Get correct decimals for proper formatting
      const inputDecimals =
        decimals?.inputDecimals ??
        (await this.contracts.getDecimals(this.signer, tokenIn));
      const outputDecimals =
        decimals?.outputDecimals ??
        (await this.contracts.getDecimals(this.signer, tokenOut));

      logger.debug(
        `Curve quote success: ${ethers.utils.formatUnits(amountIn, inputDecimals)} in -> ${ethers.utils.formatUnits(amountOut, outputDecimals)} out`
      );

      return {
        success: true,
        dstAmount: amountOut,
        selectedPool,
        // Note: Curve pools don't provide gas estimates like Uniswap QuoterV2
      };
    } catch (error: any) {
      logger.debug(`Curve quote failed: ${error.message}`);

      // Parse common errors
      if (error.message?.includes('INSUFFICIENT_LIQUIDITY')) {
        return {
          success: false,
          error: 'Insufficient liquidity in Curve pool',
        };
      } else if (error.message?.includes('revert')) {
        return {
          success: false,
          error: `Curve pool reverted: ${error.reason || error.message}`,
        };
      } else {
        return { success: false, error: `Curve quote error: ${error.message}` };
      }
    }
  }

  /**
   * Calculate market price from quote (quote tokens per collateral token)
   */
  async getMarketPrice(
    amountIn: BigNumber,
    tokenIn: string,
    tokenOut: string,
    tokenInDecimals: number,
    tokenOutDecimals: number
  ): Promise<{ success: boolean; price?: number; error?: string }> {
    try {
      const quoteResult = await this.getQuote(amountIn, tokenIn, tokenOut);

      if (!quoteResult.success || !quoteResult.dstAmount) {
        return { success: false, error: quoteResult.error };
      }

      // Calculate price: output tokens per input token
      const inputAmount = Number(
        ethers.utils.formatUnits(amountIn, tokenInDecimals)
      );
      const outputAmount = Number(
        ethers.utils.formatUnits(quoteResult.dstAmount, tokenOutDecimals)
      );

      if (inputAmount <= 0 || outputAmount <= 0) {
        return {
          success: false,
          error: 'Invalid amounts for price calculation',
        };
      }

      const marketPrice = outputAmount / inputAmount;

      logger.debug(
        `Curve market price: 1 ${tokenIn} = ${marketPrice.toFixed(6)} ${tokenOut}`
      );

      return { success: true, price: marketPrice };
    } catch (error: any) {
      return {
        success: false,
        error: `Market price calculation failed: ${error.message}`,
      };
    }
  }

  /**
   * Get configured pool addresses for debugging
   */
  getConfiguredPools(): string[] {
    return this.selector.getConfiguredPools();
  }
}
