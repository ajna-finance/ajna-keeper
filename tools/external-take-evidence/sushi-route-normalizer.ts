// Tooling-only Sushi v7 swap-API route normalizer (Packet 2A spike).
//
// Normalizes a raw Sushi same-chain swap response into the PROPOSED
// ApprovedCalldataAggregatorQuote execution fields (provider id, quote
// timestamp, chain, input/output token, recipient, amount-in, expected and
// minimum output, transaction target, approval spender, calldata + selector,
// tx.value, route summary). Every required execution field must come from the
// provider response plus standard ABI head decoding — no provider-specific
// execution hacks — or normalization FAILS CLOSED.
//
// Empirically proven response shape (Packet 2A spike, see fixtures):
//   selector 0x5f3bd1c8 on RouteProcessor target, calldata head words:
//     w0 = tokenIn, w1 = amountIn, w2 = recipient, w3 = tokenOut,
//     w4 = amountOutMin, then the opaque route bytes region.
//   The API's `recipient` query param rewrites w2 (verified); the default
//   recipient is the sender. tx.value is absent for ERC20 inputs.
//   amountOutMin tracks assumedAmountOut * (1 - maxSlippage).
//
// A second response shape (selector 0xd33721a5, observed only for
// wrapped-native POL input on Polygon) is NOT proven: its head layout does
// not match, so this normalizer rejects it. Packet 2B may freeze only the
// proven shape; the unproven shape stays a recorded, classified fixture.
//
// BOUNDARY: production src/** must never import this module.

import { BigNumber } from 'ethers';
import {
  FailureClassification,
  ProvisionalNormalizedRouteFields,
} from './evidence-schema';

export const SUSHI_V7_API_BASE = 'https://api.sushi.com/swap/v7';

// Proposed provider id for first-class Sushi aggregator support (plan:
// Aggregator Source Model). Proposal only — Packet 3B owns adding it.
export const PROPOSED_SUSHI_PROVIDER_ID = 'sushi_aggregator';

export interface ProvenSushiResponseShape {
  selector: string;
  headLayout: string;
}

export const PROVEN_SUSHI_RESPONSE_SHAPES: readonly ProvenSushiResponseShape[] =
  [
    {
      selector: '0x5f3bd1c8',
      headLayout: '(tokenIn, amountIn, recipient, tokenOut, amountOutMin, route...)',
    },
  ];

export interface SushiQuoteRequestContext {
  chainId: number;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  maxSlippage: number;
  sender: string;
  recipient?: string;
  requestedAt: string;
}

export type NormalizeResult =
  | { ok: true; normalized: ProvisionalNormalizedRouteFields }
  | { ok: false; reason: string };

const HEX_ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const HEX_DATA_RE = /^0x[0-9a-f]+$/;
const DECIMAL_STRING_RE = /^(0|[1-9][0-9]*)$/;
const HEAD_WORDS = 5;

// Slack below the exact (1 - maxSlippage) floor tolerated before the decoded
// minimum-out is treated as ambiguous: 5 basis points covers provider
// rounding without accepting a materially weaker minimum.
const MIN_OUT_ROUNDING_SLACK_PPM = 500;
const PPM = 1_000_000;

function fail(reason: string): NormalizeResult {
  return { ok: false, reason };
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

export function normalizeSushiV7Response(
  raw: unknown,
  ctx: SushiQuoteRequestContext
): NormalizeResult {
  if (!isRecord(raw)) {
    return fail('response is not a JSON object');
  }
  if (raw.status !== 'Success') {
    return fail(`response status is ${JSON.stringify(raw.status)}, not Success`);
  }
  if (!DECIMAL_STRING_RE.test(ctx.amountIn)) {
    return fail('request context amountIn is not a decimal token-unit string');
  }
  if (raw.amountIn !== ctx.amountIn) {
    return fail(
      `response amountIn ${JSON.stringify(raw.amountIn)} does not match ` +
        `requested ${ctx.amountIn}`
    );
  }
  if (
    typeof raw.assumedAmountOut !== 'string' ||
    !DECIMAL_STRING_RE.test(raw.assumedAmountOut) ||
    raw.assumedAmountOut === '0'
  ) {
    return fail('response assumedAmountOut is missing, non-decimal, or zero');
  }

  const tx = raw.tx;
  if (!isRecord(tx)) {
    return fail('response is missing the tx object');
  }
  const target = typeof tx.to === 'string' ? tx.to.toLowerCase() : '';
  if (!HEX_ADDRESS_RE.test(target)) {
    return fail('tx.to is not a valid execution target address');
  }
  const data = typeof tx.data === 'string' ? tx.data.toLowerCase() : '';
  if (!HEX_DATA_RE.test(data) || data.length < 10 + HEAD_WORDS * 64) {
    return fail('tx.data is missing or shorter than the proven calldata head');
  }
  const txValueRaw = tx.value;
  let txValue = '0';
  if (txValueRaw !== undefined && txValueRaw !== null) {
    const valueString = String(txValueRaw).toLowerCase();
    if (valueString !== '0' && valueString !== '0x0' && valueString !== '0x00') {
      // ERC20-input takes must not require native value; a non-zero value is
      // outside the proven spike scope.
      return fail(`tx.value ${valueString} is non-zero for an ERC20 input`);
    }
    txValue = '0';
  }

  const selector = data.slice(0, 10);
  const provenShape = PROVEN_SUSHI_RESPONSE_SHAPES.filter(
    shape => shape.selector === selector
  )[0];
  if (!provenShape) {
    return fail(
      `unproven response shape: selector ${selector} has no proven head layout`
    );
  }

  const decodedTokenIn = wordToAddress(headWord(data, 0));
  const decodedAmountIn = BigNumber.from('0x' + headWord(data, 1));
  const decodedRecipient = wordToAddress(headWord(data, 2));
  const decodedTokenOut = wordToAddress(headWord(data, 3));
  const decodedMinOut = BigNumber.from('0x' + headWord(data, 4));

  if (!sameAddress(decodedTokenIn, ctx.tokenIn)) {
    return fail(
      `decoded calldata tokenIn ${decodedTokenIn} does not match requested ${ctx.tokenIn}`
    );
  }
  if (!decodedAmountIn.eq(BigNumber.from(ctx.amountIn))) {
    return fail(
      `decoded calldata amountIn ${decodedAmountIn.toString()} does not match ` +
        `requested ${ctx.amountIn}`
    );
  }
  const expectedRecipient = ctx.recipient ?? ctx.sender;
  if (!sameAddress(decodedRecipient, expectedRecipient)) {
    return fail(
      `decoded calldata recipient ${decodedRecipient} does not match ` +
        `expected ${expectedRecipient}`
    );
  }
  if (!sameAddress(decodedTokenOut, ctx.tokenOut)) {
    return fail(
      `decoded calldata tokenOut ${decodedTokenOut} does not match requested ${ctx.tokenOut}`
    );
  }

  const assumedAmountOut = BigNumber.from(raw.assumedAmountOut);
  if (decodedMinOut.lte(0)) {
    return fail('decoded minimum output is zero');
  }
  if (decodedMinOut.gt(assumedAmountOut)) {
    return fail(
      `decoded minimum output ${decodedMinOut.toString()} exceeds expected ` +
        `output ${assumedAmountOut.toString()}`
    );
  }
  if (ctx.maxSlippage <= 0 || ctx.maxSlippage >= 1) {
    return fail('request context maxSlippage is not a fraction in (0, 1)');
  }
  const slippagePpm = Math.round(ctx.maxSlippage * PPM);
  const minOutFloor = assumedAmountOut
    .mul(PPM - slippagePpm - MIN_OUT_ROUNDING_SLACK_PPM)
    .div(PPM);
  if (decodedMinOut.lt(minOutFloor)) {
    return fail(
      `decoded minimum output ${decodedMinOut.toString()} is below the ` +
        `slippage floor ${minOutFloor.toString()} ` +
        `(assumed ${assumedAmountOut.toString()}, maxSlippage ${ctx.maxSlippage})`
    );
  }

  const tokens = raw.tokens;
  if (
    !Array.isArray(tokens) ||
    tokens.length === 0 ||
    tokens.some(
      token =>
        !isRecord(token) ||
        typeof token.address !== 'string' ||
        typeof token.symbol !== 'string'
    )
  ) {
    return fail('response token metadata array is missing or malformed');
  }
  const tokenFrom = raw.tokenFrom;
  const tokenTo = raw.tokenTo;
  if (
    typeof tokenFrom !== 'number' ||
    typeof tokenTo !== 'number' ||
    !tokens[tokenFrom] ||
    !tokens[tokenTo]
  ) {
    return fail('response tokenFrom/tokenTo indices are missing or invalid');
  }
  const metaTokenIn = tokens[tokenFrom] as Record<string, unknown>;
  const metaTokenOut = tokens[tokenTo] as Record<string, unknown>;
  if (!sameAddress(String(metaTokenIn.address), ctx.tokenIn)) {
    return fail('response token metadata does not match the requested tokenIn');
  }
  if (!sameAddress(String(metaTokenOut.address), ctx.tokenOut)) {
    return fail('response token metadata does not match the requested tokenOut');
  }

  const swapPrice = raw.swapPrice;
  const priceImpact = raw.priceImpact;
  const gasSpent = raw.gasSpent;
  if (typeof swapPrice !== 'number' || !isFinite(swapPrice)) {
    return fail('response swapPrice is missing or non-finite');
  }
  if (typeof priceImpact !== 'number' || !isFinite(priceImpact)) {
    return fail('response priceImpact is missing or non-finite');
  }
  if (typeof gasSpent !== 'number' || !isFinite(gasSpent) || gasSpent < 0) {
    return fail('response gasSpent is missing or invalid');
  }

  return {
    ok: true,
    normalized: {
      providerId: PROPOSED_SUSHI_PROVIDER_ID,
      quoteTimestamp: ctx.requestedAt,
      chainId: ctx.chainId,
      inputToken: ctx.tokenIn.toLowerCase(),
      outputToken: ctx.tokenOut.toLowerCase(),
      recipient: decodedRecipient,
      amountIn: ctx.amountIn,
      expectedAmountOut: assumedAmountOut.toString(),
      minimumAmountOut: decodedMinOut.toString(),
      txTarget: target,
      // Sushi's RouteProcessor pulls the input token from the caller, so the
      // approval spender is the execution target itself (observed model).
      approvalSpender: target,
      callDataSelector: selector,
      callData: data,
      txValue,
      routeSummary: {
        providerId: PROPOSED_SUSHI_PROVIDER_ID,
        swapPrice,
        priceImpact,
        gasSpentEstimate: gasSpent,
        tokenPathSymbols: tokens.map(token =>
          String((token as Record<string, unknown>).symbol)
        ),
      },
    },
  };
}

export interface ClassifiedFailure {
  classification: FailureClassification;
  evidenceSummary: string;
}

// Maps a failed Sushi quote attempt onto the shared Packet 2A/3A failure
// classification union with a summarized provider evidence string.
export function classifySushiQuoteFailure(
  httpStatus: number | undefined,
  body: unknown,
  transportError?: string
): ClassifiedFailure {
  const bodySnippet =
    typeof body === 'string'
      ? body.slice(0, 200)
      : JSON.stringify(body ?? null).slice(0, 200);
  if (transportError) {
    return {
      classification: 'transient_error',
      evidenceSummary: `transport error: ${transportError}`,
    };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return {
      classification: 'missing_credentials',
      evidenceSummary: `HTTP ${httpStatus}: ${bodySnippet}`,
    };
  }
  if (httpStatus === 429) {
    return {
      classification: 'rate_limited',
      evidenceSummary: `HTTP ${httpStatus}: ${bodySnippet}`,
    };
  }
  if (httpStatus === 404) {
    // The swap API answers unknown chain ids with a routing-layer 404
    // ("fault filter abort"), observed in the spike.
    return {
      classification: 'unsupported_chain',
      evidenceSummary: `HTTP 404 from the swap API: ${bodySnippet}`,
    };
  }
  if (httpStatus !== undefined && httpStatus >= 500) {
    return {
      classification: 'transient_error',
      evidenceSummary: `HTTP ${httpStatus}: ${bodySnippet}`,
    };
  }
  if (httpStatus === 422) {
    // Typed validation error: the requested pair cannot be quoted on that
    // chain (e.g. unknown token), which is a no-route outcome for the pair.
    return {
      classification: 'no_route',
      evidenceSummary: `HTTP 422 validation error: ${bodySnippet}`,
    };
  }
  if (isRecord(body) && body.status !== undefined && body.status !== 'Success') {
    return {
      classification: 'no_route',
      evidenceSummary: `provider status ${String(body.status)}: ${bodySnippet}`,
    };
  }
  if (httpStatus === 200 && typeof body === 'string') {
    return {
      classification: 'malformed_response',
      evidenceSummary: `HTTP 200 with non-JSON body: ${bodySnippet}`,
    };
  }
  return {
    classification: 'other',
    evidenceSummary: `HTTP ${httpStatus ?? 'unknown'}: ${bodySnippet}`,
  };
}
