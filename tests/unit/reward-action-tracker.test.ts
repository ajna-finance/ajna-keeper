import { FeeAmount } from '@uniswap/v3-sdk';
import { expect } from 'chai';
import { BigNumber, Wallet } from 'ethers';
import sinon, { SinonStub } from 'sinon';
import {
  RewardAction,
  RewardActionLabel,
  KeeperConfig,
  PostAuctionDex,
} from '../../src/config';
import { DexRouter } from '../../src/dex/router';
import { MAINNET_CONFIG } from '../integration/test-config';
import {
  deterministicJsonStringify,
  RewardActionTracker,
} from '../../src/rewards';
import * as erc20 from '../../src/erc20';
import { decimaledToWei } from '../../src/utils';

const ONE_INCH_ROUTER = '0x1111111254EEB25477B68fb85Ed929f73A960582';
const UNIVERSAL_ROUTER_ADDRESS = '0x0000000000000000000000000000000000000001';
const PERMIT2_ADDRESS = '0x0000000000000000000000000000000000000002';
const POOL_FACTORY_ADDRESS = '0x0000000000000000000000000000000000000003';
const QUOTER_V2_ADDRESS = '0x0000000000000000000000000000000000000004';
const ROUTER_QUOTER_V2_ADDRESS = '0x0000000000000000000000000000000000000005';

type RewardActionTrackerInternals = {
  feeTokenAmountMap: Map<string, BigNumber>;
  retryCountMap: Map<string, number>;
};

function asInternals(
  tracker: RewardActionTracker
): RewardActionTrackerInternals {
  return tracker as unknown as RewardActionTrackerInternals;
}

function createSigner(chainId = 1): Wallet {
  const signer = Wallet.createRandom();
  sinon.stub(signer, 'getChainId').resolves(chainId);
  return signer;
}

function createRewardActionKey(
  rewardAction: RewardAction,
  token: string
): string {
  return deterministicJsonStringify({ token, ...rewardAction });
}

// Helper function to create a mock KeeperConfig for testing
function createMockKeeperConfig(
  overrides: Partial<KeeperConfig> = {}
): KeeperConfig {
  return {
    // Required fields with mock values
    network: {
      rpcUrl: 'mock://rpc',
      subgraph: {
        url: 'mock://subgraph',
      },
    },
    signer: {
      keystore: '/path/to/mock-keystore.json',
    },
    runtime: {
      logLevel: 'info',
      delayBetweenRuns: 0,
      dryRun: true,
    },
    takers: {},
    manual: {
      pools: [],
    },
    pricing: {
      coinGeckoApiKey: 'mock-api-key',
    },
    ajna: {
      erc20PoolFactory: '0x0000000000000000000000000000000000000000',
      erc721PoolFactory: '0x0000000000000000000000000000000000000000',
      poolUtils: '0x0000000000000000000000000000000000000000',
      positionManager: '0x0000000000000000000000000000000000000000',
      ajnaToken: '0x0000000000000000000000000000000000000000',
      grantFund: '',
      burnWrapper: '',
      lenderHelper: '',
    },
    dex: {
      oneInch: {},
      uniswapV3: {
        legacy: {},
      },
    },
    // Apply any test-specific overrides
    ...overrides,
  };
}

describe('deterministicJsonStringify', () => {
  it('serializes a shallow object in a repeatable way', () => {
    const obj1: { [key: string]: string } = { hello: 'world' };
    obj1.foo = 'bar';
    const result1 = deterministicJsonStringify(obj1);
    const obj2: { [key: string]: string } = { foo: 'bar' };
    obj2.hello = 'world';
    const result2 = deterministicJsonStringify(obj1);
    expect(result1).equals(result2).equals('{"foo":"bar","hello":"world"}');
  });
});

describe('RewardActionTracker', () => {
  let dexRouter: { swap: SinonStub };

  beforeEach(() => {});

  afterEach(() => {
    sinon.restore();
  });

  it('Swaps to eth and clears entry after', async () => {
    const signer = Wallet.createRandom();
    sinon.stub(signer, 'getChainId').resolves(1);

    dexRouter = {
      swap: sinon.stub().resolves({ success: true }),
    } as unknown as { swap: SinonStub };
    const wethAddress = MAINNET_CONFIG.WETH_ADDRESS;
    const tokenToSwap = MAINNET_CONFIG.WBTC_USDC_POOL.collateralAddress;
    const et = new RewardActionTracker(
      signer,
      createMockKeeperConfig({
        network: {
          rpcUrl: 'mock://rpc',
          subgraph: { url: 'mock://subgraph' },
          tokenAddresses: { weth: wethAddress },
        },
        dex: {
          oneInch: {
            routers: { 1: '0x1111111254EEB25477B68fb85Ed929f73A960582' },
          },
        },
      }),
      dexRouter as unknown as DexRouter
    );

    const exchangeAction: RewardAction = {
      action: RewardActionLabel.EXCHANGE,
      address: tokenToSwap,
      targetToken: 'weth',
      slippage: 1,
      dexProvider: PostAuctionDex.ONEINCH,
      fee: FeeAmount.MEDIUM,
    };
    const amount = decimaledToWei(1);
    et.addToken(exchangeAction, tokenToSwap, amount);

    await et.handleAllTokens();
    await et.handleAllTokens();

    console.log('DexRouter swap call count:', dexRouter.swap.callCount);

    // The swap should have been called
    expect(dexRouter.swap.callCount).to.be.greaterThan(0);

    console.log('Actual call args:', dexRouter.swap.getCall(0).args);

    expect(dexRouter.swap.calledOnce).to.be.true;
    const callArgs = dexRouter.swap.getCall(0).args;
    expect(callArgs[0]).to.equal(1); // chainId
    expect(callArgs[1]).to.deep.equal(amount); // amount - use deep.equal for BigNumber
    expect(callArgs[2]).to.equal(tokenToSwap); // tokenIn
    expect(callArgs[3]).to.equal(wethAddress); // tokenOut
    expect(callArgs[4]).to.equal(signer.address); // to
    expect(callArgs[5]).to.equal(PostAuctionDex.ONEINCH); // dexProvider
    expect(callArgs[6]).to.equal(1); // slippage
    expect(callArgs[7]).to.equal(FeeAmount.MEDIUM); // feeAmount
    // Check the combinedSettings structure - will debug this based on console output
    console.log(
      'Combined settings (arg 8):',
      JSON.stringify(callArgs[8], null, 2)
    );
  });

  it('Handles swap failure properly with retries', async () => {
    const signer = Wallet.createRandom();
    sinon.stub(signer, 'getChainId').resolves(1);

    // Mock a dexRouter that fails with a resolved error response
    dexRouter = {
      swap: sinon.stub().resolves({ success: false, error: 'Swap failed' }),
    } as unknown as { swap: SinonStub };

    const wethAddress = MAINNET_CONFIG.WETH_ADDRESS;
    const tokenToSwap = MAINNET_CONFIG.WBTC_USDC_POOL.collateralAddress;

    const et = new RewardActionTracker(
      signer,
      createMockKeeperConfig({
        network: {
          rpcUrl: 'mock://rpc',
          subgraph: { url: 'mock://subgraph' },
          tokenAddresses: { weth: wethAddress },
        },
        dex: {
          oneInch: {
            routers: { 1: '0x1111111254EEB25477B68fb85Ed929f73A960582' },
          },
        },
      }),
      dexRouter as unknown as DexRouter
    );

    const exchangeAction: RewardAction = {
      action: RewardActionLabel.EXCHANGE,
      address: tokenToSwap,
      targetToken: 'weth',
      slippage: 1,
      dexProvider: PostAuctionDex.ONEINCH,
      fee: FeeAmount.MEDIUM,
    };

    const amount = decimaledToWei(1);
    et.addToken(exchangeAction, tokenToSwap, amount);

    // First call - should attempt but not throw error
    await et.handleAllTokens();
    expect(dexRouter.swap.calledOnce).to.be.true;

    // Verify token is still in queue for retries - reset the stub's history
    dexRouter.swap.resetHistory();

    // Second call - should attempt again
    await et.handleAllTokens();
    expect(dexRouter.swap.calledOnce).to.be.true;

    // Third call - should attempt again
    dexRouter.swap.resetHistory();
    await et.handleAllTokens();
    expect(dexRouter.swap.calledOnce).to.be.true;

    // After MAX_RETRY_COUNT (3), the token should be removed
    dexRouter.swap.resetHistory();
    await et.handleAllTokens();
    // No more calls should happen since token should be removed
    expect(dexRouter.swap.called).to.be.false;
  });

  it('uses universal router WETH as the reward target fallback', async () => {
    const signer = Wallet.createRandom();
    sinon.stub(signer, 'getChainId').resolves(1);

    dexRouter = {
      swap: sinon.stub().resolves({ success: true }),
    } as unknown as { swap: SinonStub };

    const wethAddress = MAINNET_CONFIG.WETH_ADDRESS;
    const tokenToSwap = MAINNET_CONFIG.WBTC_USDC_POOL.collateralAddress;
    const et = new RewardActionTracker(
      signer,
      createMockKeeperConfig({
        network: {
          rpcUrl: 'mock://rpc',
          subgraph: { url: 'mock://subgraph' },
        },
        dex: {
          uniswapV3: {
            universalRouter: {
              universalRouterAddress:
                '0x0000000000000000000000000000000000000001',
              permit2Address: '0x0000000000000000000000000000000000000002',
              poolFactoryAddress: '0x0000000000000000000000000000000000000003',
              quoterV2Address: '0x0000000000000000000000000000000000000004',
              wethAddress,
              defaultFeeTier: FeeAmount.MEDIUM,
            },
          },
        },
      }),
      dexRouter as unknown as DexRouter
    );

    const exchangeAction: RewardAction = {
      action: RewardActionLabel.EXCHANGE,
      address: tokenToSwap,
      targetToken: 'weth',
      slippage: 1,
      dexProvider: PostAuctionDex.UNISWAP_V3,
      fee: FeeAmount.MEDIUM,
    };

    et.addToken(exchangeAction, tokenToSwap, decimaledToWei(1));

    await et.handleAllTokens();

    const callArgs = dexRouter.swap.getCall(0).args;
    expect(callArgs[3]).to.equal(wethAddress);
    expect(callArgs[8].uniswap.wethAddress).to.equal(wethAddress);
  });

  it('removes exchange rewards without a dexProvider before swap execution', async () => {
    const signer = createSigner();
    dexRouter = {
      swap: sinon.stub().resolves({ success: true }),
    } as unknown as { swap: SinonStub };

    const tokenToSwap = MAINNET_CONFIG.WBTC_USDC_POOL.collateralAddress;
    const exchangeAction = {
      action: RewardActionLabel.EXCHANGE,
      address: tokenToSwap,
      targetToken: 'weth',
      slippage: 1,
    } as unknown as RewardAction;

    const et = new RewardActionTracker(
      signer,
      createMockKeeperConfig({
        network: {
          rpcUrl: 'mock://rpc',
          subgraph: { url: 'mock://subgraph' },
          tokenAddresses: { weth: MAINNET_CONFIG.WETH_ADDRESS },
        },
        dex: {
          oneInch: {
            routers: { 1: ONE_INCH_ROUTER },
          },
        },
      }),
      dexRouter as unknown as DexRouter
    );

    const amount = decimaledToWei(1);
    et.addToken(exchangeAction, tokenToSwap, amount);
    await et.handleAllTokens();

    const queuedAmount = asInternals(et).feeTokenAmountMap.get(
      createRewardActionKey(exchangeAction, tokenToSwap)
    );
    expect(dexRouter.swap.called).to.be.false;
    expect(queuedAmount?.isZero()).to.equal(true);
  });

  it('removes exchange rewards when DEX config validation fails', async () => {
    const signer = createSigner();
    dexRouter = {
      swap: sinon.stub().resolves({ success: true }),
    } as unknown as { swap: SinonStub };

    const tokenToSwap = MAINNET_CONFIG.WBTC_USDC_POOL.collateralAddress;
    const exchangeAction: RewardAction = {
      action: RewardActionLabel.EXCHANGE,
      address: tokenToSwap,
      targetToken: 'weth',
      slippage: 1,
      dexProvider: PostAuctionDex.UNISWAP_V3,
      fee: FeeAmount.MEDIUM,
    };

    const et = new RewardActionTracker(
      signer,
      createMockKeeperConfig({
        network: {
          rpcUrl: 'mock://rpc',
          subgraph: { url: 'mock://subgraph' },
          tokenAddresses: { weth: MAINNET_CONFIG.WETH_ADDRESS },
        },
        dex: {
          uniswapV3: {},
        },
      }),
      dexRouter as unknown as DexRouter
    );

    const amount = decimaledToWei(1);
    et.addToken(exchangeAction, tokenToSwap, amount);
    await et.handleAllTokens();

    const queuedAmount = asInternals(et).feeTokenAmountMap.get(
      createRewardActionKey(exchangeAction, tokenToSwap)
    );
    expect(dexRouter.swap.called).to.be.false;
    expect(queuedAmount?.isZero()).to.equal(true);
  });

  it('fails closed when a reward swap target cannot be resolved', async () => {
    const signer = createSigner();
    dexRouter = {
      swap: sinon.stub().resolves({ success: true }),
    } as unknown as { swap: SinonStub };

    const tokenToSwap = MAINNET_CONFIG.WBTC_USDC_POOL.collateralAddress;
    const exchangeAction: RewardAction = {
      action: RewardActionLabel.EXCHANGE,
      address: tokenToSwap,
      targetToken: 'missing-token',
      slippage: 1,
      dexProvider: PostAuctionDex.ONEINCH,
      fee: FeeAmount.MEDIUM,
    };

    const et = new RewardActionTracker(
      signer,
      createMockKeeperConfig({
        network: {
          rpcUrl: 'mock://rpc',
          subgraph: { url: 'mock://subgraph' },
          tokenAddresses: {},
        },
        dex: {
          oneInch: {
            routers: { 1: ONE_INCH_ROUTER },
          },
        },
      }),
      dexRouter as unknown as DexRouter
    );

    const amount = decimaledToWei(1);
    const key = createRewardActionKey(exchangeAction, tokenToSwap);
    et.addToken(exchangeAction, tokenToSwap, amount);

    await et.handleAllTokens();
    await et.handleAllTokens();
    await et.handleAllTokens();

    const internals = asInternals(et);
    expect(dexRouter.swap.called).to.be.false;
    expect(internals.retryCountMap.has(key)).to.equal(false);
    expect(internals.feeTokenAmountMap.get(key)?.isZero()).to.equal(true);
  });

  it('uses legacy Uniswap WETH as a reward swap target fallback', async () => {
    const signer = createSigner();
    dexRouter = {
      swap: sinon.stub().resolves({ success: true }),
    } as unknown as { swap: SinonStub };

    const wethAddress = MAINNET_CONFIG.WETH_ADDRESS;
    const tokenToSwap = MAINNET_CONFIG.WBTC_USDC_POOL.collateralAddress;
    const et = new RewardActionTracker(
      signer,
      createMockKeeperConfig({
        network: {
          rpcUrl: 'mock://rpc',
          subgraph: { url: 'mock://subgraph' },
        },
        dex: {
          oneInch: {
            routers: { 1: ONE_INCH_ROUTER },
          },
          uniswapV3: {
            legacy: {
              wethAddress,
            },
          },
        },
      }),
      dexRouter as unknown as DexRouter
    );

    const exchangeAction: RewardAction = {
      action: RewardActionLabel.EXCHANGE,
      address: tokenToSwap,
      targetToken: 'weth',
      slippage: 1,
      dexProvider: PostAuctionDex.ONEINCH,
      fee: FeeAmount.MEDIUM,
    };

    et.addToken(exchangeAction, tokenToSwap, decimaledToWei(1));
    await et.handleAllTokens();

    expect(dexRouter.swap.calledOnce).to.equal(true);
    expect(dexRouter.swap.getCall(0).args[3]).to.equal(wethAddress);
  });

  it('passes router-level QuoterV2 and default exchange options to Uniswap swaps', async () => {
    const signer = createSigner();
    dexRouter = {
      swap: sinon.stub().resolves({ success: true }),
    } as unknown as { swap: SinonStub };

    const wethAddress = MAINNET_CONFIG.WETH_ADDRESS;
    const tokenToSwap = MAINNET_CONFIG.WBTC_USDC_POOL.collateralAddress;
    const et = new RewardActionTracker(
      signer,
      createMockKeeperConfig({
        network: {
          rpcUrl: 'mock://rpc',
          subgraph: { url: 'mock://subgraph' },
        },
        dex: {
          uniswapV3: {
            universalRouter: {
              universalRouterAddress: UNIVERSAL_ROUTER_ADDRESS,
              permit2Address: PERMIT2_ADDRESS,
              poolFactoryAddress: POOL_FACTORY_ADDRESS,
              wethAddress,
              defaultFeeTier: FeeAmount.MEDIUM,
            },
            router: {
              quoterV2Address: ROUTER_QUOTER_V2_ADDRESS,
            },
          },
        },
      }),
      dexRouter as unknown as DexRouter
    );

    const exchangeAction = {
      action: RewardActionLabel.EXCHANGE,
      address: tokenToSwap,
      dexProvider: PostAuctionDex.UNISWAP_V3,
      feeAmount: FeeAmount.LOW,
    } as unknown as RewardAction;

    et.addToken(exchangeAction, tokenToSwap, decimaledToWei(1));
    await et.handleAllTokens();

    const callArgs = dexRouter.swap.getCall(0).args;
    expect(callArgs[3]).to.equal(wethAddress);
    expect(callArgs[6]).to.equal(1);
    expect(callArgs[7]).to.equal(FeeAmount.LOW);
    expect(callArgs[8].uniswap.quoterV2Address).to.equal(
      ROUTER_QUOTER_V2_ADDRESS
    );
  });

  it('transfers reward tokens after converting from WAD to token decimals', async () => {
    const signer = createSigner();
    const recipient = Wallet.createRandom().address;
    const tokenToTransfer = MAINNET_CONFIG.WBTC_USDC_POOL.collateralAddress;
    const decimalsStub = sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const transferStub = sinon
      .stub(erc20, 'transferErc20')
      .resolves({ transactionHash: '0xtransfer' } as any);

    dexRouter = {
      swap: sinon.stub().resolves({ success: true }),
    } as unknown as { swap: SinonStub };

    const et = new RewardActionTracker(
      signer,
      createMockKeeperConfig(),
      dexRouter as unknown as DexRouter
    );
    const transferAction: RewardAction = {
      action: RewardActionLabel.TRANSFER,
      to: recipient,
    };
    const amount = decimaledToWei(1);
    et.addToken(transferAction, tokenToTransfer, amount);

    await et.handleAllTokens();

    const queuedAmount = asInternals(et).feeTokenAmountMap.get(
      createRewardActionKey(transferAction, tokenToTransfer)
    );
    expect(decimalsStub.calledWith(signer, tokenToTransfer)).to.equal(true);
    expect(transferStub.calledOnce).to.equal(true);
    expect(transferStub.getCall(0).args[0]).to.equal(signer);
    expect(transferStub.getCall(0).args[1]).to.equal(tokenToTransfer);
    expect(transferStub.getCall(0).args[2]).to.equal(recipient);
    expect(transferStub.getCall(0).args[3]).to.deep.equal(
      BigNumber.from('1000000')
    );
    expect(queuedAmount?.isZero()).to.equal(true);
  });

  it('drops dust transfers that round to zero token units', async () => {
    const signer = createSigner();
    const recipient = Wallet.createRandom().address;
    const tokenToTransfer = MAINNET_CONFIG.WBTC_USDC_POOL.collateralAddress;
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const transferStub = sinon
      .stub(erc20, 'transferErc20')
      .resolves({ transactionHash: '0xtransfer' } as any);

    dexRouter = {
      swap: sinon.stub().resolves({ success: true }),
    } as unknown as { swap: SinonStub };

    const et = new RewardActionTracker(
      signer,
      createMockKeeperConfig(),
      dexRouter as unknown as DexRouter
    );
    const transferAction: RewardAction = {
      action: RewardActionLabel.TRANSFER,
      to: recipient,
    };
    const amount = BigNumber.from(1);
    et.addToken(transferAction, tokenToTransfer, amount);

    await et.handleAllTokens();

    const queuedAmount = asInternals(et).feeTokenAmountMap.get(
      createRewardActionKey(transferAction, tokenToTransfer)
    );
    expect(transferStub.called).to.equal(false);
    expect(queuedAmount?.isZero()).to.equal(true);
  });

  it('retries transfer errors and removes the reward after max attempts', async () => {
    const signer = createSigner();
    const recipient = Wallet.createRandom().address;
    const tokenToTransfer = MAINNET_CONFIG.WBTC_USDC_POOL.collateralAddress;
    sinon.stub(erc20, 'getDecimalsErc20').resolves(18);
    const transferStub = sinon
      .stub(erc20, 'transferErc20')
      .rejects(new Error('transfer failed'));

    dexRouter = {
      swap: sinon.stub().resolves({ success: true }),
    } as unknown as { swap: SinonStub };

    const et = new RewardActionTracker(
      signer,
      createMockKeeperConfig(),
      dexRouter as unknown as DexRouter
    );
    const transferAction: RewardAction = {
      action: RewardActionLabel.TRANSFER,
      to: recipient,
    };
    const amount = decimaledToWei(1);
    const key = createRewardActionKey(transferAction, tokenToTransfer);
    et.addToken(transferAction, tokenToTransfer, amount);

    await et.handleAllTokens();
    await et.handleAllTokens();
    await et.handleAllTokens();
    await et.handleAllTokens();

    const internals = asInternals(et);
    expect(transferStub.callCount).to.equal(3);
    expect(internals.retryCountMap.has(key)).to.equal(false);
    expect(internals.feeTokenAmountMap.get(key)?.isZero()).to.equal(true);
  });

  it('leaves unsupported reward actions queued without executing a swap', async () => {
    const signer = createSigner();
    dexRouter = {
      swap: sinon.stub().resolves({ success: true }),
    } as unknown as { swap: SinonStub };

    const token = MAINNET_CONFIG.WBTC_USDC_POOL.collateralAddress;
    const unsupportedAction = {
      action: 'unsupported',
    } as unknown as RewardAction;
    const amount = decimaledToWei(1);
    const et = new RewardActionTracker(
      signer,
      createMockKeeperConfig(),
      dexRouter as unknown as DexRouter
    );

    et.addToken(unsupportedAction, token, amount);
    await et.handleAllTokens();

    expect(dexRouter.swap.called).to.equal(false);
    expect(
      asInternals(et)
        .feeTokenAmountMap.get(createRewardActionKey(unsupportedAction, token))
        ?.eq(amount)
    ).to.equal(true);
  });

  it('cleans up queued rewards that already reached the retry ceiling', async () => {
    const signer = createSigner();
    dexRouter = {
      swap: sinon.stub().resolves({ success: true }),
    } as unknown as { swap: SinonStub };

    const tokenToSwap = MAINNET_CONFIG.WBTC_USDC_POOL.collateralAddress;
    const exchangeAction: RewardAction = {
      action: RewardActionLabel.EXCHANGE,
      address: tokenToSwap,
      targetToken: 'weth',
      slippage: 1,
      dexProvider: PostAuctionDex.ONEINCH,
      fee: FeeAmount.MEDIUM,
    };
    const amount = decimaledToWei(1);
    const key = createRewardActionKey(exchangeAction, tokenToSwap);
    const et = new RewardActionTracker(
      signer,
      createMockKeeperConfig(),
      dexRouter as unknown as DexRouter
    );
    const internals = asInternals(et);
    internals.feeTokenAmountMap.set(key, amount);
    internals.retryCountMap.set(key, 3);

    await et.handleAllTokens();

    expect(dexRouter.swap.called).to.equal(false);
    expect(internals.retryCountMap.has(key)).to.equal(false);
    expect(internals.feeTokenAmountMap.get(key)?.isZero()).to.equal(true);
  });

  it('rejects malformed queued reward keys before taking action', async () => {
    const signer = createSigner();
    dexRouter = {
      swap: sinon.stub().resolves({ success: true }),
    } as unknown as { swap: SinonStub };

    const et = new RewardActionTracker(
      signer,
      createMockKeeperConfig(),
      dexRouter as unknown as DexRouter
    );
    asInternals(et).feeTokenAmountMap.set(
      '{"action":"exchange","token":123}',
      decimaledToWei(1)
    );

    let thrown: Error | undefined;
    try {
      await et.handleAllTokens();
    } catch (error) {
      thrown = error as Error;
    }

    expect(dexRouter.swap.called).to.equal(false);
    expect(thrown?.message).to.match(/Could not deserialize token/);
  });

  it('records negative accounting when removing a missing queued reward', () => {
    const signer = createSigner();
    dexRouter = {
      swap: sinon.stub().resolves({ success: true }),
    } as unknown as { swap: SinonStub };

    const tokenToSwap = MAINNET_CONFIG.WBTC_USDC_POOL.collateralAddress;
    const exchangeAction: RewardAction = {
      action: RewardActionLabel.EXCHANGE,
      address: tokenToSwap,
      targetToken: 'weth',
      slippage: 1,
      dexProvider: PostAuctionDex.ONEINCH,
      fee: FeeAmount.MEDIUM,
    };
    const amount = decimaledToWei(1);
    const et = new RewardActionTracker(
      signer,
      createMockKeeperConfig(),
      dexRouter as unknown as DexRouter
    );

    et.removeToken(exchangeAction, tokenToSwap, amount);

    expect(
      asInternals(et)
        .feeTokenAmountMap.get(createRewardActionKey(exchangeAction, tokenToSwap))
        ?.eq(amount.mul(-1))
    ).to.equal(true);
  });
});
