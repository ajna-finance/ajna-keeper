import axios from 'axios';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { BigNumber, Contract, ethers, providers, Signer } from 'ethers';
import sinon from 'sinon';
import { DexRouter } from '../../src/dex/router';
import { CurvePoolType, PostAuctionDex } from '../../src/config';
import * as erc20 from '../../src/erc20';
import * as curveRouterModule from '../../src/dex/curve-router';
import * as universalRouterModule from '../../src/dex/universal-router';
import * as uniswapModule from '../../src/dex/uniswap';
import { MAINNET_CONFIG } from '../integration/test-config';
import { logger } from '../../src/logging';
import { NonceTracker } from '../../src/nonce';

chai.use(chaiAsPromised);

class CustomContract extends Contract {
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

describe('DexRouter', () => {
  let contractStub: CustomContract;
  let signer: Signer;
  let mockProvider: providers.JsonRpcProvider;
  let dexRouter: DexRouter;
  let axiosGetStub: sinon.SinonStub;
  let loggerErrorStub: sinon.SinonStub;

  const chainId = 43114;
  const amount = BigNumber.from('1000000000000000000');
  const tokenIn = MAINNET_CONFIG.WBTC_USDC_POOL.collateralAddress;
  const tokenOut = MAINNET_CONFIG.WETH_ADDRESS;
  const to = MAINNET_CONFIG.SOL_WETH_POOL.quoteWhaleAddress;
  const fromAddress = '0x964d9D1A532B5a5DaeacBAc71d46320DE313AE9C';
  const slippage = 1;
  const feeAmount = 3000;

  beforeEach(() => {
    process.env.ONEINCH_API = 'https://api.1inch.io/v5.0';
    process.env.ONEINCH_API_KEY = 'api_key';

    mockProvider = new providers.JsonRpcProvider();
    mockProvider.estimateGas = sinon.stub().resolves(BigNumber.from('100000'));
    mockProvider.getResolver = sinon.stub().resolves(null);
    mockProvider.getNetwork = sinon
      .stub()
      .resolves({ chainId: chainId, name: 'mockNetwork' });

    mockProvider.call = sinon.stub().callsFake((tx) => {
      if (tx.data === '0x313ce567') {
        return ethers.utils.defaultAbiCoder.encode(['uint8'], [8]);
      }
      if (
        tx.data ===
        '0x70a08231' +
          ethers.utils.defaultAbiCoder
            .encode(['address'], [fromAddress])
            .slice(2)
      ) {
        return ethers.utils.defaultAbiCoder.encode(
          ['uint256'],
          [BigNumber.from('50000000')]
        );
      }
      throw new Error('Unexpected call');
    });

    signer = {
      provider: mockProvider,
      getAddress: sinon.stub().resolves(fromAddress),
      sendTransaction: sinon
        .stub()
        .resolves({ wait: sinon.stub().resolves({}) }),
    } as unknown as Signer;

    contractStub = new CustomContract(tokenIn, [], mockProvider);
    sinon.stub(ethers, 'Contract').callsFake((address, abi, provider) => {
      return contractStub;
    });

    sinon
      .stub(NonceTracker, 'queueTransaction')
      .callsFake(async (signer, txFunc) => {
        // Simply execute the transaction function with a dummy nonce
        return await txFunc(10);
      });

    dexRouter = new DexRouter(signer, {
      oneInchRouters: {
        1: '0x1111111254EEB25477B68fb85Ed929f73A960582',
        8453: '0x1111111254EEB25477B68fb85Ed929f73A960582',
        43114: '0x1111111254EEB25477B68fb85Ed929f73A960582',
      },
    });

    sinon.stub(logger, 'info');
    loggerErrorStub = sinon.stub(logger, 'error');
    sinon.stub(logger, 'debug');

    axiosGetStub = sinon.stub(axios, 'get').resolves({
      data: {
        tx: {
          to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
          data: '0xdata',
          value: '0',
          gas: '100000',
        },
      },
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('constructor', () => {
    it('should log error if signer is undefined', () => {
      let threwError = false;
      try {
        new DexRouter(undefined as any);
      } catch (error) {
        threwError = true;
        expect((error as Error).message).to.include(
          "Cannot read properties of undefined (reading 'provider')"
        );
      }
      expect(threwError).to.be.true;
      expect(loggerErrorStub.calledWith('Signer is required')).to.be.true;
    });

    it('should log error if provider is unavailable', () => {
      const invalidSigner = { provider: undefined } as any;
      expect(() => new DexRouter(invalidSigner)).to.not.throw();
      expect(loggerErrorStub.calledWith('No provider available')).to.be.true;
    });
  });

  describe('swap', () => {
    function stubSwapPreconditions(
      decimals: number = 18,
      balance: BigNumber = amount
    ) {
      contractStub.balanceOf.withArgs(fromAddress).resolves(balance);
      (mockProvider.call as sinon.SinonStub).callsFake((tx) => {
        if (tx.data === '0x313ce567') {
          return ethers.utils.defaultAbiCoder.encode(['uint8'], [decimals]);
        }
        if (
          tx.data ===
          '0x70a08231' +
            ethers.utils.defaultAbiCoder
              .encode(['address'], [fromAddress])
              .slice(2)
        ) {
          return ethers.utils.defaultAbiCoder.encode(['uint256'], [balance]);
        }
        throw new Error('Unexpected call');
      });
      return sinon.stub(erc20, 'getDecimalsErc20').resolves(decimals);
    }

    it('should log error if amount is missing', async () => {
      const result = await dexRouter.swap(
        chainId,
        undefined as any,
        tokenIn,
        tokenOut,
        to,
        PostAuctionDex.UNISWAP_V3
      );
      expect(result.success).to.be.false;
      expect(result.error).to.equal('Invalid parameters provided to swap');
    });

    it('should log error if tokenIn is missing', async () => {
      const result = await dexRouter.swap(
        chainId,
        amount,
        undefined as any,
        tokenOut,
        to,
        PostAuctionDex.UNISWAP_V3
      );
      expect(result.success).to.be.false;
      expect(result.error).to.equal('Invalid parameters provided to swap');
    });

    it('should log error if tokenOut is missing', async () => {
      const result = await dexRouter.swap(
        chainId,
        amount,
        tokenIn,
        undefined as any,
        to,
        PostAuctionDex.UNISWAP_V3
      );
      expect(result.success).to.be.false;
      expect(result.error).to.equal('Invalid parameters provided to swap');
    });

    it('should log error if to is missing', async () => {
      const result = await dexRouter.swap(
        chainId,
        amount,
        tokenIn,
        tokenOut,
        undefined as any,
        PostAuctionDex.UNISWAP_V3
      );
      expect(result.success).to.be.false;
      expect(result.error).to.equal('Invalid parameters provided to swap');
    });

    it('returns success without touching balances when tokenIn already matches tokenOut', async () => {
      const getDecimalsStub = sinon.stub(erc20, 'getDecimalsErc20');

      const result = await dexRouter.swap(
        chainId,
        amount,
        tokenIn,
        tokenIn,
        to,
        PostAuctionDex.UNISWAP_V3
      );

      expect(result).to.deep.equal({ success: true });
      expect(getDecimalsStub.called).to.be.false;
      expect(contractStub.balanceOf.called).to.be.false;
    });

    it('fails closed when WAD input rounds to dust in token decimals', async () => {
      const getDecimalsStub = sinon
        .stub(erc20, 'getDecimalsErc20')
        .resolves(0);

      const result = await dexRouter.swap(
        chainId,
        BigNumber.from(1),
        tokenIn,
        tokenOut,
        to,
        PostAuctionDex.UNISWAP_V3
      );

      expect(result.success).to.be.false;
      expect(result.error).to.include('rounds to zero');
      expect(getDecimalsStub.calledOnce).to.be.true;
      expect(contractStub.balanceOf.called).to.be.false;
    });

    it('fails closed for unsupported DEX providers after preflight checks', async () => {
      stubSwapPreconditions(18, amount);

      const result = await dexRouter.swap(
        chainId,
        amount,
        tokenIn,
        tokenOut,
        to,
        'unsupported' as any
      );

      expect(result.success).to.be.false;
      expect(result.error).to.equal('Unsupported DEX provider: unsupported');
    });

    it('should log error if balance is insufficient', async () => {
      const erc20ContractStub = new CustomContract(tokenIn, [], mockProvider);
      erc20ContractStub.balanceOf
        .withArgs(fromAddress)
        .resolves(BigNumber.from('50000000'));
      sinon.stub(ethers, 'Contract').callsFake((address, abi, provider) => {
        if (address === tokenIn) return erc20ContractStub;
        throw new Error(`Unexpected contract address: ${address}`);
      });

      const getDecimalsStub = sinon.stub(erc20, 'getDecimalsErc20').resolves(8);

      const result = await dexRouter.swap(
        chainId,
        amount,
        tokenIn,
        tokenOut,
        to,
        PostAuctionDex.UNISWAP_V3
      );

      expect(result.success).to.be.false;
      expect(result.error).to.equal(`Insufficient balance for ${tokenIn}`);
      expect(getDecimalsStub.calledOnce).to.be.true;
    });

    it('fails closed when 1inch is selected without a configured router for the chain', async () => {
      stubSwapPreconditions(8, BigNumber.from('100000000'));
      const routerWithoutOneInch = new DexRouter(signer);

      const result = await routerWithoutOneInch.swap(
        chainId,
        amount,
        tokenIn,
        tokenOut,
        to,
        PostAuctionDex.ONEINCH,
        slippage,
        feeAmount
      );

      expect(result.success).to.be.false;
      expect(result.error).to.equal(
        `No 1inch router defined for chainId ${chainId}`
      );
      expect(axiosGetStub.called).to.be.false;
    });

    it('routes Universal Router swaps with slippage converted to basis points', async () => {
      stubSwapPreconditions(8, BigNumber.from('100000000'));
      const universalRouterStub = sinon
        .stub(universalRouterModule, 'swapWithUniversalRouter')
        .resolves({ success: true } as any);

      const result = await dexRouter.swap(
        chainId,
        amount,
        tokenIn,
        tokenOut,
        to,
        PostAuctionDex.UNISWAP_V3,
        1.25,
        feeAmount,
        {
          uniswap: {
            universalRouterAddress: '0x1111111111111111111111111111111111111111',
            permit2Address: '0x2222222222222222222222222222222222222222',
            poolFactoryAddress: '0x3333333333333333333333333333333333333333',
            quoterV2Address: '0x4444444444444444444444444444444444444444',
            defaultFeeTier: 500,
          },
        }
      );

      expect(result.success).to.be.true;
      expect(universalRouterStub.calledOnce).to.be.true;
      expect(universalRouterStub.firstCall.args.slice(1)).to.deep.equal([
        tokenIn,
        BigNumber.from('100000000'),
        tokenOut,
        125,
        '0x1111111111111111111111111111111111111111',
        '0x2222222222222222222222222222222222222222',
        500,
        '0x3333333333333333333333333333333333333333',
        '0x4444444444444444444444444444444444444444',
      ]);
    });

    it('surfaces Universal Router failures without falling back to another path', async () => {
      stubSwapPreconditions(8, BigNumber.from('100000000'));
      sinon
        .stub(universalRouterModule, 'swapWithUniversalRouter')
        .rejects(new Error('universal router rejected'));
      const swapToWethStub = sinon.stub(uniswapModule, 'swapToWeth');

      const result = await dexRouter.swap(
        chainId,
        amount,
        tokenIn,
        tokenOut,
        to,
        PostAuctionDex.UNISWAP_V3,
        slippage,
        feeAmount,
        {
          uniswap: {
            universalRouterAddress: '0x1111111111111111111111111111111111111111',
            permit2Address: '0x2222222222222222222222222222222222222222',
            poolFactoryAddress: '0x3333333333333333333333333333333333333333',
          },
        }
      );

      expect(result.success).to.be.false;
      expect(result.error).to.include('Universal Router swap failed');
      expect(swapToWethStub.called).to.be.false;
    });

    it('uses the legacy Uniswap V3 path when Universal Router config is incomplete', async () => {
      stubSwapPreconditions(8, BigNumber.from('100000000'));
      const swapToWethStub = sinon
        .stub(uniswapModule, 'swapToWeth')
        .resolves({ success: true } as any);

      const result = await dexRouter.swap(
        chainId,
        amount,
        tokenIn,
        tokenOut,
        to,
        PostAuctionDex.UNISWAP_V3,
        slippage,
        feeAmount,
        {
          uniswap: {
            universalRouterAddress: '0x1111111111111111111111111111111111111111',
          },
        }
      );

      expect(result.success).to.be.true;
      expect(swapToWethStub.calledOnce).to.be.true;
      expect(swapToWethStub.firstCall.args).to.deep.equal([
        signer,
        tokenIn,
        BigNumber.from('100000000'),
        feeAmount,
        slippage,
        {
          universalRouterAddress: '0x1111111111111111111111111111111111111111',
        },
      ]);
    });

    it('requires Curve settings when Curve is selected', async () => {
      stubSwapPreconditions(8, BigNumber.from('100000000'));

      const result = await dexRouter.swap(
        chainId,
        amount,
        tokenIn,
        tokenOut,
        to,
        PostAuctionDex.CURVE,
        slippage,
        feeAmount
      );

      expect(result).to.deep.equal({
        success: false,
        error: 'Curve configuration not found',
      });
    });

    it('fails closed when no Curve pool matches the token pair', async () => {
      stubSwapPreconditions(8, BigNumber.from('100000000'));
      const curveRouter = new DexRouter(signer, {
        tokenAddresses: {
          WBTC: tokenIn,
          WETH: tokenOut,
        },
      });

      const result = await curveRouter.swap(
        chainId,
        amount,
        tokenIn,
        tokenOut,
        to,
        PostAuctionDex.CURVE,
        slippage,
        feeAmount,
        {
          curve: {
            poolConfigs: {},
          },
        }
      );

      expect(result.success).to.be.false;
      expect(result.error).to.include('No Curve pool configured');
    });

    it('routes Curve swaps through the configured pool for the token pair', async () => {
      stubSwapPreconditions(8, BigNumber.from('100000000'));
      const curveSwapStub = sinon
        .stub(curveRouterModule, 'swapWithCurveRouter')
        .resolves({ success: true } as any);
      const curveRouter = new DexRouter(signer, {
        tokenAddresses: {
          WBTC: tokenIn,
          WETH: tokenOut,
        },
      });

      const result = await curveRouter.swap(
        chainId,
        amount,
        tokenIn,
        tokenOut,
        to,
        PostAuctionDex.CURVE,
        0.75,
        feeAmount,
        {
          curve: {
            defaultSlippage: 0.5,
            poolConfigs: {
              'WBTC-WETH': {
                address: '0x5555555555555555555555555555555555555555',
                poolType: CurvePoolType.STABLE,
              },
            },
          },
        }
      );

      expect(result.success).to.be.true;
      expect(curveSwapStub.calledOnce).to.be.true;
      expect(curveSwapStub.firstCall.args).to.deep.equal([
        signer,
        tokenIn,
        BigNumber.from('100000000'),
        tokenOut,
        0.75,
        '0x5555555555555555555555555555555555555555',
        CurvePoolType.STABLE,
        0.5,
      ]);
    });

    it('requires Curve pool configurations when Curve settings are present', async () => {
      stubSwapPreconditions(8, BigNumber.from('100000000'));

      const result = await dexRouter.swap(
        chainId,
        amount,
        tokenIn,
        tokenOut,
        to,
        PostAuctionDex.CURVE,
        slippage,
        feeAmount,
        {
          curve: {},
        }
      );

      expect(result).to.deep.equal({
        success: false,
        error: 'Curve pool configurations not found',
      });
    });

    it('surfaces Curve router execution failures', async () => {
      stubSwapPreconditions(8, BigNumber.from('100000000'));
      sinon
        .stub(curveRouterModule, 'swapWithCurveRouter')
        .rejects(new Error('curve execution reverted'));
      const curveRouter = new DexRouter(signer, {
        tokenAddresses: {
          WBTC: tokenIn,
          WETH: tokenOut,
        },
      });

      const result = await curveRouter.swap(
        chainId,
        amount,
        tokenIn,
        tokenOut,
        to,
        PostAuctionDex.CURVE,
        slippage,
        feeAmount,
        {
          curve: {
            poolConfigs: {
              'WBTC-WETH': {
                address: '0x5555555555555555555555555555555555555555',
                poolType: CurvePoolType.STABLE,
              },
            },
          },
        }
      );

      expect(result.success).to.be.false;
      expect(result.error).to.include('Curve swap failed');
    });

    it('returns undefined when Curve token symbols cannot be resolved', () => {
      expect(dexRouter.getTokenSymbolFromAddress(tokenIn)).to.be.undefined;
      expect(
        dexRouter.getCurvePoolForTokenPair(tokenIn, tokenOut, {
          'WBTC-WETH': {
            address: '0x5555555555555555555555555555555555555555',
            poolType: CurvePoolType.STABLE,
          },
        })
      ).to.be.undefined;
    });

    it('surfaces legacy Uniswap V3 failures', async () => {
      stubSwapPreconditions(8, BigNumber.from('100000000'));
      sinon
        .stub(uniswapModule, 'swapToWeth')
        .rejects(new Error('legacy swap reverted'));

      const result = await dexRouter.swap(
        chainId,
        amount,
        tokenIn,
        tokenOut,
        to,
        PostAuctionDex.UNISWAP_V3,
        slippage,
        feeAmount
      );

      expect(result.success).to.be.false;
      expect(result.error).to.include('Uniswap swap failed');
    });

    describe('useOneInch = true', () => {
      beforeEach(() => {
        (mockProvider.call as sinon.SinonStub).callsFake((tx) => {
          if (tx.data === '0x313ce567') {
            return ethers.utils.defaultAbiCoder.encode(['uint8'], [8]);
          }
          if (
            tx.data ===
            '0x70a08231' +
              ethers.utils.defaultAbiCoder
                .encode(['address'], [fromAddress])
                .slice(2)
          ) {
            return ethers.utils.defaultAbiCoder.encode(
              ['uint256'],
              [BigNumber.from('100000000')] // 1 WBTC
            );
          }
          throw new Error('Unexpected call');
        });
      });

      it('should approve token if allowance is insufficient', async () => {
        const erc20ContractStub = new CustomContract(tokenIn, [], mockProvider);
        erc20ContractStub.balanceOf
          .withArgs(fromAddress)
          .resolves(BigNumber.from('100000000')); // 1 WBTC
        sinon.stub(ethers, 'Contract').callsFake((address, abi, provider) => {
          if (address === tokenIn) return erc20ContractStub;
          throw new Error(`Unexpected contract address: ${address}`);
        });

        const getDecimalsStub = sinon
          .stub(erc20, 'getDecimalsErc20')
          .resolves(8);
        const getAllowanceStub = sinon
          .stub(erc20, 'getAllowanceOfErc20')
          .resolves(BigNumber.from('1'));
        const approveStub = sinon.stub(erc20, 'approveErc20').resolves();

        axiosGetStub
          .onCall(0)
          .resolves({ data: { dstAmount: '900000000000000000' } });
        axiosGetStub.onCall(1).resolves({
          data: {
            tx: {
              to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
              data: '0xdata',
              value: '0',
              gas: '100000',
            },
          },
        });

        const result = await dexRouter.swap(
          chainId,
          amount,
          tokenIn,
          tokenOut,
          to,
          PostAuctionDex.ONEINCH,
          slippage,
          feeAmount
        );

        console.log('Result (approve insufficient):', result);
        if (!result.success) {
          console.log('Error details (approve insufficient):', result.error);
        }

        expect(result.success).to.be.true;
        expect(getDecimalsStub.calledOnce).to.be.true;
        expect(getAllowanceStub.calledOnce).to.be.true;
        expect(approveStub.calledOnce).to.be.true;
      });

      it('should skip approval if allowance is sufficient', async () => {
        const erc20ContractStub = new CustomContract(tokenIn, [], mockProvider);
        erc20ContractStub.balanceOf
          .withArgs(fromAddress)
          .resolves(BigNumber.from('100000000')); // 1 WBTC
        sinon.stub(ethers, 'Contract').callsFake((address, abi, provider) => {
          if (address === tokenIn) return erc20ContractStub;
          throw new Error(`Unexpected contract address: ${address}`);
        });

        const getDecimalsStub = sinon
          .stub(erc20, 'getDecimalsErc20')
          .resolves(8);
        const getAllowanceStub = sinon
          .stub(erc20, 'getAllowanceOfErc20')
          .resolves(BigNumber.from('100000000')); // 1 WBTC
        const approveStub = sinon.stub(erc20, 'approveErc20');

        axiosGetStub
          .onCall(0)
          .resolves({ data: { dstAmount: '900000000000000000' } });
        axiosGetStub.onCall(1).resolves({
          data: {
            tx: {
              to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
              data: '0xdata',
              value: '0',
              gas: '100000',
            },
          },
        });

        const result = await dexRouter.swap(
          chainId,
          amount,
          tokenIn,
          tokenOut,
          to,
          PostAuctionDex.ONEINCH,
          slippage,
          feeAmount
        );

        console.log('Result (skip approval):', result);
        if (!result.success) {
          console.log('Error details (skip approval):', result.error);
        }

        expect(result.success).to.be.true;
        expect(getDecimalsStub.calledOnce).to.be.true;
        expect(approveStub.notCalled).to.be.true;
      });

      it('should log error if approval fails', async () => {
        const erc20ContractStub = new CustomContract(tokenIn, [], mockProvider);
        erc20ContractStub.balanceOf
          .withArgs(fromAddress)
          .resolves(BigNumber.from('100000000')); // 1 WBTC
        sinon.stub(ethers, 'Contract').callsFake((address, abi, provider) => {
          if (address === tokenIn) return erc20ContractStub;
          throw new Error(`Unexpected contract address: ${address}`);
        });

        const getDecimalsStub = sinon
          .stub(erc20, 'getDecimalsErc20')
          .resolves(8);
        const getAllowanceStub = sinon
          .stub(erc20, 'getAllowanceOfErc20')
          .resolves(BigNumber.from('0'));
        const approveStub = sinon
          .stub(erc20, 'approveErc20')
          .rejects(new Error('Approval failed'));

        const result = await dexRouter.swap(
          chainId,
          amount,
          tokenIn,
          tokenOut,
          to,
          PostAuctionDex.ONEINCH,
          slippage,
          feeAmount
        );

        expect(result.success).to.be.false;
        expect(result.error).to.include('Approval failed');
        expect(getDecimalsStub.calledOnce).to.be.true;
      });

      it('should call swapWithOneInch and execute transaction', async () => {
        const erc20ContractStub = new CustomContract(tokenIn, [], mockProvider);
        erc20ContractStub.balanceOf
          .withArgs(fromAddress)
          .resolves(BigNumber.from('100000000')); // 1 WBTC
        sinon.stub(ethers, 'Contract').callsFake((address, abi, provider) => {
          if (address === tokenIn) return erc20ContractStub;
          throw new Error(`Unexpected contract address: ${address}`);
        });

        const getDecimalsStub = sinon
          .stub(erc20, 'getDecimalsErc20')
          .resolves(8);
        const getAllowanceStub = sinon
          .stub(erc20, 'getAllowanceOfErc20')
          .resolves(BigNumber.from('100000000')); // 1 WBTC

        axiosGetStub
          .onCall(0)
          .resolves({ data: { dstAmount: '900000000000000000' } });
        axiosGetStub.onCall(1).resolves({
          data: {
            tx: {
              to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
              data: '0xdata',
              value: '0',
              gas: '100000',
            },
          },
        });

        const result = await dexRouter.swap(
          chainId,
          amount,
          tokenIn,
          tokenOut,
          to,
          PostAuctionDex.ONEINCH,
          slippage,
          feeAmount
        );

        console.log('Result (execute transaction):', result);
        if (!result.success) {
          console.log('Error details (execute transaction):', result.error);
        }

        expect(result.success).to.be.true;
        expect(axiosGetStub.calledTwice).to.be.true;
        expect(getDecimalsStub.calledOnce).to.be.true;

        expect(
          axiosGetStub
            .getCall(0)
            .calledWith(`${process.env.ONEINCH_API}/${chainId}/quote`, {
              params: {
                fromTokenAddress: tokenIn,
                toTokenAddress: tokenOut,
                amount: '100000000',
              },
              timeout: undefined,
              headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${process.env.ONEINCH_API_KEY}`,
              },
            })
        ).to.be.true;

        expect(
          axiosGetStub
            .getCall(1)
            .calledWith(`${process.env.ONEINCH_API}/${chainId}/swap`, {
              params: {
                fromTokenAddress: tokenIn,
                toTokenAddress: tokenOut,
                amount: '100000000',
                fromAddress,
                slippage,
              },
              timeout: undefined,
              headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${process.env.ONEINCH_API_KEY}`,
              },
            })
        ).to.be.true;
      });
    });
  });

  describe('swapWithOneInch', () => {
    beforeEach(() => {
      (mockProvider.call as sinon.SinonStub).callsFake((tx) => {
        if (tx.data === '0x313ce567') {
          return ethers.utils.defaultAbiCoder.encode(['uint8'], [8]);
        }
        if (
          tx.data ===
          '0x70a08231' +
            ethers.utils.defaultAbiCoder
              .encode(['address'], [fromAddress])
              .slice(2)
        ) {
          return ethers.utils.defaultAbiCoder.encode(
            ['uint256'],
            [BigNumber.from('100000000')]
          );
        }
        throw new Error('Unexpected call');
      });
    });

    it('should execute swap with 1inch successfully', async () => {
      axiosGetStub.onCall(0).resolves({
        data: {
          dstAmount: '900000000000000000',
          toTokenAmount: '900000000000000000',
          protocols: [],
        },
      });
      axiosGetStub.onCall(1).resolves({
        data: {
          tx: {
            to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
            data: '0xdata',
            value: '0',
            gas: '100000',
          },
        },
      });

      const result = await dexRouter['swapWithOneInch'](
        chainId,
        BigNumber.from('100000000'),
        tokenIn,
        tokenOut,
        slippage
      );

      console.log('Result (1inch swap):', result);
      if (!result.success) {
        console.log('Error details (1inch swap):', result.error);
      }

      expect(result.success).to.be.true;
      expect(axiosGetStub.calledTwice).to.be.true;

      expect(
        axiosGetStub
          .getCall(0)
          .calledWith(`${process.env.ONEINCH_API}/${chainId}/quote`, {
            params: {
              fromTokenAddress: tokenIn,
              toTokenAddress: tokenOut,
              amount: '100000000',
            },
            timeout: undefined,
            headers: {
              Accept: 'application/json',
              Authorization: `Bearer ${process.env.ONEINCH_API_KEY}`,
            },
          })
      ).to.be.true;

      expect(
        axiosGetStub
          .getCall(1)
          .calledWith(`${process.env.ONEINCH_API}/${chainId}/swap`, {
            params: {
              fromTokenAddress: tokenIn,
              toTokenAddress: tokenOut,
              amount: '100000000',
              fromAddress,
              slippage,
            },
            timeout: undefined,
            headers: {
              Accept: 'application/json',
              Authorization: `Bearer ${process.env.ONEINCH_API_KEY}`,
            },
          })
      ).to.be.true;
    });

    it('ignores gasPrice supplied by 1inch swap data', async () => {
      axiosGetStub.onCall(0).resolves({
        data: {
          dstAmount: '900000000000000000',
          toTokenAmount: '900000000000000000',
          protocols: [],
        },
      });
      axiosGetStub.onCall(1).resolves({
        data: {
          tx: {
            to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
            data: '0xdata',
            value: '0',
            gas: '100000',
            gasPrice: '1000000000000',
          },
        },
      });

      const result = await dexRouter['swapWithOneInch'](
        chainId,
        BigNumber.from('100000000'),
        tokenIn,
        tokenOut,
        slippage
      );

      expect(result.success).to.be.true;
      const sentTx = (signer.sendTransaction as sinon.SinonStub).firstCall
        .args[0];
      expect(sentTx.gasPrice).to.be.undefined;
    });

    it('should log error if axios fails', async () => {
      axiosGetStub.rejects(new Error('API error'));

      const result = await dexRouter['swapWithOneInch'](
        chainId,
        amount,
        tokenIn,
        tokenOut,
        slippage
      );

      expect(result).to.deep.equal({ success: false, error: 'API error' });
    });

    it('classifies timed-out 1inch quote requests as retryable', async () => {
      const timeoutError = new Error('timeout of 2000ms exceeded') as Error & {
        code: string;
      };
      timeoutError.code = 'ECONNABORTED';
      axiosGetStub.rejects(timeoutError);

      const result = await dexRouter.getQuoteFromOneInch(
        chainId,
        amount,
        tokenIn,
        tokenOut,
        { timeoutMs: 2000 }
      );

      expect(result.success).to.be.false;
      expect(result.retryable).to.be.true;
      expect(result.errorCode).to.equal('ECONNABORTED');
      expect(axiosGetStub.firstCall.args[1].timeout).to.equal(2000);
    });

    it('fails 1inch quote requests before calling the API when env is missing', async () => {
      delete process.env.ONEINCH_API_KEY;

      const result = await dexRouter.getQuoteFromOneInch(
        chainId,
        amount,
        tokenIn,
        tokenOut
      );

      expect(result).to.deep.include({
        success: false,
        retryable: false,
        errorCode: 'missing_oneinch_env',
      });
      expect(axiosGetStub.called).to.be.false;
    });

    it('fails 1inch swap-data requests before calling the API when env is missing', async () => {
      delete process.env.ONEINCH_API;

      const result = await dexRouter.getSwapDataFromOneInch(
        chainId,
        amount,
        tokenIn,
        tokenOut,
        slippage,
        fromAddress
      );

      expect(result).to.deep.include({
        success: false,
        retryable: false,
        errorCode: 'missing_oneinch_env',
      });
      expect(axiosGetStub.called).to.be.false;
    });

    it('passes connector tokens, timeout, and abort signal to 1inch quote requests', async () => {
      const controller = new AbortController();
      const routerWithConnectors = new DexRouter(signer, {
        oneInchRouters: {
          [chainId]: '0x1111111254EEB25477B68fb85Ed929f73A960582',
        },
        connectorTokens: [tokenOut, to],
      });
      axiosGetStub.resolves({
        data: {
          dstAmount: '900000000000000000',
        },
      });

      const result = await routerWithConnectors.getQuoteFromOneInch(
        chainId,
        amount,
        tokenIn,
        tokenOut,
        { timeoutMs: 2500, signal: controller.signal }
      );

      expect(result.success).to.be.true;
      expect(axiosGetStub.firstCall.args[1]).to.deep.include({
        timeout: 2500,
        signal: controller.signal,
      });
      expect(axiosGetStub.firstCall.args[1].params.connectorTokens).to.equal(
        `${tokenOut},${to}`
      );
    });

    it('passes connector tokens and patching flags to 1inch swap-data requests', async () => {
      const controller = new AbortController();
      const routerWithConnectors = new DexRouter(signer, {
        oneInchRouters: {
          [chainId]: '0x1111111254EEB25477B68fb85Ed929f73A960582',
        },
        connectorTokens: [tokenOut, to],
      });
      axiosGetStub.resolves({
        data: {
          tx: {
            to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
            data: '0xdata',
            value: '0',
          },
        },
      });

      const result = await routerWithConnectors.getSwapDataFromOneInch(
        chainId,
        amount,
        tokenIn,
        tokenOut,
        slippage,
        fromAddress,
        true,
        { signal: controller.signal }
      );

      expect(result.success).to.be.true;
      expect(axiosGetStub.firstCall.args[1].signal).to.equal(
        controller.signal
      );
      expect(axiosGetStub.firstCall.args[1].params).to.deep.include({
        connectorTokens: `${tokenOut},${to}`,
        usePatching: true,
        disableEstimate: true,
      });
    });

    it('rejects malformed 1inch quote amounts before callers parse them', async () => {
      axiosGetStub.resolves({
        data: {
          dstAmount: '1e18',
        },
      });

      const result = await dexRouter.getQuoteFromOneInch(
        chainId,
        amount,
        tokenIn,
        tokenOut
      );

      expect(result.success).to.be.false;
      expect(result.error).to.include('dstAmount is not a decimal uint string');
    });

    it('rejects 1inch quote amounts that exceed uint256', async () => {
      axiosGetStub.resolves({
        data: {
          dstAmount: ethers.constants.MaxUint256.add(1).toString(),
        },
      });

      const result = await dexRouter.getQuoteFromOneInch(
        chainId,
        amount,
        tokenIn,
        tokenOut
      );

      expect(result.success).to.be.false;
      expect(result.error).to.include('dstAmount exceeds uint256');
    });

    it('classifies 1inch response status and code failures without losing API descriptions', async () => {
      const cases: Array<{
        error: any;
        retryable: boolean;
        errorCode: number | string;
      }> = [
        {
          error: {
            response: {
              status: 429,
              data: { description: 'rate limited' },
            },
          },
          retryable: true,
          errorCode: 429,
        },
        {
          error: {
            response: {
              status: 503,
              data: { description: 'upstream unavailable' },
            },
          },
          retryable: true,
          errorCode: 503,
        },
        {
          error: {
            response: {
              status: 400,
              data: { description: 'bad request' },
            },
            code: 'ETIMEDOUT',
          },
          retryable: true,
          errorCode: 400,
        },
        {
          error: {
            response: {
              status: 400,
              data: { description: 'permanent rejection' },
            },
          },
          retryable: false,
          errorCode: 400,
        },
      ];

      for (const testCase of cases) {
        axiosGetStub.reset();
        axiosGetStub.rejects(testCase.error);

        const result = await dexRouter.getQuoteFromOneInch(
          chainId,
          amount,
          tokenIn,
          tokenOut
        );

        expect(result.success).to.be.false;
        expect(result.error).to.equal(testCase.error.response.data.description);
        expect(result.retryable).to.equal(testCase.retryable);
        expect(result.errorCode).to.equal(testCase.errorCode);
      }
    });

    it('rejects 1inch swap data without a complete transaction payload', async () => {
      axiosGetStub.resolves({
        data: {
          tx: {
            to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
          },
        },
      });

      const result = await dexRouter.getSwapDataFromOneInch(
        chainId,
        amount,
        tokenIn,
        tokenOut,
        slippage,
        fromAddress
      );

      expect(result.success).to.be.false;
      expect(result.error).to.equal('No valid transaction received from 1inch');
    });

    it('rejects 1inch swap data when the configured router is missing or malformed', async () => {
      axiosGetStub.resolves({
        data: {
          tx: {
            to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
            data: '0xdata',
            value: '0',
          },
        },
      });

      const resultWithoutRouter = await new DexRouter(
        signer
      ).getSwapDataFromOneInch(
        chainId,
        amount,
        tokenIn,
        tokenOut,
        slippage,
        fromAddress
      );

      expect(resultWithoutRouter.success).to.be.false;
      expect(resultWithoutRouter.error).to.include('router validation failed');

      const resultWithMalformedRouter = await new DexRouter(signer, {
        oneInchRouters: {
          [chainId]: 'not-an-address',
        },
      }).getSwapDataFromOneInch(
        chainId,
        amount,
        tokenIn,
        tokenOut,
        slippage,
        fromAddress
      );

      expect(resultWithMalformedRouter.success).to.be.false;
      expect(resultWithMalformedRouter.error).to.include(
        'router validation failed'
      );
    });

    it('rejects 1inch swap data with a malformed tx target address', async () => {
      axiosGetStub.resolves({
        data: {
          tx: {
            to: 'not-an-address',
            data: '0xdata',
            value: '0',
          },
        },
      });

      const result = await dexRouter.getSwapDataFromOneInch(
        chainId,
        amount,
        tokenIn,
        tokenOut,
        slippage,
        fromAddress
      );

      expect(result.success).to.be.false;
      expect(result.error).to.include('router validation failed');
    });

    it('rejects 1inch swap data when tx.to is not the configured router', async () => {
      axiosGetStub.resolves({
        data: {
          tx: {
            to: '0x9999999999999999999999999999999999999999',
            data: '0xdata',
            value: '0',
            gas: '100000',
          },
        },
      });

      const result = await dexRouter.getSwapDataFromOneInch(
        chainId,
        amount,
        tokenIn,
        tokenOut,
        slippage,
        fromAddress
      );

      expect(result.success).to.be.false;
      expect(result.error).to.include('does not match configured router');
    });

    it('rejects 1inch swap data with non-zero native tx.value', async () => {
      axiosGetStub.resolves({
        data: {
          tx: {
            to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
            data: '0xdata',
            value: '1',
            gas: '100000',
          },
        },
      });

      const result = await dexRouter.getSwapDataFromOneInch(
        chainId,
        amount,
        tokenIn,
        tokenOut,
        slippage,
        fromAddress
      );

      expect(result.success).to.be.false;
      expect(result.error).to.include('unexpected non-zero 1inch tx.value');
    });

    for (const zeroValue of [undefined, null, '', BigNumber.from(0), 0]) {
      it(`accepts zero 1inch native tx.value ${String(zeroValue)}`, async () => {
        const tx: any = {
          to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
          data: '0xdata',
        };
        if (zeroValue !== undefined) {
          tx.value = zeroValue;
        }
        axiosGetStub.resolves({
          data: {
            tx,
          },
        });

        const result = await dexRouter.getSwapDataFromOneInch(
          chainId,
          amount,
          tokenIn,
          tokenOut,
          slippage,
          fromAddress
        );

        expect(result.success).to.be.true;
      });
    }

    for (const invalidValue of [
      BigNumber.from(-1),
      BigNumber.from(1),
      ethers.constants.MaxUint256.add(1),
      -1,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      it(`rejects unsafe 1inch native tx.value ${invalidValue.toString()}`, async () => {
        axiosGetStub.resolves({
          data: {
            tx: {
              to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
              data: '0xdata',
              value: invalidValue,
            },
          },
        });

        const result = await dexRouter.getSwapDataFromOneInch(
          chainId,
          amount,
          tokenIn,
          tokenOut,
          slippage,
          fromAddress
        );

        expect(result.success).to.be.false;
        expect(result.error).to.include('1inch tx.value');
      });
    }

    it('rejects 1inch swap data with negative native tx.value', async () => {
      axiosGetStub.resolves({
        data: {
          tx: {
            to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
            data: '0xdata',
            value: '-1',
            gas: '100000',
          },
        },
      });

      const result = await dexRouter.getSwapDataFromOneInch(
        chainId,
        amount,
        tokenIn,
        tokenOut,
        slippage,
        fromAddress
      );

      expect(result.success).to.be.false;
      expect(result.error).to.include('1inch tx.value must be');
    });

    for (const malformedValue of [
      '0x',
      '0x0',
      '1.5',
      ethers.constants.MaxUint256.add(1).toString(),
    ]) {
      it(`rejects malformed 1inch native tx.value ${malformedValue}`, async () => {
        axiosGetStub.resolves({
          data: {
            tx: {
              to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
              data: '0xdata',
              value: malformedValue,
              gas: '100000',
            },
          },
        });

        const result = await dexRouter.getSwapDataFromOneInch(
          chainId,
          amount,
          tokenIn,
          tokenOut,
          slippage,
          fromAddress
        );

        expect(result.success).to.be.false;
        expect(result.error).to.include('1inch tx.value');
      });
    }

    it('returns validated dstAmount from 1inch swap data', async () => {
      axiosGetStub.resolves({
        data: {
          dstAmount: '900000000000000000',
          tx: {
            to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
            data: '0xdata',
            value: '0',
            gas: '100000',
          },
        },
      });

      const result = await dexRouter.getSwapDataFromOneInch(
        chainId,
        amount,
        tokenIn,
        tokenOut,
        slippage,
        fromAddress
      );

      expect(result.success).to.be.true;
      expect(result.dstAmount).to.equal('900000000000000000');
    });

    it('rejects malformed dstAmount from 1inch swap data', async () => {
      axiosGetStub.resolves({
        data: {
          dstAmount: '1e18',
          tx: {
            to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
            data: '0xdata',
            value: '0',
            gas: '100000',
          },
        },
      });

      const result = await dexRouter.getSwapDataFromOneInch(
        chainId,
        amount,
        tokenIn,
        tokenOut,
        slippage,
        fromAddress
      );

      expect(result.success).to.be.false;
      expect(result.error).to.include('dstAmount is not a decimal uint string');
    });

    it('returns 1inch swap-data API descriptions and retry classification on failures', async () => {
      axiosGetStub.rejects({
        response: {
          status: 503,
          data: { description: 'swap endpoint unavailable' },
        },
      });

      const result = await dexRouter.getSwapDataFromOneInch(
        chainId,
        amount,
        tokenIn,
        tokenOut,
        slippage,
        fromAddress
      );

      expect(result.success).to.be.false;
      expect(result.error).to.equal('swap endpoint unavailable');
      expect(result.retryable).to.be.true;
      expect(result.errorCode).to.equal(503);
    });

    it('retries retryable 1inch swap-data failures before succeeding', async () => {
      const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });
      try {
        sinon.stub(dexRouter as any, 'getQuoteFromOneInch').resolves({
          success: true,
          dstAmount: '900000000000000000',
        });
        const getSwapDataStub = sinon.stub(dexRouter, 'getSwapDataFromOneInch');
        getSwapDataStub.onCall(0).resolves({
          success: false,
          error: 'network error',
          retryable: true,
        });
        getSwapDataStub.onCall(1).resolves({
          success: false,
          error: 'network error',
          retryable: true,
        });
        getSwapDataStub.onCall(2).resolves({
          success: true,
          data: {
            to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
            data: '0xdata',
            value: '0',
            gas: '100000',
          },
        });

        const resultPromise = dexRouter['swapWithOneInch'](
          chainId,
          BigNumber.from('100000000'),
          tokenIn,
          tokenOut,
          slippage
        );

        await clock.runAllAsync();
        const result = await resultPromise;

        expect(result.success).to.be.true;
        expect(getSwapDataStub.callCount).to.equal(3);
      } finally {
        clock.restore();
      }
    });

    it('fails private 1inch swaps before quote when the API env is missing', async () => {
      delete process.env.ONEINCH_API;

      const result = await dexRouter['swapWithOneInch'](
        chainId,
        BigNumber.from('100000000'),
        tokenIn,
        tokenOut,
        slippage
      );

      expect(result).to.deep.equal({
        success: false,
        error: 'ONEINCH_API is not configured',
      });
      expect(axiosGetStub.called).to.be.false;
    });

    it('fails private 1inch swaps before quote when the API key env is missing', async () => {
      delete process.env.ONEINCH_API_KEY;

      const result = await dexRouter['swapWithOneInch'](
        chainId,
        BigNumber.from('100000000'),
        tokenIn,
        tokenOut,
        slippage
      );

      expect(result).to.deep.equal({
        success: false,
        error: 'ONEINCH_API_KEY is not configured',
      });
      expect(axiosGetStub.called).to.be.false;
    });

    it('rejects private 1inch swaps with out-of-range slippage before quote', async () => {
      const result = await dexRouter['swapWithOneInch'](
        chainId,
        BigNumber.from('100000000'),
        tokenIn,
        tokenOut,
        101
      );

      expect(result).to.deep.equal({
        success: false,
        error: 'Slippage must be between 0 and 100',
      });
      expect(axiosGetStub.called).to.be.false;
    });

    it('returns non-retryable 1inch swap-data failures without signing', async () => {
      sinon.stub(dexRouter as any, 'getQuoteFromOneInch').resolves({
        success: true,
        dstAmount: '900000000000000000',
      });
      sinon.stub(dexRouter, 'getSwapDataFromOneInch').resolves({
        success: false,
        error: 'permanent quote rejection',
        retryable: false,
      });

      const result = await dexRouter['swapWithOneInch'](
        chainId,
        BigNumber.from('100000000'),
        tokenIn,
        tokenOut,
        slippage
      );

      expect(result).to.deep.equal({
        success: false,
        error: 'permanent quote rejection',
      });
      expect((signer.sendTransaction as sinon.SinonStub).called).to.be.false;
    });

    it('rejects private 1inch swap-data with non-zero native value before signing', async () => {
      sinon.stub(dexRouter as any, 'getQuoteFromOneInch').resolves({
        success: true,
        dstAmount: '900000000000000000',
      });
      sinon.stub(dexRouter, 'getSwapDataFromOneInch').resolves({
        success: true,
        data: {
          to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
          data: '0xdata',
          value: '1',
        },
      });

      const result = await dexRouter['swapWithOneInch'](
        chainId,
        BigNumber.from('100000000'),
        tokenIn,
        tokenOut,
        slippage
      );

      expect(result.success).to.be.false;
      expect(result.error).to.include('unexpected non-zero 1inch tx.value');
      expect((signer.sendTransaction as sinon.SinonStub).called).to.be.false;
    });

    it('fails private 1inch swaps when gas estimation fails', async () => {
      sinon.stub(dexRouter as any, 'getQuoteFromOneInch').resolves({
        success: true,
        dstAmount: '900000000000000000',
      });
      sinon.stub(dexRouter, 'getSwapDataFromOneInch').resolves({
        success: true,
        data: {
          to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
          data: '0xdata',
          value: '0',
        },
      });
      (mockProvider.estimateGas as sinon.SinonStub).rejects(
        new Error('estimation unavailable')
      );

      const result = await dexRouter['swapWithOneInch'](
        chainId,
        BigNumber.from('100000000'),
        tokenIn,
        tokenOut,
        slippage
      );

      expect(result.success).to.be.false;
      expect(result.error).to.include('Gas estimation failed');
      expect((signer.sendTransaction as sinon.SinonStub).called).to.be.false;
    });

    it('uses zero value and estimated gas when 1inch omits tx.value and tx.gas', async () => {
      sinon.stub(dexRouter as any, 'getQuoteFromOneInch').resolves({
        success: true,
        dstAmount: '900000000000000000',
      });
      sinon.stub(dexRouter, 'getSwapDataFromOneInch').resolves({
        success: true,
        data: {
          to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
          data: '0xdata',
        },
      });

      const result = await dexRouter['swapWithOneInch'](
        chainId,
        BigNumber.from('100000000'),
        tokenIn,
        tokenOut,
        slippage
      );

      expect(result.success).to.be.true;
      const sentTx = (signer.sendTransaction as sinon.SinonStub).firstCall
        .args[0];
      expect(sentTx.value).to.equal('0');
      expect(sentTx.gasLimit.toString()).to.equal('110000');
    });

    it('retries thrown 1inch rate-limit errors before succeeding', async () => {
      const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });
      try {
        sinon.stub(dexRouter as any, 'getQuoteFromOneInch').resolves({
          success: true,
          dstAmount: '900000000000000000',
        });
        const getSwapDataStub = sinon.stub(dexRouter, 'getSwapDataFromOneInch');
        getSwapDataStub.onCall(0).rejects({
          response: {
            status: 429,
            data: { description: 'rate limited' },
          },
        });
        getSwapDataStub.onCall(1).resolves({
          success: true,
          data: {
            to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
            data: '0xdata',
            value: '0',
          },
        });

        const resultPromise = dexRouter['swapWithOneInch'](
          chainId,
          BigNumber.from('100000000'),
          tokenIn,
          tokenOut,
          slippage
        );

        await clock.runAllAsync();
        const result = await resultPromise;

        expect(result.success).to.be.true;
        expect(getSwapDataStub.callCount).to.equal(2);
      } finally {
        clock.restore();
      }
    });
  });
});
