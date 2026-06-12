import { BigNumber } from 'ethers';
import { ApprovedCalldataAggregatorQuote } from '../../take/aggregator-calldata/types';
import { NormalizedSushiAggregatorChainPolicy } from '../../config/sushi-aggregator-policy';

/**
 * Fail-closed Sushi v7 route validation and normalization (Packet 3B).
 * Enforces the packet security contract before anything reaches route
 * binding or approval:
 * - same-chain execution is pinned by the request URL; the validator
 *   additionally cross-checks the response token metadata
 * - tx.to must be in the chain's call-target allowlist
 * - the approval spender (the RouteProcessor target itself) must be in the
 *   approval-spender allowlist
 * - the calldata selector must be allowlisted for the target
 * - decoded calldata head must match the request exactly: tokenIn = pool
 *   collateral, amountIn = requested exact-fill amount, recipient = the
 *   taker contract, tokenOut = pool quote token
 * - decoded minimum output must be positive, not above the expected output,
 *   and within the slippage band
 * - tx.value must be zero for ERC20-collateral routes
 * - absolute price impact must not exceed the configured maximum
 * Raw provider responses never cross into the returned normalized quote.
 *
 * Proven response shape (Packet 2A evidence): selector 0x5f3bd1c8 with head
 * words (tokenIn, amountIn, recipient, tokenOut, amountOutMin, route...).
 */
export const PROVEN_SUSHI_AGGREGATOR_SELECTORS: readonly string[] = [
  '0x5f3bd1c8',
];

const HEX_ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const HEX_DATA_RE = /^0x[0-9a-f]+$/;
const DECIMAL_STRING_RE = /^(0|[1-9][0-9]*)$/;
const HEAD_WORDS = 5;
const MIN_OUT_ROUNDING_SLACK_PPM = 500;
const PPM = 1_000_000;

export class SushiAggregatorRouteValidationError extends Error {}

function fail(reason: string): never {
  throw new SushiAggregatorRouteValidationError(
    `Sushi aggregator route rejected: ${reason}`
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function headWord(data: string, index: number): string {
  return data.slice(10 + index * 64, 10 + (index + 1) * 64);
}

function wordToAddress(word: string): string {
  return '0x' + word.slice(24);
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function validateSushiAggregatorQuote(params: {
  quote: unknown;
  chainId: number;
  fromToken: string;
  toToken: string;
  fromAmount: BigNumber;
  takerAddress: string;
  maxSlippage: number;
  maxPriceImpact: number;
  chainPolicy: NormalizedSushiAggregatorChainPolicy;
  quotedAtMs: number;
}): ApprovedCalldataAggregatorQuote {
  const raw = params.quote;
  if (!isRecord(raw)) {
    fail('response is not a JSON object');
  }
  if (raw.status !== 'Success') {
    fail(`provider status ${JSON.stringify(raw.status)} is not Success`);
  }
  if (params.chainPolicy.chainId !== params.chainId) {
    fail(
      `chain policy ${params.chainPolicy.chainId} does not match keeper chain ${params.chainId}`
    );
  }
  const amountString = params.fromAmount.toString();
  if (!DECIMAL_STRING_RE.test(amountString) || params.fromAmount.lte(0)) {
    fail('requested amount is not a positive token-unit value');
  }
  if (raw.amountIn !== amountString) {
    fail(
      `response amountIn ${JSON.stringify(raw.amountIn)} does not match requested ${amountString}`
    );
  }
  if (
    typeof raw.assumedAmountOut !== 'string' ||
    !DECIMAL_STRING_RE.test(raw.assumedAmountOut) ||
    raw.assumedAmountOut === '0'
  ) {
    fail('response assumedAmountOut is missing, non-decimal, or zero');
  }
  const priceImpact = raw.priceImpact;
  if (typeof priceImpact !== 'number' || !isFinite(priceImpact)) {
    fail('response priceImpact is missing or non-finite');
  }
  if (Math.abs(priceImpact) > params.maxPriceImpact) {
    fail(
      `price impact ${Math.abs(priceImpact)} exceeds configured maximum ${params.maxPriceImpact}`
    );
  }

  const tx = raw.tx;
  if (!isRecord(tx)) {
    fail('response is missing the tx object');
  }
  const target = typeof tx.to === 'string' ? tx.to.toLowerCase() : '';
  if (!HEX_ADDRESS_RE.test(target)) {
    fail('tx.to is not a valid execution target address');
  }
  const allowedCallTargets = params.chainPolicy.callTargets.map(value =>
    value.toLowerCase()
  );
  const allowedApprovalSpenders = params.chainPolicy.approvalSpenders.map(
    value => value.toLowerCase()
  );
  if (allowedCallTargets.indexOf(target) < 0) {
    fail(`tx.to ${target} is not in the chain call-target allowlist`);
  }
  if (allowedApprovalSpenders.indexOf(target) < 0) {
    fail(
      `approval spender ${target} is not in the chain approval-spender allowlist`
    );
  }
  const txValueRaw = tx.value;
  if (txValueRaw !== undefined && txValueRaw !== null) {
    const valueString = String(txValueRaw).toLowerCase();
    if (valueString !== '0' && valueString !== '0x0' && valueString !== '0x00') {
      fail(`tx.value ${valueString} is non-zero for an ERC20 collateral route`);
    }
  }
  const data = typeof tx.data === 'string' ? tx.data.toLowerCase() : '';
  if (!HEX_DATA_RE.test(data) || data.length < 10 + HEAD_WORDS * 64) {
    fail('tx.data is missing or shorter than the proven calldata head');
  }
  const selector = data.slice(0, 10);
  if (PROVEN_SUSHI_AGGREGATOR_SELECTORS.indexOf(selector) < 0) {
    fail(`selector ${selector} has no proven head layout`);
  }
  const selectorEntry = Object.keys(params.chainPolicy.selectorAllowlist).find(
    key => key.toLowerCase() === target
  );
  const allowedSelectors = selectorEntry
    ? params.chainPolicy.selectorAllowlist[selectorEntry].map(value =>
        value.toLowerCase()
      )
    : [];
  if (allowedSelectors.indexOf(selector) < 0) {
    fail(`selector ${selector} is not allowlisted for target ${target}`);
  }

  const decodedTokenIn = wordToAddress(headWord(data, 0));
  const decodedAmountIn = BigNumber.from('0x' + headWord(data, 1));
  const decodedRecipient = wordToAddress(headWord(data, 2));
  const decodedTokenOut = wordToAddress(headWord(data, 3));
  const decodedMinOut = BigNumber.from('0x' + headWord(data, 4));
  if (!sameAddress(decodedTokenIn, params.fromToken)) {
    fail(
      `decoded tokenIn ${decodedTokenIn} does not match pool collateral ${params.fromToken}`
    );
  }
  if (!decodedAmountIn.eq(params.fromAmount)) {
    fail(
      `decoded amountIn ${decodedAmountIn.toString()} does not match requested ${amountString}`
    );
  }
  if (!sameAddress(decodedRecipient, params.takerAddress)) {
    fail(
      `decoded recipient ${decodedRecipient} is not the taker contract ${params.takerAddress}`
    );
  }
  if (!sameAddress(decodedTokenOut, params.toToken)) {
    fail(
      `decoded tokenOut ${decodedTokenOut} does not match pool quote token ${params.toToken}`
    );
  }
  const assumedAmountOut = BigNumber.from(raw.assumedAmountOut);
  if (decodedMinOut.lte(0)) {
    fail('decoded minimum output is zero');
  }
  if (decodedMinOut.gt(assumedAmountOut)) {
    fail(
      `decoded minimum output ${decodedMinOut.toString()} exceeds expected output ${assumedAmountOut.toString()}`
    );
  }
  if (params.maxSlippage <= 0 || params.maxSlippage >= 1) {
    fail('maxSlippage is not a fraction in (0, 1)');
  }
  const slippagePpm = Math.round(params.maxSlippage * PPM);
  const minOutFloor = assumedAmountOut
    .mul(PPM - slippagePpm - MIN_OUT_ROUNDING_SLACK_PPM)
    .div(PPM);
  if (decodedMinOut.lt(minOutFloor)) {
    fail(
      `decoded minimum output ${decodedMinOut.toString()} is below the slippage floor ${minOutFloor.toString()}`
    );
  }

  const tokens = raw.tokens;
  const tokenFrom = raw.tokenFrom;
  const tokenTo = raw.tokenTo;
  if (
    !Array.isArray(tokens) ||
    typeof tokenFrom !== 'number' ||
    typeof tokenTo !== 'number' ||
    !isRecord(tokens[tokenFrom]) ||
    !isRecord(tokens[tokenTo])
  ) {
    fail('response token metadata is missing or malformed');
  }
  const metaIn = tokens[tokenFrom] as Record<string, unknown>;
  const metaOut = tokens[tokenTo] as Record<string, unknown>;
  if (!sameAddress(String(metaIn.address), params.fromToken)) {
    fail('response token metadata contradicts the requested input token');
  }
  if (!sameAddress(String(metaOut.address), params.toToken)) {
    fail('response token metadata contradicts the requested output token');
  }

  return {
    providerId: 'sushi_aggregator',
    quotedAtMs: params.quotedAtMs,
    chainId: params.chainId,
    srcToken: params.fromToken.toLowerCase(),
    dstToken: params.toToken.toLowerCase(),
    dstReceiver: params.takerAddress.toLowerCase(),
    amountInTokenUnits: params.fromAmount,
    quoteAmountRaw: assumedAmountOut,
    routeMinOutRaw: decodedMinOut,
    transactionTarget: target,
    approvalSpender: target,
    callData: data,
    selector,
    txValue: '0',
    routeSummary: {
      providerId: 'sushi_aggregator',
      tool: 'sushi-swap-api-v7',
      feeCosts: [],
    },
  };
}
