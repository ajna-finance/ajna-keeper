import { expect } from 'chai';
import { BigNumber, ethers } from 'ethers';
import genericRouterABI from '../../src/abis/1inch-genericrouter.abi.json';
import {
  OneInchQuoteResult,
  OneInchSwapDataResult,
} from '../../src/dex/oneinch';
import {
  OneInchRouteCanaryDeps,
  OneInchRouteCanaryRuntime,
  runOneInchRouteCanary,
} from '../../src/dex/oneinch-aggregator/route-canary';

const BASE_CADC = ethers.utils.getAddress(
  '0x043eb4b75d0805c43d7c834902e335621983cf03'
);
const BASE_USDC = ethers.utils.getAddress(
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
);
const BASE_ONEINCH_ROUTER = ethers.utils.getAddress(
  '0x1111111254EEB25477B68fb85Ed929f73A960582'
);
const TAKER = ethers.utils.getAddress(
  '0x1111111111111111111111111111111111111111'
);
const AGGREGATION_EXECUTOR = ethers.utils.getAddress(
  '0x2222222222222222222222222222222222222222'
);

const routerInterface = new ethers.utils.Interface(genericRouterABI);

/**
 * Encode a real 1inch `swap` calldata payload so the canary's
 * convertSwapApiResponseToDetails / validateOneInchSwapDetailsForAtomicTake
 * path runs end-to-end against decoded calldata — fully offline.
 */
function encodeOneInchSwapData(params: {
  executor: string;
  srcToken: string;
  dstToken: string;
  srcReceiver: string;
  dstReceiver: string;
  amount: BigNumber;
  minReturnAmount: BigNumber;
  flags: BigNumber;
}): string {
  return routerInterface.encodeFunctionData('swap', [
    params.executor,
    {
      srcToken: params.srcToken,
      dstToken: params.dstToken,
      srcReceiver: params.srcReceiver,
      dstReceiver: params.dstReceiver,
      amount: params.amount,
      minReturnAmount: params.minReturnAmount,
      flags: params.flags,
    },
    '0x',
  ]);
}

type RuntimeOverrides = Partial<OneInchRouteCanaryRuntime>;

function buildRuntime(
  overrides: RuntimeOverrides = {}
): OneInchRouteCanaryRuntime {
  return {
    getTokenDecimals: async () => 18,
    getQuote: async ({ amountRaw }): Promise<OneInchQuoteResult> => ({
      success: true,
      dstAmount: amountRaw.toString(),
    }),
    getSwapData: async ({
      amountRaw,
      tokenIn,
      tokenOut,
      takerAddress,
    }): Promise<OneInchSwapDataResult> => ({
      success: true,
      dstAmount: amountRaw.toString(),
      data: {
        to: BASE_ONEINCH_ROUTER,
        data: encodeOneInchSwapData({
          executor: AGGREGATION_EXECUTOR,
          srcToken: tokenIn,
          dstToken: tokenOut,
          srcReceiver: BASE_ONEINCH_ROUTER,
          dstReceiver: takerAddress,
          amount: amountRaw,
          minReturnAmount: amountRaw.div(2).add(1),
          flags: BigNumber.from(0),
        }),
      },
    }),
    quoteUniswapV3ExactInputSingle: async ({ amountRaw }) => amountRaw.mul(2),
    ...overrides,
  };
}

function depsWith(overrides: RuntimeOverrides = {}): OneInchRouteCanaryDeps {
  return {
    createRuntime: () => buildRuntime(overrides),
  };
}

/**
 * Env that resolves an RPC URL (skip-gate satisfied) and enables 1inch checks
 * (ONEINCH_API + a usable ONEINCH_API_KEY + a taker address).
 */
function liveEnv(
  extra: Record<string, string | undefined> = {}
): Record<string, string | undefined> {
  return {
    AJNA_AGENT_RPC_URL: 'https://base.rpc.test/v2/key',
    ONEINCH_API: 'https://api.1inch.dev/swap/v6.0',
    ONEINCH_API_KEY: 'usable-test-key',
    AJNA_AGENT_ONEINCH_CANARY_TAKER_ADDRESS: TAKER,
    ...extra,
  };
}

describe('1inch route canary', function () {
  this.timeout(20000);

  it('skips fail-open when no RPC source env is present', async () => {
    const { summary, exitCode } = await runOneInchRouteCanary({
      env: {},
      deps: depsWith(),
    });
    expect(summary.status).to.equal('skipped');
    expect(exitCode).to.equal(0);
    expect(summary.checks).to.have.length(1);
    expect(summary.checks[0].label).to.equal('canary-env');
    expect(summary.checks[0].skipped).to.equal(true);
    expect(summary.checks[0].error).to.include('Missing required canary env');
  });

  it('rejects a non-Base chain id', async () => {
    let threw: Error | undefined;
    try {
      await runOneInchRouteCanary({
        env: liveEnv({ AJNA_AGENT_ONEINCH_CANARY_CHAIN_ID: '1' }),
        deps: depsWith(),
      });
    } catch (error) {
      threw = error as Error;
    }
    expect(threw?.message).to.include('supports Base only');
  });

  it('runs Uniswap checks and skips 1inch checks when 1inch env is incomplete', async () => {
    const { summary, exitCode } = await runOneInchRouteCanary({
      env: {
        AJNA_AGENT_RPC_URL: 'https://base.rpc.test/v2/key',
        // ONEINCH_API / ONEINCH_API_KEY / taker intentionally absent
      },
      deps: depsWith(),
    });
    expect(summary.status).to.equal('passed');
    expect(exitCode).to.equal(0);
    const labels = summary.checks.map((check) => check.label);
    // Default fee tiers => four UniswapV3 fee-tier checks + one skip marker.
    expect(labels).to.include(
      'UniswapV3-WETH-USDC-gas-conversion-quote-fee-3000'
    );
    const skipCheck = summary.checks.find(
      (check) => check.label === 'oneinch-canary-env'
    );
    expect(skipCheck?.skipped).to.equal(true);
    expect(skipCheck?.error).to.include('Skipped 1inch checks; missing env');
    expect(skipCheck?.error).to.include('ONEINCH_API');
    expect(summary.takerAddress).to.equal(undefined);
  });

  it('treats a placeholder ONEINCH_API_KEY as missing', async () => {
    const { summary } = await runOneInchRouteCanary({
      env: liveEnv({ ONEINCH_API_KEY: 'your-key-here' }),
      deps: depsWith(),
    });
    const skipCheck = summary.checks.find(
      (check) => check.label === 'oneinch-canary-env'
    );
    expect(skipCheck?.skipped).to.equal(true);
    expect(skipCheck?.error).to.include('ONEINCH_API_KEY');
  });

  it('passes the full offline 1inch + Uniswap canary with a valid swap fixture', async () => {
    const { summary, exitCode } = await runOneInchRouteCanary({
      env: liveEnv(),
      deps: depsWith(),
    });
    expect(summary.status).to.equal('passed');
    expect(exitCode).to.equal(0);
    expect(summary.failureCount).to.equal(0);
    expect(summary.chainId).to.equal(8453);
    expect(summary.router).to.equal(BASE_ONEINCH_ROUTER);
    expect(summary.takerAddress).to.equal(TAKER);

    const labels = summary.checks.map((check) => check.label);
    // Two default CADC quote amounts + WETH gas quote + swap validation.
    expect(labels).to.include('CADC-USDC-quote-6750734311152542852');
    expect(labels).to.include('WETH-USDC-gas-conversion-quote');
    const swapCheck = summary.checks.find(
      (check) => check.label === 'CADC-USDC-swap-data-validation'
    );
    expect(swapCheck?.success).to.equal(true);
    expect(swapCheck?.source).to.equal('oneinch');
    expect(swapCheck?.validationError).to.equal(undefined);
    expect(swapCheck?.tokenIn).to.equal(BASE_CADC);
    expect(swapCheck?.tokenOut).to.equal(BASE_USDC);
  });

  it('honors the aggregation-executor allowlist on the swap-data check', async () => {
    const { summary } = await runOneInchRouteCanary({
      env: liveEnv({
        AJNA_AGENT_ONEINCH_CANARY_AGGREGATION_EXECUTOR_ALLOWLIST:
          '0x9999999999999999999999999999999999999999',
      }),
      deps: depsWith(),
    });
    const swapCheck = summary.checks.find(
      (check) => check.label === 'CADC-USDC-swap-data-validation'
    );
    expect(swapCheck?.success).to.equal(false);
    expect(summary.status).to.equal('failed');
    expect(summary.failureCount).to.be.greaterThan(0);
    expect(swapCheck?.validationError).to.include(
      'not in the configured allowlist'
    );
  });

  it('fails when a UniswapV3 fee-tier quote returns zero output', async () => {
    const { summary, exitCode } = await runOneInchRouteCanary({
      env: liveEnv({ AJNA_AGENT_ONEINCH_CANARY_UNISWAP_FEE_TIERS: '3000' }),
      deps: depsWith({
        quoteUniswapV3ExactInputSingle: async () => BigNumber.from(0),
      }),
    });
    expect(exitCode).to.equal(1);
    expect(summary.status).to.equal('failed');
    const feeCheck = summary.checks.find((check) =>
      check.label.startsWith('UniswapV3-WETH-USDC-gas-conversion-quote-fee-')
    );
    expect(feeCheck?.success).to.equal(false);
    expect(feeCheck?.error).to.include('QuoterV2 returned zero output');
  });

  it('reports a failed 1inch quote as a failure but keeps the fixture quote non-blocking', async () => {
    const { summary, exitCode } = await runOneInchRouteCanary({
      env: liveEnv({
        AJNA_AGENT_ONEINCH_CANARY_FIXTURE_COLLATERAL_ADDRESS:
          '0x3333333333333333333333333333333333333333',
        AJNA_AGENT_ONEINCH_CANARY_FIXTURE_QUOTE_ADDRESS: BASE_USDC,
      }),
      deps: depsWith({
        getQuote: async ({ tokenIn }) => {
          // Fail only the non-blocking fixture-collateral quote.
          if (
            tokenIn ===
            ethers.utils.getAddress(
              '0x3333333333333333333333333333333333333333'
            )
          ) {
            return {
              success: false,
              error: 'no route',
              retryable: false,
              errorCode: 400,
            };
          }
          return { success: true, dstAmount: '1' };
        },
      }),
    });
    const fixtureCheck = summary.checks.find(
      (check) => check.label === 'fixture-collateral-quote'
    );
    expect(fixtureCheck?.success).to.equal(false);
    // fixture-collateral-quote is excluded from failureCount.
    expect(summary.status).to.equal('passed');
    expect(exitCode).to.equal(0);
    expect(summary.failureCount).to.equal(0);
  });

  it('parses custom CADC quote amounts and rejects invalid fee tiers', async () => {
    let threw: Error | undefined;
    try {
      await runOneInchRouteCanary({
        env: liveEnv({ AJNA_AGENT_ONEINCH_CANARY_UNISWAP_FEE_TIERS: '0' }),
        deps: depsWith(),
      });
    } catch (error) {
      threw = error as Error;
    }
    expect(threw?.message).to.include('invalid fee tier');
  });

  it('rejects an out-of-range slippage value', async () => {
    let threw: Error | undefined;
    try {
      await runOneInchRouteCanary({
        env: liveEnv({ AJNA_AGENT_ONEINCH_CANARY_SLIPPAGE: '250' }),
        deps: depsWith(),
      });
    } catch (error) {
      threw = error as Error;
    }
    expect(threw?.message).to.include('must be 0..100');
  });

  it('resolves an RPC url from ALCHEMY_API_KEY and forwards a custom router address', async () => {
    const customRouter = ethers.utils.getAddress(
      '0x4444444444444444444444444444444444444444'
    );
    let observedRpcUrl: string | undefined;
    let observedRouter: string | undefined;
    const { summary } = await runOneInchRouteCanary({
      env: {
        ALCHEMY_API_KEY: 'alchemy-test-key',
        ONEINCH_API: 'https://api.1inch.dev/swap/v6.0',
        ONEINCH_API_KEY: 'usable-test-key',
        AJNA_AGENT_ONEINCH_CANARY_TAKER_ADDRESS: TAKER,
        AJNA_AGENT_ONEINCH_ROUTER_BASE: customRouter,
      },
      deps: {
        createRuntime: ({ rpcUrl, oneInchRouterAddress }) => {
          observedRpcUrl = rpcUrl;
          observedRouter = oneInchRouterAddress;
          return buildRuntime();
        },
      },
    });
    expect(observedRpcUrl).to.equal(
      'https://base-mainnet.g.alchemy.com/v2/alchemy-test-key'
    );
    expect(observedRouter).to.equal(customRouter);
    expect(summary.router).to.equal(customRouter);
  });
});
