import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, ethers } from 'ethers';
import {
  CurveQuoteProvider,
  CurveQuoteProviderAdapters,
} from '../../src/dex/providers/curve-quote-provider';
import { CurvePoolType } from '../../src/config';

describe('Curve Quote Provider', () => {
  let mockSigner: any;
  const WETH = '0x4200000000000000000000000000000000000006';
  const USDC = '0x53Be558aF29cC65126ED0E585119FAC748FeB01B';
  const DAI = '0x1111111111111111111111111111111111111111';
  const POOL = '0x6e53131F68a034873b6bFA15502aF094Ef0c5854';
  const ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

  beforeEach(() => {
    // Create basic mock signer - same pattern as other tests
    mockSigner = {
      getAddress: sinon.stub().resolves('0xTestAddress'),
      getChainId: sinon.stub().resolves(8453), // Base chain ID
      provider: {
        getNetwork: sinon.stub().resolves({ chainId: 8453, name: 'base' }),
        getCode: sinon.stub().resolves('0x123456'),
      },
    };
  });

  afterEach(() => {
    sinon.restore();
  });

  function makeProvider(
    overrides: any = {},
    adapters: Partial<CurveQuoteProviderAdapters> = {}
  ): CurveQuoteProvider {
    return new CurveQuoteProvider(
      mockSigner,
      {
        poolConfigs: {
          'WETH-USDC': {
            address: POOL,
            poolType: CurvePoolType.STABLE,
          },
        },
        defaultSlippage: 1.0,
        wethAddress: WETH,
        tokenAddresses: {
          WETH,
          USDC,
          DAI,
        },
        ...overrides,
      },
      adapters
    );
  }

  function selectedPool(overrides: any = {}) {
    return {
      address: POOL,
      poolType: CurvePoolType.STABLE,
      tokenInIndex: 0,
      tokenOutIndex: 1,
      ...overrides,
    };
  }

  function curveContractAdapters(
    contract: any
  ): Partial<CurveQuoteProviderAdapters> {
    return {
      makeContract: sinon
        .stub()
        .callsFake(
          (_address: string, _abi: any, _signer: any) => contract
        ) as any,
    };
  }

  describe('Real provider fail-closed behavior', () => {
    it('reports initialization fast path and configured pools', async () => {
      const provider = makeProvider();

      expect(await provider.initialize()).to.equal(true);
      expect(await provider.initialize()).to.equal(true);
      expect(provider.isAvailable()).to.equal(true);
      expect(provider.getConfiguredPools()).to.deep.equal([POOL]);

      const emptyProvider: any = makeProvider({ poolConfigs: {} });
      emptyProvider.isInitialized = true;
      expect(emptyProvider.isAvailable()).to.equal(false);
    });

    it('stays unavailable and refuses quotes when no pools are configured', async () => {
      const provider = makeProvider({ poolConfigs: {} });

      expect(await provider.initialize()).to.equal(false);
      expect(provider.isAvailable()).to.equal(false);

      const quote = await provider.getQuote(BigNumber.from(100), WETH, USDC);
      expect(quote).to.deep.equal({
        success: false,
        error: 'Quote provider not available',
      });
    });

    it('caches positive and negative pool selections', async () => {
      const provider: any = makeProvider();
      await provider.initialize();
      const findPool = sinon.stub(provider, 'findPoolForTokenPair').resolves({
        address: POOL,
        poolType: CurvePoolType.STABLE,
      });
      const resolveFromConfig = sinon
        .stub(provider, 'resolvePoolSelectionFromConfig')
        .resolves(selectedPool());

      expect(await provider.resolvePoolSelection(WETH, USDC)).to.deep.equal(
        selectedPool()
      );
      expect(await provider.resolvePoolSelection(WETH, USDC)).to.deep.equal(
        selectedPool()
      );
      expect(findPool.calledOnce).to.equal(true);
      expect(resolveFromConfig.calledOnce).to.equal(true);

      const negativeProvider: any = makeProvider();
      await negativeProvider.initialize();
      const negativeFind = sinon
        .stub(negativeProvider, 'findPoolForTokenPair')
        .resolves(undefined);
      expect(await negativeProvider.resolvePoolSelection(DAI, USDC)).to.equal(
        undefined
      );
      expect(await negativeProvider.resolvePoolSelection(DAI, USDC)).to.equal(
        undefined
      );
      expect(negativeFind.calledOnce).to.equal(true);
    });

    it('expires stale pool-selection cache entries', () => {
      const provider: any = makeProvider();
      const cacheKey = `${WETH.toLowerCase()}:${USDC.toLowerCase()}`;
      provider.poolSelectionCache.set(cacheKey, {
        selection: selectedPool(),
        expiresAt: Date.now() - 1,
      });

      expect(provider.getCachedPoolSelection(cacheKey)).to.deep.equal({
        hit: false,
      });
      expect(provider.poolSelectionCache.has(cacheKey)).to.equal(false);
    });

    it('returns undefined when resolvePoolSelection cannot initialize', async () => {
      const provider = makeProvider({ poolConfigs: {} });

      expect(await provider.resolvePoolSelection(WETH, USDC)).to.equal(
        undefined
      );
    });

    it('uses symbol lookup first and then address fallback checks', async () => {
      const provider: any = makeProvider();
      expect(await provider.findPoolForTokenPair(WETH, USDC)).to.deep.equal({
        address: POOL,
        poolType: CurvePoolType.STABLE,
      });

      const missingProvider: any = makeProvider({ tokenAddresses: undefined });
      const missingCheck = sinon
        .stub(missingProvider, 'checkTokensInPool')
        .resolves(false);
      expect(await missingProvider.findPoolForTokenPair(ETH, USDC)).to.equal(
        undefined
      );
      expect(
        missingCheck.calledOnceWith(
          POOL,
          CurvePoolType.STABLE,
          WETH.toLowerCase(),
          USDC.toLowerCase()
        )
      ).to.equal(true);

      const failingProvider: any = makeProvider({ tokenAddresses: undefined });
      sinon
        .stub(failingProvider, 'checkTokensInPool')
        .rejects(new Error('bad pool'));
      expect(await failingProvider.findPoolForTokenPair(WETH, USDC)).to.equal(
        undefined
      );
    });

    it('returns undefined for missing token-symbol mappings', () => {
      const provider: any = makeProvider({ tokenAddresses: undefined });
      expect(provider.getTokenSymbolFromAddress(WETH)).to.equal(undefined);

      const mappedProvider: any = makeProvider();
      expect(
        mappedProvider.getTokenSymbolFromAddress(
          '0x9999999999999999999999999999999999999999'
        )
      ).to.equal(undefined);
    });

    it('checks tokens in a pool and treats discovery errors as unavailable', async () => {
      const provider: any = makeProvider();
      const discover = sinon.stub(provider, 'discoverTokenIndices');
      discover.onFirstCall().resolves({ tokenInIndex: 0, tokenOutIndex: 1 });
      discover.onSecondCall().resolves({ tokenInIndex: 0 });
      discover.onThirdCall().rejects(new Error('coins reverted'));

      expect(
        await provider.checkTokensInPool(POOL, CurvePoolType.STABLE, WETH, USDC)
      ).to.equal(true);
      expect(
        await provider.checkTokensInPool(POOL, CurvePoolType.STABLE, WETH, USDC)
      ).to.equal(false);
      expect(
        await provider.checkTokensInPool(POOL, CurvePoolType.STABLE, WETH, USDC)
      ).to.equal(false);
    });

    it('resolves configured pools only when discovered indices are valid', async () => {
      const provider: any = makeProvider();
      const discover = sinon.stub(provider, 'discoverTokenIndices');
      discover.onFirstCall().resolves({ tokenInIndex: 0, tokenOutIndex: 1 });
      discover.onSecondCall().resolves({ tokenInIndex: 16, tokenOutIndex: 1 });
      discover.onThirdCall().resolves({ tokenInIndex: 0 });

      const poolConfig = { address: POOL, poolType: CurvePoolType.STABLE };
      expect(
        await provider.resolvePoolSelectionFromConfig(poolConfig, WETH, USDC)
      ).to.deep.equal(selectedPool());
      expect(
        await provider.resolvePoolSelectionFromConfig(poolConfig, WETH, USDC)
      ).to.equal(undefined);
      expect(
        await provider.resolvePoolSelectionFromConfig(poolConfig, WETH, USDC)
      ).to.equal(undefined);
    });

    it('discovers token indices and normalizes native ETH to WETH', async () => {
      const coins = sinon.stub();
      coins.withArgs(0).resolves(WETH);
      coins.withArgs(1).resolves(USDC);
      coins.rejects(new Error('index out of range'));

      const provider: any = makeProvider({}, curveContractAdapters({ coins }));
      const indices = await provider.discoverTokenIndices(
        POOL,
        CurvePoolType.STABLE,
        ETH,
        USDC
      );

      expect(indices).to.deep.equal({ tokenInIndex: 0, tokenOutIndex: 1 });
      expect(coins.calledWith(2)).to.equal(true);
    });

    it('discovers crypto-pool indices with native ETH as output token', async () => {
      const coins = sinon.stub();
      coins.withArgs(0).resolves(WETH);
      coins.withArgs(1).resolves(USDC);
      coins.rejects(new Error('index out of range'));

      const provider: any = makeProvider({}, curveContractAdapters({ coins }));
      const indices = await provider.discoverTokenIndices(
        POOL,
        CurvePoolType.CRYPTO,
        USDC,
        ETH
      );

      expect(indices).to.deep.equal({ tokenInIndex: 1, tokenOutIndex: 0 });
    });

    it('reports pool existence without throwing on lookup failures', async () => {
      const provider: any = makeProvider();
      sinon.stub(provider, 'resolvePoolSelection').resolves(selectedPool());
      expect(await provider.poolExists(WETH, USDC)).to.equal(true);

      const missingProvider: any = makeProvider();
      sinon.stub(missingProvider, 'resolvePoolSelection').resolves(undefined);
      expect(await missingProvider.poolExists(DAI, USDC)).to.equal(false);

      const failingProvider: any = makeProvider();
      sinon
        .stub(failingProvider, 'resolvePoolSelection')
        .rejects(new Error('rpc down'));
      expect(await failingProvider.poolExists(WETH, USDC)).to.equal(false);
    });

    it('returns no-pool and zero-output quote failures before reporting success', async () => {
      const provider: any = makeProvider();
      sinon.stub(provider, 'resolvePoolSelection').resolves(undefined);
      const noPool = await provider.getQuote(BigNumber.from(100), WETH, USDC);
      expect(noPool.success).to.equal(false);
      expect(noPool.error).to.match(/No Curve pool configured/);

      const getDy = sinon.stub().resolves(BigNumber.from(0));
      const zeroProvider: any = makeProvider(
        {},
        curveContractAdapters({ get_dy: getDy })
      );
      sinon.stub(zeroProvider, 'resolvePoolSelection').resolves(
        selectedPool({
          poolType: CurvePoolType.CRYPTO,
        })
      );

      const zeroQuote = await zeroProvider.getQuote(
        BigNumber.from(100),
        WETH,
        USDC,
        { inputDecimals: 18, outputDecimals: 6 }
      );
      expect(zeroQuote).to.deep.equal({
        success: false,
        error: 'Zero output from Curve pool',
      });
      expect(getDy.calledOnceWith(0, 1, BigNumber.from(100))).to.equal(true);
    });

    it('returns successful quotes with the selected pool attached', async () => {
      const getDy = sinon.stub().resolves(BigNumber.from(950));
      const provider: any = makeProvider(
        {},
        curveContractAdapters({ get_dy: getDy })
      );
      const pool = selectedPool();
      sinon.stub(provider, 'resolvePoolSelection').resolves(pool);

      const quote = await provider.getQuote(BigNumber.from(1000), WETH, USDC, {
        inputDecimals: 18,
        outputDecimals: 6,
      });

      expect(quote.success).to.equal(true);
      expect(quote.dstAmount.toString()).to.equal('950');
      expect(quote.selectedPool).to.deep.equal(pool);
    });

    it('loads token decimals only when quote decimals are not supplied', async () => {
      const getDecimals = sinon.stub();
      getDecimals.withArgs(mockSigner, WETH).resolves(18);
      getDecimals.withArgs(mockSigner, USDC).resolves(6);
      const provider: any = makeProvider(
        {},
        {
          ...curveContractAdapters({
            get_dy: sinon.stub().resolves(BigNumber.from(950)),
          }),
          getDecimals: getDecimals as any,
        }
      );
      sinon.stub(provider, 'resolvePoolSelection').resolves(selectedPool());

      const quote = await provider.getQuote(BigNumber.from(1000), WETH, USDC);

      expect(quote.success).to.equal(true);
      expect(getDecimals.calledTwice).to.equal(true);
    });

    it('classifies Curve quote contract errors', async () => {
      for (const [message, reason, expected] of [
        [
          'INSUFFICIENT_LIQUIDITY',
          undefined,
          'Insufficient liquidity in Curve pool',
        ],
        ['execution reverted', 'bad pool', 'Curve pool reverted: bad pool'],
        [
          'execution reverted',
          undefined,
          'Curve pool reverted: execution reverted',
        ],
        ['rpc unavailable', undefined, 'Curve quote error: rpc unavailable'],
      ]) {
        sinon.restore();
        const error: any = new Error(message);
        error.reason = reason;
        const provider: any = makeProvider(
          {},
          curveContractAdapters({ get_dy: sinon.stub().rejects(error) })
        );
        sinon.stub(provider, 'resolvePoolSelection').resolves(selectedPool());

        const quote = await provider.getQuote(BigNumber.from(100), WETH, USDC, {
          inputDecimals: 18,
          outputDecimals: 6,
        });
        expect(quote).to.deep.equal({ success: false, error: expected });
      }
    });

    it('calculates market price and propagates quote/amount failures', async () => {
      const provider: any = makeProvider();
      const getQuote = sinon.stub(provider, 'getQuote');
      getQuote.onFirstCall().resolves({
        success: true,
        dstAmount: ethers.utils.parseUnits('2', 6),
      });
      getQuote.onSecondCall().resolves({
        success: false,
        error: 'No Curve pool configured',
      });
      getQuote.onThirdCall().resolves({
        success: true,
        dstAmount: BigNumber.from(0),
      });

      const price = await provider.getMarketPrice(
        ethers.utils.parseEther('1'),
        WETH,
        USDC,
        18,
        6
      );
      expect(price).to.deep.equal({ success: true, price: 2 });

      const quoteFailure = await provider.getMarketPrice(
        BigNumber.from(100),
        WETH,
        USDC,
        18,
        6
      );
      expect(quoteFailure).to.deep.equal({
        success: false,
        error: 'No Curve pool configured',
      });

      const amountFailure = await provider.getMarketPrice(
        BigNumber.from(100),
        WETH,
        USDC,
        18,
        6
      );
      expect(amountFailure).to.deep.equal({
        success: false,
        error: 'Invalid amounts for price calculation',
      });

      getQuote.onCall(3).rejects(new Error('math exploded'));
      const thrownFailure = await provider.getMarketPrice(
        BigNumber.from(100),
        WETH,
        USDC,
        18,
        6
      );
      expect(thrownFailure).to.deep.equal({
        success: false,
        error: 'Market price calculation failed: math exploded',
      });
    });
  });

  describe('Class Import and Basic Functionality', () => {
    it('should import CurveQuoteProvider class successfully', () => {
      expect(CurveQuoteProvider).to.be.a('function');
      expect(CurveQuoteProvider.name).to.equal('CurveQuoteProvider');
    });

    it('should return pool configurations from config', () => {
      const config = {
        poolConfigs: {
          'tbtc-weth': {
            address: '0x6e53131F68a034873b6bFA15502aF094Ef0c5854',
            poolType: CurvePoolType.CRYPTO,
          },
          'usdc_t-usd_t1': {
            address: '0x01C2c9f2C271ECEF81287B44FA6F813a1605F5Eb',
            poolType: CurvePoolType.STABLE,
          },
        },
        defaultSlippage: 1.0,
        wethAddress: '0x4200000000000000000000000000000000000006',
        tokenAddresses: {
          weth: '0x4200000000000000000000000000000000000006',
          usdc_t: '0x53Be558aF29cC65126ED0E585119FAC748FeB01B',
          usd_t1: '0xf0c44a9f24159E1f2A0D9Ba3203172f528d224CA',
          tbtc: '0x236aa50979D5f3De3Bd1Eeb40E81137F22ab794b',
        },
      };

      // Test pool configuration structure
      expect(config.poolConfigs['tbtc-weth'].address).to.equal(
        '0x6e53131F68a034873b6bFA15502aF094Ef0c5854'
      );
      expect(config.poolConfigs['tbtc-weth'].poolType).to.equal(
        CurvePoolType.CRYPTO
      );
      expect(config.poolConfigs['usdc_t-usd_t1'].poolType).to.equal(
        CurvePoolType.STABLE
      );
      expect(ethers.utils.isAddress(config.poolConfigs['tbtc-weth'].address)).to
        .be.true;
    });

    it('should handle missing tokenAddresses in configuration', () => {
      const config = {
        poolConfigs: {
          'usdc_t-usd_t1': {
            address: '0x01C2c9f2C271ECEF81287B44FA6F813a1605F5Eb',
            poolType: CurvePoolType.STABLE,
          },
        },
        defaultSlippage: 1.0,
        wethAddress: '0x4200000000000000000000000000000000000006',
        // tokenAddresses intentionally missing
      };

      expect(config).to.not.have.property('tokenAddresses');
      expect(config.poolConfigs).to.have.property('usdc_t-usd_t1');
    });
  });

  describe('Pool Configuration Validation Logic', () => {
    it('should validate Base production pool addresses are valid format', () => {
      const basePoolAddresses = {
        cryptoPool: '0x6e53131F68a034873b6bFA15502aF094Ef0c5854', // TriCrypto from config
        stablePool: '0x01C2c9f2C271ECEF81287B44FA6F813a1605F5Eb', // 3-stable from config
        weth: '0x4200000000000000000000000000000000000006', // WETH on Base
      };

      Object.entries(basePoolAddresses).forEach(([name, address]) => {
        expect(
          ethers.utils.isAddress(address),
          `${name} should be valid address`
        ).to.be.true;
        expect(address, `${name} should not be zero address`).to.not.equal(
          '0x0000000000000000000000000000000000000000'
        );
      });
    });

    it('should validate pool type values', () => {
      const validPoolTypes = [CurvePoolType.STABLE, CurvePoolType.CRYPTO];
      const stableType = CurvePoolType.STABLE;
      const cryptoType = CurvePoolType.CRYPTO;

      expect(validPoolTypes).to.include(stableType);
      expect(validPoolTypes).to.include(cryptoType);
      expect(stableType).to.not.equal(cryptoType);
    });

    it('should validate token address mapping logic', () => {
      const tokenAddresses = {
        weth: '0x4200000000000000000000000000000000000006',
        usdc_t: '0x53Be558aF29cC65126ED0E585119FAC748FeB01B',
        usd_t1: '0xf0c44a9f24159E1f2A0D9Ba3203172f528d224CA',
        tbtc: '0x236aa50979D5f3De3Bd1Eeb40E81137F22ab794b',
      };

      // Test symbol lookup logic
      const findSymbolForAddress = (
        targetAddress: string
      ): string | undefined => {
        for (const [symbol, address] of Object.entries(tokenAddresses)) {
          if (address.toLowerCase() === targetAddress.toLowerCase()) {
            return symbol;
          }
        }
        return undefined;
      };

      expect(
        findSymbolForAddress('0x4200000000000000000000000000000000000006')
      ).to.equal('weth');
      expect(
        findSymbolForAddress('0x53Be558aF29cC65126ED0E585119FAC748FeB01B')
      ).to.equal('usdc_t');
      expect(findSymbolForAddress('0xInvalidAddress')).to.be.undefined;
    });
  });

  describe('Quote Response Structure', () => {
    it('should validate successful quote response format', () => {
      const successResponse = {
        success: true,
        dstAmount: BigNumber.from('980000'), // 0.98 tokens out for stable swap
      };

      expect(successResponse.success).to.be.true;
      expect(BigNumber.isBigNumber(successResponse.dstAmount)).to.be.true;
      expect(successResponse.dstAmount.gt(0)).to.be.true;
    });

    it('should validate error response format', () => {
      const errorResponse = {
        success: false,
        error: 'No Curve pool configured for tokenA/tokenB',
      };

      expect(errorResponse.success).to.be.false;
      expect(errorResponse.error).to.be.a('string');
      expect(errorResponse.error.length).to.be.greaterThan(0);
    });
  });

  describe('Pool Discovery Logic', () => {
    it('should identify valid token pair matching', () => {
      const poolConfigs: {
        [key: string]: { address: string; poolType: CurvePoolType };
      } = {
        'tbtc-weth': {
          address: '0x6e53131F68a034873b6bFA15502aF094Ef0c5854',
          poolType: CurvePoolType.CRYPTO,
        },
        'usdc_t-usd_t1': {
          address: '0x01C2c9f2C271ECEF81287B44FA6F813a1605F5Eb',
          poolType: CurvePoolType.STABLE,
        },
      };

      // Test pool discovery logic (both directions)
      const findPoolConfig = (tokenA: string, tokenB: string) => {
        const key1 = `${tokenA}-${tokenB}`;
        const key2 = `${tokenB}-${tokenA}`;
        return poolConfigs[key1] || poolConfigs[key2];
      };

      const stablePool = findPoolConfig('usdc_t', 'usd_t1');
      const stablePoolReverse = findPoolConfig('usd_t1', 'usdc_t');
      const cryptoPool = findPoolConfig('tbtc', 'weth');
      const noPool = findPoolConfig('invalid', 'tokens');

      expect(stablePool?.poolType).to.equal(CurvePoolType.STABLE);
      expect(stablePoolReverse?.poolType).to.equal(CurvePoolType.STABLE);
      expect(cryptoPool?.poolType).to.equal(CurvePoolType.CRYPTO);
      expect(noPool).to.be.undefined;
    });

    it('should handle ETH/WETH conversion in pool discovery', () => {
      const ethAddress = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
      const wethAddress = '0x4200000000000000000000000000000000000006';

      // Test ETH/WETH conversion logic
      const normalizeAddress = (address: string, wethAddr: string): string => {
        return address.toLowerCase() === ethAddress.toLowerCase()
          ? wethAddr
          : address;
      };

      expect(normalizeAddress(ethAddress, wethAddress)).to.equal(wethAddress);
      expect(normalizeAddress(wethAddress, wethAddress)).to.equal(wethAddress);
      expect(
        normalizeAddress(
          '0x53Be558aF29cC65126ED0E585119FAC748FeB01B',
          wethAddress
        )
      ).to.equal('0x53Be558aF29cC65126ED0E585119FAC748FeB01B');
    });

    it('falls back to address-based matching when token symbol casing differs from pool config keys', async () => {
      const provider: any = new CurveQuoteProvider(mockSigner, {
        poolConfigs: {
          'weth-usdc': {
            address: '0x6e53131F68a034873b6bFA15502aF094Ef0c5854',
            poolType: CurvePoolType.CRYPTO,
          },
        },
        defaultSlippage: 1.0,
        wethAddress: '0x4200000000000000000000000000000000000006',
        tokenAddresses: {
          WETH: '0x4200000000000000000000000000000000000006',
          USDC: '0x53Be558aF29cC65126ED0E585119FAC748FeB01B',
        },
      });
      const checkTokensStub = sinon
        .stub(provider, 'checkTokensInPool')
        .resolves(true);

      const poolConfig = await provider.findPoolForTokenPair(
        '0x4200000000000000000000000000000000000006',
        '0x53Be558aF29cC65126ED0E585119FAC748FeB01B'
      );

      expect(poolConfig).to.deep.equal({
        address: '0x6e53131F68a034873b6bFA15502aF094Ef0c5854',
        poolType: CurvePoolType.CRYPTO,
      });
      expect(checkTokensStub.calledOnce).to.be.true;
    });
  });

  describe('Market Price Calculation Logic', () => {
    it('should calculate market price correctly', () => {
      // Test the math that would be used in getMarketPrice
      const inputAmount = 1000000; // 1 token with 6 decimals
      const outputAmount = 995000; // 0.995 token with 6 decimals (typical stable swap)

      const marketPrice = outputAmount / inputAmount;

      expect(marketPrice).to.equal(0.995);
      expect(marketPrice).to.be.lessThan(1.0);
      expect(marketPrice).to.be.greaterThan(0.0);
    });

    it('should handle zero amounts and invalid scenarios', () => {
      const inputAmount = 1000000;
      const zeroOutput = 0;

      const priceWithZeroOutput = zeroOutput / inputAmount;
      const zeroInputPrice = inputAmount / 0; // This would be Infinity

      expect(priceWithZeroOutput).to.equal(0);
      expect(zeroInputPrice).to.equal(Infinity);
      expect(Number.isFinite(priceWithZeroOutput)).to.be.true;
      expect(Number.isFinite(zeroInputPrice)).to.be.false;

      // Test validation logic for invalid amounts
      const isValidAmount = (amount: number) =>
        amount > 0 && Number.isFinite(amount);
      expect(isValidAmount(inputAmount)).to.be.true;
      expect(isValidAmount(zeroOutput)).to.be.false;
      expect(isValidAmount(zeroInputPrice)).to.be.false;
    });
  });

  describe('Error Message Categorization', () => {
    it('should categorize different Curve error types', () => {
      const poolErrors = ['No Curve pool configured', 'No pool found'];
      const tokenErrors = [
        'Tokens not found in Curve pool',
        'Token indices not found',
      ];
      const liquidityErrors = [
        'Zero output from Curve pool',
        'Insufficient liquidity',
      ];
      const configErrors = ['Quote provider not available'];

      const categorizeError = (error: string) => {
        if (poolErrors.some((pattern) => error.includes(pattern))) {
          return 'pool';
        }
        if (tokenErrors.some((pattern) => error.includes(pattern))) {
          return 'token';
        }
        if (liquidityErrors.some((pattern) => error.includes(pattern))) {
          return 'liquidity';
        }
        if (configErrors.some((pattern) => error.includes(pattern))) {
          return 'config';
        }
        return 'unknown';
      };

      expect(
        categorizeError('No Curve pool configured for tokenA/tokenB')
      ).to.equal('pool');
      expect(categorizeError('Tokens not found in Curve pool')).to.equal(
        'token'
      );
      expect(categorizeError('Zero output from Curve pool')).to.equal(
        'liquidity'
      );
      expect(categorizeError('Quote provider not available')).to.equal(
        'config'
      );
      expect(categorizeError('Random curve error')).to.equal('unknown');
    });
  });
});
