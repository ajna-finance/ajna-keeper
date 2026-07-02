import 'dotenv/config';
import { BigNumber, Signer, providers } from 'ethers';
import { logger } from '../logging';
import { NonceTracker } from '../nonce';
import { parseOneInchUint } from './oneinch-uint';
import type { OneInchUintParseResult } from './oneinch-uint';

export interface OneInchRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ValidatedOneInchTransaction {
  to: string;
  data: string;
  // Always zero: ERC20 swaps must not carry native value. Enforced by
  // normalizeOneInchTransactionData and re-asserted before sending.
  value: BigNumber;
}

export interface OneInchFailureResult {
  success: false;
  data?: undefined;
  dstAmount?: string;
  error: string;
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
  data: ValidatedOneInchTransaction;
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

type ValidationResult<T> =
  | { success: true; value: T }
  | { success: false; error: string };

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

export type OneInchApiEnv =
  | { baseUrl: string; error?: undefined }
  | { baseUrl?: undefined; error: string };

export function validateOneInchApiEnv(): OneInchApiEnv {
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
): ValidationResult<string> {
  // 1inch serializes canonical decimals, but zero-padded strings were
  // historically accepted (BigNumber.from('0123') → 123); strip the padding
  // rather than failing the whole quote.
  const canonicalValue =
    typeof value === 'string' && /^\d+$/.test(value)
      ? value.replace(/^0+(?=\d)/, '')
      : value;
  const parsed = parseOneInchUint(canonicalValue, {
    fieldName: `1inch ${fieldName}`,
    requireString: true,
    invalidStringError: `1inch ${fieldName} is not a decimal uint string`,
  });
  if (!parsed.success) {
    return parsed;
  }
  return { success: true, value: parsed.value.toString() };
}

export function normalizeOneInchTransactionData(value: unknown):
  | {
      success: true;
      value: ValidatedOneInchTransaction;
    }
  | {
      success: false;
      error: string;
    } {
  if (!value || typeof value !== 'object') {
    return {
      success: false,
      error: 'No valid transaction received from 1inch',
    };
  }

  const tx = value as {
    to?: unknown;
    data?: unknown;
    value?: unknown;
  };
  if (
    typeof tx.to !== 'string' ||
    tx.to.length === 0 ||
    typeof tx.data !== 'string' ||
    tx.data.length === 0
  ) {
    return {
      success: false,
      error: 'No valid transaction received from 1inch',
    };
  }

  const parsedValue = parseOneInchTxValue(tx.value);
  if (!parsedValue.success) {
    return parsedValue;
  }
  if (!parsedValue.value.eq(0)) {
    return {
      success: false,
      error: `unexpected non-zero 1inch tx.value ${parsedValue.value.toString()} for ERC20 swap`,
    };
  }

  const normalized: ValidatedOneInchTransaction = {
    to: tx.to,
    data: tx.data,
    value: parsedValue.value,
  };

  return { success: true, value: normalized };
}

function parseOneInchTxValue(value: unknown): OneInchUintParseResult {
  return parseOneInchUint(value, {
    fieldName: '1inch tx.value',
    emptyAsZero: true,
  });
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
  return typed.response?.data?.description || typed.message || String(error);
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

      const txFrom1inch = swapDataResult.data;
      logger.debug(`Transaction from 1inch: ${JSON.stringify(txFrom1inch)}`);

      if (!txFrom1inch.value.isZero()) {
        const error = `unexpected non-zero 1inch tx.value ${txFrom1inch.value.toString()} for ERC20 swap`;
        logger.error(error);
        return { success: false, error };
      }

      const tx = {
        to: txFrom1inch.to,
        data: txFrom1inch.data,
        value: txFrom1inch.value,
        gasLimit: undefined as BigNumber | undefined,
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
