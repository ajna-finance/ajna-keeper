import { BigNumber, constants } from 'ethers';

/**
 * Derive the on-chain `amountOutMinimum` (slippage floor) for a reward-token
 * swap from a real quoted OUTPUT amount and the operator's configured slippage.
 *
 * This is the single source of truth for both the legacy Uniswap V3
 * (`swapToWeth`) and Universal Router reward-swap paths, so the min-out can no
 * longer (a) silently ignore the operator's slippage in favor of a hardcoded
 * value, (b) be derived from the INPUT amount (wrong units), or (c) collapse to
 * a meaningless near-zero floor when the quote is unavailable.
 */
export function deriveSwapMinimumOut(params: {
  /** The quoted output amount, in OUTPUT-token raw units. */
  expectedOutputRaw: BigNumber;
  /** The swap input amount, in INPUT-token raw units (for diagnostics only). */
  inputRaw: BigNumber;
  /** Operator slippage tolerance as a percentage (1 = 1%, 0.5 = 0.5%). */
  slippagePercent: number;
}): BigNumber {
  if (params.expectedOutputRaw.lte(constants.Zero)) {
    // Fail closed: a non-positive quote means we cannot price the swap, so we
    // must NOT substitute a near-zero floor (which would permit a ~total-loss
    // fill). Abort the swap instead.
    throw new Error(
      'Refusing to swap reward token: quoted output is non-positive; cannot derive a safe minimum-out (failing closed rather than using a near-zero floor).'
    );
  }
  const slippageBps = Math.round(params.slippagePercent * 100);
  if (
    !Number.isFinite(slippageBps) ||
    slippageBps < 0 ||
    slippageBps >= 10000
  ) {
    throw new Error(
      `Invalid reward-swap slippage tolerance: ${params.slippagePercent}% (expected 0 <= slippage < 100)`
    );
  }
  // minOut = quotedOutput * (1 - slippage), in OUTPUT-token units.
  return params.expectedOutputRaw.mul(10000 - slippageBps).div(10000);
}
