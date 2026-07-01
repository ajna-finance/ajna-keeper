import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, ethers } from 'ethers';
import { CurvePoolType, LiquiditySource } from '../../src/config';
import { evaluateGasPolicy } from '../../src/discovery/gas-policy';
import { DexRouter } from '../../src/dex/router';
import { UniswapV3QuoteProvider } from '../../src/dex/providers/uniswap-quote-provider';
import * as erc20 from '../../src/erc20';
import {
  QUOTE_TOKEN_ADDRESS,
  WETH_ADDRESS,
  oneInchGasConfig,
  readRpcWithGasPrice,
  signerWithChain,
} from './helpers/discovery-gas-policy-fixture';

describe('Discovery Gas Policy Quote Sources', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('records an empty 1inch gas quote response as a conversion failure', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const oneInchQuoteStub = sinon
      .stub(DexRouter.prototype, 'getQuoteFromOneInch')
      .resolves(undefined as any);
    const rpcCache: any = {
      chainId: 1,
    };

    const result = await evaluateGasPolicy({
      signer: signerWithChain(1),
      config: oneInchGasConfig({
        maxGasCostQuote: 5,
        oneInchQuoteFailureCooldownMs: 30_000,
        oneInchQuoteFailureThreshold: 1,
      }),
      transports: readRpcWithGasPrice(ethers.utils.parseUnits('1', 'gwei')),
      policy: {
        maxGasCostQuote: 5,
        oneInchQuoteFailureCooldownMs: 30_000,
        oneInchQuoteFailureThreshold: 1,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: QUOTE_TOKEN_ADDRESS,
      preferredLiquiditySource: LiquiditySource.ONEINCH,
      gasPrice: ethers.utils.parseUnits('1', 'gwei'),
      rpcCache,
    });

    expect(result.approved).to.be.false;
    expect(result.rejectCode).to.equal(
      'native_to_quote_conversion_unavailable'
    );
    expect(result.gasQuoteAttempts?.[0]).to.deep.include({
      source: LiquiditySource.ONEINCH,
      success: false,
      reason: '1inch returned empty gas quote response',
    });
    expect(
      rpcCache.providerCircuits.oneinch.gas_conversion.cooldownUntilMs
    ).to.be.a('number');
    expect(oneInchQuoteStub.calledOnce).to.be.true;
  });

  it('records retryable 1inch gas quote failures in the circuit state', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    sinon.stub(DexRouter.prototype, 'getQuoteFromOneInch').resolves({
      success: false,
      retryable: true,
      error: 'rate limited',
    } as any);
    const rpcCache: any = {
      chainId: 1,
    };

    const result = await evaluateGasPolicy({
      signer: signerWithChain(1),
      config: oneInchGasConfig({
        maxGasCostQuote: 5,
        oneInchQuoteFailureCooldownMs: 30_000,
        oneInchQuoteFailureThreshold: 1,
      }),
      transports: readRpcWithGasPrice(ethers.utils.parseUnits('1', 'gwei')),
      policy: {
        maxGasCostQuote: 5,
        oneInchQuoteFailureCooldownMs: 30_000,
        oneInchQuoteFailureThreshold: 1,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: QUOTE_TOKEN_ADDRESS,
      preferredLiquiditySource: LiquiditySource.ONEINCH,
      gasPrice: ethers.utils.parseUnits('1', 'gwei'),
      rpcCache,
    });

    expect(result.approved).to.be.false;
    expect(result.gasQuoteAttempts?.[0]).to.deep.include({
      source: LiquiditySource.ONEINCH,
      success: false,
      reason: 'rate limited',
    });
    expect(rpcCache.providerCircuits.oneinch.gas_conversion.failures).to.equal(
      1
    );
    expect(
      rpcCache.providerCircuits.oneinch.gas_conversion.cooldownUntilMs
    ).to.be.a('number');
  });

  it('records Uniswap provider unavailability as a gas quote attempt failure', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);

    const result = await evaluateGasPolicy({
      signer: signerWithChain(8453),
      config: {
        autoDiscover: {
          enabled: true,
          take: {
            enabled: true,
            maxGasCostQuote: 5,
          },
        },
        uniswapV3RouterOverrides: {
          poolFactoryAddress: '0x3333333333333333333333333333333333333333',
          quoterV2Address: '0x4444444444444444444444444444444444444444',
          wethAddress: WETH_ADDRESS,
          defaultFeeTier: 3000,
        },
        tokenAddresses: {
          weth: WETH_ADDRESS,
        },
      } as any,
      transports: readRpcWithGasPrice(ethers.utils.parseUnits('1', 'gwei')),
      policy: {
        maxGasCostQuote: 5,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: QUOTE_TOKEN_ADDRESS,
      preferredLiquiditySource: LiquiditySource.UNISWAPV3,
      gasPrice: ethers.utils.parseUnits('1', 'gwei'),
      rpcCache: {
        chainId: 8453,
        directDexQuoteProviders: {
          uniswapV3: null,
        },
      } as any,
    });

    expect(result.approved).to.be.false;
    expect(result.rejectCode).to.equal(
      'native_to_quote_conversion_unavailable'
    );
    expect(result.gasQuoteAttempts?.[0]).to.deep.include({
      source: LiquiditySource.UNISWAPV3,
      success: false,
      reason: 'Uniswap V3 quote provider unavailable',
    });
  });

  it('records Curve gas quote failures from the runtime quote provider', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const curveQuoteProvider = {
      getQuote: sinon.stub().resolves({ success: false }),
    };

    const result = await evaluateGasPolicy({
      signer: signerWithChain(1),
      config: {
        autoDiscover: {
          enabled: true,
          take: {
            enabled: true,
            maxGasCostQuote: 5,
          },
        },
        curveRouterOverrides: {
          wethAddress: WETH_ADDRESS,
          poolConfigs: {
            weth_usdc: {
              address: '0x5555555555555555555555555555555555555555',
              poolType: CurvePoolType.STABLE,
            },
          },
        },
        tokenAddresses: {
          weth: WETH_ADDRESS,
          usdc: QUOTE_TOKEN_ADDRESS,
        },
      } as any,
      transports: readRpcWithGasPrice(ethers.utils.parseUnits('1', 'gwei')),
      policy: {
        maxGasCostQuote: 5,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: QUOTE_TOKEN_ADDRESS,
      preferredLiquiditySource: LiquiditySource.CURVE,
      gasPrice: ethers.utils.parseUnits('1', 'gwei'),
      rpcCache: {
        chainId: 1,
        directDexQuoteProviders: {
          curve: curveQuoteProvider,
        },
      } as any,
    });

    expect(result.approved).to.be.false;
    expect(result.rejectCode).to.equal(
      'native_to_quote_conversion_unavailable'
    );
    expect(result.gasQuoteAttempts?.[0]).to.deep.include({
      source: LiquiditySource.CURVE,
      success: false,
      reason: 'Curve returned no usable gas quote',
    });
    expect(curveQuoteProvider.getQuote.calledOnce).to.be.true;
  });

  it('rejects Curve gas quotes above the quote-token cap', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const curveQuoteProvider = {
      getQuote: sinon.stub().resolves({
        success: true,
        dstAmount: ethers.utils.parseUnits('2', 6),
      }),
    };

    const result = await evaluateGasPolicy({
      signer: signerWithChain(1),
      config: {
        autoDiscover: {
          enabled: true,
          take: {
            enabled: true,
            maxGasCostQuote: 1,
          },
        },
        curveRouterOverrides: {
          wethAddress: WETH_ADDRESS,
          poolConfigs: {
            weth_usdc: {
              address: '0x5555555555555555555555555555555555555555',
              poolType: CurvePoolType.STABLE,
            },
          },
        },
        tokenAddresses: {
          weth: WETH_ADDRESS,
          usdc: QUOTE_TOKEN_ADDRESS,
        },
      } as any,
      transports: readRpcWithGasPrice(ethers.utils.parseUnits('1', 'gwei')),
      policy: {
        maxGasCostQuote: 1,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: QUOTE_TOKEN_ADDRESS,
      preferredLiquiditySource: LiquiditySource.CURVE,
      gasPrice: ethers.utils.parseUnits('1', 'gwei'),
      rpcCache: {
        chainId: 1,
        directDexQuoteProviders: {
          curve: curveQuoteProvider,
        },
      } as any,
    });

    expect(result.approved).to.be.false;
    expect(result.rejectCode).to.equal('quote_gas_cost_above_cap');
    expect(result.gasQuoteAttempts?.[0]).to.deep.include({
      source: LiquiditySource.CURVE,
      success: true,
      amountOut: ethers.utils.parseUnits('2', 6).toString(),
    });
  });

  it('reads gas price from the discovery transport when no cached price is supplied', async () => {
    const gasPrice = ethers.utils.parseUnits('2', 'gwei');
    const transports = readRpcWithGasPrice(gasPrice);

    const result = await evaluateGasPolicy({
      signer: signerWithChain(1),
      config: {},
      transports,
      policy: {},
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: QUOTE_TOKEN_ADDRESS,
    });

    expect(result.approved).to.be.true;
    expect(result.gasPriceRaw?.eq(gasPrice)).to.be.true;
    expect(result.gasPriceGwei).to.equal(2);
    expect(transports.readRpc.getGasPrice.calledOnce).to.be.true;
  });

  it('apportions zero gas plus zero native profit without calling an external quote source', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const oneInchQuoteStub = sinon.stub(
      DexRouter.prototype,
      'getQuoteFromOneInch'
    );

    const result = await evaluateGasPolicy({
      signer: signerWithChain(1),
      config: oneInchGasConfig({
        minProfitNative: '0',
      }),
      transports: readRpcWithGasPrice(BigNumber.from(0)),
      policy: {
        minProfitNative: '0',
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: QUOTE_TOKEN_ADDRESS,
      preferredLiquiditySource: LiquiditySource.ONEINCH,
      useProfitFloor: true,
      gasPrice: BigNumber.from(0),
      rpcCache: {
        chainId: 1,
      },
    });

    expect(result.approved).to.be.true;
    expect(result.gasCostQuoteRaw?.isZero()).to.be.true;
    expect(result.minProfitNativeQuoteRaw?.isZero()).to.be.true;
    expect(result.gasQuoteAttempts).to.equal(undefined);
    expect(oneInchQuoteStub.called).to.be.false;
  });

  it('rejects wrapped-native quote caps without gas quote attempt telemetry', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(18);
    const gasPrice = ethers.utils.parseUnits('1', 'gwei');
    const gasLimit = BigNumber.from(900000);

    const result = await evaluateGasPolicy({
      signer: signerWithChain(1),
      config: oneInchGasConfig(),
      transports: readRpcWithGasPrice(gasPrice),
      policy: {
        maxGasCostQuote: 0.0001,
      },
      gasLimit,
      quoteTokenAddress: WETH_ADDRESS,
      preferredLiquiditySource: LiquiditySource.ONEINCH,
      gasPrice,
      rpcCache: {
        chainId: 1,
      },
    });

    expect(result.approved).to.be.false;
    expect(result.rejectCode).to.equal('quote_gas_cost_above_cap');
    expect(result.gasCostQuoteRaw?.eq(gasPrice.mul(gasLimit))).to.be.true;
    expect(result.gasQuoteAttempts).to.equal(undefined);
  });

  it('falls back to Uniswap when 1inch cannot resolve a chain for gas conversion', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const oneInchQuoteStub = sinon.stub(
      DexRouter.prototype,
      'getQuoteFromOneInch'
    );
    sinon.stub(UniswapV3QuoteProvider.prototype, 'isAvailable').returns(true);
    sinon.stub(UniswapV3QuoteProvider.prototype, 'poolExists').resolves(true);
    sinon.stub(UniswapV3QuoteProvider.prototype, 'getQuote').resolves({
      success: true,
      dstAmount: ethers.utils.parseUnits('2', 6).toString(),
    } as any);

    const result = await evaluateGasPolicy({
      signer: signerWithChain(),
      config: {
        ...oneInchGasConfig({ maxGasCostQuote: 5 }),
        uniswapV3RouterOverrides: {
          poolFactoryAddress: '0x3333333333333333333333333333333333333333',
          quoterV2Address: '0x4444444444444444444444444444444444444444',
          wethAddress: WETH_ADDRESS,
          defaultFeeTier: 3000,
        },
      } as any,
      transports: readRpcWithGasPrice(ethers.utils.parseUnits('1', 'gwei')),
      policy: {
        maxGasCostQuote: 5,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: QUOTE_TOKEN_ADDRESS,
      preferredLiquiditySource: LiquiditySource.ONEINCH,
      gasPrice: ethers.utils.parseUnits('1', 'gwei'),
    });

    expect(result.approved).to.be.true;
    expect(result.gasQuoteAttempts?.[0]).to.deep.include({
      source: LiquiditySource.ONEINCH,
      success: false,
      reason: 'chainId unavailable for 1inch gas quote',
    });
    expect(result.gasQuoteAttempts?.[1]).to.deep.include({
      source: LiquiditySource.UNISWAPV3,
      success: true,
      amountOut: ethers.utils.parseUnits('2', 6).toString(),
    });
    expect(oneInchQuoteStub.called).to.be.false;
  });

  it('records the default 1inch no-route reason when the quote has no error', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    sinon
      .stub(DexRouter.prototype, 'getQuoteFromOneInch')
      .resolves({ success: false } as any);

    const result = await evaluateGasPolicy({
      signer: signerWithChain(1),
      config: oneInchGasConfig({ maxGasCostQuote: 5 }),
      transports: readRpcWithGasPrice(ethers.utils.parseUnits('1', 'gwei')),
      policy: {
        maxGasCostQuote: 5,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: QUOTE_TOKEN_ADDRESS,
      preferredLiquiditySource: LiquiditySource.ONEINCH,
      gasPrice: ethers.utils.parseUnits('1', 'gwei'),
      rpcCache: {
        chainId: 1,
      },
    });

    expect(result.approved).to.be.false;
    expect(result.gasQuoteAttempts?.[0]).to.deep.include({
      source: LiquiditySource.ONEINCH,
      success: false,
      reason: '1inch returned no gas quote route',
    });
  });

  it('records thrown gas quote source errors as failed attempts', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    sinon
      .stub(DexRouter.prototype, 'getQuoteFromOneInch')
      .rejects(new Error('1inch exploded'));

    const result = await evaluateGasPolicy({
      signer: signerWithChain(1),
      config: oneInchGasConfig({ maxGasCostQuote: 5 }),
      transports: readRpcWithGasPrice(ethers.utils.parseUnits('1', 'gwei')),
      policy: {
        maxGasCostQuote: 5,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: QUOTE_TOKEN_ADDRESS,
      preferredLiquiditySource: LiquiditySource.ONEINCH,
      gasPrice: ethers.utils.parseUnits('1', 'gwei'),
      rpcCache: {
        chainId: 1,
      },
    });

    expect(result.approved).to.be.false;
    expect(result.gasQuoteAttempts?.[0]).to.deep.include({
      source: LiquiditySource.ONEINCH,
      success: false,
      reason: '1inch exploded',
    });
  });

  it('keeps the highest direct DEX gas quote across zero and lower-output fee tiers', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    sinon.stub(UniswapV3QuoteProvider.prototype, 'isAvailable').returns(true);
    sinon.stub(UniswapV3QuoteProvider.prototype, 'poolExists').resolves(true);
    const uniswapQuoteStub = sinon
      .stub(UniswapV3QuoteProvider.prototype, 'getQuote')
      .callsFake(
        async (_amountIn, _tokenIn, _tokenOut, feeTier?: number) =>
          ({
            success: true,
            dstAmount:
              feeTier === 500
                ? ethers.utils.parseUnits('3', 6).toString()
                : feeTier === 3000
                  ? '0'
                  : ethers.utils.parseUnits('2', 6).toString(),
          }) as any
      );

    const result = await evaluateGasPolicy({
      signer: signerWithChain(8453),
      config: {
        autoDiscover: {
          enabled: true,
          take: {
            enabled: true,
            maxGasCostQuote: 5,
          },
        },
        uniswapV3RouterOverrides: {
          poolFactoryAddress: '0x3333333333333333333333333333333333333333',
          quoterV2Address: '0x4444444444444444444444444444444444444444',
          wethAddress: WETH_ADDRESS,
          defaultFeeTier: 500,
          candidateFeeTiers: [3000, 10000],
        },
        tokenAddresses: {
          weth: WETH_ADDRESS,
        },
      } as any,
      transports: readRpcWithGasPrice(ethers.utils.parseUnits('1', 'gwei')),
      policy: {
        maxGasCostQuote: 5,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: QUOTE_TOKEN_ADDRESS,
      preferredLiquiditySource: LiquiditySource.UNISWAPV3,
      gasPrice: ethers.utils.parseUnits('1', 'gwei'),
      rpcCache: {
        chainId: 8453,
      },
    });

    expect(result.approved).to.be.true;
    expect(result.gasCostQuoteRaw?.eq(ethers.utils.parseUnits('3', 6))).to.be
      .true;
    expect(uniswapQuoteStub.callCount).to.equal(3);
  });

  it('records Curve provider unavailability as a gas quote attempt failure', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);

    const result = await evaluateGasPolicy({
      signer: signerWithChain(1),
      config: {
        autoDiscover: {
          enabled: true,
          take: {
            enabled: true,
            maxGasCostQuote: 5,
          },
        },
        curveRouterOverrides: {
          wethAddress: WETH_ADDRESS,
          poolConfigs: {
            weth_usdc: {
              address: '0x5555555555555555555555555555555555555555',
              poolType: CurvePoolType.STABLE,
            },
          },
        },
      } as any,
      transports: readRpcWithGasPrice(ethers.utils.parseUnits('1', 'gwei')),
      policy: {
        maxGasCostQuote: 5,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: QUOTE_TOKEN_ADDRESS,
      preferredLiquiditySource: LiquiditySource.CURVE,
      gasPrice: ethers.utils.parseUnits('1', 'gwei'),
      rpcCache: {
        chainId: 1,
        directDexQuoteProviders: {
          curve: null,
        },
      } as any,
    });

    expect(result.approved).to.be.false;
    expect(result.gasQuoteAttempts?.[0]).to.deep.include({
      source: LiquiditySource.CURVE,
      success: false,
      reason: 'Curve quote provider unavailable',
    });
  });
});
