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

export interface OneInchFailureResult {
  success: false;
  data?: undefined;
  dstAmount?: string;
  error?: string;
  retryable?: boolean;
  errorCode?: number | string;
}

export interface OneInchQuoteSuccessResult {
  success: true;
  data?: undefined;
  dstAmount: string;
  error?: undefined;
  retryable?: undefined;
  errorCode?: undefined;
}

export interface OneInchSwapDataSuccessResult {
  success: true;
  data: OneInchTransactionData;
  dstAmount?: string;
  error?: undefined;
  retryable?: undefined;
  errorCode?: undefined;
}

export type OneInchQuoteResult =
  | OneInchQuoteSuccessResult
  | OneInchFailureResult;

export type OneInchSwapDataResult =
  | OneInchSwapDataSuccessResult
  | OneInchFailureResult;

export type OneInchApiResult = OneInchQuoteResult | OneInchSwapDataResult;

export type OneInchSwapResult =
  | { success: true; receipt: providers.TransactionReceipt }
  | { success: false; error: string };

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
  ): Promise<OneInchQuoteResult>;
  getSwapData(
    chainId: number,
    amount: BigNumber,
    tokenIn: string,
    tokenOut: string,
    slippage: number,
    fromAddress: string
  ): Promise<OneInchSwapDataResult>;
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

export function normalizeOneInchTransactionData(value: unknown): {
  value?: OneInchTransactionData;
  error?: string;
} {
  if (!value || typeof value !== 'object') {
    return { error: 'No valid transaction received from 1inch' };
  }

  const tx = value as {
    to?: unknown;
    data?: unknown;
    value?: unknown;
    gas?: unknown;
  };
  if (typeof tx.to !== 'string' || typeof tx.data !== 'string') {
    return { error: 'No valid transaction received from 1inch' };
  }

  const normalized: OneInchTransactionData = {
    to: tx.to,
    data: tx.data,
  };
  if (tx.value !== undefined) {
    normalized.value = tx.value;
  }
  if (tx.gas !== undefined) {
    if (
      typeof tx.gas !== 'string' &&
      typeof tx.gas !== 'number' &&
      !BigNumber.isBigNumber(tx.gas)
    ) {
      return { error: '1inch tx.gas must be a string, number, or BigNumber' };
    }
    normalized.gas = tx.gas;
  }

  return { value: normalized };
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

interface OneInchRequestError {
  response?: {
    data?: {
      description?: string;
    };
    status?: number;
  };
  code?: number | string;
  message?: string;
}

function asOneInchRequestError(error: unknown): OneInchRequestError {
  if (error && typeof error === 'object') {
    return error as OneInchRequestError;
  }
  return { message: String(error) };
}

export function getOneInchErrorMessage(error: unknown): string {
  const typed = asOneInchRequestError(error);
  return typed.response?.data?.description ?? typed.message ?? String(error);
}

export function getOneInchErrorCode(
  error: unknown
): number | string | undefined {
  const typed = asOneInchRequestError(error);
  if (typed.response?.status !== undefined) {
    return typed.response.status;
  }
  return typed.code;
}

export function isRetryableOneInchError(error: unknown): boolean {
  const typed = asOneInchRequestError(error);
  const status = typed.response?.status;
  const code = typed.code;
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
    return {
      success: false,
      error: quoteResult.error ?? '1inch quote request failed',
    };
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
        return {
          success: false,
          error: swapDataResult.error ?? '1inch swap data request failed',
        };
      }

      const txFrom1inch = swapDataResult.data;
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
    } catch (error: unknown) {
      const errorMsg = getOneInchErrorMessage(error);
      const status = asOneInchRequestError(error).response?.status ?? 500;
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
