import axios from 'axios';
import { BigNumber, Contract, ethers, providers, Signer } from 'ethers';
import sinon from 'sinon';
import { PostAuctionDex } from '../../../src/config';
import { DexRouter } from '../../../src/dex/router';
import { logger } from '../../../src/logging';
import { NonceTracker } from '../../../src/nonce';
import { MAINNET_CONFIG } from '../../integration/test-config';

export class CustomContract extends Contract {
  liquidity: sinon.SinonStub<any[], any>;
  slot0: sinon.SinonStub<any[], any>;
  decimals: sinon.SinonStub<any[], any>;
  exactInputSingle: sinon.SinonStub<any[], any>;
  hash: sinon.SinonStub<any[], any>;
  balanceOf: sinon.SinonStub<any[], any>;

  constructor(address: string, abi: any, provider: providers.Provider) {
    super(address, abi, provider);
    this.liquidity = sinon.stub();
    this.slot0 = sinon.stub();
    this.decimals = sinon.stub();
    this.exactInputSingle = sinon.stub();
    this.hash = sinon.stub();
    this.balanceOf = sinon.stub();
  }
}

export const DEX_ROUTER_FIXTURE = {
  chainId: 43114,
  amount: BigNumber.from('1000000000000000000'),
  tokenIn: MAINNET_CONFIG.WBTC_USDC_POOL.collateralAddress,
  tokenOut: MAINNET_CONFIG.WETH_ADDRESS,
  to: MAINNET_CONFIG.SOL_WETH_POOL.quoteWhaleAddress,
  fromAddress: '0x964d9D1A532B5a5DaeacBAc71d46320DE313AE9C',
  slippage: 1,
  feeAmount: 3000,
};

export interface DexRouterFixture {
  contractStub: CustomContract;
  signer: Signer;
  mockProvider: providers.JsonRpcProvider;
  dexRouter: DexRouter;
  axiosGetStub: sinon.SinonStub;
  loggerErrorStub: sinon.SinonStub;
}

export function installDexRouterFixture(): DexRouterFixture {
  const { chainId, tokenIn, fromAddress } = DEX_ROUTER_FIXTURE;
  process.env.ONEINCH_API = 'https://api.1inch.io/v5.0';
  process.env.ONEINCH_API_KEY = 'api_key';

  const mockProvider = new providers.JsonRpcProvider();
  mockProvider.estimateGas = sinon.stub().resolves(BigNumber.from('100000'));
  mockProvider.getResolver = sinon.stub().resolves(null);
  mockProvider.getNetwork = sinon
    .stub()
    .resolves({ chainId, name: 'mockNetwork' });

  mockProvider.call = sinon.stub().callsFake((tx) => {
    if (tx.data === '0x313ce567') {
      return ethers.utils.defaultAbiCoder.encode(['uint8'], [8]);
    }
    if (
      tx.data ===
      '0x70a08231' +
        ethers.utils.defaultAbiCoder.encode(['address'], [fromAddress]).slice(2)
    ) {
      return ethers.utils.defaultAbiCoder.encode(
        ['uint256'],
        [BigNumber.from('50000000')]
      );
    }
    throw new Error('Unexpected call');
  });

  const signer = {
    provider: mockProvider,
    getAddress: sinon.stub().resolves(fromAddress),
    sendTransaction: sinon.stub().resolves({ wait: sinon.stub().resolves({}) }),
  } as unknown as Signer;

  const contractStub = new CustomContract(tokenIn, [], mockProvider);
  sinon.stub(ethers, 'Contract').callsFake(() => contractStub);

  sinon
    .stub(NonceTracker, 'queueTransaction')
    .callsFake(async (_signer, txFunc) => {
      return await txFunc(10);
    });

  const dexRouter = new DexRouter(signer, {
    oneInchRouters: {
      1: '0x1111111254EEB25477B68fb85Ed929f73A960582',
      8453: '0x1111111254EEB25477B68fb85Ed929f73A960582',
      43114: '0x1111111254EEB25477B68fb85Ed929f73A960582',
    },
  });

  sinon.stub(logger, 'info');
  const loggerErrorStub = sinon.stub(logger, 'error');
  sinon.stub(logger, 'debug');

  const axiosGetStub = sinon.stub(axios, 'get').resolves({
    data: {
      tx: {
        to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
        data: '0xdata',
        value: '0',
        gas: '100000',
      },
    },
  });

  return {
    contractStub,
    signer,
    mockProvider,
    dexRouter,
    axiosGetStub,
    loggerErrorStub,
  };
}

export function stubOneInchTokenReads(
  mockProvider: providers.JsonRpcProvider,
  fromAddress: string
): void {
  (mockProvider.call as sinon.SinonStub).callsFake((tx) => {
    if (tx.data === '0x313ce567') {
      return ethers.utils.defaultAbiCoder.encode(['uint8'], [8]);
    }
    if (
      tx.data ===
      '0x70a08231' +
        ethers.utils.defaultAbiCoder.encode(['address'], [fromAddress]).slice(2)
    ) {
      return ethers.utils.defaultAbiCoder.encode(
        ['uint256'],
        [BigNumber.from('100000000')]
      );
    }
    throw new Error('Unexpected call');
  });
}

export { PostAuctionDex };
