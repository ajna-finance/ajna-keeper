import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { deriveSwapMinimumOut } from '../../src/dex/swap-min-out';

// Reproducer for the reward-swap money-safety defects surfaced by the no-spend
// coverage review (docs/surfaced-code-defects.md #1/#2): the legacy swapToWeth
// hardcoded 0.5% slippage and floored amountOutMinimum to 0.01% of the INPUT,
// and the Universal Router path derived amountOutMin from the input amount.
describe('deriveSwapMinimumOut — reward-swap min-out (defects #1/#2)', () => {
  const inputRaw = BigNumber.from('1000000000000000000'); // 1e18

  it('honors the operator slippage instead of a hardcoded 0.5%', () => {
    const expectedOutputRaw = BigNumber.from('1000');
    // 1% slippage -> 990, NOT 995 (the hardcoded 0.5% result).
    expect(
      deriveSwapMinimumOut({
        expectedOutputRaw,
        slippagePercent: 1,
      }).toString()
    ).to.equal('990');
    // 0.1% slippage -> 999.
    expect(
      deriveSwapMinimumOut({
        expectedOutputRaw,
        slippagePercent: 0.1,
      }).toString()
    ).to.equal('999');
  });

  it('derives the floor from the quoted OUTPUT, not a fraction of the input', () => {
    const expectedOutputRaw = BigNumber.from('100');
    const minOut = deriveSwapMinimumOut({
      expectedOutputRaw,
      slippagePercent: 1,
    });
    expect(minOut.toString()).to.equal('99'); // 100 * (1 - 1%)
    // Must NOT be rescued to ~0.01% of the (much larger) input amount.
    expect(minOut.lt(inputRaw.div(10000))).to.equal(true);
  });

  it('fails closed on a non-positive quote (no near-zero input-based floor)', () => {
    expect(() =>
      deriveSwapMinimumOut({
        expectedOutputRaw: BigNumber.from('0'),
        slippagePercent: 1,
      })
    ).to.throw(/non-positive|fail closed|quote/i);
  });
});
