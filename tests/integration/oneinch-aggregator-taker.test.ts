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

  // P2-1 fee-on-transfer quote token: it burns a cut on every transfer, so the
  // amounts the taker moves don't reconcile — repaying the pool the exact amount
  // due requires more than the swap delivered. The take must REVERT ATOMICALLY
  // (the keeper never under-repays the pool or strands funds), not settle short.
  it('reverts a take atomically when a fee-on-transfer quote token cannot repay the pool the full amount due', async () => {
    const fixture = await executeAggregatorTake({
      Factory: OneInchAggregatorKeeperTaker__factory,
      source: LiquiditySource.ONEINCH,
      outputAmount: utils.parseEther('1.1'),
      amountOutMinimum: utils.parseEther('1.0'),
      quoteAmountDue: utils.parseEther('1.05'),
      feeOnTransferQuoteBps: 200, // 2% fee on every quote transfer
    });

    // The fee leaves a transfer short, so the take aborts (ERC20 shortfall)
    // rather than under-repaying the pool.
    await expectRevertContaining(fixture.send(), 'ERC20');
    // Atomic: no take recorded, no quote stranded on the taker.
    expect((await fixture.pool.takeCount()).eq(0)).to.equal(true);
    expect(
      (await fixture.quote.balanceOf(fixture.taker.address)).eq(0)
    ).to.equal(true);
  });
});
