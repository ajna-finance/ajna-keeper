import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { BigNumber, Wallet, ethers } from 'ethers';
import { DexRouter } from '../src/dex/router';
import {
  convertSwapApiResponseToDetails,
  validateOneInchSwapDetailsForAtomicTake,
} from '../src/dex/one-inch';
import { convertWadToTokenDecimals, getDecimalsErc20 } from '../src/erc20';
import { BASE_ONEINCH_ROUTER } from './no-spend/fixture-constants';

type CanaryCheck = {
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

type CanarySummary = {
  status: 'passed' | 'failed' | 'skipped';
  chainId: number;
  router: string;
  takerAddress?: string;
  checks: CanaryCheck[];
  failureCount: number;
};

const BASE_CHAIN_ID = 8453;
const BASE_CADC = '0x043eb4b75d0805c43d7c834902e335621983cf03';
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const BASE_WETH = '0x4200000000000000000000000000000000000006';
const BASE_UNISWAP_V3_QUOTER_V2 = '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a';

const DEFAULT_CADC_QUOTE_AMOUNTS_WAD = [
  '6750734311152542852',
  '4283573040064348752',
];
const DEFAULT_CADC_SWAP_AMOUNT_WAD = '4283573040064348752';
const DEFAULT_WETH_GAS_QUOTE_AMOUNT_RAW = '1000000000000000';
const DEFAULT_UNISWAP_V3_FEE_TIERS = [3000, 100, 500, 10000];
const QUOTER_V2_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
];

dotenv.config();

function optionalEnv(name: string, fallback?: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? fallback : value;
}

function usableSecretEnv(name: string): string | undefined {
  const value = optionalEnv(name);
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    /^\?+$/.test(trimmed) ||
    /^your[-_ ]?key[-_ ]?here$/i.test(trimmed) ||
    /^\[.*\]$/.test(trimmed)
  ) {
    return undefined;
  }
  return value;
}

function normalizeAddressEnv(name: string, fallback: string): string {
  return ethers.utils.getAddress(optionalEnv(name, fallback)!);
}

function parsePositiveIntegerEnv(name: string, fallback: string): number {
  const value = Number(optionalEnv(name, fallback));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function parseAmountListEnv(name: string, fallback: string[]): string[] {
  const raw = optionalEnv(name);
  if (raw === undefined) {
    return fallback;
  }
  const values = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (values.length === 0) {
    throw new Error(`${name} must contain at least one comma-separated amount`);
  }
  for (const value of values) {
    BigNumber.from(value);
  }
  return values;
}

function parseFeeTierListEnv(name: string, fallback: number[]): number[] {
  const raw = optionalEnv(name);
  const values =
    raw === undefined
      ? fallback
      : raw
          .split(',')
          .map((part) => Number(part.trim()))
          .filter((value) => Number.isFinite(value));
  if (values.length === 0) {
    throw new Error(`${name} must contain at least one fee tier`);
  }
  for (const value of values) {
    if (!Number.isInteger(value) || value <= 0 || value > 1_000_000) {
      throw new Error(`${name} contains invalid fee tier ${value}`);
    }
  }
  return Array.from(new Set(values));
}

function parseAddressListEnv(name: string): string[] | undefined {
  const raw = optionalEnv(name);
  if (raw === undefined) {
    return undefined;
  }
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((address) => ethers.utils.getAddress(address));
}

function writeSummaryIfRequested(summary: CanarySummary): void {
  const outputPath = optionalEnv('AJNA_AGENT_ONEINCH_CANARY_OUTPUT_PATH');
  if (!outputPath) {
    return;
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
}

function resolveBaseRpcUrl(): string | undefined {
  const explicitRpcUrl =
    optionalEnv('AJNA_AGENT_RPC_URL') ??
    optionalEnv('AJNA_RPC_URL_BASE') ??
    optionalEnv('BASE_RPC_URL');
  if (explicitRpcUrl !== undefined) {
    return explicitRpcUrl;
  }
  const alchemyApiKey = usableSecretEnv('ALCHEMY_API_KEY');
  return alchemyApiKey === undefined
    ? undefined
    : `https://base-mainnet.g.alchemy.com/v2/${alchemyApiKey}`;
}

async function tokenAmountFromWad(params: {
  signer: Wallet;
  tokenAddress: string;
  amountWad: string;
}): Promise<BigNumber> {
  const decimals = await getDecimalsErc20(params.signer, params.tokenAddress);
  return convertWadToTokenDecimals(BigNumber.from(params.amountWad), decimals);
}

async function runQuoteCheck(params: {
  router: DexRouter;
  chainId: number;
  label: string;
  tokenIn: string;
  tokenOut: string;
  amountRaw: BigNumber;
  timeoutMs: number;
}): Promise<CanaryCheck> {
  const result = await params.router.getQuoteFromOneInch(
    params.chainId,
    params.amountRaw,
    params.tokenIn,
    params.tokenOut,
    { timeoutMs: params.timeoutMs }
  );
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
  router: DexRouter;
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
}): Promise<CanaryCheck> {
  const result = await params.router.getSwapDataFromOneInch(
    params.chainId,
    params.amountRaw,
    params.tokenIn,
    params.tokenOut,
    params.slippage,
    params.takerAddress,
    true,
    { timeoutMs: params.timeoutMs }
  );
  if (!result.success || !result.data) {
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
  provider: ethers.providers.Provider;
  quoterV2Address: string;
  labelPrefix: string;
  tokenIn: string;
  tokenOut: string;
  amountRaw: BigNumber;
  feeTiers: number[];
}): Promise<CanaryCheck[]> {
  const quoter = new ethers.Contract(
    params.quoterV2Address,
    QUOTER_V2_ABI,
    params.provider
  );
  const checks: CanaryCheck[] = [];
  for (const feeTier of params.feeTiers) {
    try {
      const quoted = await quoter.callStatic.quoteExactInputSingle({
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        amountIn: params.amountRaw,
        fee: feeTier,
        sqrtPriceLimitX96: 0,
      });
      const amountOut = BigNumber.from(quoted.amountOut ?? quoted[0]);
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

async function main(): Promise<void> {
  const rpcUrl = resolveBaseRpcUrl();
  const missingRpcEnv = !rpcUrl
    ? [
        'AJNA_AGENT_RPC_URL, AJNA_RPC_URL_BASE, BASE_RPC_URL, or ALCHEMY_API_KEY',
      ]
    : [];

  if (missingRpcEnv.length > 0) {
    const skipped: CanarySummary = {
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
    writeSummaryIfRequested(skipped);
    process.stdout.write(`${JSON.stringify(skipped, null, 2)}\n`);
    return;
  }

  const chainId = parsePositiveIntegerEnv(
    'AJNA_AGENT_ONEINCH_CANARY_CHAIN_ID',
    String(BASE_CHAIN_ID)
  );
  if (chainId !== BASE_CHAIN_ID) {
    throw new Error('The 1inch route canary currently supports Base only');
  }

  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const signer = Wallet.createRandom().connect(provider);
  const oneInchRouterAddress = normalizeAddressEnv(
    'AJNA_AGENT_ONEINCH_ROUTER_BASE',
    BASE_ONEINCH_ROUTER
  );
  const cadcAddress = normalizeAddressEnv(
    'AJNA_AGENT_ONEINCH_CANARY_CADC_ADDRESS',
    BASE_CADC
  );
  const usdcAddress = normalizeAddressEnv(
    'AJNA_AGENT_ONEINCH_CANARY_USDC_ADDRESS',
    BASE_USDC
  );
  const wethAddress = normalizeAddressEnv(
    'AJNA_AGENT_ONEINCH_CANARY_WETH_ADDRESS',
    BASE_WETH
  );
  const uniswapQuoterV2Address = normalizeAddressEnv(
    'AJNA_AGENT_ONEINCH_CANARY_UNISWAP_QUOTER_V2_ADDRESS',
    BASE_UNISWAP_V3_QUOTER_V2
  );
  const takerAddress = optionalEnv('AJNA_AGENT_ONEINCH_CANARY_TAKER_ADDRESS');
  const oneInchMissingEnv = [
    !process.env.ONEINCH_API ? 'ONEINCH_API' : undefined,
    !usableSecretEnv('ONEINCH_API_KEY') ? 'ONEINCH_API_KEY' : undefined,
    !takerAddress ? 'AJNA_AGENT_ONEINCH_CANARY_TAKER_ADDRESS' : undefined,
  ].filter((value): value is string => value !== undefined);
  const normalizedTakerAddress =
    takerAddress !== undefined
      ? ethers.utils.getAddress(takerAddress)
      : undefined;
  const timeoutMs = parsePositiveIntegerEnv(
    'AJNA_AGENT_ONEINCH_CANARY_TIMEOUT_MS',
    '5000'
  );
  const slippage = Number(
    optionalEnv('AJNA_AGENT_ONEINCH_CANARY_SLIPPAGE', '1')
  );
  if (!Number.isFinite(slippage) || slippage < 0 || slippage > 100) {
    throw new Error('AJNA_AGENT_ONEINCH_CANARY_SLIPPAGE must be 0..100');
  }

  const checks: CanaryCheck[] = [];

  const wethGasQuoteAmountRaw = BigNumber.from(
    optionalEnv(
      'AJNA_AGENT_ONEINCH_CANARY_WETH_GAS_QUOTE_AMOUNT_RAW',
      DEFAULT_WETH_GAS_QUOTE_AMOUNT_RAW
    )
  );
  const uniswapWethUsdcChecks = await runUniswapV3FeeTierQuoteChecks({
    provider,
    quoterV2Address: uniswapQuoterV2Address,
    labelPrefix: 'UniswapV3-WETH-USDC-gas-conversion-quote',
    tokenIn: wethAddress,
    tokenOut: usdcAddress,
    amountRaw: wethGasQuoteAmountRaw,
    feeTiers: parseFeeTierListEnv(
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
    const router = new DexRouter(signer, {
      oneInchRouters: { [chainId]: oneInchRouterAddress },
    });

    const cadcQuoteAmountsWad = parseAmountListEnv(
      'AJNA_AGENT_ONEINCH_CANARY_CADC_QUOTE_AMOUNTS_WAD',
      DEFAULT_CADC_QUOTE_AMOUNTS_WAD
    );
    for (const amountWad of cadcQuoteAmountsWad) {
      const amountRaw = await tokenAmountFromWad({
        signer,
        tokenAddress: cadcAddress,
        amountWad,
      });
      checks.push(
        await runQuoteCheck({
          router,
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
        router,
        chainId,
        label: 'WETH-USDC-gas-conversion-quote',
        tokenIn: wethAddress,
        tokenOut: usdcAddress,
        amountRaw: wethGasQuoteAmountRaw,
        timeoutMs,
      })
    );

    const fixtureCollateralAddress = optionalEnv(
      'AJNA_AGENT_ONEINCH_CANARY_FIXTURE_COLLATERAL_ADDRESS'
    );
    const fixtureQuoteAddress = optionalEnv(
      'AJNA_AGENT_ONEINCH_CANARY_FIXTURE_QUOTE_ADDRESS'
    );
    if (fixtureCollateralAddress && fixtureQuoteAddress) {
      const amountRaw = await tokenAmountFromWad({
        signer,
        tokenAddress: ethers.utils.getAddress(fixtureCollateralAddress),
        amountWad: optionalEnv(
          'AJNA_AGENT_ONEINCH_CANARY_FIXTURE_COLLATERAL_AMOUNT_WAD',
          '1000000000000000000'
        )!,
      });
      checks.push(
        await runQuoteCheck({
          router,
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
      signer,
      tokenAddress: cadcAddress,
      amountWad: optionalEnv(
        'AJNA_AGENT_ONEINCH_CANARY_CADC_SWAP_AMOUNT_WAD',
        DEFAULT_CADC_SWAP_AMOUNT_WAD
      )!,
    });
    checks.push(
      await runSwapDataValidation({
        router,
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
          'AJNA_AGENT_ONEINCH_CANARY_AGGREGATION_EXECUTOR_ALLOWLIST'
        ),
      })
    );
  }

  const requiredChecks = checks.filter(
    (check) => !check.skipped && check.label !== 'fixture-collateral-quote'
  );
  const failureCount = requiredChecks.filter((check) => !check.success).length;
  const summary: CanarySummary = {
    status: failureCount === 0 ? 'passed' : 'failed',
    chainId,
    router: oneInchRouterAddress,
    takerAddress: normalizedTakerAddress,
    checks,
    failureCount,
  };
  writeSummaryIfRequested(summary);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (failureCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(
    `1inch canary failed: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
});
