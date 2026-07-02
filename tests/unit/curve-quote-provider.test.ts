import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, ethers, Signer } from 'ethers';
import {
  CurvePoolSelection,
  CurveQuoteProvider,
} from '../../src/dex/providers/curve-quote-provider';
import { CurvePoolType } from '../../src/config';
import { DexContractServices } from '../../src/dex/contracts';

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

  type CurveQuoteProviderConfig = ConstructorParameters<
    typeof CurveQuoteProvider
  >[1];

  function makeProvider(
    overrides: Partial<CurveQuoteProviderConfig> = {},
    contracts?: DexContractServices
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
      contracts
    );
  }

  function selectedPool(
    overrides: Partial<CurvePoolSelection> = {}
  ): CurvePoolSelection {
    return {
      address: POOL,
      poolType: CurvePoolType.STABLE,
      tokenInIndex: 0,
      tokenOutIndex: 1,
      ...overrides,
    };
  }

  function coinsFor(...addresses: string[]): sinon.SinonStub {
    const coins = sinon.stub();
    addresses.forEach((address, index) => {
      coins.withArgs(index).resolves(address);
    });
    coins.rejects(new Error('index out of range'));
    return coins;
  }

  function curveContractServices(
    contract: {
      coins?: sinon.SinonStub;
      get_dy?: sinon.SinonStub;
    },
    getDecimals: sinon.SinonStub<[Signer, string], Promise<number>> = sinon
      .stub<[Signer, string], Promise<number>>()
      .resolves(18)
  ): DexContractServices {
    return {
      makeContract: sinon
        .stub()
        .returns(contract as unknown as ethers.Contract),
      getDecimals,
    };
  }

  describe('Real provider fail-closed behavior', () => {
    it('reports initialization fast path and configured pools', async () => {
      const provider = makeProvider();

      expect(await provider.initialize()).to.equal(true);
      expect(await provider.initialize()).to.equal(true);
      expect(provider.isAvailable()).to.equal(true);
      expect(provider.getConfiguredPools()).to.deep.equal([POOL]);
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
      const coins = coinsFor(WETH, USDC);
      const provider = makeProvider({}, curveContractServices({ coins }));

      expect(await provider.resolvePoolSelection(WETH, USDC)).to.deep.equal(
        selectedPool()
      );
      expect(await provider.resolvePoolSelection(WETH, USDC)).to.deep.equal(
        selectedPool()
      );
      expect(coins.callCount).to.equal(3);

      const negativeCoins = coinsFor(WETH, USDC);
      const negativeProvider = makeProvider(
        {},
        curveContractServices({ coins: negativeCoins })
      );
      expect(await negativeProvider.resolvePoolSelection(DAI, USDC)).to.equal(
        undefined
      );
      expect(await negativeProvider.resolvePoolSelection(DAI, USDC)).to.equal(
        undefined
      );
      expect(negativeCoins.callCount).to.equal(3);
    });

    it('expires stale pool-selection cache entries through public lookups', async () => {
      const clock = sinon.useFakeTimers({ now: 1_000, toFake: ['Date'] });
      try {
        const coins = coinsFor(WETH, USDC);
        const provider = makeProvider({}, curveContractServices({ coins }));

        expect(await provider.resolvePoolSelection(WETH, USDC)).to.deep.equal(
          selectedPool()
        );
        expect(await provider.resolvePoolSelection(WETH, USDC)).to.deep.equal(
          selectedPool()
        );
        expect(coins.callCount).to.equal(3);

        clock.tick(5 * 60 * 1000 + 1);
        expect(await provider.resolvePoolSelection(WETH, USDC)).to.deep.equal(
          selectedPool()
        );
        expect(coins.callCount).to.equal(6);
      } finally {
        clock.restore();
      }
    });

    it('returns undefined when resolvePoolSelection cannot initialize', async () => {
      const provider = makeProvider({ poolConfigs: {} });

      expect(await provider.resolvePoolSelection(WETH, USDC)).to.equal(
        undefined
      );
    });

    it('resolves symbol lookup and address fallback through public selection', async () => {
      const symbolCoins = coinsFor(WETH, USDC);
      const symbolProvider = makeProvider(
        {},
        curveContractServices({ coins: symbolCoins })
      );
      expect(
        await symbolProvider.resolvePoolSelection(WETH, USDC)
      ).to.deep.equal(selectedPool());

      const fallbackCoins = coinsFor(WETH, USDC);
      const fallbackProvider = makeProvider(
        { tokenAddresses: undefined },
        curveContractServices({ coins: fallbackCoins })
      );
      expect(
        await fallbackProvider.resolvePoolSelection(ETH, USDC)
      ).to.deep.equal(selectedPool());
    });

    it('returns undefined when neither symbol lookup nor fallback discovery finds both tokens', async () => {
      const coins = coinsFor(WETH, DAI);
      const provider = makeProvider({}, curveContractServices({ coins }));
      expect(
        await provider.resolvePoolSelection(
          '0x9999999999999999999999999999999999999999',
          USDC
        )
      ).to.equal(undefined);
    });

    it('reports pool existence without throwing on lookup failures', async () => {
      const provider = makeProvider(
        {},
        curveContractServices({ coins: coinsFor(WETH, USDC) })
      );
      expect(await provider.poolExists(WETH, USDC)).to.equal(true);

      const missingProvider = makeProvider(
        {},
        curveContractServices({ coins: coinsFor(WETH, DAI) })
      );
      expect(await missingProvider.poolExists(DAI, USDC)).to.equal(false);

      const failingProvider = makeProvider(
        {},
        curveContractServices({
          coins: sinon.stub().rejects(new Error('rpc down')),
        })
      );
      expect(await failingProvider.poolExists(WETH, USDC)).to.equal(false);
    });

    it('discovers token indices and normalizes native ETH through fallback discovery', async () => {
      const coins = coinsFor(WETH, USDC);
      const provider = makeProvider(
        { tokenAddresses: undefined },
        curveContractServices({ coins })
      );

      expect(await provider.resolvePoolSelection(ETH, USDC)).to.deep.equal(
        selectedPool()
      );
      expect(coins.calledWith(2)).to.equal(true);
    });

    it('returns no-pool and zero-output quote failures before reporting success', async () => {
      const provider = makeProvider(
        {},
        curveContractServices({ coins: coinsFor(WETH, DAI) })
      );
      const noPool = await provider.getQuote(BigNumber.from(100), WETH, USDC);
      expect(noPool.success).to.equal(false);
      expect(noPool.error).to.match(/No Curve pool configured/);

      const getDy = sinon.stub().resolves(BigNumber.from(0));
      const zeroProvider = makeProvider(
        {},
        curveContractServices({ coins: coinsFor(WETH, USDC), get_dy: getDy })
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
      const provider = makeProvider(
        {},
        curveContractServices({ coins: coinsFor(WETH, USDC), get_dy: getDy })
      );

      const quote = await provider.getQuote(BigNumber.from(1000), WETH, USDC, {
        inputDecimals: 18,
        outputDecimals: 6,
      });

      expect(quote.success).to.equal(true);
      if (!quote.dstAmount) {
        expect.fail('Expected successful quote to include dstAmount');
      }
      expect(quote.dstAmount.toString()).to.equal('950');
      expect(quote.selectedPool).to.deep.equal(selectedPool());
    });

    it('loads token decimals only when quote decimals are not supplied', async () => {
      const getDecimals = sinon
        .stub<[Signer, string], Promise<number>>()
        .resolves(18);
      getDecimals.withArgs(mockSigner as Signer, USDC).resolves(6);
      const provider = makeProvider(
        {},
        curveContractServices(
          {
            coins: coinsFor(WETH, USDC),
            get_dy: sinon.stub().resolves(BigNumber.from(950)),
          },
          getDecimals
        )
      );

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
        const error = new Error(message) as Error & { reason?: string };
        error.reason = reason;
        const provider = makeProvider(
          {},
          curveContractServices({
            coins: coinsFor(WETH, USDC),
            get_dy: sinon.stub().rejects(error),
          })
        );

        const quote = await provider.getQuote(BigNumber.from(100), WETH, USDC, {
          inputDecimals: 18,
          outputDecimals: 6,
        });
        expect(quote).to.deep.equal({ success: false, error: expected });
      }
    });

    it('calculates market price and propagates quote/amount failures', async () => {
      const getDecimals = sinon
        .stub<[Signer, string], Promise<number>>()
        .resolves(18);
      getDecimals.withArgs(mockSigner as Signer, USDC).resolves(6);
      const provider = makeProvider(
        {},
        curveContractServices(
          {
            coins: coinsFor(WETH, USDC),
            get_dy: sinon.stub().resolves(ethers.utils.parseUnits('2', 6)),
          },
          getDecimals
        )
      );

      const price = await provider.getMarketPrice(
        ethers.utils.parseEther('1'),
        WETH,
        USDC,
        18,
        6
      );
      expect(price).to.deep.equal({ success: true, price: 2 });

      const missingProvider = makeProvider(
        {},
        curveContractServices({ coins: coinsFor(WETH, DAI) })
      );
      const quoteFailure = await missingProvider.getMarketPrice(
        BigNumber.from(100),
        WETH,
        USDC,
        18,
        6
      );
      expect(quoteFailure).to.deep.equal({
        success: false,
        error: `No Curve pool configured for ${WETH}/${USDC}`,
      });

      const amountFailure = await provider.getMarketPrice(
        BigNumber.from(0),
        WETH,
        USDC,
        18,
        6
      );
      expect(amountFailure).to.deep.equal({
        success: false,
        error: 'Invalid amounts for price calculation',
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
      const coins = coinsFor(WETH, USDC);
      const provider = makeProvider(
        {
          poolConfigs: {
            'weth-usdc': {
              address: POOL,
              poolType: CurvePoolType.CRYPTO,
            },
          },
        },
        curveContractServices({ coins })
      );

      expect(await provider.resolvePoolSelection(WETH, USDC)).to.deep.equal({
        address: POOL,
        poolType: CurvePoolType.CRYPTO,
        tokenInIndex: 0,
        tokenOutIndex: 1,
      });
      expect(coins.calledWith(2)).to.equal(true);
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
