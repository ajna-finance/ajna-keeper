import { expect } from 'chai';
import { BigNumber, utils } from 'ethers';
import { LiquiditySource } from '../../src/config';
import { OneInchAggregatorKeeperTaker__factory } from '../../typechain-types/factories/contracts/takers';
import {
  deployAggregatorTaker,
  deployMockTakerBase,
  executeAggregatorTake,
  expectRevertContaining,
} from './helpers/mock-taker-base';

async function deployOneInchAggregatorFixture() {
  return deployAggregatorTaker(await deployMockTakerBase(), {
    Factory: OneInchAggregatorKeeperTaker__factory,
    source: LiquiditySource.ONEINCH,
  });
}

function executeOneInchTake(
  params: {
    amountIn?: BigNumber;
    detailsAmountIn?: BigNumber;
    outputAmount?: BigNumber;
    quoteAmountDue?: BigNumber;
    amountOutMinimum?: BigNumber;
  } = {}
) {
  return executeAggregatorTake({
    Factory: OneInchAggregatorKeeperTaker__factory,
    source: LiquiditySource.ONEINCH,
    ...params,
  });
}

describe('OneInchAggregatorKeeperTaker (Packet 5)', () => {
  it('registers at the stable 1inch source id and reports 1inch-only support', async () => {
    const fixture = await deployOneInchAggregatorFixture();

    expect(
      await fixture.factory.hasConfiguredTaker(LiquiditySource.ONEINCH)
    ).to.equal(true);
    expect(
      await fixture.taker.isSourceSupported(LiquiditySource.ONEINCH)
    ).to.equal(true);
    expect(await fixture.taker.isSourceSupported(LiquiditySource.LIFI)).to.equal(
      false
    );
    const sources = await fixture.taker.getSupportedSources();
    expect(sources.length).to.equal(1);
    expect(sources[0]).to.equal(LiquiditySource.ONEINCH);
  });

  it('emits exactly one AggregatorSwapExecuted and never the base SwapExecuted', async () => {
    const fixture = await executeOneInchTake();
    const receipt = await (await fixture.send()).wait();

    const oneInchTopic = fixture.taker.interface.getEventTopic(
      'AggregatorSwapExecuted'
    );
    const baseTopic = fixture.taker.interface.getEventTopic('SwapExecuted');
    const oneInchEvents = receipt.logs.filter(
      (log) => log.topics[0] === oneInchTopic
    );
    const baseEvents = receipt.logs.filter(
      (log) => log.topics[0] === baseTopic
    );
    expect(oneInchEvents.length).to.equal(1);
    expect(baseEvents.length).to.equal(0);
    const decoded = fixture.taker.interface.decodeEventLog(
      'AggregatorSwapExecuted',
      oneInchEvents[0].data,
      oneInchEvents[0].topics
    );
    expect(decoded.source).to.equal(LiquiditySource.ONEINCH);
    expect(decoded.target).to.equal(fixture.target.address);
    expect(decoded.amountIn.eq(fixture.amountIn)).to.equal(true);
    expect(decoded.amountOut.eq(fixture.outputAmount)).to.equal(true);
  });

  it('rejects amount drift instead of pro-rating migrated 1inch calldata', async () => {
    // The pool sends actual collateral (amountIn) but the migrated calldata quotes
    // a higher (stale) input; the exact-fill guard must reject the drift.
    const fixture = await executeOneInchTake({
      amountIn: utils.parseEther('1'),
      detailsAmountIn: utils.parseEther('1.01'),
    });

    await expectRevertContaining(fixture.send(), 'UnexpectedSourceBalance');
  });

  it('nets positive quote-token profit to the owner and reduces auction collateral', async () => {
    const fixture = await executeOneInchTake();
    const ownerQuoteBefore = await fixture.quote.balanceOf(
      fixture.owner.address
    );

    await (await fixture.send()).wait();

    // The pool was repaid the amount due; _settleAfterTake swept the remaining
    // (outputAmount - quoteAmountDue) surplus to the taker's owner.
    expect(
      (await fixture.quote.balanceOf(fixture.owner.address))
        .sub(ownerQuoteBefore)
        .eq(fixture.outputAmount.sub(fixture.quoteAmountDue))
    ).to.equal(true);
    // The auction collateral was consumed by the swap input.
    expect(
      (await fixture.pool.lastCollateralTaken()).eq(fixture.amountIn)
    ).to.equal(true);
  });

  it('settles the ONEINCH external take cleanly: owner earns the surplus, pool repaid exactly the due, taker fully swept', async () => {
    // take-external coverage: the surviving production path (LiquiditySource.ONEINCH
    // -> calldata_aggregator) must earn quote end-to-end and leave no residue in the
    // taker. Distinct from the profit/collateral case above: this pins the
    // settlement completeness invariant.
    const fixture = await executeOneInchTake({
      amountIn: utils.parseEther('2'),
      outputAmount: utils.parseEther('2.6'),
      quoteAmountDue: utils.parseEther('2'),
      amountOutMinimum: utils.parseEther('2.3'),
    });
    const ownerQuoteBefore = await fixture.quote.balanceOf(
      fixture.owner.address
    );

    await (await fixture.send()).wait();

    // Owner earned the full swap surplus...
    expect(
      (await fixture.quote.balanceOf(fixture.owner.address))
        .sub(ownerQuoteBefore)
        .eq(fixture.outputAmount.sub(fixture.quoteAmountDue))
    ).to.equal(true);
    // ...the pool was repaid exactly the amount due...
    expect(
      (await fixture.quote.balanceOf(fixture.pool.address)).eq(
        fixture.quoteAmountDue
      )
    ).to.equal(true);
    // ...and the taker retains no residual quote or collateral.
    expect(
      (await fixture.quote.balanceOf(fixture.taker.address)).eq(0)
    ).to.equal(true);
    expect(
      (await fixture.collateral.balanceOf(fixture.taker.address)).eq(0)
    ).to.equal(true);
  });

  // P2-1 / audit F-01 — fee-on-transfer quote token. The quote burns a cut on
  // every TRANSFER, so a take's quote movements don't reconcile. There are two
  // distinct legs, and only one is guardable on-chain:
  //   (1) swap -> taker: the fee shrinks what the taker receives, so the per-take
  //       backstop (quoteReceived >= max(amountOutMinimum, quoteAmountDueCeiling))
  //       catches the shortfall and REVERTS atomically.
  //   (2) taker -> pool pull: the pool repays itself by pulling `due` from the
  //       taker AFTER the callback returns; the fee shrinks what the POOL nets,
  //       and the taker cannot observe that on-chain. The keeper backstop does
  //       NOT cover this leg — fee-on-transfer quote tokens are unsupported (see
  //       the _approveQuoteForTake NatSpec). The third test pins that shortfall.
  //
  // The earlier single test set quoteAmountDue (1.05) ABOVE the approval ceiling
  // (ceil(amountIn * auctionPrice) = 1.0), so it reverted on an allowance gap a
  // non-fee token hits identically — never proving the backstop. These params
  // keep the pull within the approval so the fee is the only variable.
  it('reverts atomically (InsufficientQuoteReceived) when the fee shrinks the taker receipt below the amount due', async () => {
    const fixture = await executeAggregatorTake({
      Factory: OneInchAggregatorKeeperTaker__factory,
      source: LiquiditySource.ONEINCH,
      amountIn: utils.parseEther('1'), // approval ceiling = ceil(1 * 1.0) = 1.0
      quoteAmountDue: utils.parseEther('1'), // pull 1.0 <= approval: no allowance gap
      outputAmount: utils.parseEther('1'), // 1.0 nominal -> 0.98 net after the 2% fee
      amountOutMinimum: utils.parseEther('0.9'), // below the due, so the due ceiling binds
      feeOnTransferQuoteBps: 200,
    });

    // 0.98 net clears amountOutMinimum (0.9) but not quoteAmountDueCeiling (1.0):
    // the pool-repayment backstop (not the min-out) rejects it.
    await expectRevertContaining(fixture.send(), 'InsufficientQuoteReceived');
    // Atomic: no take recorded, no quote stranded on the taker.
    expect((await fixture.pool.takeCount()).eq(0)).to.equal(true);
    expect(
      (await fixture.quote.balanceOf(fixture.taker.address)).eq(0)
    ).to.equal(true);
  });

  it('positive control: the same amounts settle cleanly with a non-fee quote token', async () => {
    // Identical params, no transfer fee: the taker receives the full 1.0, clears
    // the 1.0 due ceiling, and the pool is repaid in full. Isolates the fee (not
    // the param choice) as the cause of the revert above.
    const fixture = await executeAggregatorTake({
      Factory: OneInchAggregatorKeeperTaker__factory,
      source: LiquiditySource.ONEINCH,
      amountIn: utils.parseEther('1'),
      quoteAmountDue: utils.parseEther('1'),
      outputAmount: utils.parseEther('1'),
      amountOutMinimum: utils.parseEther('0.9'),
    });

    await (await fixture.send()).wait();

    expect((await fixture.pool.takeCount()).eq(1)).to.equal(true);
    // The pool was repaid the full amount due...
    expect(
      (await fixture.quote.balanceOf(fixture.pool.address)).eq(
        fixture.quoteAmountDue
      )
    ).to.equal(true);
    // ...and the taker retains no residual quote.
    expect(
      (await fixture.quote.balanceOf(fixture.taker.address)).eq(0)
    ).to.equal(true);
  });

  it('DOCUMENTED LIMITATION (F-01): a fee-on-transfer quote under-repays the pool when the swap over-delivers — the backstop is taker-side only', async () => {
    // The swap over-delivers enough that the taker clears the due ceiling even
    // after the fee, so the taker-side backstop passes and the take SUCCEEDS.
    // But the pool's post-callback pull of `due` from the taker also loses the
    // fee, so the POOL nets less than the due. The keeper cannot observe or guard
    // the pool's receipt on-chain (the pull happens after the callback returns) —
    // this is why fee-on-transfer quote tokens are unsupported. The mock pull does
    // not balance-check (the pessimistic case), so it under-repays.
    const fee = 200; // 2%
    const quoteAmountDue = utils.parseEther('1');
    const fixture = await executeAggregatorTake({
      Factory: OneInchAggregatorKeeperTaker__factory,
      source: LiquiditySource.ONEINCH,
      amountIn: utils.parseEther('1'),
      quoteAmountDue,
      outputAmount: utils.parseEther('2'), // 2.0 nominal -> 1.96 net clears the 1.0 ceiling
      amountOutMinimum: utils.parseEther('1'),
      feeOnTransferQuoteBps: fee,
    });

    await (await fixture.send()).wait();

    // The take succeeded despite the pool being under-repaid by the transfer fee.
    expect((await fixture.pool.takeCount()).eq(1)).to.equal(true);
    const expectedPoolReceipt = quoteAmountDue.sub(
      quoteAmountDue.mul(fee).div(10_000)
    );
    // The pool pulled 1.0 but netted 0.98 — short by the 2% fee.
    expect(
      (await fixture.quote.balanceOf(fixture.pool.address)).eq(
        expectedPoolReceipt
      )
    ).to.equal(true);
    expect(expectedPoolReceipt.lt(quoteAmountDue)).to.equal(true);
  });
});

describe('aggregator-base quote pull ceiling for non-18-decimal quote tokens', () => {
  // The +1 quoteAmountDueCeiling backstop -- the merged-audited PR #17
  // non-18-decimal invariant the BaseAggregatorCalldataTaker natspec calls out --
  // is exercised for the direct-DEX takers (Uniswap/Curve in
  // taker-hardening.test.ts) but never for the aggregator base at
  // quoteTokenScale > 1, which is the production LI.FI/1inch path. Real Ajna
  // passes floor(quoteWad/scale) to the callback but pulls ceil(quoteWad/scale),
  // so the base must demand one extra token-wei or the pool's pull fails deep in
  // the take. Exercised here against the 1inch base (the surviving production
  // path); all three providers share BaseAggregatorCalldataTaker.
  const QUOTE_SCALE = BigNumber.from(10).pow(12);
  const DUE_RAW = BigNumber.from(5_000_000); // 5 USDC at 6 decimals

  const scaledTake = (outputAmount: BigNumber) =>
    executeAggregatorTake({
      Factory: OneInchAggregatorKeeperTaker__factory,
      source: LiquiditySource.ONEINCH,
      quoteDecimals: 6,
      quoteTokenScale: QUOTE_SCALE,
      quoteAmountDue: DUE_RAW,
      quotePullOverride: DUE_RAW.add(1),
      outputAmount,
      // The pool's quote allowance is sized off maxAmount * auctionPrice (which
      // executeAggregatorTake fixes at 1.0), scaled down by quoteTokenScale. Take
      // 6 collateral so that implied max-quote (6e18 WAD -> 6e6 raw) comfortably
      // covers the 5e6 due + 1 ceil pull; otherwise the approval, not the
      // ceiling, would be the limiting factor.
      amountIn: utils.parseEther('6'),
      // Keep the ceiling (not amountOutMinimum) the binding constraint.
      amountOutMinimum: BigNumber.from(1),
    });

  it('rejects an aggregator swap that only covers the floored quote due', async () => {
    const fixture = await scaledTake(DUE_RAW);
    await expectRevertContaining(fixture.send(), 'InsufficientQuoteReceived');
  });

  it('accepts an aggregator swap that covers the ceil-rounded pull', async () => {
    const fixture = await scaledTake(DUE_RAW.add(1));
    await (await fixture.send()).wait();

    expect((await fixture.pool.takeCount()).eq(1)).to.equal(true);
    expect(
      (await fixture.quote.balanceOf(fixture.pool.address)).gte(DUE_RAW.add(1))
    ).to.equal(true);
  });
});
