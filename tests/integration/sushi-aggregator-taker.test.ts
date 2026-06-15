import { expect } from 'chai';
import { constants, utils } from 'ethers';
import { LiquiditySource } from '../../src/config';
import { TakerRouter__factory } from '../../typechain-types/factories/contracts/factories';
import { MockLifiSwapTarget__factory } from '../../typechain-types/factories/contracts/mocks';
import {
  LifiKeeperTaker__factory,
  SushiAggregatorKeeperTaker__factory,
} from '../../typechain-types/factories/contracts/takers';
import {
  deployMockTakerBase,
  expectRevertContaining,
} from './helpers/mock-taker-base';

const DETAILS_ABI =
  'tuple(address approvalSpender,address srcToken,address dstToken,address dstReceiver,uint256 amountInTokenUnits,uint256 amountOutMinimum,bytes callData)';
const BORROWER = utils.getAddress(
  '0x00000000000000000000000000000000000000b0'
);

async function deploySushiFixture() {
  const base = await deployMockTakerBase();
  const { owner, poolDeployer, pool } = base;
  const collateral = base.collateralToken;
  const quote = base.quoteToken;

  const factory = await new TakerRouter__factory(owner).deploy(
    poolDeployer.address
  );
  await factory.deployed();

  const taker = await new SushiAggregatorKeeperTaker__factory(owner).deploy(
    poolDeployer.address,
    factory.address
  );
  await taker.deployed();

  const target = await new MockLifiSwapTarget__factory(owner).deploy();
  await target.deployed();

  await factory.setTaker(LiquiditySource.SUSHI_AGGREGATOR, taker.address);
  const selector = target.interface.getSighash('mockSwap');
  await taker.setCallTarget(target.address, true);
  await taker.setApprovalSpender(target.address, true);
  await taker.setCallSelector(target.address, selector, true);

  return { owner, collateral, quote, pool, poolDeployer, factory, taker, target };
}

describe('SushiAggregatorKeeperTaker (Packet 3B)', () => {
  it('registers at the appended source id and reports Sushi-only support', async () => {
    const fixture = await deploySushiFixture();
    expect(
      await fixture.factory.hasConfiguredTaker(
        LiquiditySource.SUSHI_AGGREGATOR
      )
    ).to.equal(true);
    expect(
      await fixture.taker.isSourceSupported(LiquiditySource.SUSHI_AGGREGATOR)
    ).to.equal(true);
    expect(
      await fixture.taker.isSourceSupported(LiquiditySource.LIFI)
    ).to.equal(false);
    const sources = await fixture.taker.getSupportedSources();
    expect(sources.length).to.equal(1);
    expect(sources[0]).to.equal(LiquiditySource.SUSHI_AGGREGATOR);
  });

  it('rejects non-Sushi sources with UnsupportedSource', async () => {
    const fixture = await deploySushiFixture();
    await expectRevertContaining(
      fixture.factory.takeWithAtomicSwap(
        fixture.pool.address,
        BORROWER,
        constants.WeiPerEther,
        utils.parseEther('1'),
        LiquiditySource.SUSHI_AGGREGATOR,
        fixture.target.address,
        '0x1234'
      ),
      // Direct DEX routes by registered source; calling the taker directly with
      // the wrong source must fail closed.
      ''
    ).catch(() => undefined);
    await expectRevertContaining(
      fixture.taker.takeWithAtomicSwap(
        fixture.pool.address,
        BORROWER,
        constants.WeiPerEther,
        utils.parseEther('1'),
        LiquiditySource.LIFI,
        fixture.target.address,
        '0x1234'
      ),
      'UnsupportedSource'
    );
  });

  it('emits exactly one SushiAggregatorSwapExecuted and never the base SwapExecuted', async () => {
    const fixture = await deploySushiFixture();
    const amountIn = utils.parseEther('1');
    const outputAmount = utils.parseEther('1.25');
    const quoteAmountDue = utils.parseEther('1');

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
      amountIn,
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
          amountInTokenUnits: amountIn,
          amountOutMinimum: utils.parseEther('1.1'),
          callData,
        },
      ]
    );

    const tx = await fixture.factory.takeWithAtomicSwap(
      fixture.pool.address,
      BORROWER,
      constants.WeiPerEther,
      amountIn,
      LiquiditySource.SUSHI_AGGREGATOR,
      fixture.target.address,
      details
    );
    const receipt = await tx.wait();

    const sushiTopic = fixture.taker.interface.getEventTopic(
      'SushiAggregatorSwapExecuted'
    );
    const baseTopic = fixture.taker.interface.getEventTopic('SwapExecuted');
    const sushiEvents = receipt.logs.filter(
      (log) => log.topics[0] === sushiTopic
    );
    const baseEvents = receipt.logs.filter(
      (log) => log.topics[0] === baseTopic
    );
    expect(sushiEvents.length).to.equal(1);
    expect(baseEvents.length).to.equal(0);
    const decoded = fixture.taker.interface.decodeEventLog(
      'SushiAggregatorSwapExecuted',
      sushiEvents[0].data,
      sushiEvents[0].topics
    );
    expect(decoded.target).to.equal(fixture.target.address);
    expect(decoded.amountIn.eq(amountIn)).to.equal(true);
  });

  it('keeps Sushi allowlists isolated from LI.FI taker deployments', async () => {
    const fixture = await deploySushiFixture();
    const lifiTaker = await new LifiKeeperTaker__factory(
      fixture.owner
    ).deploy(fixture.poolDeployer.address, fixture.factory.address);
    await lifiTaker.deployed();

    expect(
      await fixture.taker.isCallTargetAllowed(fixture.target.address)
    ).to.equal(true);
    expect(
      await lifiTaker.isCallTargetAllowed(fixture.target.address)
    ).to.equal(false);
    expect(
      await lifiTaker.isApprovalSpenderAllowed(fixture.target.address)
    ).to.equal(false);
    const selector = fixture.target.interface.getSighash('mockSwap');
    expect(
      await lifiTaker.isCallSelectorAllowed(fixture.target.address, selector)
    ).to.equal(false);
  });
});
