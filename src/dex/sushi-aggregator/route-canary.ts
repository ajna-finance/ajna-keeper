import { BigNumber } from 'ethers';
import {
  DEFAULT_SUSHI_AGGREGATOR_MAX_PRICE_IMPACT,
  DEFAULT_SUSHI_AGGREGATOR_SLIPPAGE,
  normalizeSushiAggregatorChainPolicy,
} from '../../config/sushi-aggregator-policy';
import { SushiAggregatorDexConfig } from '../../config';
import {
  SushiAggregatorQuoteHttpResult,
  SushiAggregatorQuoteRequest,
  fetchSushiAggregatorQuote,
} from './client';
import {
  SUSHI_AGGREGATOR_SCOPED_APPROVAL_SPENDER_ALLOWLIST,
  SUSHI_AGGREGATOR_SCOPED_CALL_TARGET_ALLOWLIST,
  SUSHI_AGGREGATOR_SCOPED_CHAIN_IDS,
  SUSHI_AGGREGATOR_SCOPED_SELECTOR_ALLOWLIST,
} from './scope';
import { validateSushiAggregatorQuote } from './validate-route';
import { getErrorMessage } from '../../utils';

// Canary identity: a burn address; quotes are read-only and never executed.
export const SUSHI_CANARY_TAKER =
  '0x000000000000000000000000000000000000dead';
export const SUSHI_CANARY_AMOUNT = BigNumber.from('1000000000000000000');

// Keeper-relevant scoped pair per chain (wrapped native / production USDC),
// matching the Packet 3A sample set.
export const SUSHI_CANARY_PAIRS: Record<
  number,
  { tokenIn: string; tokenOut: string; label: string }
> = {
  1: {
    tokenIn: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    tokenOut: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    label: 'WETH/USDC',
  },
  8453: {
    tokenIn: '0x4200000000000000000000000000000000000006',
    tokenOut: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    label: 'WETH/USDC',
  },
  42161: {
    tokenIn: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
    tokenOut: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    label: 'WETH/USDC',
  },
  10: {
    tokenIn: '0x4200000000000000000000000000000000000006',
    tokenOut: '0x0b2c639c533813f4aa9d7837caf62653d097ff85',
    label: 'WETH/USDC',
  },
  137: {
    tokenIn: '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619',
    tokenOut: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
    label: 'WETH/USDC',
  },
  43114: {
    tokenIn: '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7',
    tokenOut: '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e',
    label: 'WAVAX/USDC',
  },
};

export const SUSHI_SCOPED_CANARY_CONFIG: SushiAggregatorDexConfig = {
  mode: 'production',
  callTargetAllowlist: SUSHI_AGGREGATOR_SCOPED_CALL_TARGET_ALLOWLIST,
  approvalSpenderAllowlist: SUSHI_AGGREGATOR_SCOPED_APPROVAL_SPENDER_ALLOWLIST,
  selectorAllowlist: SUSHI_AGGREGATOR_SCOPED_SELECTOR_ALLOWLIST,
};

export type SushiRouteCanaryCheck = {
  chainId: number;
  label: string;
  success: boolean;
  transactionTarget?: string;
  selector?: string;
  routeMinOutRaw?: string;
  quoteAmountRaw?: string;
  error?: string;
};

export type SushiRouteCanarySummary = {
  status: 'passed' | 'failed';
  chainIds: number[];
  checks: SushiRouteCanaryCheck[];
  failureCount: number;
};

export type SushiRouteCanaryDeps = {
  fetchQuote?: (params: {
    config: SushiAggregatorDexConfig;
    request: SushiAggregatorQuoteRequest;
  }) => Promise<SushiAggregatorQuoteHttpResult>;
  validateQuote?: typeof validateSushiAggregatorQuote;
};

export type RunSushiRouteCanaryInput = {
  argv?: readonly string[];
  deps?: SushiRouteCanaryDeps;
};

export type RunSushiRouteCanaryResult = {
  summary: SushiRouteCanarySummary;
  exitCode: number;
};

/** Resolve the scoped chain set, optionally narrowed by `--chain <id>`. */
export function resolveSushiCanaryChains(argv: readonly string[]): number[] {
  const chainArgIndex = argv.indexOf('--chain');
  const onlyChain =
    chainArgIndex >= 0 ? Number(argv[chainArgIndex + 1]) : undefined;
  const chains = SUSHI_AGGREGATOR_SCOPED_CHAIN_IDS.filter(
    (chainId) => onlyChain === undefined || chainId === onlyChain
  );
  if (chains.length === 0) {
    throw new Error(
      `--chain ${onlyChain} is not in the reviewed Packet 3A scope ` +
        `(${SUSHI_AGGREGATOR_SCOPED_CHAIN_IDS.join(', ')})`
    );
  }
  return [...chains];
}

async function runSushiChainCheck(params: {
  chainId: number;
  deps?: SushiRouteCanaryDeps;
}): Promise<SushiRouteCanaryCheck> {
  const pair = SUSHI_CANARY_PAIRS[params.chainId];
  try {
    const result = await (params.deps?.fetchQuote ?? fetchSushiAggregatorQuote)({
      config: SUSHI_SCOPED_CANARY_CONFIG,
      request: {
        chainId: params.chainId,
        tokenIn: pair.tokenIn,
        tokenOut: pair.tokenOut,
        amount: SUSHI_CANARY_AMOUNT.toString(),
        takerAddress: SUSHI_CANARY_TAKER,
        maxSlippage: DEFAULT_SUSHI_AGGREGATOR_SLIPPAGE,
      },
    });
    if (result.status !== 200) {
      throw new Error(`HTTP ${result.status}`);
    }
    const normalized = (params.deps?.validateQuote ??
      validateSushiAggregatorQuote)({
      quote: result.data,
      chainId: params.chainId,
      fromToken: pair.tokenIn,
      toToken: pair.tokenOut,
      fromAmount: SUSHI_CANARY_AMOUNT,
      takerAddress: SUSHI_CANARY_TAKER,
      maxSlippage: DEFAULT_SUSHI_AGGREGATOR_SLIPPAGE,
      maxPriceImpact: DEFAULT_SUSHI_AGGREGATOR_MAX_PRICE_IMPACT,
      chainPolicy: normalizeSushiAggregatorChainPolicy({
        config: SUSHI_SCOPED_CANARY_CONFIG,
        fieldName: 'canary.dex.sushiAggregator',
        chainId: params.chainId,
      }),
      quotedAtMs: result.requestedAtMs,
    });
    return {
      chainId: params.chainId,
      label: pair.label,
      success: true,
      transactionTarget: normalized.transactionTarget,
      selector: normalized.selector,
      routeMinOutRaw: normalized.routeMinOutRaw.toString(),
      quoteAmountRaw: normalized.quoteAmountRaw.toString(),
    };
  } catch (error) {
    return {
      chainId: params.chainId,
      label: pair.label,
      success: false,
      error: getErrorMessage(error),
    };
  }
}

export async function runSushiRouteCanary(
  input: RunSushiRouteCanaryInput = {}
): Promise<RunSushiRouteCanaryResult> {
  const chains = resolveSushiCanaryChains(input.argv ?? []);
  const checks: SushiRouteCanaryCheck[] = [];
  for (const chainId of chains) {
    checks.push(await runSushiChainCheck({ chainId, deps: input.deps }));
  }
  const failureCount = checks.filter((check) => !check.success).length;
  const summary: SushiRouteCanarySummary = {
    status: failureCount === 0 ? 'passed' : 'failed',
    chainIds: chains,
    checks,
    failureCount,
  };
  return { summary, exitCode: failureCount > 0 ? 1 : 0 };
}
