import { expect } from 'chai';
import {
  BigNumber,
  Contract,
  Wallet,
  constants,
  providers,
  utils,
} from 'ethers';
import { network } from 'hardhat';
import { TakerRouter__factory } from '../../typechain-types/factories/contracts/factories';
import {
  MockAtomicSwapPool__factory,
  MockPoolDeployer__factory,
} from '../../typechain-types/factories/contracts/mocks';
import { LifiKeeperTaker__factory } from '../../typechain-types/factories/contracts/takers';
import { LiquiditySource } from '../../src/config';
import {
  assertLifiToolsContainFilters,
  fetchLifiQuote,
  fetchLifiTools,
  normalizeLifiExchangeFilters,
  validateLifiQuote,
} from '../../src/dex/lifi';
import {
  ForkCanaryLifiConfig,
  LIFI_FORK_CANARY_BASE_CHAIN_ID as BASE_CHAIN_ID,
  getLifiForkCanaryApiKey,
  loadLifiForkCanaryKeeperConfig,
  optionalForkCanaryEnv,
  resolveLifiForkCanaryConfig,
} from './helpers/lifi-fork-canary-config';
import { resetHardhat, setBalance } from './test-utils';

const RUN_LIFI_FORK_CANARY =
  process.env.RUN_LIFI_FORK_CANARY === 'true' ||
  process.env.AJNA_AGENT_RUN_LIFI_FORK_CANARY === 'true';

// Opt-in, NON-PRODUCTION mode: skip the configured-production-deployment
// registration gate and instead verify real LI.FI calldata execution against the
// freshly deployed local factory/taker this test already creates. Use this to
// validate real same-chain calldata key-free WITHOUT a deployed production
// factory/taker. The strict production gate remains the default.
const USE_FRESH_DEPLOYMENT =
  process.env.AJNA_AGENT_LIFI_FORK_CANARY_USE_FRESH_DEPLOYMENT === 'true';

const BASE_WETH = utils.getAddress(
  '0x4200000000000000000000000000000000000006'
);
const BASE_USDC = utils.getAddress(
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
);
const DEFAULT_BASE_WETH_AMOUNT_RAW = '1000000000000000';
const ERC20_NON_SUBSET_HASH = utils.keccak256(
  utils.toUtf8Bytes('ERC20_NON_SUBSET_HASH')
);
const BORROWER = utils.getAddress('0x00000000000000000000000000000000000000b0');
const WETH_ABI = [
  'function deposit() payable',
  'function transfer(address to,uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner,address spender) view returns (uint256)',
];
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner,address spender) view returns (uint256)',
];

function getProvider() {
  return new providers.Web3Provider(network.provider as any);
}

function optionalEnv(...names: string[]): string | undefined {
  return optionalForkCanaryEnv(process.env, ...names);
}

function requireConfiguredBaseForkRpc(): void {
  const forkUrl = (network.config as any).forking?.url;
  if (
    typeof forkUrl !== 'string' ||
    forkUrl.trim().length === 0 ||
    /\b(undefined|null)\b/i.test(forkUrl)
  ) {
    throw new Error(
      'Base fork RPC is required for RUN_LIFI_FORK_CANARY=true before hardhat_reset; set AJNA_AGENT_RPC_URL, AJNA_RPC_URL_BASE, BASE_RPC_URL, or ALCHEMY_API_KEY for the configured Base fork URL'
    );
  }
}

async function requireForkContractCode(params: {
  provider: providers.Provider;
  label: string;
  address: string;
}): Promise<void> {
  const code = await params.provider.getCode(params.address);
  if (code === '0x') {
    throw new Error(
      `LI.FI fork canary requires deployed code at ${params.label} ${params.address}`
    );
  }
}

async function requireConfiguredProductionTakerRegistration(params: {
  provider: providers.Provider;
  config: ForkCanaryLifiConfig;
}): Promise<void> {
  await requireForkContractCode({
    provider: params.provider,
    label: 'config.takers.router',
    address: params.config.configuredFactoryAddress,
  });
  await requireForkContractCode({
    provider: params.provider,
    label: 'config.takers.contracts.Lifi',
    address: params.config.configuredTakerAddress,
  });

  const configuredFactory = TakerRouter__factory.connect(
    params.config.configuredFactoryAddress,
    params.provider
  );
  const registeredTaker = utils.getAddress(
    await configuredFactory.takerContracts(LiquiditySource.LIFI)
  );
  if (registeredTaker !== params.config.configuredTakerAddress) {
    throw new Error(
      `LI.FI configured factory registration mismatch: expected ${params.config.configuredTakerAddress}, got ${registeredTaker}`
    );
  }
  if (!(await configuredFactory.hasConfiguredTaker(LiquiditySource.LIFI))) {
    throw new Error('LI.FI configured factory does not report LIFI as enabled');
  }
}

async function requireLifiToolsContainForkFilters(params: {
  config: ForkCanaryLifiConfig;
  apiKey?: string;
}): Promise<void> {
  const filters = normalizeLifiExchangeFilters(params.config);
  const toolsResponse = await fetchLifiTools({
    config: params.config,
    apiKey: params.apiKey,
  });
  assertLifiToolsContainFilters({ filters, toolsResponse });
}

async function buildForkCanaryConfig(): Promise<ForkCanaryLifiConfig> {
  return resolveLifiForkCanaryConfig({
    keeperConfig: await loadLifiForkCanaryKeeperConfig(),
  });
}

function encodeLifiSwapDetails(params: {
  approvalSpender: string;
  srcToken: string;
  dstToken: string;
  dstReceiver: string;
  amountInTokenUnits: BigNumber;
  amountOutMinimum: BigNumber;
  callData: string;
}): string {
  return utils.defaultAbiCoder.encode(
    [
      'tuple(address approvalSpender,address srcToken,address dstToken,address dstReceiver,uint256 amountInTokenUnits,uint256 amountOutMinimum,bytes callData)',
    ],
    [params]
  );
}

describe('LI.FI callback-path fork execution canary', function () {
  this.timeout(300_000);

  before(async function () {
    if (!RUN_LIFI_FORK_CANARY) {
      this.skip();
    }
    if (network.name !== 'hardhat') {
      throw new Error('LI.FI fork canary must run on the hardhat network');
    }
    if ((process.env.FORK_NETWORK ?? 'mainnet') !== 'base') {
      throw new Error('LI.FI fork canary currently requires FORK_NETWORK=base');
    }
    if (Number(process.env.HARDHAT_CHAIN_ID ?? '31337') !== BASE_CHAIN_ID) {
      throw new Error('LI.FI fork canary requires HARDHAT_CHAIN_ID=8453');
    }
    requireConfiguredBaseForkRpc();
    await buildForkCanaryConfig();
    await resetHardhat();
  });

  it('executes fresh LI.FI same-chain calldata through the Ajna callback path on a Base fork', async function () {
    if (!RUN_LIFI_FORK_CANARY) {
      this.skip();
    }

    const fromToken = utils.getAddress(
      optionalEnv('AJNA_AGENT_LIFI_FORK_CANARY_FROM_TOKEN') ?? BASE_WETH
    );
    const toToken = utils.getAddress(
      optionalEnv('AJNA_AGENT_LIFI_FORK_CANARY_TO_TOKEN') ?? BASE_USDC
    );
    if (fromToken.toLowerCase() !== BASE_WETH.toLowerCase()) {
      throw new Error('LI.FI fork canary currently funds only Base WETH input');
    }
    const fromAmount = BigNumber.from(
      optionalEnv('AJNA_AGENT_LIFI_FORK_CANARY_FROM_AMOUNT_RAW') ??
        DEFAULT_BASE_WETH_AMOUNT_RAW
    );
    if (!fromAmount.gt(0)) {
      throw new Error(
        'AJNA_AGENT_LIFI_FORK_CANARY_FROM_AMOUNT_RAW must be > 0'
      );
    }
    const profitFloorRaw = BigNumber.from(
      optionalEnv(
        'AJNA_AGENT_LIFI_FORK_CANARY_PROFIT_FLOOR_RAW',
        'AJNA_AGENT_LIFI_CANARY_PROFIT_FLOOR_RAW'
      ) ?? '1'
    );
    if (!profitFloorRaw.gt(0)) {
      throw new Error(
        'AJNA_AGENT_LIFI_FORK_CANARY_PROFIT_FLOOR_RAW must be > 0'
      );
    }

    const provider = getProvider();
    const lifiConfig = await buildForkCanaryConfig();
    if (!USE_FRESH_DEPLOYMENT) {
      await requireConfiguredProductionTakerRegistration({
        provider,
        config: lifiConfig,
      });
    }

    const owner = Wallet.createRandom().connect(provider);
    await setBalance(owner.address, utils.parseEther('100').toHexString());

    const pool = await new MockAtomicSwapPool__factory(owner).deploy(
      fromToken,
      toToken,
      1
    );
    await pool.deployed();
    const poolDeployer = await new MockPoolDeployer__factory(owner).deploy();
    await poolDeployer.deployed();
    await poolDeployer.setDeployedPool(
      ERC20_NON_SUBSET_HASH,
      fromToken,
      toToken,
      pool.address
    );
    const factory = await new TakerRouter__factory(owner).deploy(
      poolDeployer.address
    );
    await factory.deployed();
    const taker = await new LifiKeeperTaker__factory(owner).deploy(
      poolDeployer.address,
      factory.address
    );
    await taker.deployed();
    await factory.setTaker(LiquiditySource.LIFI, taker.address);

    const apiKey = getLifiForkCanaryApiKey(lifiConfig);
    await requireLifiToolsContainForkFilters({
      config: lifiConfig,
      apiKey,
    });
    const quoteResult = await fetchLifiQuote({
      config: lifiConfig,
      apiKey,
      request: {
        chainId: BASE_CHAIN_ID,
        fromToken,
        toToken,
        fromAmount: fromAmount.toString(),
        fromAddress: taker.address,
        toAddress: taker.address,
        slippage: lifiConfig.defaultSlippage,
        maxPriceImpact: lifiConfig.maxPriceImpact,
      },
    });
    const approvedQuote = validateLifiQuote({
      quote: quoteResult.data,
      chainId: BASE_CHAIN_ID,
      fromToken,
      toToken,
      fromAmount,
      takerAddress: taker.address,
      allowedExchangeTools: lifiConfig.allowExchanges,
      callTargetAllowlist: lifiConfig.callTargetAllowlist[BASE_CHAIN_ID],
      approvalSpenderAllowlist:
        lifiConfig.approvalSpenderAllowlist[BASE_CHAIN_ID],
      selectorAllowlist: lifiConfig.selectorAllowlist[BASE_CHAIN_ID],
      feeCostPolicy: lifiConfig.feeCostPolicy,
    });

    // li.quest returns value as a hex string ("0x0"); the validator accepts any
    // zero representation, so assert numeric zero rather than a literal '0'.
    expect(
      BigNumber.from(approvedQuote.transactionRequest.value).isZero()
    ).to.equal(true);
    expect(approvedQuote.srcToken).to.equal(fromToken);
    expect(approvedQuote.dstToken).to.equal(toToken);
    expect(approvedQuote.dstReceiver).to.equal(taker.address);
    expect(
      (await provider.getCode(approvedQuote.transactionTarget)).length
    ).to.be.greaterThan(2);
    expect(
      (await provider.getCode(approvedQuote.approvalSpender)).length
    ).to.be.greaterThan(2);

    for (const target of lifiConfig.callTargetAllowlist[BASE_CHAIN_ID]) {
      await taker.setCallTarget(target, true);
    }
    for (const spender of lifiConfig.approvalSpenderAllowlist[BASE_CHAIN_ID]) {
      await taker.setApprovalSpender(spender, true);
    }
    for (const [target, selectors] of Object.entries(
      lifiConfig.selectorAllowlist[BASE_CHAIN_ID]
    )) {
      for (const selector of selectors) {
        await taker.setCallSelector(target, selector, true);
      }
    }

    const weth = new Contract(fromToken, WETH_ABI, owner);
    const quoteToken = new Contract(toToken, ERC20_ABI, owner);
    await weth.deposit({ value: fromAmount });
    await weth.transfer(pool.address, fromAmount);
    expect((await weth.balanceOf(taker.address)).eq(0)).to.equal(true);
    expect((await quoteToken.balanceOf(taker.address)).eq(0)).to.equal(true);

    const quoteAmountDue = approvedQuote.routeMinOutRaw;
    const approvedMinOutRaw = quoteAmountDue.add(profitFloorRaw);
    if (approvedQuote.quoteAmountRaw.lt(approvedMinOutRaw)) {
      throw new Error(
        'LI.FI fork canary quote cannot satisfy route min-out plus profit floor'
      );
    }
    await pool.setQuoteAmountDue(quoteAmountDue);
    const details = encodeLifiSwapDetails({
      approvalSpender: approvedQuote.approvalSpender,
      srcToken: approvedQuote.srcToken,
      dstToken: approvedQuote.dstToken,
      dstReceiver: approvedQuote.dstReceiver,
      amountInTokenUnits: approvedQuote.amountInTokenUnits,
      amountOutMinimum: approvedMinOutRaw,
      callData: approvedQuote.transactionRequest.data,
    });
    const auctionPriceWad = quoteAmountDue
      .mul(constants.WeiPerEther)
      .add(fromAmount)
      .sub(1)
      .div(fromAmount);

    await factory.takeWithAtomicSwap(
      pool.address,
      BORROWER,
      auctionPriceWad,
      fromAmount,
      LiquiditySource.LIFI,
      approvedQuote.transactionTarget,
      details
    );

    expect((await pool.takeCount()).eq(1)).to.equal(true);
    expect(
      (await quoteToken.balanceOf(pool.address)).eq(quoteAmountDue)
    ).to.equal(true);
    expect((await weth.balanceOf(taker.address)).eq(0)).to.equal(true);
    expect((await quoteToken.balanceOf(taker.address)).eq(0)).to.equal(true);
    expect(
      (await weth.allowance(taker.address, approvedQuote.approvalSpender)).eq(0)
    ).to.equal(true);
    expect(
      (await quoteToken.allowance(taker.address, pool.address)).eq(0)
    ).to.equal(true);
    expect(
      (await quoteToken.balanceOf(owner.address)).gte(profitFloorRaw)
    ).to.equal(true);
  });
});
