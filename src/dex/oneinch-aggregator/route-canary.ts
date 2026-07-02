import { BigNumber, Wallet, ethers } from 'ethers';
import { DexRouter } from '../router';
import type { OneInchQuoteResult, OneInchSwapDataResult } from '../oneinch';
import {
  convertSwapApiResponseToDetails,
  validateOneInchSwapDetailsForAtomicTake,
} from '../one-inch';
import { convertWadToTokenDecimals, getDecimalsErc20 } from '../../erc20';
import {
  BASE_CADC,
  BASE_CHAIN_ID,
  BASE_ONEINCH_ROUTER,
  BASE_UNISWAP_V3_QUOTER_V2,
  BASE_USDC,
  BASE_WETH,
  DEFAULT_CADC_QUOTE_AMOUNTS_WAD,
  DEFAULT_CADC_SWAP_AMOUNT_WAD,
  DEFAULT_FIXTURE_COLLATERAL_AMOUNT_WAD,
  DEFAULT_UNISWAP_V3_FEE_TIERS,
  DEFAULT_WETH_GAS_QUOTE_AMOUNT_RAW,
  OneInchRouteCanaryEnv,
  normalizeAddressEnv,
  optionalEnv,
  parseAddressListEnv,
  parseAmountListEnv,
  parseFeeTierListEnv,
  parsePositiveIntegerEnv,
  parseSlippageEnv,
  resolveBaseRpcUrl,
  usableSecretEnv,
} from './route-canary-env';

export type OneInchRouteCanaryCheck = {
  label: string;
  success: boolean;
  skipped?: boolean;
  source?: 'oneinch' | 'uniswapV3';
  retryable?: boolean;
  errorCode?: number | string;
  error?: string;
  tokenIn?: string;
  tokenOut?: string;
  amountRaw?: string;
  dstAmountRaw?: string;
  feeTier?: number;
  feeTiers?: number[];
  validationError?: string;
};

export type OneInchRouteCanarySummary = {
  status: 'passed' | 'failed' | 'skipped';
  chainId: number;
  router: string;
  takerAddress?: string;
  checks: OneInchRouteCanaryCheck[];
  failureCount: number;
};

export const QUOTER_V2_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
];

/**
 * Provider-agnostic primitives the orchestration depends on. The production
 * factory wires these to a DexRouter + ethers provider/QuoterV2 contract;
 * tests inject offline stand-ins so the canary never touches the network.
 */
export type OneInchRouteCanaryRuntime = {
  /** Resolve a token's ERC20 decimals (used to scale WAD -> raw amounts). */
  getTokenDecimals: (tokenAddress: string) => Promise<number>;
  getQuote: (params: {
    chainId: number;
    amountRaw: BigNumber;
    tokenIn: string;
    tokenOut: string;
    timeoutMs: number;
  }) => Promise<OneInchQuoteResult>;
  getSwapData: (params: {
    chainId: number;
    amountRaw: BigNumber;
    tokenIn: string;
    tokenOut: string;
    slippage: number;
    takerAddress: string;
    timeoutMs: number;
  }) => Promise<OneInchSwapDataResult>;
  quoteUniswapV3ExactInputSingle: (params: {
    quoterV2Address: string;
    tokenIn: string;
    tokenOut: string;
    amountRaw: BigNumber;
    feeTier: number;
  }) => Promise<BigNumber>;
};

export type OneInchRouteCanaryDeps = {
  /**
   * Build the runtime primitives for a resolved canary run. Defaults to the
   * production factory that constructs a DexRouter + ethers QuoterV2 contract.
   */
  createRuntime?: (params: {
    rpcUrl: string;
    chainId: number;
    oneInchRouterAddress: string;
  }) => OneInchRouteCanaryRuntime;
};

export type RunOneInchRouteCanaryInput = {
  env?: OneInchRouteCanaryEnv;
  deps?: OneInchRouteCanaryDeps;
};

export type RunOneInchRouteCanaryResult = {
  summary: OneInchRouteCanarySummary;
  exitCode: number;
};

function createDefaultRuntime(params: {
  rpcUrl: string;
  chainId: number;
  oneInchRouterAddress: string;
}): OneInchRouteCanaryRuntime {
  const provider = new ethers.providers.JsonRpcProvider(params.rpcUrl);
  const signer = Wallet.createRandom().connect(provider);
  const router = new DexRouter(signer, {
    oneInchRouters: { [params.chainId]: params.oneInchRouterAddress },
  });
  return {
    getTokenDecimals: (tokenAddress) => getDecimalsErc20(signer, tokenAddress),
    getQuote: ({ chainId, amountRaw, tokenIn, tokenOut, timeoutMs }) =>
      router.getQuoteFromOneInch(chainId, amountRaw, tokenIn, tokenOut, {
        timeoutMs,
      }),
    getSwapData: ({
      chainId,
      amountRaw,
      tokenIn,
      tokenOut,
      slippage,
      takerAddress,
      timeoutMs,
    }) =>
      router.getSwapDataFromOneInch(
        chainId,
        amountRaw,
        tokenIn,
        tokenOut,
        slippage,
        takerAddress,
        true,
        { timeoutMs }
      ),
    quoteUniswapV3ExactInputSingle: async ({
      quoterV2Address,
      tokenIn,
      tokenOut,
      amountRaw,
      feeTier,
    }) => {
      const quoter = new ethers.Contract(
        quoterV2Address,
        QUOTER_V2_ABI,
        provider
      );
      const quoted = await quoter.callStatic.quoteExactInputSingle({
        tokenIn,
        tokenOut,
        amountIn: amountRaw,
        fee: feeTier,
        sqrtPriceLimitX96: 0,
      });
      return BigNumber.from(quoted.amountOut ?? quoted[0]);
    },
  };
}

async function tokenAmountFromWad(params: {
  runtime: OneInchRouteCanaryRuntime;
  tokenAddress: string;
  amountWad: string;
}): Promise<BigNumber> {
  const decimals = await params.runtime.getTokenDecimals(params.tokenAddress);
  return convertWadToTokenDecimals(BigNumber.from(params.amountWad), decimals);
}

async function runQuoteCheck(params: {
  runtime: OneInchRouteCanaryRuntime;
  chainId: number;
  label: string;
  tokenIn: string;
  tokenOut: string;
  amountRaw: BigNumber;
  timeoutMs: number;
}): Promise<OneInchRouteCanaryCheck> {
  const result = await params.runtime.getQuote({
    chainId: params.chainId,
    amountRaw: params.amountRaw,
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
    timeoutMs: params.timeoutMs,
  });
  return {
    label: params.label,
    success: result.success,
    source: 'oneinch',
    retryable: result.retryable,
    errorCode: result.errorCode,
    error: result.error,
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
    amountRaw: params.amountRaw.toString(),
    dstAmountRaw: result.dstAmount,
  };
}

async function runSwapDataValidation(params: {
  runtime: OneInchRouteCanaryRuntime;
  chainId: number;
  label: string;
  tokenIn: string;
  tokenOut: string;
  amountRaw: BigNumber;
  slippage: number;
  oneInchRouterAddress: string;
  takerAddress: string;
  timeoutMs: number;
  aggregationExecutors?: string[];
}): Promise<OneInchRouteCanaryCheck> {
  const result = await params.runtime.getSwapData({
    chainId: params.chainId,
    amountRaw: params.amountRaw,
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
    slippage: params.slippage,
    takerAddress: params.takerAddress,
    timeoutMs: params.timeoutMs,
  });
  if (!result.success) {
    return {
      label: params.label,
      success: false,
      source: 'oneinch',
      retryable: result.retryable,
      errorCode: result.errorCode,
      error: result.error,
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      amountRaw: params.amountRaw.toString(),
      dstAmountRaw: result.dstAmount,
    };
  }

  const details = convertSwapApiResponseToDetails(result.data);
  const validationError = validateOneInchSwapDetailsForAtomicTake(details, {
    srcToken: params.tokenIn,
    dstToken: params.tokenOut,
    srcReceiver: params.oneInchRouterAddress,
    dstReceiver: params.takerAddress,
    amount: params.amountRaw,
    aggregationExecutors: params.aggregationExecutors,
  });

  return {
    label: params.label,
    success: validationError === undefined,
    source: 'oneinch',
    validationError,
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
    amountRaw: params.amountRaw.toString(),
    dstAmountRaw: result.dstAmount,
  };
}

async function runUniswapV3FeeTierQuoteChecks(params: {
  runtime: OneInchRouteCanaryRuntime;
  quoterV2Address: string;
  labelPrefix: string;
  tokenIn: string;
  tokenOut: string;
  amountRaw: BigNumber;
  feeTiers: number[];
}): Promise<OneInchRouteCanaryCheck[]> {
  const checks: OneInchRouteCanaryCheck[] = [];
  for (const feeTier of params.feeTiers) {
    try {
      const amountOut = await params.runtime.quoteUniswapV3ExactInputSingle({
        quoterV2Address: params.quoterV2Address,
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        amountRaw: params.amountRaw,
        feeTier,
      });
      checks.push({
        label: `${params.labelPrefix}-fee-${feeTier}`,
        success: amountOut.gt(0),
        source: 'uniswapV3',
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        amountRaw: params.amountRaw.toString(),
        dstAmountRaw: amountOut.toString(),
        feeTier,
        feeTiers: params.feeTiers,
        error: amountOut.gt(0) ? undefined : 'QuoterV2 returned zero output',
      });
    } catch (error) {
      checks.push({
        label: `${params.labelPrefix}-fee-${feeTier}`,
        success: false,
        source: 'uniswapV3',
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        amountRaw: params.amountRaw.toString(),
        feeTier,
        feeTiers: params.feeTiers,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return checks;
}

export async function runOneInchRouteCanary(
  input: RunOneInchRouteCanaryInput = {}
): Promise<RunOneInchRouteCanaryResult> {
  const env = input.env ?? process.env;
  const rpcUrl = resolveBaseRpcUrl(env);
  const missingRpcEnv = !rpcUrl
    ? [
        'AJNA_AGENT_RPC_URL, AJNA_RPC_URL_BASE, BASE_RPC_URL, or ALCHEMY_API_KEY',
      ]
    : [];

  if (missingRpcEnv.length > 0) {
    const skipped: OneInchRouteCanarySummary = {
      status: 'skipped',
      chainId: BASE_CHAIN_ID,
      router: BASE_ONEINCH_ROUTER,
      checks: [
        {
          label: 'canary-env',
          success: false,
          skipped: true,
          error: `Missing required canary env: ${missingRpcEnv.join(', ')}`,
        },
      ],
      failureCount: 0,
    };
    return { summary: skipped, exitCode: 0 };
  }

  const chainId = parsePositiveIntegerEnv(
    env,
    'AJNA_AGENT_ONEINCH_CANARY_CHAIN_ID',
    String(BASE_CHAIN_ID)
  );
  if (chainId !== BASE_CHAIN_ID) {
    throw new Error('The 1inch route canary currently supports Base only');
  }

  const oneInchRouterAddress = normalizeAddressEnv(
    env,
    'AJNA_AGENT_ONEINCH_ROUTER_BASE',
    BASE_ONEINCH_ROUTER
  );
  const cadcAddress = normalizeAddressEnv(
    env,
    'AJNA_AGENT_ONEINCH_CANARY_CADC_ADDRESS',
    BASE_CADC
  );
  const usdcAddress = normalizeAddressEnv(
    env,
    'AJNA_AGENT_ONEINCH_CANARY_USDC_ADDRESS',
    BASE_USDC
  );
  const wethAddress = normalizeAddressEnv(
    env,
    'AJNA_AGENT_ONEINCH_CANARY_WETH_ADDRESS',
    BASE_WETH
  );
  const uniswapQuoterV2Address = normalizeAddressEnv(
    env,
    'AJNA_AGENT_ONEINCH_CANARY_UNISWAP_QUOTER_V2_ADDRESS',
    BASE_UNISWAP_V3_QUOTER_V2
  );
  const takerAddress = optionalEnv(
    env,
    'AJNA_AGENT_ONEINCH_CANARY_TAKER_ADDRESS'
  );
  const oneInchMissingEnv = [
    !optionalEnv(env, 'ONEINCH_API') ? 'ONEINCH_API' : undefined,
    !usableSecretEnv(env, 'ONEINCH_API_KEY') ? 'ONEINCH_API_KEY' : undefined,
    !takerAddress ? 'AJNA_AGENT_ONEINCH_CANARY_TAKER_ADDRESS' : undefined,
  ].filter((value): value is string => value !== undefined);
  const normalizedTakerAddress =
    takerAddress !== undefined
      ? ethers.utils.getAddress(takerAddress)
      : undefined;
  const timeoutMs = parsePositiveIntegerEnv(
    env,
    'AJNA_AGENT_ONEINCH_CANARY_TIMEOUT_MS',
    '5000'
  );
  const slippage = parseSlippageEnv(
    env,
    'AJNA_AGENT_ONEINCH_CANARY_SLIPPAGE',
    '1'
  );

  const runtime = (input.deps?.createRuntime ?? createDefaultRuntime)({
    rpcUrl: rpcUrl!,
    chainId,
    oneInchRouterAddress,
  });

  const checks: OneInchRouteCanaryCheck[] = [];

  const wethGasQuoteAmountRaw = BigNumber.from(
    optionalEnv(
      env,
      'AJNA_AGENT_ONEINCH_CANARY_WETH_GAS_QUOTE_AMOUNT_RAW',
      DEFAULT_WETH_GAS_QUOTE_AMOUNT_RAW
    )
  );
  const uniswapWethUsdcChecks = await runUniswapV3FeeTierQuoteChecks({
    runtime,
    quoterV2Address: uniswapQuoterV2Address,
    labelPrefix: 'UniswapV3-WETH-USDC-gas-conversion-quote',
    tokenIn: wethAddress,
    tokenOut: usdcAddress,
    amountRaw: wethGasQuoteAmountRaw,
    feeTiers: parseFeeTierListEnv(
      env,
      'AJNA_AGENT_ONEINCH_CANARY_UNISWAP_FEE_TIERS',
      DEFAULT_UNISWAP_V3_FEE_TIERS
    ),
  });
  checks.push(...uniswapWethUsdcChecks);

  if (oneInchMissingEnv.length > 0) {
    checks.push({
      label: 'oneinch-canary-env',
      success: true,
      skipped: true,
      source: 'oneinch',
      error: `Skipped 1inch checks; missing env: ${oneInchMissingEnv.join(', ')}`,
    });
  } else {
    const cadcQuoteAmountsWad = parseAmountListEnv(
      env,
      'AJNA_AGENT_ONEINCH_CANARY_CADC_QUOTE_AMOUNTS_WAD',
      DEFAULT_CADC_QUOTE_AMOUNTS_WAD
    );
    for (const amountWad of cadcQuoteAmountsWad) {
      const amountRaw = await tokenAmountFromWad({
        runtime,
        tokenAddress: cadcAddress,
        amountWad,
      });
      checks.push(
        await runQuoteCheck({
          runtime,
          chainId,
          label: `CADC-USDC-quote-${amountWad}`,
          tokenIn: cadcAddress,
          tokenOut: usdcAddress,
          amountRaw,
          timeoutMs,
        })
      );
    }

    checks.push(
      await runQuoteCheck({
        runtime,
        chainId,
        label: 'WETH-USDC-gas-conversion-quote',
        tokenIn: wethAddress,
        tokenOut: usdcAddress,
        amountRaw: wethGasQuoteAmountRaw,
        timeoutMs,
      })
    );

    const fixtureCollateralAddress = optionalEnv(
      env,
      'AJNA_AGENT_ONEINCH_CANARY_FIXTURE_COLLATERAL_ADDRESS'
    );
    const fixtureQuoteAddress = optionalEnv(
      env,
      'AJNA_AGENT_ONEINCH_CANARY_FIXTURE_QUOTE_ADDRESS'
    );
    if (fixtureCollateralAddress && fixtureQuoteAddress) {
      const amountRaw = await tokenAmountFromWad({
        runtime,
        tokenAddress: ethers.utils.getAddress(fixtureCollateralAddress),
        amountWad: optionalEnv(
          env,
          'AJNA_AGENT_ONEINCH_CANARY_FIXTURE_COLLATERAL_AMOUNT_WAD',
          DEFAULT_FIXTURE_COLLATERAL_AMOUNT_WAD
        )!,
      });
      checks.push(
        await runQuoteCheck({
          runtime,
          chainId,
          label: 'fixture-collateral-quote',
          tokenIn: ethers.utils.getAddress(fixtureCollateralAddress),
          tokenOut: ethers.utils.getAddress(fixtureQuoteAddress),
          amountRaw,
          timeoutMs,
        })
      );
    }

    const swapAmountRaw = await tokenAmountFromWad({
      runtime,
      tokenAddress: cadcAddress,
      amountWad: optionalEnv(
        env,
        'AJNA_AGENT_ONEINCH_CANARY_CADC_SWAP_AMOUNT_WAD',
        DEFAULT_CADC_SWAP_AMOUNT_WAD
      )!,
    });
    checks.push(
      await runSwapDataValidation({
        runtime,
        chainId,
        label: 'CADC-USDC-swap-data-validation',
        tokenIn: cadcAddress,
        tokenOut: usdcAddress,
        amountRaw: swapAmountRaw,
        slippage,
        oneInchRouterAddress,
        takerAddress: normalizedTakerAddress!,
        timeoutMs,
        aggregationExecutors: parseAddressListEnv(
          env,
          'AJNA_AGENT_ONEINCH_CANARY_AGGREGATION_EXECUTOR_ALLOWLIST'
        ),
      })
    );
  }

  const requiredChecks = checks.filter(
    (check) => !check.skipped && check.label !== 'fixture-collateral-quote'
  );
  const failureCount = requiredChecks.filter((check) => !check.success).length;
  const summary: OneInchRouteCanarySummary = {
    status: failureCount === 0 ? 'passed' : 'failed',
    chainId,
    router: oneInchRouterAddress,
    takerAddress: normalizedTakerAddress,
    checks,
    failureCount,
  };
  return {
    summary,
    exitCode: failureCount > 0 ? 1 : 0,
  };
}
