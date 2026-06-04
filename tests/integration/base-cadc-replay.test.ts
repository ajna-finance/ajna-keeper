import { expect } from 'chai';
import { BigNumber, Contract, providers, utils } from 'ethers';
import { network } from 'hardhat';
import {
  EXTERNAL_TAKE_REJECTION_REASONS,
  applyExternalTakeRoutePolicy,
} from '../../src/take/external-take/policy';

const RUN_BASE_CADC_REPLAY = process.env.RUN_BASE_CADC_REPLAY === 'true';
const BASE_POOL_INFO_UTILS = '0x97fa9b0909C238D170C1ab3B5c728A3a45BBEcBa';
const CADC_POOL = '0x2a869a3911396ff387f4671735dc7df3330d0c31';
const CADC_BORROWER = '0x181010cf1fdb3c9842ebeee504051e0811138a81';
const FIRST_BUCKET_TAKE_REPLAY_BLOCK = 45_714_423;
const SECOND_BUCKET_TAKE_REPLAY_BLOCK = 45_714_584;
const POOL_INFO_UTILS_ABI = [
  'function auctionStatus(address ajnaPool_, address borrower_) view returns (uint256 kickTime_, uint256 collateral_, uint256 debtToCover_, bool isCollateralized_, uint256 price_, uint256 neutralPrice_)',
];

function wad(value: string): BigNumber {
  return utils.parseUnits(value, 18);
}

function marketFactorFloor(quoteDue: BigNumber): BigNumber {
  return quoteDue.mul(100).add(98).div(99);
}

function getProvider(): providers.Web3Provider {
  return new providers.Web3Provider(network.provider as any);
}

async function resetBaseFork(blockNumber: number): Promise<void> {
  const hardhatNetworkConfig = (network.config as any).forking;
  const jsonRpcUrl = hardhatNetworkConfig?.url;
  if (!jsonRpcUrl) {
    throw new Error('Hardhat forking URL is not configured');
  }
  await network.provider.send('hardhat_reset', [
    {
      forking: {
        jsonRpcUrl,
        blockNumber,
      },
    },
  ]);
  const provider = getProvider();
  expect(await provider.getBlockNumber()).to.equal(blockNumber);
}

async function expectCadcAuctionActive(): Promise<void> {
  const poolInfoUtils = new Contract(
    BASE_POOL_INFO_UTILS,
    POOL_INFO_UTILS_ABI,
    getProvider()
  );
  const status = await poolInfoUtils.auctionStatus(CADC_POOL, CADC_BORROWER);
  expect(status.kickTime_.gt(0)).to.equal(true);
  expect(status.collateral_.gt(0)).to.equal(true);
}

describe('Base CADC auction replay controls', function () {
  this.timeout(300_000);

  beforeEach(function () {
    if (!RUN_BASE_CADC_REPLAY) {
      this.skip();
    }
    if ((process.env.FORK_NETWORK || 'mainnet') !== 'base') {
      this.skip();
    }
    if (!process.env.ALCHEMY_API_KEY) {
      this.skip();
    }
  });

  it('keeps the first CADC BucketTake point rejected on a Base fork', async function () {
    await resetBaseFork(FIRST_BUCKET_TAKE_REPLAY_BLOCK);
    await expectCadcAuctionActive();

    const quoteDue = wad('5.023934827627184068');
    const policy = applyExternalTakeRoutePolicy({
      configuredMarketPriceFactor: 0.99,
      allowSubsidy: false,
      quoteAmountRaw: wad('4.954684377911498'),
      quoteDueRaw: quoteDue,
      marketFactorFloorQuoteRaw: marketFactorFloor(quoteDue),
    });

    expect(policy.isEconomicallyExecutable).to.equal(false);
    expect(policy.rejectionReason).to.equal(
      EXTERNAL_TAKE_REJECTION_REASONS.routeQuoteBelowRepaymentFloor
    );
  });

  it('keeps the second CADC BucketTake point eligible only while floors fit the observed spread', async function () {
    await resetBaseFork(SECOND_BUCKET_TAKE_REPLAY_BLOCK);
    await expectCadcAuctionActive();

    const quoteDue = wad('3.090554648181740026');
    const quoteAmount = wad('3.1439176014062675');
    const eligible = applyExternalTakeRoutePolicy({
      configuredMarketPriceFactor: 0.99,
      allowSubsidy: false,
      quoteAmountRaw: quoteAmount,
      quoteDueRaw: quoteDue,
      marketFactorFloorQuoteRaw: marketFactorFloor(quoteDue),
    });
    const floorTooHigh = applyExternalTakeRoutePolicy({
      configuredMarketPriceFactor: 0.99,
      allowSubsidy: false,
      quoteAmountRaw: quoteAmount,
      quoteDueRaw: quoteDue,
      marketFactorFloorQuoteRaw: marketFactorFloor(quoteDue),
      configuredProfitFloorQuoteRaw: wad('0.06'),
    });

    expect(eligible.isEconomicallyExecutable).to.equal(true);
    expect(
      eligible.expectedNetProfitQuoteRaw.eq(quoteAmount.sub(quoteDue))
    ).to.equal(true);
    expect(floorTooHigh.isEconomicallyExecutable).to.equal(false);
    expect(floorTooHigh.rejectionReason).to.equal(
      EXTERNAL_TAKE_REJECTION_REASONS.routeQuoteBelowRequiredOutputFloor
    );
  });
});
