import { expect } from 'chai';
import { BigNumber, constants, utils } from 'ethers';
import { LiquiditySource } from '../../src/config';
import { TakerRouter__factory } from '../../typechain-types/factories/contracts/factories';
import { MockLifiSwapTarget__factory } from '../../typechain-types/factories/contracts/mocks';
import { OneInchAggregatorKeeperTaker__factory } from '../../typechain-types/factories/contracts/takers';
import {
  deployMockTakerBase,
  expectRevertContaining,
} from './helpers/mock-taker-base';

const DETAILS_ABI =
  'tuple(address approvalSpender,address srcToken,address dstToken,address dstReceiver,uint256 amountInTokenUnits,uint256 amountOutMinimum,bytes callData)';
const BORROWER = utils.getAddress(
  '0x00000000000000000000000000000000000000b0'
);

async function deployOneInchAggregatorFixture() {
  const base = await deployMockTakerBase();
  const { owner, poolDeployer, pool } = base;
  const collateral = base.collateralToken;
  const quote = base.quoteToken;

  const factory = await new TakerRouter__factory(owner).deploy(
    poolDeployer.address
  );
  await factory.deployed();

  const taker = await new OneInchAggregatorKeeperTaker__factory(owner).deploy(
    poolDeployer.address,
    factory.address
  );
  await taker.deployed();

  const target = await new MockLifiSwapTarget__factory(owner).deploy();
  await target.deployed();

  await factory.setTaker(LiquiditySource.ONEINCH, taker.address);
  const selector = target.interface.getSighash('mockSwap');
  await taker.setCallTarget(target.address, true);
  await taker.setApprovalSpender(target.address, true);
  await taker.setCallSelector(target.address, selector, true);

  return { owner, collateral, quote, pool, factory, taker, target };
}

/**
 * Deploys the 1inch aggregator fixture and stages a single mockSwap take through
 * TakerRouter: collateral in the pool, output quote in the target, the amount due
 * pre-funded+approved on the owner, and an encoded details/callData pair. Returns
 * the fixture plus a `send()` that fires the take, so each test asserts deltas
 * instead of re-staging the swap. `detailsAmountIn` defaults to `amountIn`; set it
 * higher to model stale (drifted) quoted calldata.
 */
async function executeOneInchTake(
  params: {
    amountIn?: BigNumber;
    detailsAmountIn?: BigNumber;
    outputAmount?: BigNumber;
    quoteAmountDue?: BigNumber;
    amountOutMinimum?: BigNumber;
  } = {}
) {
  const fixture = await deployOneInchAggregatorFixture();
  const amountIn = params.amountIn ?? utils.parseEther('1');
  const detailsAmountIn = params.detailsAmountIn ?? amountIn;
  const outputAmount = params.outputAmount ?? utils.parseEther('1.25');
  const quoteAmountDue = params.quoteAmountDue ?? utils.parseEther('1');
  const amountOutMinimum = params.amountOutMinimum ?? utils.parseEther('1.1');

  await fixture.collateral.mint(fixture.pool.address, amountIn);
  await fixture.quote.mint(fixture.target.address, outputAmount);
  await fixture.quote.mint(fixture.owner.address, quoteAmountDue);
  await fixture.quote
    .connect(fixture.owner)
    .approve(fixture.pool.address, constants.MaxUint256);
  await fixture.pool.setQuoteAmountDue(quoteAmountDue);

  const callData = fixture.target.interface.encodeFunctionData('mockSwap', [
    fixture.collateral.address,
    fixture.quote.address,
    fixture.taker.address,
    detailsAmountIn,
    outputAmount,
  ]);
  const details = utils.defaultAbiCoder.encode(
    [DETAILS_ABI],
    [
      {
        approvalSpender: fixture.target.address,
        srcToken: fixture.collateral.address,
        dstToken: fixture.quote.address,
        dstReceiver: fixture.taker.address,
        amountInTokenUnits: detailsAmountIn,
        amountOutMinimum,
        callData,
      },
    ]
  );

  const send = () =>
    fixture.factory.takeWithAtomicSwap(
      fixture.pool.address,
      BORROWER,
      constants.WeiPerEther,
      amountIn,
      LiquiditySource.ONEINCH,
      fixture.target.address,
      details
    );

  return {
    ...fixture,
    amountIn,
    detailsAmountIn,
    outputAmount,
    quoteAmountDue,
    amountOutMinimum,
    details,
    send,
  };
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
});
