// W3-FINAL fork execution canary: fetches REAL 1inch swap calldata for the
// Base WETH/USDC pair through the production requestValidatedOneInchAggregatorQuote
// path (same fail-closed decode + aggregationExecutor validation the live take
// uses), executes it through OneInchAggregatorKeeperTaker via the factory on a
// Base fork against the real 1inch router, and verifies the actual quote-token
// balance delta (never optimistic return data).
//
// Run: RUN_ONEINCH_FORK_CANARY=true HARDHAT_CHAIN_ID=8453 FORK_NETWORK=base \
//        ONEINCH_API_KEY=<valid> \
//        npx hardhat test tests/integration/oneinch-aggregator-fork-canary.test.ts
//
// NOTE: blocked in this dev environment — the dev ONEINCH_API_KEY returns 401,
// so this canary is gated off by default and must be run where a valid key
// exists, pinned near the live head (mirrors the Sushi fork canary).
import { expect } from 'chai';
import { BigNumber, Contract, Wallet, constants, utils } from 'ethers';
import { fundSigner, getProvider } from './helpers/mock-taker-base';
import { FungiblePool } from '@ajna-finance/sdk';
import { LiquiditySource } from '../../src/config';
import { requestValidatedOneInchAggregatorQuote } from '../../src/take/oneinch-aggregator/quote-service';
import { encodeAggregatorSwapDetails } from '../../src/take/aggregator-calldata/execution';
import { BASE_ONEINCH_ROUTER } from '../../scripts/no-spend/fixture-constants';
import { TakerRouter__factory } from '../../typechain-types/factories/contracts/factories';
import {
  MockAtomicSwapPool__factory,
  MockPoolDeployer__factory,
} from '../../typechain-types/factories/contracts/mocks';
import { OneInchAggregatorKeeperTaker__factory } from '../../typechain-types/factories/contracts/takers';

const BASE_CHAIN_ID = 8453;
const BASE_WETH = '0x4200000000000000000000000000000000000006';
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const USDC_SCALE = BigNumber.from(10).pow(12);
const TAKE_AMOUNT_WAD = utils.parseEther('0.05');
const BORROWER = '0x00000000000000000000000000000000000000b0';

const WETH_ABI = [
  'function deposit() payable',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
];
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

describe('1inch aggregator fork execution canary (W3-FINAL)', function () {
  this.timeout(300_000);

  before(function () {
    if (
      process.env.RUN_ONEINCH_FORK_CANARY !== 'true' ||
      (process.env.FORK_NETWORK || 'mainnet') !== 'base'
    ) {
      this.skip();
    }
  });

  it('executes real 1inch calldata through the taker and verifies the USDC balance delta', async () => {
    const owner = Wallet.createRandom().connect(getProvider());
    await fundSigner(owner.address);

    const poolDeployer = await new MockPoolDeployer__factory(owner).deploy();
    await poolDeployer.deployed();
    const pool = await new MockAtomicSwapPool__factory(owner).deploy(
      BASE_WETH,
      BASE_USDC,
      USDC_SCALE
    );
    await pool.deployed();
    await poolDeployer.setDeployedPool(
      utils.keccak256(utils.toUtf8Bytes('ERC20_NON_SUBSET_HASH')),
      BASE_WETH,
      BASE_USDC,
      pool.address
    );

    const factory = await new TakerRouter__factory(owner).deploy(
      poolDeployer.address
    );
    await factory.deployed();
    const taker = await new OneInchAggregatorKeeperTaker__factory(owner).deploy(
      poolDeployer.address,
      factory.address
    );
    await taker.deployed();
    await factory.setTaker(LiquiditySource.ONEINCH, taker.address);

    // Fund the mock pool with real WETH (wrapped from fork ETH).
    const weth = new Contract(BASE_WETH, WETH_ABI, owner);
    await weth.deposit({ value: TAKE_AMOUNT_WAD });
    await weth.transfer(pool.address, TAKE_AMOUNT_WAD);
    await pool.setQuoteAmountDue(0);

    // Live quote via the SAME production path the 1inch external take uses: real
    // 1inch swap calldata, decoded + fail-closed-validated for the taker as
    // sender/recipient. Only collateralAddress/quoteAddress are read off `pool`.
    const quote = await requestValidatedOneInchAggregatorQuote({
      pool: {
        collateralAddress: BASE_WETH,
        quoteAddress: BASE_USDC,
      } as unknown as FungiblePool,
      signer: owner,
      config: {
        oneInchRouters: { [BASE_CHAIN_ID]: BASE_ONEINCH_ROUTER },
        oneInchDefaultSlippage: 1,
      },
      takerAddress: taker.address,
      chainId: BASE_CHAIN_ID,
      collateralInTokenDecimals: TAKE_AMOUNT_WAD,
    });

    await taker.setCallTarget(quote.transactionTarget, true);
    await taker.setApprovalSpender(quote.approvalSpender, true);
    await taker.setCallSelector(quote.transactionTarget, quote.selector, true);

    const usdc = new Contract(BASE_USDC, ERC20_ABI, owner);
    const ownerUsdcBefore: BigNumber = await usdc.balanceOf(owner.address);

    const swapDetails = encodeAggregatorSwapDetails({
      quote,
      amountOutMinimum: quote.routeMinOutRaw,
    });
    const tx = await factory.takeWithAtomicSwap(
      pool.address,
      BORROWER,
      constants.WeiPerEther,
      TAKE_AMOUNT_WAD,
      LiquiditySource.ONEINCH,
      quote.transactionTarget,
      swapDetails,
      { gasLimit: 2_000_000 }
    );
    const receipt = await tx.wait();

    const oneInchTopic = taker.interface.getEventTopic('AggregatorSwapExecuted');
    const oneInchEvents = receipt.logs.filter(
      (log) => log.topics[0] === oneInchTopic
    );
    expect(oneInchEvents.length).to.equal(1);
    const decoded = taker.interface.decodeEventLog(
      'AggregatorSwapExecuted',
      oneInchEvents[0].data,
      oneInchEvents[0].topics
    );
    expect(decoded.amountOut.gte(quote.routeMinOutRaw)).to.equal(true);

    // The settle sweep sends the swap output (and any residue) to the owner:
    // verify the ACTUAL quote-token balance delta, not return data.
    const ownerUsdcAfter: BigNumber = await usdc.balanceOf(owner.address);
    const delta = ownerUsdcAfter.sub(ownerUsdcBefore);
    expect(
      delta.gte(quote.routeMinOutRaw),
      `owner USDC delta ${delta.toString()} below route minimum ${quote.routeMinOutRaw.toString()}`
    ).to.equal(true);
    // No WETH residue left on the taker; allowance cleared.
    expect(
      (await weth.balanceOf(taker.address)).isZero(),
      'taker should hold no residual collateral'
    ).to.equal(true);
  });
});
