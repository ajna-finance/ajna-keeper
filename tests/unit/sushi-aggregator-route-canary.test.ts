import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { ApprovedCalldataAggregatorQuote } from '../../src/take/aggregator-calldata/types';
import {
  SUSHI_CANARY_AMOUNT,
  SUSHI_CANARY_PAIRS,
  SUSHI_CANARY_TAKER,
  SushiRouteCanaryDeps,
  resolveSushiCanaryChains,
  runSushiRouteCanary,
} from '../../src/dex/sushi-aggregator/route-canary';
import {
  DEFAULT_SUSHI_AGGREGATOR_MAX_PRICE_IMPACT,
  DEFAULT_SUSHI_AGGREGATOR_SLIPPAGE,
} from '../../src/config/sushi-aggregator-policy';

const SCOPED_CHAIN_IDS = [1, 8453, 42161, 10, 137, 43114];
const PROVEN_TARGET = '0xac4c6e212a361c968f1725b4d055b47e63f80b75';
const PROVEN_SELECTOR = '0x5f3bd1c8';

function approvedQuote(params: {
  chainId: number;
  fromToken: string;
  toToken: string;
  fromAmount: BigNumber;
  takerAddress: string;
  quotedAtMs: number;
}): ApprovedCalldataAggregatorQuote {
  return {
    providerId: 'sushi_aggregator',
    quotedAtMs: params.quotedAtMs,
    chainId: params.chainId,
    srcToken: params.fromToken,
    dstToken: params.toToken,
    dstReceiver: params.takerAddress,
    amountInTokenUnits: params.fromAmount,
    quoteAmountRaw: BigNumber.from('2500000'),
    routeMinOutRaw: BigNumber.from('2400000'),
    transactionTarget: PROVEN_TARGET,
    approvalSpender: PROVEN_TARGET,
    callData: `${PROVEN_SELECTOR}00000000`,
    selector: PROVEN_SELECTOR,
    txValue: '0',
    routeSummary: {
      providerId: 'sushi_aggregator',
      tool: 'sushi',
      feeCosts: [],
    },
  };
}

function passingDeps(): SushiRouteCanaryDeps {
  return {
    fetchQuote: async ({ request }) => ({
      status: 200,
      data: { status: 'Success', chainId: request.chainId },
      requestedAtMs: 1_700_000_000_000,
    }),
    validateQuote: (params) =>
      approvedQuote({
        chainId: params.chainId,
        fromToken: params.fromToken,
        toToken: params.toToken,
        fromAmount: params.fromAmount,
        takerAddress: params.takerAddress,
        quotedAtMs: params.quotedAtMs,
      }),
  };
}

describe('Sushi aggregator route canary', function () {
  this.timeout(20000);

  it('resolves the full scoped chain set with no --chain arg', () => {
    expect(resolveSushiCanaryChains([])).to.deep.equal(SCOPED_CHAIN_IDS);
  });

  it('narrows to a single scoped chain via --chain', () => {
    expect(resolveSushiCanaryChains(['--chain', '8453'])).to.deep.equal([8453]);
  });

  it('rejects an out-of-scope --chain selection', () => {
    let threw: Error | undefined;
    try {
      resolveSushiCanaryChains(['--chain', '5']);
    } catch (error) {
      threw = error as Error;
    }
    expect(threw?.message).to.include('is not in the reviewed Packet 3A scope');
  });

  it('passes every scoped chain through the offline fail-closed validator', async () => {
    const { summary, exitCode } = await runSushiRouteCanary({
      deps: passingDeps(),
    });
    expect(summary.status).to.equal('passed');
    expect(exitCode).to.equal(0);
    expect(summary.failureCount).to.equal(0);
    expect(summary.chainIds).to.deep.equal(SCOPED_CHAIN_IDS);
    expect(summary.checks).to.have.length(SCOPED_CHAIN_IDS.length);
    for (const check of summary.checks) {
      expect(check.success).to.equal(true);
      expect(check.transactionTarget).to.equal(PROVEN_TARGET);
      expect(check.selector).to.equal(PROVEN_SELECTOR);
      expect(check.routeMinOutRaw).to.equal('2400000');
      expect(check.quoteAmountRaw).to.equal('2500000');
    }
  });

  it('forwards the canary taker/amount/slippage on each scoped quote request', async () => {
    const seen: Array<{ chainId: number; amount: string; sender: string }> = [];
    await runSushiRouteCanary({
      argv: ['--chain', '8453'],
      deps: {
        fetchQuote: async ({ request }) => {
          seen.push({
            chainId: request.chainId,
            amount: request.amount,
            sender: request.takerAddress,
          });
          return {
            status: 200,
            data: { status: 'Success' },
            requestedAtMs: 1,
          };
        },
        validateQuote: (params) =>
          approvedQuote({
            chainId: params.chainId,
            fromToken: params.fromToken,
            toToken: params.toToken,
            fromAmount: params.fromAmount,
            takerAddress: params.takerAddress,
            quotedAtMs: params.quotedAtMs,
          }),
      },
    });
    expect(seen).to.deep.equal([
      {
        chainId: 8453,
        amount: SUSHI_CANARY_AMOUNT.toString(),
        sender: '0x000000000000000000000000000000000000dead',
      },
    ]);
  });

  it('wires the per-chain pair, scoped policy, and quote timestamp into the fail-closed validator', async () => {
    const requestedAtMs = 1_700_000_123_456;
    const seen: Array<Parameters<NonNullable<SushiRouteCanaryDeps['validateQuote']>>[0]> = [];
    await runSushiRouteCanary({
      argv: ['--chain', '8453'],
      deps: {
        fetchQuote: async ({ request }) => ({
          status: 200,
          data: { status: 'Success', chainId: request.chainId },
          requestedAtMs,
        }),
        validateQuote: (params) => {
          seen.push(params);
          return approvedQuote({
            chainId: params.chainId,
            fromToken: params.fromToken,
            toToken: params.toToken,
            fromAmount: params.fromAmount,
            takerAddress: params.takerAddress,
            quotedAtMs: params.quotedAtMs,
          });
        },
      },
    });
    expect(seen).to.have.length(1);
    const params = seen[0];
    expect(params.chainId).to.equal(8453);
    expect(params.fromToken).to.equal(SUSHI_CANARY_PAIRS[8453].tokenIn);
    expect(params.toToken).to.equal(SUSHI_CANARY_PAIRS[8453].tokenOut);
    expect(params.fromAmount.eq(SUSHI_CANARY_AMOUNT)).to.equal(true);
    expect(params.takerAddress).to.equal(SUSHI_CANARY_TAKER);
    expect(params.maxSlippage).to.equal(DEFAULT_SUSHI_AGGREGATOR_SLIPPAGE);
    expect(params.maxPriceImpact).to.equal(
      DEFAULT_SUSHI_AGGREGATOR_MAX_PRICE_IMPACT
    );
    // Freshness wiring: the canary stamps the validator with the quote's
    // request time, not Date.now().
    expect(params.quotedAtMs).to.equal(requestedAtMs);
    // The reviewed scoped chain policy is normalized (not empty) and forwarded.
    expect(params.chainPolicy.callTargets.length).to.be.greaterThan(0);
    expect(params.chainPolicy.approvalSpenders.length).to.be.greaterThan(0);
    expect(
      Object.keys(params.chainPolicy.selectorAllowlist).length
    ).to.be.greaterThan(0);
  });

  it('fails a chain whose quote returns a non-200 status', async () => {
    const { summary, exitCode } = await runSushiRouteCanary({
      argv: ['--chain', '1'],
      deps: {
        fetchQuote: async () => ({
          status: 503,
          data: undefined,
          requestedAtMs: 1,
        }),
        validateQuote: passingDeps().validateQuote,
      },
    });
    expect(exitCode).to.equal(1);
    expect(summary.status).to.equal('failed');
    expect(summary.failureCount).to.equal(1);
    expect(summary.checks[0].success).to.equal(false);
    expect(summary.checks[0].error).to.include('HTTP 503');
  });

  it('fails a chain whose quote drifts past the fail-closed validator', async () => {
    const { summary, exitCode } = await runSushiRouteCanary({
      argv: ['--chain', '8453'],
      deps: {
        fetchQuote: async () => ({
          status: 200,
          data: { status: 'Success' },
          requestedAtMs: 1,
        }),
        validateQuote: () => {
          throw new Error('route processor target drift detected');
        },
      },
    });
    expect(exitCode).to.equal(1);
    expect(summary.status).to.equal('failed');
    expect(summary.checks[0].success).to.equal(false);
    expect(summary.checks[0].error).to.include(
      'route processor target drift detected'
    );
  });

  it('reports a mixed pass/fail summary across scoped chains', async () => {
    const { summary, exitCode } = await runSushiRouteCanary({
      deps: {
        fetchQuote: async ({ request }) => ({
          status: request.chainId === 137 ? 502 : 200,
          data: { status: 'Success' },
          requestedAtMs: 1,
        }),
        validateQuote: (params) =>
          approvedQuote({
            chainId: params.chainId,
            fromToken: params.fromToken,
            toToken: params.toToken,
            fromAmount: params.fromAmount,
            takerAddress: params.takerAddress,
            quotedAtMs: params.quotedAtMs,
          }),
      },
    });
    expect(exitCode).to.equal(1);
    expect(summary.status).to.equal('failed');
    expect(summary.failureCount).to.equal(1);
    const failed = summary.checks.filter((check) => !check.success);
    expect(failed).to.have.length(1);
    expect(failed[0].chainId).to.equal(137);
  });
});
