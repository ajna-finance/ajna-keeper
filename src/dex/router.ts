import axios from 'axios';
import 'dotenv/config';
import { BigNumber, Contract, Signer, providers } from 'ethers';
import ERC20_ABI from '../abis/erc20.abi.json';
import { approveErc20, getAllowanceOfErc20, getDecimalsErc20 } from '../erc20';
import { logger } from '../logging';
import { swapToWeth } from './uniswap';
import { tokenChangeDecimals } from '../utils';
import { swapWithUniversalRouter } from './universal-router';
import { swapWithCurveRouter } from './curve-router';
import {
  executeOneInchSwap,
  getOneInchAxiosOptions,
  getOneInchErrorCode,
  getOneInchErrorMessage,
  isRetryableOneInchError,
  normalizeAddressForComparison,
  normalizeOneInchTransactionData,
  normalizeOneInchUintAmount,
  validateOneInchApiEnv,
  validateZeroOneInchTxValue,
} from './oneinch';
import type {
  OneInchQuoteResult,
  OneInchRequestOptions,
  OneInchSwapDataResult,
} from './oneinch';
export type {
  OneInchApiResult,
  OneInchQuoteResult,
  OneInchRequestOptions,
  OneInchSwapDataResult,
} from './oneinch';
import {
  CurvePoolType,
  CurveRouterOverrides,
  DEFAULT_FEE_TIER_BY_SOURCE,
  LiquiditySource,
  PostAuctionDex,
} from '../config';

export class DexRouter {
  private signer: Signer;
  private oneInchRouters: { [chainId: number]: string };
  private connectorTokens: string;
  private tokenAddresses: { [symbol: string]: string }; // CURVE INTEGRATION: Added for symbol lookup

  constructor(
    signer: Signer,
    options: {
      oneInchRouters?: { [chainId: number]: string };
      connectorTokens?: Array<string>;
      tokenAddresses?: { [symbol: string]: string }; // CURVE INTEGRATION: Added tokenAddresses
    } = {}
  ) {
    if (!signer) logger.error('Signer is required');
    const provider = signer.provider;
    if (!provider) logger.error('No provider available');
    this.signer = signer;
    this.oneInchRouters = options.oneInchRouters || {};
    this.connectorTokens = options.connectorTokens
      ? options.connectorTokens.join(',')
      : '';
    this.tokenAddresses = options.tokenAddresses || {}; // CURVE INTEGRATION: Store tokenAddresses
  }

  public getRouter(chainId: number): string | undefined {
    return this.oneInchRouters[chainId];
  }

  public async getQuoteFromOneInch(
    chainId: number,
    amount: BigNumber,
    tokenIn: string,
    tokenOut: string,
    options: OneInchRequestOptions = {}
  ): Promise<OneInchQuoteResult> {
    const apiEnv = validateOneInchApiEnv();
    if (!apiEnv.baseUrl) {
      return {
        success: false,
        error: apiEnv.error,
        retryable: false,
        errorCode: 'missing_oneinch_env',
      };
    }
    const url = `${apiEnv.baseUrl}/${chainId}/quote`;

    const params: {
      fromTokenAddress: string;
      toTokenAddress: string;
      amount: string;
      connectorTokens?: string;
    } = {
      fromTokenAddress: tokenIn,
      toTokenAddress: tokenOut,
      amount: amount.toString(),
    };

    if (this.connectorTokens.length > 0) {
      params['connectorTokens'] = this.connectorTokens;
    }

    logger.debug(
      `Sending these parameters to 1inch get quote: ${JSON.stringify(params)}`
    );

    try {
      const response = await axios.get(
        url,
        getOneInchAxiosOptions(params, options)
      );
      const normalizedDstAmount = normalizeOneInchUintAmount(
        response.data.dstAmount,
        'dstAmount'
      );
      if (!normalizedDstAmount.value) {
        logger.error(normalizedDstAmount.error);
        return {
          success: false,
          error: normalizedDstAmount.error,
          retryable: true,
          errorCode: 'invalid_response',
        };
      }

      logger.debug(
        `1inch quote: ${amount} ${tokenIn} → ${normalizedDstAmount.value} ${tokenOut}`
      );

      return { success: true, dstAmount: normalizedDstAmount.value };
    } catch (error: unknown) {
      const errorMsg = getOneInchErrorMessage(error);
      logger.error(`Failed to get quote from 1inch: ${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
        retryable: isRetryableOneInchError(error),
        errorCode: getOneInchErrorCode(error),
      };
    }
  }

  public async getSwapDataFromOneInch(
    chainId: number,
    amount: BigNumber,
    tokenIn: string,
    tokenOut: string,
    slippage: number,
    fromAddress: string,
    usePatching: boolean = false,
    options: OneInchRequestOptions = {}
  ): Promise<OneInchSwapDataResult> {
    const apiEnv = validateOneInchApiEnv();
    if (!apiEnv.baseUrl) {
      return {
        success: false,
        error: apiEnv.error,
        retryable: false,
        errorCode: 'missing_oneinch_env',
      };
    }
    const url = `${apiEnv.baseUrl}/${chainId}/swap`;
    const params: {
      fromTokenAddress: string;
      toTokenAddress: string;
      amount: string;
      fromAddress: string;
      slippage: number;
      connectorTokens?: string;
      usePatching?: boolean;
      disableEstimate?: boolean;
    } = {
      fromTokenAddress: tokenIn,
      toTokenAddress: tokenOut,
      amount: amount.toString(),
      fromAddress,
      slippage,
    };

    if (this.connectorTokens.length > 0) {
      params['connectorTokens'] = this.connectorTokens;
    }
    if (usePatching) {
      params['usePatching'] = true; // allow mutations to the swap data
      params['disableEstimate'] = true; // skip API balance check (collateral will come mid-transaction)
    }

    logger.debug(
      `Sending these parameters to 1inch: ${JSON.stringify(params)}`
    );

    try {
      const response = await axios.get(
        url,
        getOneInchAxiosOptions(params, options)
      );

      const normalizedTransaction = normalizeOneInchTransactionData(
        response.data.tx
      );
      if (!normalizedTransaction.value) {
        logger.error(normalizedTransaction.error);
        return {
          success: false,
          error: normalizedTransaction.error,
          retryable: true,
          errorCode: 'invalid_response',
        };
      }

      const expectedRouter = this.oneInchRouters[chainId];
      const normalizedExpectedRouter =
        expectedRouter !== undefined
          ? normalizeAddressForComparison(expectedRouter)
          : undefined;
      const normalizedTxTarget = normalizeAddressForComparison(
        normalizedTransaction.value.to
      );
      if (!normalizedExpectedRouter || !normalizedTxTarget) {
        return {
          success: false,
          error: `1inch router validation failed for chain ${chainId}`,
          retryable: false,
          errorCode: 'router_validation',
        };
      }
      if (normalizedTxTarget !== normalizedExpectedRouter) {
        return {
          success: false,
          error: `1inch tx target ${normalizedTransaction.value.to} does not match configured router ${expectedRouter}`,
          retryable: true,
          errorCode: 'invalid_response',
        };
      }
      const valueValidationError = validateZeroOneInchTxValue(
        normalizedTransaction.value.value
      );
      if (valueValidationError) {
        return {
          success: false,
          error: valueValidationError,
          retryable: true,
          errorCode: 'invalid_response',
        };
      }
      const normalizedDstAmount =
        response.data.dstAmount !== undefined
          ? normalizeOneInchUintAmount(response.data.dstAmount, 'dstAmount')
          : {};
      if (response.data.dstAmount !== undefined && !normalizedDstAmount.value) {
        return {
          success: false,
          error: normalizedDstAmount.error,
          retryable: true,
          errorCode: 'invalid_response',
        };
      }

      return {
        success: true,
        data: normalizedTransaction.value,
        dstAmount: normalizedDstAmount.value,
      };
    } catch (error: unknown) {
      const errorMsg = getOneInchErrorMessage(error);
      return {
        success: false,
        error: errorMsg,
        retryable: isRetryableOneInchError(error),
        errorCode: getOneInchErrorCode(error),
      };
    }
  }

  // CURVE INTEGRATION: Simplified helper to find pool config by token pair
  public getCurvePoolForTokenPair(
    tokenIn: string,
    tokenOut: string,
    poolConfigs: any
  ): { address: string; poolType: CurvePoolType } | undefined {
    // Convert addresses to symbol names for lookup
    const tokenInSymbol = this.getTokenSymbolFromAddress(tokenIn);
    const tokenOutSymbol = this.getTokenSymbolFromAddress(tokenOut);

    if (!tokenInSymbol || !tokenOutSymbol) {
      logger.debug(
        `Could not resolve token symbols for ${tokenIn}/${tokenOut}`
      );
      return undefined;
    }

    // Try both directions for the token pair
    const key1 = `${tokenInSymbol}-${tokenOutSymbol}`;
    const key2 = `${tokenOutSymbol}-${tokenInSymbol}`;

    const poolConfig = poolConfigs[key1] || poolConfigs[key2];

    if (poolConfig) {
      logger.debug(
        `Found Curve pool for ${tokenInSymbol}/${tokenOutSymbol}: ${poolConfig.address}`
      );
      return poolConfig;
    }

    logger.debug(
      `No Curve pool configured for ${tokenInSymbol}/${tokenOutSymbol}`
    );
    return undefined;
  }

  // CURVE INTEGRATION: Helper to convert address to symbol using tokenAddresses from config
  public getTokenSymbolFromAddress(address: string): string | undefined {
    for (const [symbol, tokenAddress] of Object.entries(this.tokenAddresses)) {
      if (tokenAddress.toString().toLowerCase() === address.toLowerCase()) {
        return symbol;
      }
    }
    return undefined;
  }

  // CURVE INTEGRATION: Updated Curve swap method with simplified lookup
  private async swapWithCurve(
    chainId: number,
    amount: BigNumber,
    tokenIn: string,
    tokenOut: string,
    to: string,
    slippage: number,
    feeAmount?: number,
    curveSettings?: any
  ): Promise<{ success: boolean; error?: string }> {
    try {
      if (!curveSettings) {
        return {
          success: false,
          error: 'Curve configuration not found',
        };
      }

      if (!curveSettings.poolConfigs) {
        return {
          success: false,
          error: 'Curve pool configurations not found',
        };
      }

      // SIMPLIFIED: Use the new token pair lookup
      const poolConfig = this.getCurvePoolForTokenPair(
        tokenIn,
        tokenOut,
        curveSettings.poolConfigs
      );

      if (!poolConfig) {
        return {
          success: false,
          error: `No Curve pool configured for ${tokenIn}/${tokenOut}`,
        };
      }

      const result = await swapWithCurveRouter(
        this.signer,
        tokenIn,
        amount,
        tokenOut,
        slippage,
        poolConfig.address,
        poolConfig.poolType,
        curveSettings.defaultSlippage
      );

      return result;
    } catch (error) {
      return {
        success: false,
        error: `Curve swap failed: ${error}`,
      };
    }
  }

  public async swap(
    chainId: number,
    amount: BigNumber,
    tokenIn: string,
    tokenOut: string,
    to: string,
    dexProvider: PostAuctionDex,
    slippage: number = 1,
    feeAmount: number = DEFAULT_FEE_TIER_BY_SOURCE[LiquiditySource.UNISWAPV3],
    combinedSettings?: {
      uniswap?: {
        wethAddress?: string;
        uniswapV3Router?: string;
        universalRouterAddress?: string;
        permit2Address?: string;
        poolFactoryAddress?: string;
        quoterV2Address?: string;
        defaultFeeTier?: number;
        defaultSlippage?: number;
      };
      curve?: CurveRouterOverrides;
    }
  ): Promise<{ success: boolean; error?: string }> {
    if (!chainId || !amount || !tokenIn || !tokenOut || !to) {
      logger.error('Invalid parameters provided to swap');
      return { success: false, error: 'Invalid parameters provided to swap' };
    }
    if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) {
      logger.info(`Token ${tokenIn} is already ${tokenOut}, no swap necessary`);
      return { success: true };
    }

    const provider = this.signer.provider as providers.Provider;
    const fromAddress = await this.signer.getAddress();

    // Convert amount from WAD (18 decimals) to token's native decimals
    const decimals = await getDecimalsErc20(this.signer, tokenIn);
    const adjustedAmount = tokenChangeDecimals(amount, 18, decimals);
    logger.debug(
      `Converted ${amount.toString()} (WAD) to ${adjustedAmount.toString()} (${decimals} decimals) for token ${tokenIn}`
    );

    if (adjustedAmount.isZero()) {
      logger.debug(
        `Skipping swap: dust amount rounds to zero in ${decimals}-decimal token ${tokenIn}`
      );
      return {
        success: false,
        error: `Amount too small for ${tokenIn} (rounds to zero)`,
      };
    }

    const erc20 = new Contract(tokenIn, ERC20_ABI, provider);
    const balance = await erc20.balanceOf(fromAddress);

    if (balance.lt(adjustedAmount)) {
      logger.error(
        `Insufficient balance for ${tokenIn}: ${balance.toString()} < ${adjustedAmount.toString()}`
      );
      return { success: false, error: `Insufficient balance for ${tokenIn}` };
    }

    switch (dexProvider) {
      case PostAuctionDex.ONEINCH:
        const oneInchRouter = this.oneInchRouters[chainId];
        if (!oneInchRouter) {
          logger.error(`No 1inch router defined for chainId ${chainId}`);
          return {
            success: false,
            error: `No 1inch router defined for chainId ${chainId}`,
          };
        }

        const currentAllowance = await getAllowanceOfErc20(
          this.signer,
          tokenIn,
          oneInchRouter
        );
        logger.debug(
          `Current allowance: ${currentAllowance.toString()}, Amount: ${adjustedAmount.toString()}`
        );
        if (currentAllowance.lt(adjustedAmount)) {
          try {
            logger.debug(
              `Approving 1inch router ${oneInchRouter} for token: ${tokenIn}`
            );
            await approveErc20(
              this.signer,
              tokenIn,
              oneInchRouter,
              adjustedAmount
            );
            logger.info(`Approval successful for token ${tokenIn}`);
          } catch (error) {
            logger.error(
              `Failed to approve token ${tokenIn} for 1inch: ${error}`
            );
            return { success: false, error: `Approval failed: ${error}` };
          }
        }

        const result = await executeOneInchSwap(
          {
            signer: this.signer,
            getQuote: this.getQuoteFromOneInch.bind(this),
            getSwapData: this.getSwapDataFromOneInch.bind(this),
          },
          {
            chainId,
            amount: adjustedAmount,
            tokenIn,
            tokenOut,
            slippage,
          }
        );
        return result;

      case PostAuctionDex.UNISWAP_V3:
        if (
          combinedSettings?.uniswap?.universalRouterAddress &&
          combinedSettings?.uniswap?.permit2Address &&
          combinedSettings?.uniswap?.poolFactoryAddress
        ) {
          try {
            logger.info(`Using Universal Router for swap`);
            const result = await swapWithUniversalRouter(
              this.signer,
              tokenIn,
              adjustedAmount,
              tokenOut,
              slippage * 100, // Convert percentage to basis points
              combinedSettings.uniswap.universalRouterAddress,
              combinedSettings.uniswap.permit2Address,
              combinedSettings.uniswap.defaultFeeTier || feeAmount,
              combinedSettings.uniswap.poolFactoryAddress,
              combinedSettings.uniswap.quoterV2Address
            );
            if (!result.success) {
              const error = result.error;
              logger.error(
                `Universal Router swap failed for token: ${tokenIn}: ${error}`
              );
              return { success: false, error };
            }
            logger.info(
              `Universal Router swap successful: ${adjustedAmount.toString()} ${tokenIn} -> ${tokenOut}`
            );
            return { success: true };
          } catch (error) {
            logger.error(
              `Universal Router swap failed for token: ${tokenIn}: ${error}`
            );
            return {
              success: false,
              error: `Universal Router swap failed: ${error}`,
            };
          }
        } else {
          try {
            await swapToWeth(
              this.signer,
              tokenIn,
              adjustedAmount,
              feeAmount,
              slippage,
              combinedSettings?.uniswap
            );
            logger.info(
              `Uniswap V3 swap successful: ${adjustedAmount.toString()} ${tokenIn} -> ${tokenOut}`
            );
            return { success: true };
          } catch (error) {
            logger.error(
              `Uniswap V3 swap failed for token: ${tokenIn}: ${error}`
            );
            return { success: false, error: `Uniswap swap failed: ${error}` };
          }
        }

      case PostAuctionDex.CURVE:
        // CURVE INTEGRATION: New case for Curve post-auction swaps
        return await this.swapWithCurve(
          chainId,
          adjustedAmount,
          tokenIn,
          tokenOut,
          to,
          slippage,
          feeAmount,
          combinedSettings?.curve
        );

      default:
        return {
          success: false,
          error: `Unsupported DEX provider: ${dexProvider}`,
        };
    }
  }
}
