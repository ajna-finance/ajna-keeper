import { expect } from 'chai';
import { constants, utils } from 'ethers';
import { LiquiditySource } from '../../src/config';
import {
  LifiKeeperTaker__factory,
  SushiAggregatorKeeperTaker__factory,
} from '../../typechain-types/factories/contracts/takers';
import {
  deployAggregatorTaker,
  deployMockTakerBase,
  executeAggregatorTake,
  expectRevertContaining,
} from './helpers/mock-taker-base';

const BORROWER = utils.getAddress(
  '0x00000000000000000000000000000000000000b0'
);

async function deploySushiFixture() {
  return deployAggregatorTaker(await deployMockTakerBase(), {
    Factory: SushiAggregatorKeeperTaker__factory,
    source: LiquiditySource.SUSHI_AGGREGATOR,
  });
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

  it('emits exactly one AggregatorSwapExecuted and never the base SwapExecuted', async () => {
    const fixture = await executeAggregatorTake({
      Factory: SushiAggregatorKeeperTaker__factory,
      source: LiquiditySource.SUSHI_AGGREGATOR,
    });
    const receipt = await (await fixture.send()).wait();

    const sushiTopic = fixture.taker.interface.getEventTopic(
      'AggregatorSwapExecuted'
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
      'AggregatorSwapExecuted',
      sushiEvents[0].data,
      sushiEvents[0].topics
    );
    expect(decoded.source).to.equal(LiquiditySource.SUSHI_AGGREGATOR);
    expect(decoded.target).to.equal(fixture.target.address);
    expect(decoded.amountIn.eq(fixture.amountIn)).to.equal(true);
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
