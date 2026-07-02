import axios from 'axios';
import 'dotenv/config';
import { BigNumber, Signer, constants, providers, utils } from 'ethers';
import { logger } from '../logging';
import { NonceTracker } from '../nonce';
import { getErrorMessage } from '../utils';

export interface OneInchRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface OneInchTransactionData {
  to: string;
  data: string;
  value?: unknown;
  gas?: string | number | BigNumber;
}

export interface OneInchApiResult {
  success: boolean;
  data?: any;
  dstAmount?: string;
  error?: string;
  retryable?: boolean;
  errorCode?: number | string;
}

export interface OneInchSwapResult {
  success: boolean;
  receipt?: providers.TransactionReceipt;
  error?: string;
}

export interface OneInchSwapParams {
  chainId: number;
  amount: BigNumber;
  tokenIn: string;
  tokenOut: string;
  slippage: number;
  retries?: number;
  retryDelayMs?: number;
}

export interface OneInchSwapDeps {
  signer: Signer;
  getQuote(
    chainId: number,
    amount: BigNumber,
    tokenIn: string,
    tokenOut: string
  ): Promise<OneInchApiResult>;
  getSwapData(
    chainId: number,
    amount: BigNumber,
    tokenIn: string,
    tokenOut: string,
    slippage: number,
    fromAddress: string
  ): Promise<OneInchApiResult>;
  queueTransaction?<T>(
    signer: Signer,
    txFunction: (nonce: number) => Promise<T>
  ): Promise<T>;
  delayMs?(ms: number): Promise<void>;
}

export function getOneInchAxiosOptions(
  params: Record<string, string | number | boolean | undefined>,
  options: OneInchRequestOptions
) {
  return {
    params,
    timeout: options.timeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${process.env.ONEINCH_API_KEY}`,
    },
  };
}

export function validateOneInchApiEnv(): { baseUrl?: string; error?: string } {
  if (!process.env.ONEINCH_API) {
    return { error: 'ONEINCH_API is not configured' };
  }
  if (!process.env.ONEINCH_API_KEY) {
    return { error: 'ONEINCH_API_KEY is not configured' };
  }
  return { baseUrl: process.env.ONEINCH_API };
}

export function normalizeOneInchUintAmount(
  value: unknown,
  fieldName: string
): { value?: string; error?: string } {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return {
      error: `1inch ${fieldName} is not a decimal uint string`,
    };
  }

  try {
    const parsed = BigNumber.from(value);
    if (parsed.gt(constants.MaxUint256)) {
      return {
        error: `1inch ${fieldName} exceeds uint256`,
      };
    }
    return { value: parsed.toString() };
  } catch (error) {
    return {
      error: `1inch ${fieldName} is invalid: ${getErrorMessage(error)}`,
    };
  }
}

export function normalizeAddressForComparison(
  value: string
): string | undefined {
  try {
    return utils.getAddress(value).toLowerCase();
  } catch {
    return undefined;
  }
}

export function parseOneInchTxValue(value: unknown): {
  value?: BigNumber;
  error?: string;
} {
  if (value === undefined || value === null || value === '') {
    return { value: constants.Zero };
  }
  if (BigNumber.isBigNumber(value)) {
    if (value.lt(0)) {
      return {
        error: '1inch tx.value must be a non-negative uint',
      };
    }
    if (value.gt(constants.MaxUint256)) {
      return {
        error: '1inch tx.value exceeds uint256',
      };
    }
    return { value };
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      return {
        error: '1inch tx.value must be a non-negative safe integer',
      };
    }
    return { value: BigNumber.from(value) };
  }
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    return {
      error: '1inch tx.value must be a decimal uint string',
    };
  }
  try {
    const parsed = BigNumber.from(value);
    if (parsed.gt(constants.MaxUint256)) {
      return {
        error: '1inch tx.value exceeds uint256',
      };
    }
    return { value: parsed };
  } catch (error) {
    return {
      error: `1inch tx.value is invalid: ${getErrorMessage(error)}`,
    };
  }
}

export function validateZeroOneInchTxValue(value: unknown): string | undefined {
  const parsed = parseOneInchTxValue(value);
  if (parsed.error) {
    return parsed.error;
  }
  if (parsed.value && !parsed.value.eq(0)) {
    return `unexpected non-zero 1inch tx.value ${parsed.value.toString()} for ERC20 swap`;
  }
  return undefined;
}

export function getOneInchErrorMessage(error: Error | any): string {
  return error.response?.data?.description || error.message;
}

export function getOneInchErrorCode(
  error: Error | any
): number | string | undefined {
  if (error.response?.status !== undefined) {
    return error.response.status;
  }
  return error.code;
}

export function isRetryableOneInchError(error: Error | any): boolean {
  const status = error.response?.status;
  const code = error.code;
  return (
    status === 429 ||
    status === undefined ||
    status >= 500 ||
    code === 'ECONNABORTED' ||
    code === 'ETIMEDOUT'
  );
}

async function defaultDelayMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function executeOneInchSwap(
  deps: OneInchSwapDeps,
  params: OneInchSwapParams
): Promise<OneInchSwapResult> {
  const apiEnv = validateOneInchApiEnv();
  if (!apiEnv.baseUrl) {
    logger.error(apiEnv.error);
    return { success: false, error: apiEnv.error };
  }

  const fromAddress = await deps.signer.getAddress();

  if (params.slippage < 0 || params.slippage > 100) {
    logger.error('Slippage must be between 0 and 100');
    return { success: false, error: 'Slippage must be between 0 and 100' };
  }

  const quoteResult = await deps.getQuote(
    params.chainId,
    params.amount,
    params.tokenIn,
    params.tokenOut
  );
  if (!quoteResult.success) {
    return { success: false, error: quoteResult.error };
  }
  logger.info(
    `1inch quote: ${params.amount.toString()} ${params.tokenIn} -> ${quoteResult.dstAmount} ${params.tokenOut}`
  );

  const retries = params.retries ?? 3;
  const retryDelayMs = params.retryDelayMs ?? 2000;
  const delayMs = deps.delayMs ?? defaultDelayMs;
  const queueTransaction =
    deps.queueTransaction ?? NonceTracker.queueTransaction;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const swapDataResult = await deps.getSwapData(
        params.chainId,
        params.amount,
        params.tokenIn,
        params.tokenOut,
        params.slippage,
        fromAddress
      );
      if (!swapDataResult.success) {
        if (swapDataResult.retryable && attempt < retries) {
          const waitTime = retryDelayMs * Math.pow(2, attempt - 1);
          logger.warn(`Attempt (${attempt}/${retries}) after ${waitTime}ms`);
          await delayMs(waitTime);
          continue;
        }
        return { success: false, error: swapDataResult.error };
      }

      const txFrom1inch = swapDataResult.data!;
      logger.debug(`Transaction from 1inch: ${JSON.stringify(txFrom1inch)}`);
      const parsedValue = parseOneInchTxValue(txFrom1inch.value);
      if (parsedValue.error) {
        return {
          success: false,
          error: parsedValue.error,
        };
      }
      const txValue = parsedValue.value ?? constants.Zero;
      if (!txValue.eq(0)) {
        return {
          success: false,
          error: `unexpected non-zero 1inch tx.value ${txValue.toString()} for ERC20 swap`,
        };
      }

      const tx = {
        to: txFrom1inch.to,
        data: txFrom1inch.data,
        value: txValue,
        gasLimit: txFrom1inch.gas ? BigNumber.from(txFrom1inch.gas) : undefined,
      };

      const provider = deps.signer.provider as providers.Provider;
      try {
        const gasEstimate = await provider.estimateGas({
          to: tx.to,
          data: tx.data,
          value: tx.value,
          from: fromAddress,
        });
        tx.gasLimit = gasEstimate.add(gasEstimate.div(10));
      } catch (gasError) {
        logger.error(`Failed to estimate gas: ${gasError}`);
        return {
          success: false,
          error: `Gas estimation failed: ${gasError}`,
        };
      }

      const receipt = await queueTransaction<providers.TransactionReceipt>(
        deps.signer,
        async (nonce: number) => {
          const txResponse = await deps.signer.sendTransaction({
            ...tx,
            nonce,
          });
          return await txResponse.wait();
        }
      );

      logger.info(
        `1inch swap successful: ${params.amount.toString()} ${params.tokenIn} -> ${params.tokenOut} | Tx Hash: ${receipt.transactionHash}`
      );
      return { success: true, receipt };
    } catch (error: Error | any) {
      const errorMsg = error.response?.data?.description || error.message;
      const status = error.response?.status || 500;
      if (status === 429 && attempt < retries) {
        const waitTime = retryDelayMs * Math.pow(2, attempt - 1);
        logger.warn(`Attempt (${attempt}/${retries}) after ${waitTime}ms`);
        await delayMs(waitTime);
        continue;
      }
      logger.error(`Failed to swap with 1inch: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  }

  return { success: false, error: 'Max retries reached for 1inch swap' };
}
