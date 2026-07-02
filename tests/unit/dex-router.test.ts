import axios from 'axios';
import { expect } from 'chai';
import { BigNumber, ethers, providers, Signer } from 'ethers';
import sinon from 'sinon';
import { DexRouter } from '../../src/dex/router';
import { CurvePoolType, PostAuctionDex } from '../../src/config';
import * as erc20 from '../../src/erc20';
import * as curveRouterModule from '../../src/dex/curve-router';
import * as universalRouterModule from '../../src/dex/universal-router';
import * as uniswapModule from '../../src/dex/uniswap';
import { logger } from '../../src/logging';
import { NonceTracker } from '../../src/nonce';
import {
  CustomContract,
  DEX_ROUTER_FIXTURE,
} from './helpers/dex-router-fixture';

describe('DexRouter', () => {
  let contractStub: CustomContract;
  let signer: Signer;
  let mockProvider: providers.JsonRpcProvider;
  let dexRouter: DexRouter;
  let axiosGetStub: sinon.SinonStub;
  let loggerErrorStub: sinon.SinonStub;

  const {
    chainId,
    amount,
    tokenIn,
    tokenOut,
    to,
    fromAddress,
    slippage,
    feeAmount,
  } = DEX_ROUTER_FIXTURE;

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
      const getDecimalsStub = sinon.stub(erc20, 'getDecimalsErc20').resolves(0);

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
            universalRouterAddress:
              '0x1111111111111111111111111111111111111111',
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
            universalRouterAddress:
              '0x1111111111111111111111111111111111111111',
            permit2Address: '0x2222222222222222222222222222222222222222',
            poolFactoryAddress: '0x3333333333333333333333333333333333333333',
          },
        }
      );

      expect(result.success).to.be.false;
      expect(result.error).to.include('Universal Router swap failed');
      expect(swapToWethStub.called).to.be.false;
    });

    it('surfaces resolved Universal Router failures without reporting success', async () => {
      stubSwapPreconditions(8, BigNumber.from('100000000'));
      sinon.stub(universalRouterModule, 'swapWithUniversalRouter').resolves({
        success: false,
        error: 'execution reverted: UR',
      } as any);
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
            universalRouterAddress:
              '0x1111111111111111111111111111111111111111',
            permit2Address: '0x2222222222222222222222222222222222222222',
            poolFactoryAddress: '0x3333333333333333333333333333333333333333',
          },
        }
      );

      expect(result).to.deep.equal({
        success: false,
        error: 'execution reverted: UR',
      });
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
            universalRouterAddress:
              '0x1111111111111111111111111111111111111111',
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

      it('should call 1inch and execute transaction', async () => {
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
});
