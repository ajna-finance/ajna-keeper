import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, ethers } from 'ethers';
import { CurvePoolType, LiquiditySource } from '../../src/config';
import { evaluateGasPolicy } from '../../src/discovery/gas-policy';
import { DexRouter } from '../../src/dex/router';
import { UniswapV3QuoteProvider } from '../../src/dex/providers/uniswap-quote-provider';
import * as erc20 from '../../src/erc20';

describe('Discovery Gas Policy', () => {
  const WETH_ADDRESS = '0x4200000000000000000000000000000000000006';
  const QUOTE_TOKEN_ADDRESS = '0x9999999999999999999999999999999999999999';
  const ONEINCH_ROUTER_ADDRESS =
    '0x1111111111111111111111111111111111111111';

  afterEach(() => {
    sinon.restore();
  });

  function signerWithChain(chainId?: number): any {
    return {
      provider: {},
      ...(chainId !== undefined
        ? { getChainId: sinon.stub().resolves(chainId) }
        : {}),
    };
  }

  function readRpcWithGasPrice(gasPrice: BigNumber): any {
    return {
      readRpc: {
        getGasPrice: sinon.stub().resolves(gasPrice),
      },
    };
  }

  function oneInchGasConfig(takePolicy: Record<string, unknown> = {}): any {
    return {
      autoDiscover: {
        enabled: true,
        take: {
          enabled: true,
          ...takePolicy,
        },
      },
      oneInchRouters: {
        1: ONEINCH_ROUTER_ADDRESS,
      },
      connectorTokens: [],
      tokenAddresses: {
        weth: WETH_ADDRESS,
      },
    };
  }

  it('rejects before gas reads when the signer provider is unavailable', async () => {
    const getGasPrice = sinon
      .stub()
      .rejects(new Error('gas price should not be read without a provider'));

    const result = await evaluateGasPolicy({
      signer: { provider: undefined } as any,
      config: oneInchGasConfig({ maxGasCostQuote: 5 }),
      transports: {
        readRpc: {
          getGasPrice,
        },
      },
      policy: {
        maxGasCostQuote: 5,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: QUOTE_TOKEN_ADDRESS,
    });

    expect(result.approved).to.be.false;
    expect(result.rejectCode).to.equal('provider_unavailable');
    expect(result.reason).to.equal('signer has no provider');
    expect(getGasPrice.called).to.be.false;
  });

  it('rejects gas prices above the configured cap', async () => {
    const gasPrice = ethers.utils.parseUnits('10', 'gwei');

    const result = await evaluateGasPolicy({
      signer: signerWithChain(1),
      config: {},
      transports: readRpcWithGasPrice(gasPrice),
      policy: {
        maxGasPriceGwei: 1,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: QUOTE_TOKEN_ADDRESS,
      gasPrice,
    });

    expect(result.approved).to.be.false;
    expect(result.rejectCode).to.equal('gas_price_above_cap');
    expect(result.gasPriceRaw?.eq(gasPrice)).to.be.true;
    expect(result.gasPriceGwei).to.equal(10);
    expect(result.reason).to.equal(
      'gas price 10.00 gwei exceeds maxGasPriceGwei 1'
    );
  });

  it('rejects native gas cost above the configured cap before quote conversion', async () => {
    const gasPrice = ethers.utils.parseUnits('1', 'gwei');

    const result = await evaluateGasPolicy({
      signer: signerWithChain(1),
      config: {},
      transports: readRpcWithGasPrice(gasPrice),
      policy: {
        maxGasCostNative: 0.0001,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: QUOTE_TOKEN_ADDRESS,
      gasPrice,
    });

    expect(result.approved).to.be.false;
    expect(result.rejectCode).to.equal('native_gas_cost_above_cap');
    expect(result.gasCostNative).to.equal(0.0009);
    expect(result.gasCostQuote).to.equal(0);
    expect(result.reason).to.equal(
      'estimated gas cost 0.000900 exceeds maxGasCostNative 0.0001'
    );
  });

  it('approves without quote conversion when no quote-denominated policy is required', async () => {
    const gasPrice = ethers.utils.parseUnits('1', 'gwei');

    const result = await evaluateGasPolicy({
      signer: signerWithChain(1),
      config: {},
      transports: readRpcWithGasPrice(gasPrice),
      policy: {},
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: QUOTE_TOKEN_ADDRESS,
      gasPrice,
    });

    expect(result.approved).to.be.true;
    expect(result.gasCostNative).to.equal(0.0009);
    expect(result.gasCostQuote).to.equal(0);
    expect(result.gasCostQuoteRaw).to.equal(undefined);
  });

  it('approves zero native gas cost without requiring wrapped-native config', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);

    const result = await evaluateGasPolicy({
      signer: signerWithChain(1),
      config: oneInchGasConfig({ maxGasCostQuote: 5 }),
      transports: readRpcWithGasPrice(BigNumber.from(0)),
      policy: {
        maxGasCostQuote: 5,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: QUOTE_TOKEN_ADDRESS,
      gasPrice: BigNumber.from(0),
      requireGasCostQuote: true,
    });

    expect(result.approved).to.be.true;
    expect(result.gasCostQuoteRaw?.isZero()).to.be.true;
    expect(result.quoteTokenDecimals).to.equal(6);
  });

  it('rejects quote-denominated gas policy when wrapped native is not configured', async () => {
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
        oneInchRouters: {
          1: ONEINCH_ROUTER_ADDRESS,
        },
        connectorTokens: [],
      } as any,
      transports: readRpcWithGasPrice(ethers.utils.parseUnits('1', 'gwei')),
      policy: {
        maxGasCostQuote: 5,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: QUOTE_TOKEN_ADDRESS,
      gasPrice: ethers.utils.parseUnits('1', 'gwei'),
    });

    expect(result.approved).to.be.false;
    expect(result.rejectCode).to.equal('wrapped_native_unconfigured');
    expect(result.reason).to.equal(
      'no wrapped native token configured for gas cost conversion'
    );
  });

  it('rejects when quoted gas cost exceeds the quote-token cap', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const oneInchQuoteStub = sinon
      .stub(DexRouter.prototype, 'getQuoteFromOneInch')
      .resolves({
        success: true,
        dstAmount: ethers.utils.parseUnits('2', 6).toString(),
      });

    const result = await evaluateGasPolicy({
      signer: signerWithChain(1),
      config: oneInchGasConfig({ maxGasCostQuote: 1 }),
      transports: readRpcWithGasPrice(ethers.utils.parseUnits('1', 'gwei')),
      policy: {
        maxGasCostQuote: 1,
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
    expect(result.rejectCode).to.equal('quote_gas_cost_above_cap');
    expect(result.gasCostQuoteRaw?.eq(ethers.utils.parseUnits('2', 6))).to.be
      .true;
    expect(result.gasQuoteAttempts?.[0]).to.deep.include({
      source: LiquiditySource.ONEINCH,
      success: true,
      amountOut: ethers.utils.parseUnits('2', 6).toString(),
    });
    expect(oneInchQuoteStub.calledOnce).to.be.true;
  });

  it('prices gas and native profit directly when the quote token is wrapped native', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(18);
    const oneInchQuoteStub = sinon.stub(
      DexRouter.prototype,
      'getQuoteFromOneInch'
    );
    const gasPrice = ethers.utils.parseUnits('1', 'gwei');
    const gasLimit = BigNumber.from(900000);
    const minProfitNative = ethers.utils.parseEther('0.01');

    const result = await evaluateGasPolicy({
      signer: signerWithChain(1),
      config: oneInchGasConfig(),
      transports: readRpcWithGasPrice(gasPrice),
      policy: {
        minProfitNative: minProfitNative.toString(),
        maxGasCostQuote: 1,
      },
      gasLimit,
      quoteTokenAddress: WETH_ADDRESS,
      preferredLiquiditySource: LiquiditySource.ONEINCH,
      useProfitFloor: true,
      gasPrice,
      rpcCache: {
        chainId: 1,
      },
    });

    expect(result.approved).to.be.true;
    expect(result.gasCostQuoteRaw?.eq(gasPrice.mul(gasLimit))).to.be.true;
    expect(result.minProfitNativeQuoteRaw?.eq(minProfitNative)).to.be.true;
    expect(result.gasQuoteAttempts).to.equal(undefined);
    expect(oneInchQuoteStub.called).to.be.false;
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

  it('reuses identical native-to-quote gas conversions within a discovery cycle', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const oneInchQuoteStub = sinon
      .stub(DexRouter.prototype, 'getQuoteFromOneInch')
      .resolves({
        success: true,
        dstAmount: ethers.utils.parseUnits('1', 6).toString(),
      });

    const signer = {
      provider: {},
      getChainId: sinon.stub().resolves(1),
    };
    const rpcCache = { stats: {} };
    const params = {
      signer: signer as any,
      config: {
        autoDiscover: {
          enabled: true,
          take: {
            enabled: true,
            maxGasCostQuote: 5,
          },
        },
        oneInchRouters: {
          1: '0x1111111111111111111111111111111111111111',
        },
        connectorTokens: [],
        tokenAddresses: {
          weth: '0x4200000000000000000000000000000000000006',
        },
      } as any,
      transports: {
        readRpc: {
          getGasPrice: sinon
            .stub()
            .resolves(ethers.utils.parseUnits('1', 'gwei')),
        },
      },
      policy: {
        maxGasCostQuote: 5,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: '0x9999999999999999999999999999999999999999',
      preferredLiquiditySource: LiquiditySource.ONEINCH,
      gasPrice: ethers.utils.parseUnits('1', 'gwei'),
      rpcCache,
    };

    const firstResult = await evaluateGasPolicy(params);
    const secondResult = await evaluateGasPolicy(params);

    expect(firstResult.approved).to.be.true;
    expect(secondResult.approved).to.be.true;
    expect(firstResult.gasCostQuoteRaw?.eq(ethers.utils.parseUnits('1', 6))).to
      .be.true;
    expect(firstResult.quoteTokenDecimals).to.equal(6);
    expect(oneInchQuoteStub.calledOnce).to.be.true;
    expect(rpcCache.stats).to.deep.include({
      gasQuoteConversionCacheMisses: 1,
      gasQuoteConversionCacheHits: 1,
    });
  });

  it('expires native-to-quote gas conversion cache entries', async () => {
    const clock = sinon.useFakeTimers({ now: 1_000, toFake: ['Date'] });
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const oneInchQuoteStub = sinon
      .stub(DexRouter.prototype, 'getQuoteFromOneInch')
      .onFirstCall()
      .resolves({
        success: true,
        dstAmount: ethers.utils.parseUnits('1', 6).toString(),
      })
      .onSecondCall()
      .resolves({
        success: true,
        dstAmount: ethers.utils.parseUnits('2', 6).toString(),
      });

    const rpcCache = { stats: {} };
    const params = {
      signer: {
        provider: {},
        getChainId: sinon.stub().resolves(1),
      } as any,
      config: {
        autoDiscover: {
          enabled: true,
          take: {
            enabled: true,
            maxGasCostQuote: 5,
          },
        },
        oneInchRouters: {
          1: '0x1111111111111111111111111111111111111111',
        },
        connectorTokens: [],
        tokenAddresses: {
          weth: '0x4200000000000000000000000000000000000006',
        },
      } as any,
      transports: {
        readRpc: {
          getGasPrice: sinon
            .stub()
            .resolves(ethers.utils.parseUnits('1', 'gwei')),
        },
      },
      policy: {
        maxGasCostQuote: 5,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: '0x9999999999999999999999999999999999999999',
      preferredLiquiditySource: LiquiditySource.ONEINCH,
      gasPrice: ethers.utils.parseUnits('1', 'gwei'),
      rpcCache,
    };

    const firstResult = await evaluateGasPolicy(params);
    const cachedResult = await evaluateGasPolicy(params);
    clock.tick(30_001);
    const refreshedResult = await evaluateGasPolicy(params);

    expect(firstResult.gasCostQuoteRaw?.eq(ethers.utils.parseUnits('1', 6))).to
      .be.true;
    expect(cachedResult.gasCostQuoteRaw?.eq(ethers.utils.parseUnits('1', 6))).to
      .be.true;
    expect(refreshedResult.gasCostQuoteRaw?.eq(ethers.utils.parseUnits('2', 6)))
      .to.be.true;
    expect(oneInchQuoteStub.calledTwice).to.be.true;
    expect(rpcCache.stats).to.deep.include({
      gasQuoteConversionCacheMisses: 2,
      gasQuoteConversionCacheHits: 1,
    });
  });

  it('passes the configured 1inch timeout to gas quote conversions', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const oneInchQuoteStub = sinon
      .stub(DexRouter.prototype, 'getQuoteFromOneInch')
      .resolves({
        success: true,
        dstAmount: ethers.utils.parseUnits('1', 6).toString(),
      });

    const result = await evaluateGasPolicy({
      signer: {
        provider: {},
        getChainId: sinon.stub().resolves(1),
      } as any,
      config: {
        autoDiscover: {
          enabled: true,
          take: {
            enabled: true,
            maxGasCostQuote: 5,
            oneInchQuoteTimeoutMs: 750,
          },
        },
        oneInchRouters: {
          1: '0x1111111111111111111111111111111111111111',
        },
        connectorTokens: [],
        tokenAddresses: {
          weth: '0x4200000000000000000000000000000000000006',
        },
      } as any,
      transports: {
        readRpc: {
          getGasPrice: sinon
            .stub()
            .resolves(ethers.utils.parseUnits('1', 'gwei')),
        },
      },
      policy: {
        maxGasCostQuote: 5,
        oneInchQuoteTimeoutMs: 750,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: '0x9999999999999999999999999999999999999999',
      preferredLiquiditySource: LiquiditySource.ONEINCH,
      gasPrice: ethers.utils.parseUnits('1', 'gwei'),
      rpcCache: {
        chainId: 1,
      },
    });

    expect(result.approved).to.be.true;
    expect(oneInchQuoteStub.calledOnce).to.be.true;
    expect(oneInchQuoteStub.firstCall.args[4]).to.deep.equal({
      timeoutMs: 750,
    });
  });

  it('ceil-rounds gas quote apportionment and quotes gas plus native profit in one request', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const gasPrice = BigNumber.from(1);
    const gasLimit = BigNumber.from(100000);
    const gasCostNativeRaw = gasPrice.mul(gasLimit);
    const minProfitNativeRaw = ethers.utils.parseEther('1');
    const combinedNativeRaw = gasCostNativeRaw.add(minProfitNativeRaw);
    const oneInchQuoteStub = sinon
      .stub(DexRouter.prototype, 'getQuoteFromOneInch')
      .callsFake(async (_chainId, amountIn: BigNumber) => {
        expect(amountIn.eq(combinedNativeRaw)).to.be.true;
        return {
          success: true,
          dstAmount: '1',
        };
      });

    const result = await evaluateGasPolicy({
      signer: {
        provider: {},
        getChainId: sinon.stub().resolves(1),
      } as any,
      config: {
        autoDiscover: {
          enabled: true,
          take: {
            enabled: true,
            maxGasCostQuote: 1,
            minProfitNative: minProfitNativeRaw.toString(),
          },
        },
        oneInchRouters: {
          1: '0x1111111111111111111111111111111111111111',
        },
        connectorTokens: [],
        tokenAddresses: {
          weth: '0x4200000000000000000000000000000000000006',
        },
      } as any,
      transports: {
        readRpc: {
          getGasPrice: sinon.stub().resolves(gasPrice),
        },
      },
      policy: {
        maxGasCostQuote: 1,
        minProfitNative: minProfitNativeRaw.toString(),
      },
      gasLimit,
      quoteTokenAddress: '0x9999999999999999999999999999999999999999',
      preferredLiquiditySource: LiquiditySource.ONEINCH,
      gasPrice,
      rpcCache: {
        chainId: 1,
      },
    });

    expect(result.approved).to.be.true;
    expect(result.gasCostQuoteRaw?.eq(1)).to.be.true;
    expect(result.minProfitNativeQuoteRaw?.eq(0)).to.be.true;
    expect(oneInchQuoteStub.calledOnce).to.be.true;
  });

  it('rejects zero-output 1inch gas quote conversions', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const oneInchQuoteStub = sinon
      .stub(DexRouter.prototype, 'getQuoteFromOneInch')
      .resolves({
        success: true,
        dstAmount: '0',
      });

    const result = await evaluateGasPolicy({
      signer: {
        provider: {},
        getChainId: sinon.stub().resolves(1),
      } as any,
      config: {
        autoDiscover: {
          enabled: true,
          take: {
            enabled: true,
            maxGasCostQuote: 5,
          },
        },
        oneInchRouters: {
          1: '0x1111111111111111111111111111111111111111',
        },
        connectorTokens: [],
        tokenAddresses: {
          weth: '0x4200000000000000000000000000000000000006',
        },
      } as any,
      transports: {
        readRpc: {
          getGasPrice: sinon
            .stub()
            .resolves(ethers.utils.parseUnits('1', 'gwei')),
        },
      },
      policy: {
        maxGasCostQuote: 5,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: '0x9999999999999999999999999999999999999999',
      preferredLiquiditySource: LiquiditySource.ONEINCH,
      gasPrice: ethers.utils.parseUnits('1', 'gwei'),
      rpcCache: {
        chainId: 1,
      },
    });

    expect(result.approved).to.be.false;
    expect(result.reason).to.equal('failed to quote gas cost into quote token');
    expect(result.rejectCode).to.equal(
      'native_to_quote_conversion_unavailable'
    );
    expect(result.gasQuoteAttempts?.[0]).to.deep.include({
      source: LiquiditySource.ONEINCH,
      success: false,
      reason: '1inch gas quote conversion returned zero output',
    });
    expect(oneInchQuoteStub.calledOnce).to.be.true;
  });

  it('returns structured native-to-quote conversion rejection and per-source attempts when every gas quote source fails', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    sinon
      .stub(DexRouter.prototype, 'getQuoteFromOneInch')
      .resolves({ success: false, error: 'insufficient liquidity' });
    sinon.stub(UniswapV3QuoteProvider.prototype, 'isAvailable').returns(true);
    const poolExistsStub = sinon
      .stub(UniswapV3QuoteProvider.prototype, 'poolExists')
      .resolves(false);
    const uniswapQuoteStub = sinon.stub(
      UniswapV3QuoteProvider.prototype,
      'getQuote'
    );

    const result = await evaluateGasPolicy({
      signer: {
        provider: {},
        getChainId: sinon.stub().resolves(8453),
      } as any,
      config: {
        autoDiscover: {
          enabled: true,
          take: {
            enabled: true,
            maxGasCostQuote: 5,
          },
        },
        oneInchRouters: {
          8453: '0x1111111111111111111111111111111111111111',
        },
        uniswapV3RouterOverrides: {
          poolFactoryAddress: '0x3333333333333333333333333333333333333333',
          quoterV2Address: '0x4444444444444444444444444444444444444444',
          wethAddress: '0x4200000000000000000000000000000000000006',
          defaultFeeTier: 3000,
          candidateFeeTiers: [500, 100, 10000],
        },
        tokenAddresses: {
          weth: '0x4200000000000000000000000000000000000006',
        },
      } as any,
      transports: {
        readRpc: {
          getGasPrice: sinon
            .stub()
            .resolves(ethers.utils.parseUnits('1', 'gwei')),
        },
      },
      policy: {
        maxGasCostQuote: 5,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: '0x9999999999999999999999999999999999999999',
      preferredLiquiditySource: LiquiditySource.ONEINCH,
      gasPrice: ethers.utils.parseUnits('1', 'gwei'),
      rpcCache: {
        chainId: 8453,
      },
    });

    expect(result.approved).to.equal(false);
    expect(result.rejectCode).to.equal(
      'native_to_quote_conversion_unavailable'
    );
    expect(result.reason).to.equal('failed to quote gas cost into quote token');
    expect(
      result.gasQuoteAttempts?.map((attempt) => attempt.source)
    ).to.deep.equal([LiquiditySource.ONEINCH, LiquiditySource.UNISWAPV3]);
    expect(result.gasQuoteAttempts?.[0]).to.deep.include({
      source: LiquiditySource.ONEINCH,
      success: false,
      reason: 'insufficient liquidity',
    });
    expect(result.gasQuoteAttempts?.[1]).to.deep.include({
      source: LiquiditySource.UNISWAPV3,
      success: false,
      reason: 'no direct DEX pool at configured fee tiers',
    });
    expect(result.gasQuoteAttempts?.[1].feeTiers).to.deep.equal([
      3000, 500, 100, 10000,
    ]);
    expect(poolExistsStub.callCount).to.equal(4);
    expect(uniswapQuoteStub.called).to.equal(false);
  });

  it('uses the cached discovery chainId instead of calling signer.getChainId per evaluation', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const oneInchQuoteStub = sinon
      .stub(DexRouter.prototype, 'getQuoteFromOneInch')
      .resolves({
        success: true,
        dstAmount: ethers.utils.parseUnits('1', 6).toString(),
      });

    const result = await evaluateGasPolicy({
      signer: {
        provider: {},
        getChainId: sinon
          .stub()
          .rejects(new Error('should use cached chainId')),
      } as any,
      config: {
        autoDiscover: {
          enabled: true,
          take: {
            enabled: true,
            maxGasCostQuote: 5,
          },
        },
        oneInchRouters: {
          1: '0x1111111111111111111111111111111111111111',
        },
        connectorTokens: [],
        tokenAddresses: {
          weth: '0x4200000000000000000000000000000000000006',
        },
      } as any,
      transports: {
        readRpc: {
          getGasPrice: sinon
            .stub()
            .resolves(ethers.utils.parseUnits('1', 'gwei')),
        },
      },
      policy: {
        maxGasCostQuote: 5,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: '0x9999999999999999999999999999999999999999',
      preferredLiquiditySource: LiquiditySource.ONEINCH,
      gasPrice: ethers.utils.parseUnits('1', 'gwei'),
      rpcCache: {
        chainId: 1,
      },
    });

    expect(result.approved).to.be.true;
    expect(oneInchQuoteStub.calledOnce).to.be.true;
  });

  it('applies the L2 gas buffer when only signer.getChainId can resolve the chain', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const gasPrice = ethers.utils.parseUnits('1', 'gwei');
    const gasLimit = BigNumber.from(900000);
    const bufferedGasCostNativeRaw = gasPrice
      .mul(gasLimit)
      .mul(13000)
      .add(9999)
      .div(10000);
    const oneInchQuoteStub = sinon
      .stub(DexRouter.prototype, 'getQuoteFromOneInch')
      .callsFake(async (_chainId, amountIn: BigNumber) => ({
        success: true,
        dstAmount: amountIn.eq(bufferedGasCostNativeRaw)
          ? ethers.utils.parseUnits('1.3', 6).toString()
          : ethers.utils.parseUnits('1', 6).toString(),
      }));

    const result = await evaluateGasPolicy({
      signer: {
        provider: {},
        getChainId: sinon.stub().resolves(8453),
      } as any,
      config: {
        autoDiscover: {
          enabled: true,
          take: {
            enabled: true,
            maxGasCostQuote: 2,
          },
        },
        oneInchRouters: {
          8453: '0x1111111111111111111111111111111111111111',
        },
        connectorTokens: [],
        tokenAddresses: {
          weth: '0x4200000000000000000000000000000000000006',
        },
      } as any,
      transports: {
        readRpc: {
          getGasPrice: sinon.stub().resolves(gasPrice),
        },
      },
      policy: {
        maxGasCostQuote: 2,
      },
      gasLimit,
      quoteTokenAddress: '0x9999999999999999999999999999999999999999',
      preferredLiquiditySource: LiquiditySource.ONEINCH,
      gasPrice,
    });

    expect(result.approved).to.be.true;
    expect(result.gasCostQuoteRaw?.eq(ethers.utils.parseUnits('1.3', 6))).to.be
      .true;
    expect(oneInchQuoteStub.calledOnce).to.be.true;
  });

  it('uses configured L2 gas buffer basis points', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const gasPrice = ethers.utils.parseUnits('1', 'gwei');
    const gasLimit = BigNumber.from(900000);
    const bufferedGasCostNativeRaw = gasPrice
      .mul(gasLimit)
      .mul(20000)
      .add(9999)
      .div(10000);
    const oneInchQuoteStub = sinon
      .stub(DexRouter.prototype, 'getQuoteFromOneInch')
      .callsFake(async (_chainId, amountIn: BigNumber) => ({
        success: true,
        dstAmount: amountIn.eq(bufferedGasCostNativeRaw)
          ? ethers.utils.parseUnits('2', 6).toString()
          : ethers.utils.parseUnits('1', 6).toString(),
      }));

    const result = await evaluateGasPolicy({
      signer: {
        provider: {},
        getChainId: sinon.stub().resolves(8453),
      } as any,
      config: {
        autoDiscover: {
          enabled: true,
          take: {
            enabled: true,
            maxGasCostQuote: 3,
          },
        },
        oneInchRouters: {
          8453: '0x1111111111111111111111111111111111111111',
        },
        connectorTokens: [],
        tokenAddresses: {
          weth: '0x4200000000000000000000000000000000000006',
        },
      } as any,
      transports: {
        readRpc: {
          getGasPrice: sinon.stub().resolves(gasPrice),
        },
      },
      policy: {
        maxGasCostQuote: 3,
        l2GasCostBufferBasisPoints: 20_000,
      },
      gasLimit,
      quoteTokenAddress: '0x9999999999999999999999999999999999999999',
      preferredLiquiditySource: LiquiditySource.ONEINCH,
      gasPrice,
    });

    expect(result.approved).to.be.true;
    expect(result.gasCostQuoteRaw?.eq(ethers.utils.parseUnits('2', 6))).to.be
      .true;
    expect(oneInchQuoteStub.calledOnce).to.be.true;
  });

  it('falls back when oneInchRouters is present but empty', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(18);

    const result = await evaluateGasPolicy({
      signer: {
        provider: {},
        getChainId: sinon.stub().resolves(1),
      } as any,
      config: {
        autoDiscover: {
          enabled: true,
          take: {
            enabled: true,
            maxGasCostQuote: 5,
          },
        },
        oneInchRouters: {},
        tokenAddresses: {
          weth: '0x4200000000000000000000000000000000000006',
        },
      } as any,
      transports: {
        readRpc: {
          getGasPrice: sinon
            .stub()
            .resolves(ethers.utils.parseUnits('1', 'gwei')),
        },
      },
      policy: {
        maxGasCostQuote: 5,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: '0x9999999999999999999999999999999999999999',
      gasPrice: ethers.utils.parseUnits('1', 'gwei'),
      rpcCache: {},
    });

    expect(result.approved).to.be.false;
    expect(result.reason).to.equal(
      'no liquidity source available for gas cost conversion'
    );
  });

  it('recognizes wrapped native aliases from tokenAddresses for quote-denominated gas conversion', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const oneInchQuoteStub = sinon
      .stub(DexRouter.prototype, 'getQuoteFromOneInch')
      .resolves({
        success: true,
        dstAmount: ethers.utils.parseUnits('1', 6).toString(),
      });

    const result = await evaluateGasPolicy({
      signer: {
        provider: {},
        getChainId: sinon.stub().resolves(43114),
      } as any,
      config: {
        autoDiscover: {
          enabled: true,
          take: {
            enabled: true,
            maxGasCostQuote: 5,
          },
        },
        oneInchRouters: {
          43114: '0x1111111111111111111111111111111111111111',
        },
        connectorTokens: [],
        tokenAddresses: {
          wavax: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
        },
      } as any,
      transports: {
        readRpc: {
          getGasPrice: sinon
            .stub()
            .resolves(ethers.utils.parseUnits('1', 'gwei')),
        },
      },
      policy: {
        maxGasCostQuote: 5,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: '0x9999999999999999999999999999999999999999',
      preferredLiquiditySource: LiquiditySource.ONEINCH,
      gasPrice: ethers.utils.parseUnits('1', 'gwei'),
      rpcCache: {},
    });

    expect(result.approved).to.be.true;
    expect(oneInchQuoteStub.calledOnce).to.be.true;
    expect(oneInchQuoteStub.firstCall.args[2]).to.equal(
      '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7'
    );
  });

  it('falls back to uniswap gas quoting when 1inch is unavailable on the active chain', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const oneInchQuoteStub = sinon.stub(
      DexRouter.prototype,
      'getQuoteFromOneInch'
    );
    const uniswapAvailabilityStub = sinon
      .stub(UniswapV3QuoteProvider.prototype, 'isAvailable')
      .returns(true);
    const uniswapPoolExistsStub = sinon
      .stub(UniswapV3QuoteProvider.prototype, 'poolExists')
      .resolves(true);
    const uniswapQuoteStub = sinon
      .stub(UniswapV3QuoteProvider.prototype, 'getQuote')
      .resolves({
        success: true,
        dstAmount: ethers.utils.parseUnits('2', 6).toString(),
      } as any);

    const result = await evaluateGasPolicy({
      signer: {
        provider: {},
        getChainId: sinon.stub().resolves(8453),
      } as any,
      config: {
        autoDiscover: {
          enabled: true,
          settlement: {
            enabled: true,
            maxGasCostQuote: 5,
          },
        },
        oneInchRouters: {
          1: '0x1111111111111111111111111111111111111111',
        },
        uniswapV3RouterOverrides: {
          poolFactoryAddress: '0x3333333333333333333333333333333333333333',
          quoterV2Address: '0x4444444444444444444444444444444444444444',
          wethAddress: '0x4200000000000000000000000000000000000006',
          defaultFeeTier: 3000,
          candidateFeeTiers: [3000],
        },
        tokenAddresses: {
          weth: '0x4200000000000000000000000000000000000006',
        },
      } as any,
      transports: {
        readRpc: {
          getGasPrice: sinon
            .stub()
            .resolves(ethers.utils.parseUnits('1', 'gwei')),
        },
      },
      policy: {
        maxGasCostQuote: 5,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: '0x9999999999999999999999999999999999999999',
      preferredLiquiditySource: LiquiditySource.ONEINCH,
      gasPrice: ethers.utils.parseUnits('1', 'gwei'),
      rpcCache: {},
    });

    expect(result.approved).to.be.true;
    expect(oneInchQuoteStub.called).to.be.false;
    expect(uniswapAvailabilityStub.called).to.be.true;
    expect(uniswapPoolExistsStub.calledOnce).to.be.true;
    expect(uniswapQuoteStub.calledOnce).to.be.true;
  });

  it('skips 1inch gas quote conversion while the quote circuit is open', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const oneInchQuoteStub = sinon.stub(
      DexRouter.prototype,
      'getQuoteFromOneInch'
    );
    sinon.stub(UniswapV3QuoteProvider.prototype, 'isAvailable').returns(true);
    sinon.stub(UniswapV3QuoteProvider.prototype, 'poolExists').resolves(true);
    const uniswapQuoteStub = sinon
      .stub(UniswapV3QuoteProvider.prototype, 'getQuote')
      .resolves({
        success: true,
        dstAmount: ethers.utils.parseUnits('2', 6).toString(),
      } as any);

    const result = await evaluateGasPolicy({
      signer: {
        provider: {},
        getChainId: sinon.stub().resolves(8453),
      } as any,
      config: {
        autoDiscover: {
          enabled: true,
          take: {
            enabled: true,
            maxGasCostQuote: 5,
            oneInchQuoteFailureCooldownMs: 30_000,
            oneInchQuoteFailureThreshold: 2,
          },
        },
        oneInchRouters: {
          8453: '0x1111111111111111111111111111111111111111',
        },
        uniswapV3RouterOverrides: {
          poolFactoryAddress: '0x3333333333333333333333333333333333333333',
          quoterV2Address: '0x4444444444444444444444444444444444444444',
          wethAddress: '0x4200000000000000000000000000000000000006',
          defaultFeeTier: 3000,
          candidateFeeTiers: [3000],
        },
        tokenAddresses: {
          weth: '0x4200000000000000000000000000000000000006',
        },
      } as any,
      transports: {
        readRpc: {
          getGasPrice: sinon
            .stub()
            .resolves(ethers.utils.parseUnits('1', 'gwei')),
        },
      },
      policy: {
        maxGasCostQuote: 5,
        oneInchQuoteFailureCooldownMs: 30_000,
        oneInchQuoteFailureThreshold: 2,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: '0x9999999999999999999999999999999999999999',
      preferredLiquiditySource: LiquiditySource.ONEINCH,
      gasPrice: ethers.utils.parseUnits('1', 'gwei'),
      rpcCache: {
        chainId: 8453,
        providerCircuits: {
          oneinch: {
            gas_conversion: {
              failures: 2,
              cooldownUntilMs: Date.now() + 30_000,
            },
          },
        },
      },
    });

    expect(result.approved).to.be.true;
    expect(oneInchQuoteStub.called).to.be.false;
    expect(uniswapQuoteStub.calledOnce).to.be.true;
    expect(result.gasQuoteAttempts?.[0]).to.deep.include({
      source: LiquiditySource.ONEINCH,
      success: false,
    });
    expect(result.gasQuoteAttempts?.[0].reason).to.include(
      'purpose=gas_conversion'
    );
    expect(result.gasQuoteAttempts?.[1]).to.deep.include({
      source: LiquiditySource.UNISWAPV3,
      success: true,
      amountOut: ethers.utils.parseUnits('2', 6).toString(),
    });
  });

  it('tries another configured gas quote source when the preferred source cannot quote', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const oneInchQuoteStub = sinon
      .stub(DexRouter.prototype, 'getQuoteFromOneInch')
      .resolves({ success: false, error: 'no route' });
    sinon.stub(UniswapV3QuoteProvider.prototype, 'isAvailable').returns(true);
    sinon.stub(UniswapV3QuoteProvider.prototype, 'poolExists').resolves(true);
    const uniswapQuoteStub = sinon
      .stub(UniswapV3QuoteProvider.prototype, 'getQuote')
      .resolves({
        success: true,
        dstAmount: ethers.utils.parseUnits('2', 6).toString(),
      } as any);

    const result = await evaluateGasPolicy({
      signer: {
        provider: {},
        getChainId: sinon.stub().resolves(8453),
      } as any,
      config: {
        autoDiscover: {
          enabled: true,
          take: {
            enabled: true,
            maxGasCostQuote: 5,
          },
        },
        oneInchRouters: {
          8453: '0x1111111111111111111111111111111111111111',
        },
        uniswapV3RouterOverrides: {
          poolFactoryAddress: '0x3333333333333333333333333333333333333333',
          quoterV2Address: '0x4444444444444444444444444444444444444444',
          wethAddress: '0x4200000000000000000000000000000000000006',
          defaultFeeTier: 3000,
          candidateFeeTiers: [3000],
        },
        tokenAddresses: {
          weth: '0x4200000000000000000000000000000000000006',
        },
      } as any,
      transports: {
        readRpc: {
          getGasPrice: sinon
            .stub()
            .resolves(ethers.utils.parseUnits('1', 'gwei')),
        },
      },
      policy: {
        maxGasCostQuote: 5,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: '0x9999999999999999999999999999999999999999',
      preferredLiquiditySource: LiquiditySource.ONEINCH,
      gasPrice: ethers.utils.parseUnits('1', 'gwei'),
      rpcCache: {
        chainId: 8453,
      },
    });

    expect(result.approved).to.be.true;
    expect(result.gasCostQuoteRaw?.eq(ethers.utils.parseUnits('2', 6))).to.be
      .true;
    expect(oneInchQuoteStub.calledOnce).to.be.true;
    expect(uniswapQuoteStub.calledOnce).to.be.true;
  });

  it('retries a preferred gas quote source after a short fallback-cache window', async () => {
    const clock = sinon.useFakeTimers({ now: 1_000, toFake: ['Date'] });
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const oneInchQuoteStub = sinon
      .stub(DexRouter.prototype, 'getQuoteFromOneInch')
      .onFirstCall()
      .resolves({ success: false, error: 'temporary no route' })
      .onSecondCall()
      .resolves({
        success: true,
        dstAmount: ethers.utils.parseUnits('1', 6).toString(),
      });
    sinon.stub(UniswapV3QuoteProvider.prototype, 'isAvailable').returns(true);
    sinon.stub(UniswapV3QuoteProvider.prototype, 'poolExists').resolves(true);
    const uniswapQuoteStub = sinon
      .stub(UniswapV3QuoteProvider.prototype, 'getQuote')
      .resolves({
        success: true,
        dstAmount: ethers.utils.parseUnits('2', 6).toString(),
      } as any);
    const rpcCache = {
      chainId: 8453,
      stats: {},
    };
    const params = {
      signer: {
        provider: {},
        getChainId: sinon.stub().resolves(8453),
      } as any,
      config: {
        autoDiscover: {
          enabled: true,
          take: {
            enabled: true,
            maxGasCostQuote: 5,
          },
        },
        oneInchRouters: {
          8453: '0x1111111111111111111111111111111111111111',
        },
        uniswapV3RouterOverrides: {
          poolFactoryAddress: '0x3333333333333333333333333333333333333333',
          quoterV2Address: '0x4444444444444444444444444444444444444444',
          wethAddress: '0x4200000000000000000000000000000000000006',
          defaultFeeTier: 3000,
          candidateFeeTiers: [3000],
        },
        tokenAddresses: {
          weth: '0x4200000000000000000000000000000000000006',
        },
      } as any,
      transports: {
        readRpc: {
          getGasPrice: sinon
            .stub()
            .resolves(ethers.utils.parseUnits('1', 'gwei')),
        },
      },
      policy: {
        maxGasCostQuote: 5,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: '0x9999999999999999999999999999999999999999',
      preferredLiquiditySource: LiquiditySource.ONEINCH,
      gasPrice: ethers.utils.parseUnits('1', 'gwei'),
      rpcCache,
    };

    const firstResult = await evaluateGasPolicy(params);
    const cachedFallbackResult = await evaluateGasPolicy(params);
    clock.tick(5_001);
    const preferredResult = await evaluateGasPolicy(params);

    expect(firstResult.gasCostQuoteRaw?.eq(ethers.utils.parseUnits('2', 6))).to
      .be.true;
    expect(
      cachedFallbackResult.gasCostQuoteRaw?.eq(ethers.utils.parseUnits('2', 6))
    ).to.be.true;
    expect(preferredResult.gasCostQuoteRaw?.eq(ethers.utils.parseUnits('1', 6)))
      .to.be.true;
    expect(oneInchQuoteStub.calledTwice).to.be.true;
    expect(uniswapQuoteStub.calledOnce).to.be.true;
    expect(rpcCache.stats).to.deep.include({
      gasQuoteConversionCacheMisses: 2,
      gasQuoteConversionCacheHits: 1,
    });
  });

  it('uses candidate fee tiers for Uniswap gas quote conversion', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    sinon.stub(UniswapV3QuoteProvider.prototype, 'isAvailable').returns(true);
    const poolExistsStub = sinon
      .stub(UniswapV3QuoteProvider.prototype, 'poolExists')
      .callsFake(
        async (_tokenIn, _tokenOut, feeTier?: number) => feeTier === 500
      );
    const uniswapQuoteStub = sinon
      .stub(UniswapV3QuoteProvider.prototype, 'getQuote')
      .callsFake(
        async (_amountIn, _tokenIn, _tokenOut, feeTier?: number) =>
          ({
            success: feeTier === 500,
            dstAmount:
              feeTier === 500
                ? ethers.utils.parseUnits('3', 6).toString()
                : undefined,
          }) as any
      );

    const result = await evaluateGasPolicy({
      signer: {
        provider: {},
        getChainId: sinon.stub().resolves(8453),
      } as any,
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
          wethAddress: '0x4200000000000000000000000000000000000006',
          defaultFeeTier: 3000,
          candidateFeeTiers: [500],
        },
        tokenAddresses: {
          weth: '0x4200000000000000000000000000000000000006',
        },
      } as any,
      transports: {
        readRpc: {
          getGasPrice: sinon
            .stub()
            .resolves(ethers.utils.parseUnits('1', 'gwei')),
        },
      },
      policy: {
        maxGasCostQuote: 5,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: '0x9999999999999999999999999999999999999999',
      preferredLiquiditySource: LiquiditySource.UNISWAPV3,
      gasPrice: ethers.utils.parseUnits('1', 'gwei'),
      rpcCache: {
        chainId: 8453,
      },
    });

    expect(result.approved).to.be.true;
    expect(result.gasCostQuoteRaw?.eq(ethers.utils.parseUnits('3', 6))).to.be
      .true;
    expect(poolExistsStub.calledTwice).to.be.true;
    expect(uniswapQuoteStub.calledOnce).to.be.true;
    expect(uniswapQuoteStub.firstCall.args[3]).to.equal(500);
  });

  it('records a failed Uniswap gas quote attempt when pools exist but return no usable quote', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    sinon.stub(UniswapV3QuoteProvider.prototype, 'isAvailable').returns(true);
    const poolExistsStub = sinon
      .stub(UniswapV3QuoteProvider.prototype, 'poolExists')
      .resolves(true);
    const uniswapQuoteStub = sinon
      .stub(UniswapV3QuoteProvider.prototype, 'getQuote')
      .resolves({ success: false } as any);

    const result = await evaluateGasPolicy({
      signer: {
        provider: {},
        getChainId: sinon.stub().resolves(8453),
      } as any,
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
          wethAddress: '0x4200000000000000000000000000000000000006',
          defaultFeeTier: 3000,
        },
        tokenAddresses: {
          weth: '0x4200000000000000000000000000000000000006',
        },
      } as any,
      transports: {
        readRpc: {
          getGasPrice: sinon
            .stub()
            .resolves(ethers.utils.parseUnits('1', 'gwei')),
        },
      },
      policy: {
        maxGasCostQuote: 5,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: '0x9999999999999999999999999999999999999999',
      preferredLiquiditySource: LiquiditySource.UNISWAPV3,
      gasPrice: ethers.utils.parseUnits('1', 'gwei'),
      rpcCache: {
        chainId: 8453,
      },
    });

    expect(result.approved).to.equal(false);
    expect(result.rejectCode).to.equal(
      'native_to_quote_conversion_unavailable'
    );
    expect(result.gasQuoteAttempts).to.have.length(1);
    expect(result.gasQuoteAttempts?.[0]).to.deep.include({
      source: LiquiditySource.UNISWAPV3,
      success: false,
      reason: 'direct DEX pool exists but returned no usable gas quote',
    });
    expect(result.gasQuoteAttempts?.[0].feeTiers).to.deep.equal([
      3000, 100, 500, 10000,
    ]);
    expect(poolExistsStub.callCount).to.equal(4);
    expect(uniswapQuoteStub.callCount).to.equal(4);
  });

  it('keeps the best V3 gas quote when a later fee tier fails', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    sinon.stub(UniswapV3QuoteProvider.prototype, 'isAvailable').returns(true);
    const poolExistsStub = sinon
      .stub(UniswapV3QuoteProvider.prototype, 'poolExists')
      .callsFake(async (_tokenIn, _tokenOut, feeTier?: number) => {
        if (feeTier === 3000) {
          throw new Error('rpc timeout');
        }
        return feeTier === 500 || feeTier === 3000;
      });
    const uniswapQuoteStub = sinon
      .stub(UniswapV3QuoteProvider.prototype, 'getQuote')
      .callsFake(
        async (_amountIn, _tokenIn, _tokenOut, feeTier?: number) =>
          ({
            success: feeTier === 500,
            dstAmount:
              feeTier === 500
                ? ethers.utils.parseUnits('3', 6).toString()
                : undefined,
          }) as any
      );

    const result = await evaluateGasPolicy({
      signer: {
        provider: {},
        getChainId: sinon.stub().resolves(8453),
      } as any,
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
          wethAddress: '0x4200000000000000000000000000000000000006',
          defaultFeeTier: 500,
        },
        tokenAddresses: {
          weth: '0x4200000000000000000000000000000000000006',
        },
      } as any,
      transports: {
        readRpc: {
          getGasPrice: sinon
            .stub()
            .resolves(ethers.utils.parseUnits('1', 'gwei')),
        },
      },
      policy: {
        maxGasCostQuote: 5,
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: '0x9999999999999999999999999999999999999999',
      preferredLiquiditySource: LiquiditySource.UNISWAPV3,
      gasPrice: ethers.utils.parseUnits('1', 'gwei'),
      rpcCache: {
        chainId: 8453,
      },
    });

    expect(result.approved).to.be.true;
    expect(result.gasCostQuoteRaw?.eq(ethers.utils.parseUnits('3', 6))).to.be
      .true;
    expect(poolExistsStub.callCount).to.equal(4);
    expect(uniswapQuoteStub.calledOnce).to.be.true;
    expect(uniswapQuoteStub.firstCall.args[3]).to.equal(500);
  });

  it('quotes gas cost and minProfitNative together when no quote gas cap is configured', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    const gasCostNativeRaw = ethers.utils.parseUnits('1', 'gwei').mul(900000);
    const bufferedGasCostNativeRaw = gasCostNativeRaw
      .mul(13000)
      .add(9999)
      .div(10000);
    const minProfitNative = ethers.utils.parseEther('0.01');
    const combinedNativeRaw = bufferedGasCostNativeRaw.add(minProfitNative);
    const combinedQuoteRaw = ethers.utils.parseUnits('21', 6);
    const oneInchQuoteStub = sinon
      .stub(DexRouter.prototype, 'getQuoteFromOneInch')
      .callsFake(async (_chainId, amountIn: BigNumber) => ({
        success: true,
        dstAmount: amountIn.eq(combinedNativeRaw)
          ? combinedQuoteRaw.toString()
          : ethers.utils.parseUnits('999', 6).toString(),
      }));

    const result = await evaluateGasPolicy({
      signer: {
        provider: {},
        getChainId: sinon.stub().resolves(8453),
      } as any,
      config: {
        autoDiscover: {
          enabled: true,
          take: {
            enabled: true,
          },
        },
        oneInchRouters: {
          8453: '0x1111111111111111111111111111111111111111',
        },
        connectorTokens: [],
        tokenAddresses: {
          weth: '0x4200000000000000000000000000000000000006',
        },
      } as any,
      transports: {
        readRpc: {
          getGasPrice: sinon
            .stub()
            .resolves(ethers.utils.parseUnits('1', 'gwei')),
        },
      },
      policy: {
        minProfitNative: minProfitNative.toString(),
      },
      gasLimit: BigNumber.from(900000),
      quoteTokenAddress: '0x9999999999999999999999999999999999999999',
      preferredLiquiditySource: LiquiditySource.ONEINCH,
      useProfitFloor: true,
      gasPrice: ethers.utils.parseUnits('1', 'gwei'),
      rpcCache: {
        chainId: 8453,
      },
    });

    expect(result.approved).to.be.true;
    expect(
      result.gasCostQuoteRaw
        ?.add(result.minProfitNativeQuoteRaw ?? BigNumber.from(0))
        .eq(combinedQuoteRaw)
    ).to.be.true;
    expect(oneInchQuoteStub.calledOnce).to.be.true;
    expect(oneInchQuoteStub.firstCall.args[1].eq(combinedNativeRaw)).to.be.true;
  });
});
