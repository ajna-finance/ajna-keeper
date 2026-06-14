// Sushi aggregator route-shape canary (Packet 3B). Live, read-only, never
// broadcasts: fetches a real Sushi v7 quote for each scoped chain's
// keeper-relevant pair and runs it through the production fail-closed
// validator against the reviewed scoped allowlists. Any drift in the
// RouteProcessor target, selector, spender, head layout, value policy, or
// price-impact band fails the canary BEFORE live use.
//
// Usage: npm run sushi-aggregator-route-canary [-- --chain <id>]
import { BigNumber } from 'ethers';
import {
  DEFAULT_SUSHI_AGGREGATOR_MAX_PRICE_IMPACT,
  DEFAULT_SUSHI_AGGREGATOR_SLIPPAGE,
  normalizeSushiAggregatorChainPolicy,
} from '../src/config/sushi-aggregator-policy';
import { SushiAggregatorDexConfig } from '../src/config';
import { fetchSushiAggregatorQuote } from '../src/dex/sushi-aggregator/client';
import {
  SUSHI_AGGREGATOR_SCOPED_APPROVAL_SPENDER_ALLOWLIST,
  SUSHI_AGGREGATOR_SCOPED_CALL_TARGET_ALLOWLIST,
  SUSHI_AGGREGATOR_SCOPED_CHAIN_IDS,
  SUSHI_AGGREGATOR_SCOPED_SELECTOR_ALLOWLIST,
} from '../src/dex/sushi-aggregator/scope';
import { validateSushiAggregatorQuote } from '../src/dex/sushi-aggregator/validate-route';

// Canary identity: a burn address; quotes are read-only and never executed.
const CANARY_TAKER = '0x000000000000000000000000000000000000dead';
const CANARY_AMOUNT = BigNumber.from('1000000000000000000');

// Keeper-relevant scoped pair per chain (wrapped native / production USDC),
// matching the Packet 3A sample set.
const CANARY_PAIRS: Record<number, { tokenIn: string; tokenOut: string; label: string }> = {
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

const SCOPED_CANARY_CONFIG: SushiAggregatorDexConfig = {
  mode: 'production',
  callTargetAllowlist: SUSHI_AGGREGATOR_SCOPED_CALL_TARGET_ALLOWLIST,
  approvalSpenderAllowlist: SUSHI_AGGREGATOR_SCOPED_APPROVAL_SPENDER_ALLOWLIST,
  selectorAllowlist: SUSHI_AGGREGATOR_SCOPED_SELECTOR_ALLOWLIST,
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const chainArgIndex = args.indexOf('--chain');
  const onlyChain =
    chainArgIndex >= 0 ? Number(args[chainArgIndex + 1]) : undefined;
  const chains = SUSHI_AGGREGATOR_SCOPED_CHAIN_IDS.filter(
    chainId => onlyChain === undefined || chainId === onlyChain
  );
  if (chains.length === 0) {
    console.error(
      `FAIL [scope] --chain ${onlyChain} is not in the reviewed Packet 3A scope ` +
        `(${SUSHI_AGGREGATOR_SCOPED_CHAIN_IDS.join(', ')})`
    );
    process.exit(1);
  }

  let failures = 0;
  for (const chainId of chains) {
    const pair = CANARY_PAIRS[chainId];
    try {
      const result = await fetchSushiAggregatorQuote({
        config: SCOPED_CANARY_CONFIG,
        request: {
          chainId,
          tokenIn: pair.tokenIn,
          tokenOut: pair.tokenOut,
          amount: CANARY_AMOUNT.toString(),
          takerAddress: CANARY_TAKER,
          maxSlippage: DEFAULT_SUSHI_AGGREGATOR_SLIPPAGE,
        },
      });
      if (result.status !== 200) {
        throw new Error(`HTTP ${result.status}`);
      }
      const normalized = validateSushiAggregatorQuote({
        quote: result.data,
        chainId,
        fromToken: pair.tokenIn,
        toToken: pair.tokenOut,
        fromAmount: CANARY_AMOUNT,
        takerAddress: CANARY_TAKER,
        maxSlippage: DEFAULT_SUSHI_AGGREGATOR_SLIPPAGE,
        maxPriceImpact: DEFAULT_SUSHI_AGGREGATOR_MAX_PRICE_IMPACT,
        chainPolicy: normalizeSushiAggregatorChainPolicy({
          config: SCOPED_CANARY_CONFIG,
          fieldName: 'canary.dex.sushiAggregator',
          chainId,
        }),
        quotedAtMs: result.requestedAtMs,
      });
      console.log(
        `ok chain ${chainId} ${pair.label}: target=${normalized.transactionTarget} ` +
          `selector=${normalized.selector} minOut=${normalized.routeMinOutRaw.toString()} ` +
          `expected=${normalized.quoteAmountRaw.toString()}`
      );
    } catch (error) {
      failures += 1;
      console.error(
        `FAIL [route-shape] chain ${chainId} ${pair.label}: ${error instanceof Error ? error.message : error}`
      );
    }
  }
  if (failures > 0) {
    console.error(
      `${failures} scoped chain(s) failed the Sushi aggregator route-shape canary`
    );
    process.exit(1);
  }
  console.log(
    `ok canary: ${chains.length}/${chains.length} scoped chains validate fail-closed`
  );
}

if (require.main === module) {
  main().catch(error => {
    console.error(`FAIL [canary] ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
