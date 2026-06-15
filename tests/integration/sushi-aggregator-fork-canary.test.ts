// Packet 3B fork execution canary: fetches REAL Sushi v7 calldata for the
// scoped Base WETH/USDC pair, validates it through the production
// fail-closed validator against the reviewed scoped allowlists, executes it
// through SushiAggregatorKeeperTaker via the factory on a Base fork against
// the real RouteProcessor, and verifies the actual quote-token balance delta
// (never optimistic return data).
//
// Run: RUN_SUSHI_FORK_CANARY=true HARDHAT_CHAIN_ID=8453 FORK_NETWORK=base \
//        npx hardhat test tests/integration/sushi-aggregator-fork-canary.test.ts
import { expect } from 'chai';
import { BigNumber, Contract, Wallet, constants, utils } from 'ethers';
import {
  fundSigner,
  getProvider,
} from './helpers/mock-taker-base';
import { LiquiditySource, SushiAggregatorDexConfig } from '../../src/config';
import {
  DEFAULT_SUSHI_AGGREGATOR_MAX_PRICE_IMPACT,
  DEFAULT_SUSHI_AGGREGATOR_SLIPPAGE,
  normalizeSushiAggregatorChainPolicy,
} from '../../src/config/sushi-aggregator-policy';
import { fetchSushiAggregatorQuote } from '../../src/dex/sushi-aggregator/client';
import {
  SUSHI_AGGREGATOR_SCOPED_APPROVAL_SPENDER_ALLOWLIST,
  SUSHI_AGGREGATOR_SCOPED_CALL_TARGET_ALLOWLIST,
  SUSHI_AGGREGATOR_SCOPED_SELECTOR_ALLOWLIST,
} from '../../src/dex/sushi-aggregator/scope';
import { validateSushiAggregatorQuote } from '../../src/dex/sushi-aggregator/validate-route';
import { encodeAggregatorSwapDetails } from '../../src/take/aggregator-calldata/execution';
import { TakerRouter__factory } from '../../typechain-types/factories/contracts/factories';
import {
  MockAtomicSwapPool__factory,
  MockPoolDeployer__factory,
} from '../../typechain-types/factories/contracts/mocks';
import { SushiAggregatorKeeperTaker__factory } from '../../typechain-types/factories/contracts/takers';

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

const SCOPED_CONFIG: SushiAggregatorDexConfig = {
  mode: 'production',
  callTargetAllowlist: SUSHI_AGGREGATOR_SCOPED_CALL_TARGET_ALLOWLIST,
  approvalSpenderAllowlist: SUSHI_AGGREGATOR_SCOPED_APPROVAL_SPENDER_ALLOWLIST,
  selectorAllowlist: SUSHI_AGGREGATOR_SCOPED_SELECTOR_ALLOWLIST,
};

describe('Sushi aggregator fork execution canary (Packet 3B)', function () {
  this.timeout(300_000);

  before(function () {
    if (
      process.env.RUN_SUSHI_FORK_CANARY !== 'true' ||
      (process.env.FORK_NETWORK || 'mainnet') !== 'base'
    ) {
      this.skip();
    }
  });

  it('executes real Sushi calldata through the taker and verifies the USDC balance delta', async () => {
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
    const taker = await new SushiAggregatorKeeperTaker__factory(owner).deploy(
      poolDeployer.address,
      factory.address
    );
    await taker.deployed();
    await factory.setTaker(LiquiditySource.SUSHI_AGGREGATOR, taker.address);

    // Fund the mock pool with real WETH (wrapped from fork ETH).
    const weth = new Contract(BASE_WETH, WETH_ABI, owner);
    await weth.deposit({ value: TAKE_AMOUNT_WAD });
    await weth.transfer(pool.address, TAKE_AMOUNT_WAD);
    await pool.setQuoteAmountDue(0);

    // Live quote for the taker as sender + recipient, validated through the
    // production fail-closed validator against the reviewed scoped policy.
    const result = await fetchSushiAggregatorQuote({
      config: SCOPED_CONFIG,
      request: {
        chainId: BASE_CHAIN_ID,
        tokenIn: BASE_WETH,
        tokenOut: BASE_USDC,
        amount: TAKE_AMOUNT_WAD.toString(),
        takerAddress: taker.address,
        maxSlippage: DEFAULT_SUSHI_AGGREGATOR_SLIPPAGE,
      },
    });
    expect(result.status).to.equal(200);
    const normalized = validateSushiAggregatorQuote({
      quote: result.data,
      chainId: BASE_CHAIN_ID,
      fromToken: BASE_WETH,
      toToken: BASE_USDC,
      fromAmount: TAKE_AMOUNT_WAD,
      takerAddress: taker.address,
      maxSlippage: DEFAULT_SUSHI_AGGREGATOR_SLIPPAGE,
      maxPriceImpact: DEFAULT_SUSHI_AGGREGATOR_MAX_PRICE_IMPACT,
      chainPolicy: normalizeSushiAggregatorChainPolicy({
        config: SCOPED_CONFIG,
        fieldName: 'forkCanary.dex.sushiAggregator',
        chainId: BASE_CHAIN_ID,
      }),
      quotedAtMs: result.requestedAtMs,
    });

    await taker.setCallTarget(normalized.transactionTarget, true);
    await taker.setApprovalSpender(normalized.approvalSpender, true);
    await taker.setCallSelector(
      normalized.transactionTarget,
      normalized.selector,
      true
    );

    const usdc = new Contract(BASE_USDC, ERC20_ABI, owner);
    const ownerUsdcBefore: BigNumber = await usdc.balanceOf(owner.address);

    const swapDetails = encodeAggregatorSwapDetails({
      quote: normalized,
      amountOutMinimum: normalized.routeMinOutRaw,
    });
    const tx = await factory.takeWithAtomicSwap(
      pool.address,
      BORROWER,
      constants.WeiPerEther,
      TAKE_AMOUNT_WAD,
      LiquiditySource.SUSHI_AGGREGATOR,
      normalized.transactionTarget,
      swapDetails,
      { gasLimit: 2_000_000 }
    );
    const receipt = await tx.wait();

    const sushiTopic = taker.interface.getEventTopic(
      'AggregatorSwapExecuted'
    );
    const sushiEvents = receipt.logs.filter(
      (log) => log.topics[0] === sushiTopic
    );
    expect(sushiEvents.length).to.equal(1);
    const decoded = taker.interface.decodeEventLog(
      'AggregatorSwapExecuted',
      sushiEvents[0].data,
      sushiEvents[0].topics
    );
    expect(decoded.amountOut.gte(normalized.routeMinOutRaw)).to.equal(true);

    // The settle sweep sends the swap output (and any residue) to the owner:
    // verify the ACTUAL quote-token balance delta, not return data.
    const ownerUsdcAfter: BigNumber = await usdc.balanceOf(owner.address);
    const delta = ownerUsdcAfter.sub(ownerUsdcBefore);
    expect(
      delta.gte(normalized.routeMinOutRaw),
      `owner USDC delta ${delta.toString()} below route minimum ${normalized.routeMinOutRaw.toString()}`
    ).to.equal(true);
    // No WETH residue left on the taker; allowance cleared.
    expect(
      (await weth.balanceOf(taker.address)).isZero(),
      'taker should hold no residual collateral'
    ).to.equal(true);
  });
});
