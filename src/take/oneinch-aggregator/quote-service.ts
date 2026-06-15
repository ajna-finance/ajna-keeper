import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber, ethers } from 'ethers';
import { DexRouter, OneInchRequestOptions } from '../../dex/router';
import {
  convertSwapApiResponseToDetails,
  validateOneInchSwapDetailsForAtomicTake,
} from '../../dex/one-inch';
import {
  getCachedTokenDecimals,
  resolveExternalTakeChainId,
} from '../external-take/chain';
import { ApprovedCalldataAggregatorQuote } from '../aggregator-calldata/types';
import { OneInchAggregatorQuoteConfig } from './types';

const ONEINCH_LABEL = '1inch';

export class OneInchAggregatorQuoteError extends Error {
  readonly retryable?: boolean;
  readonly errorCode?: number | string;

  constructor(
    message: string,
    options: { retryable?: boolean; errorCode?: number | string } = {}
  ) {
    super(message);
    this.name = 'OneInchAggregatorQuoteError';
    Object.setPrototypeOf(this, OneInchAggregatorQuoteError.prototype);
    this.retryable = options.retryable;
    this.errorCode = options.errorCode;
  }
}

export function getOneInchAggregatorQuoteFailureMetadata(error: unknown): {
  retryable?: boolean;
  code?: number | string;
} {
  if (error instanceof OneInchAggregatorQuoteError) {
    return {
      retryable: error.retryable,
      code: error.errorCode,
    };
  }
  return {
    retryable: true,
    code: 'exception',
  };
}

export async function resolveOneInchAggregatorChainId(
  config: Pick<OneInchAggregatorQuoteConfig, 'chainId'>,
  signer: Signer
): Promise<number> {
  return resolveExternalTakeChainId(config, signer, ONEINCH_LABEL);
}

export async function getOneInchAggregatorTokenDecimals(params: {
  signer: Signer;
  tokenAddress: string;
  chainId?: number;
  cache?: Map<string, number>;
}): Promise<number> {
  return getCachedTokenDecimals(params);
}

function getOneInchAggregatorRequestOptions(
  config: Pick<
    OneInchAggregatorQuoteConfig,
    'oneInchRequestTimeoutMs' | 'oneInchRequestAbortSignal'
  >
): OneInchRequestOptions {
  return {
    timeoutMs: config.oneInchRequestTimeoutMs,
    ...(config.oneInchRequestAbortSignal
      ? { signal: config.oneInchRequestAbortSignal }
      : {}),
  };
}

function requireOneInchRouter(params: {
  routers?: { [chainId: number]: string };
  chainId: number;
}): string {
  const router = params.routers?.[params.chainId];
  if (!router) {
    throw new OneInchAggregatorQuoteError(
      `missing 1inch router for chain ${params.chainId}`,
      { retryable: false, errorCode: 'missing_router' }
    );
  }
  return router;
}

function normalizeTxValue(value: unknown): string {
  if (value === undefined || value === null || value === '') {
    return '0';
  }
  return BigNumber.from(value).toString();
}

/**
 * Fetches 1inch swap calldata for the calldata-aggregator taker and normalizes
 * it into the shared aggregator quote shape. Raw 1inch responses stay inside
 * this provider boundary.
 */
export async function requestValidatedOneInchAggregatorQuote(params: {
  pool: FungiblePool;
  signer: Signer;
  config: OneInchAggregatorQuoteConfig;
  takerAddress: string;
  chainId: number;
  collateralInTokenDecimals: BigNumber;
}): Promise<ApprovedCalldataAggregatorQuote> {
  const configuredRouter = requireOneInchRouter({
    routers: params.config.oneInchRouters,
    chainId: params.chainId,
  });
  const dexRouter = new DexRouter(params.signer, {
    oneInchRouters: params.config.oneInchRouters ?? {},
    connectorTokens: params.config.connectorTokens ?? [],
  });
  const swapData = await dexRouter.getSwapDataFromOneInch(
    params.chainId,
    params.collateralInTokenDecimals,
    params.pool.collateralAddress,
    params.pool.quoteAddress,
    params.config.oneInchDefaultSlippage ?? 1,
    params.takerAddress,
    true,
    getOneInchAggregatorRequestOptions(params.config)
  );
  if (!swapData.success || !swapData.data) {
    throw new OneInchAggregatorQuoteError(
      swapData.error ?? '1inch swap data request failed',
      {
        retryable: swapData.retryable,
        errorCode: swapData.errorCode,
      }
    );
  }
  if (swapData.dstAmount === undefined) {
    throw new OneInchAggregatorQuoteError(
      '1inch swap data is missing dstAmount',
      { retryable: true, errorCode: 'invalid_response' }
    );
  }

  const swapDetails = convertSwapApiResponseToDetails(swapData.data);
  const validationError = validateOneInchSwapDetailsForAtomicTake(
    swapDetails,
    {
      srcToken: params.pool.collateralAddress,
      dstToken: params.pool.quoteAddress,
      srcReceiver: configuredRouter,
      dstReceiver: params.takerAddress,
      amount: params.collateralInTokenDecimals,
      aggregationExecutors:
        params.config.oneInchAggregationExecutorAllowlist?.[params.chainId],
    }
  );
  if (validationError) {
    throw new OneInchAggregatorQuoteError(validationError, {
      retryable: false,
      errorCode: 'route_validation',
    });
  }
  const callData = swapData.data.data;
  const routeMinOutRaw = BigNumber.from(
    swapDetails.swapDescription.minReturnAmount
  );

  return {
    providerId: 'oneinch',
    quotedAtMs: Date.now(),
    chainId: params.chainId,
    srcToken: params.pool.collateralAddress,
    dstToken: params.pool.quoteAddress,
    dstReceiver: params.takerAddress,
    amountInTokenUnits: params.collateralInTokenDecimals,
    quoteAmountRaw: BigNumber.from(swapData.dstAmount),
    routeMinOutRaw,
    transactionTarget: swapData.data.to,
    approvalSpender: configuredRouter,
    callData,
    selector: ethers.utils.hexDataSlice(callData, 0, 4),
    txValue: normalizeTxValue(swapData.data.value),
    routeSummary: {
      providerId: 'oneinch',
      tool: '1inch',
      feeCosts: [],
    },
  };
}
