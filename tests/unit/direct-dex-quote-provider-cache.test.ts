import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, ethers } from 'ethers';
import { CurvePoolType, LiquiditySource } from '../../src/config';
import { logger } from '../../src/logging';
import * as takeDirectDex from '../../src/take/direct-dex';
import { UniswapV3QuoteProvider } from '../../src/dex/providers/uniswap-quote-provider';
import { CurveQuoteProvider } from '../../src/dex/providers/curve-quote-provider';
import * as erc20 from '../../src/erc20';
import {
  DEFAULT_DIRECT_DEX_ROUTE_RPC_TIMEOUT_MS,
  getCachedDirectDexTokenDecimals,
  getCurveQuoteProvider,
} from '../../src/take/direct-dex/route-selection';

const TEST_UNISWAP_SWAP_ROUTER_02_ADDRESS =
  '0x3333333333333333333333333333333333333333';

describe('Direct DEX quote provider cache', () => {
  let mockSigner: any;

  beforeEach(() => {
    mockSigner = {
      getAddress: sinon.stub().resolves('0xTestAddress'),
      getChainId: sinon.stub().resolves(43114),
    };
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('Quote Provider Reuse', () => {
    it('uses an address-only decimals cache key when chainId lookup times out without skipping decimals', async () => {
      const clock = sinon.useFakeTimers();
      const tokenAddress = '0x1111111111111111111111111111111111111111';
      const runtimeCache = takeDirectDex.createDirectDexQuoteProviderRuntimeCache();
      const neverResolves = new Promise<number>(() => {});
      mockSigner.getChainId = sinon.stub().returns(neverResolves);
      const decimalsStub = sinon.stub(erc20, 'getDecimalsErc20').resolves(6);

      const decimalsPromise = getCachedDirectDexTokenDecimals(
        mockSigner,
        tokenAddress,
        runtimeCache
      );
      await clock.tickAsync(DEFAULT_DIRECT_DEX_ROUTE_RPC_TIMEOUT_MS);

      const decimals = await decimalsPromise;

      expect(decimals).to.equal(6);
      expect(decimalsStub.calledOnceWith(mockSigner, tokenAddress, undefined))
        .to.be.true;
      expect(
        runtimeCache.tokenDecimals?.get(`unknown:${tokenAddress}`)
      ).to.equal(6);
    });

    it('returns an address-only decimals cache hit without waiting for a pending chainId lookup', async () => {
      const tokenAddress = '0x1111111111111111111111111111111111111112';
      const runtimeCache = takeDirectDex.createDirectDexQuoteProviderRuntimeCache();
      runtimeCache.tokenDecimals = new Map([[`unknown:${tokenAddress}`, 6]]);
      mockSigner.getChainId = sinon
        .stub()
        .returns(new Promise<number>(() => {}));
      const decimalsStub = sinon.stub(erc20, 'getDecimalsErc20').resolves(18);

      let result: number | undefined;
      await getCachedDirectDexTokenDecimals(
        mockSigner,
        tokenAddress,
        runtimeCache
      ).then((decimals) => {
        result = decimals;
      });

      expect(result).to.equal(6);
      expect(decimalsStub.notCalled).to.be.true;
      expect(mockSigner.getChainId.calledOnce).to.be.true;
      expect(runtimeCache.chainIdInflight).to.exist;
    });

    it('migrates address-only decimals cache entries once chainId resolves later', async () => {
      const clock = sinon.useFakeTimers();
      const tokenAddress = '0x2222222222222222222222222222222222222222';
      const runtimeCache = takeDirectDex.createDirectDexQuoteProviderRuntimeCache();
      let resolveChainId!: (chainId: number) => void;
      const chainIdPromise = new Promise<number>((resolve) => {
        resolveChainId = resolve;
      });
      mockSigner.getChainId = sinon.stub().returns(chainIdPromise);
      sinon.stub(erc20, 'getDecimalsErc20').resolves(18);

      const decimalsPromise = getCachedDirectDexTokenDecimals(
        mockSigner,
        tokenAddress,
        runtimeCache
      );
      await clock.tickAsync(DEFAULT_DIRECT_DEX_ROUTE_RPC_TIMEOUT_MS);

      expect(await decimalsPromise).to.equal(18);
      expect(
        runtimeCache.tokenDecimals?.get(`unknown:${tokenAddress}`)
      ).to.equal(18);

      const inflight = runtimeCache.chainIdInflight;
      resolveChainId(8453);
      await inflight;

      expect(runtimeCache.chainId).to.equal(8453);
      expect(runtimeCache.tokenDecimals?.has(`unknown:${tokenAddress}`)).to.be
        .false;
      expect(runtimeCache.tokenDecimals?.get(`8453:${tokenAddress}`)).to.equal(
        18
      );
    });

    it('reuses migrated address-only decimals entries without a second decimals read', async () => {
      const tokenAddress = '0x3333333333333333333333333333333333333333';
      const runtimeCache = takeDirectDex.createDirectDexQuoteProviderRuntimeCache();
      runtimeCache.tokenDecimals = new Map([[`unknown:${tokenAddress}`, 8]]);
      mockSigner.getChainId = sinon.stub().resolves(8453);
      const decimalsStub = sinon.stub(erc20, 'getDecimalsErc20').resolves(18);

      const decimals = await getCachedDirectDexTokenDecimals(
        mockSigner,
        tokenAddress,
        runtimeCache
      );

      expect(decimals).to.equal(8);
      expect(decimalsStub.notCalled).to.be.true;
      expect(runtimeCache.chainIdInflight).to.exist;
      await runtimeCache.chainIdInflight;
      expect(runtimeCache.tokenDecimals?.has(`unknown:${tokenAddress}`)).to.be
        .false;
      expect(runtimeCache.tokenDecimals?.get(`8453:${tokenAddress}`)).to.equal(
        8
      );
    });

    it('reuses a shared Uniswap V3 quote provider cache across quote evaluations', async () => {
      sinon.stub(UniswapV3QuoteProvider.prototype, 'poolExists').resolves(true);
      sinon.stub(UniswapV3QuoteProvider.prototype, 'getQuote').resolves({
        success: true,
        dstAmount: ethers.utils.parseUnits('120', 6).toString(),
      } as any);
      const decimalsStub = sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
      const quoteTokenScaleStub = sinon
        .stub()
        .resolves(BigNumber.from('1000000000000'));

      const pool = {
        name: 'Test Pool',
        collateralAddress: '0x1111111111111111111111111111111111111111',
        quoteAddress: '0x2222222222222222222222222222222222222222',
        contract: {
          quoteTokenScale: quoteTokenScaleStub,
        },
      };
      const poolConfig = {
        name: 'Test Pool',
        take: {
          liquiditySource: LiquiditySource.UNISWAPV3,
          marketPriceFactor: 0.99,
        },
      };
      const config = {
        uniswapV3RouterOverrides: {
          swapRouter02Address: TEST_UNISWAP_SWAP_ROUTER_02_ADDRESS,
          poolFactoryAddress: '0x4444444444444444444444444444444444444444',
          defaultFeeTier: 3000,
          candidateFeeTiers: [3000],
          wethAddress: '0x5555555555555555555555555555555555555555',
          quoterV2Address: '0x6666666666666666666666666666666666666666',
        },
      };
      const quoteSigner = ethers.Wallet.createRandom().connect(
        new ethers.providers.JsonRpcProvider()
      );
      const runtimeCache = takeDirectDex.createDirectDexQuoteProviderRuntimeCache();
      runtimeCache.chainId = 8453;

      await takeDirectDex.getDirectDexTakeQuoteEvaluation(
        pool as any,
        ethers.utils.parseEther('1'),
        ethers.utils.parseEther('1'),
        poolConfig as any,
        config as any,
        quoteSigner as any,
        runtimeCache
      );
      const cachedProvider = runtimeCache.uniswapV3;
      expect(cachedProvider).to.not.equal(undefined);
      expect(cachedProvider).to.not.equal(null);

      await takeDirectDex.getDirectDexTakeQuoteEvaluation(
        pool as any,
        ethers.utils.parseEther('1'),
        ethers.utils.parseEther('1'),
        poolConfig as any,
        config as any,
        quoteSigner as any,
        runtimeCache
      );

      expect(runtimeCache.uniswapV3).to.equal(cachedProvider);
      expect(decimalsStub.calledTwice).to.be.true;
      expect(quoteTokenScaleStub.calledOnce).to.be.true;
    });

    it('reuses a shared Curve quote provider cache across quote evaluations', async () => {
      const initializeStub = sinon
        .stub(CurveQuoteProvider.prototype, 'initialize')
        .resolves(true);
      sinon.stub(CurveQuoteProvider.prototype, 'getQuote').resolves({
        success: true,
        dstAmount: ethers.utils.parseUnits('120', 6),
      } as any);
      sinon.stub(CurveQuoteProvider.prototype, 'poolExists').resolves(true);
      sinon.stub(erc20, 'getDecimalsErc20').resolves(6);

      const pool = {
        name: 'Test Pool',
        collateralAddress: '0x1111111111111111111111111111111111111111',
        quoteAddress: '0x2222222222222222222222222222222222222222',
        contract: {
          quoteTokenScale: sinon
            .stub()
            .resolves(BigNumber.from('1000000000000')),
        },
      };
      const poolConfig = {
        name: 'Test Pool',
        take: {
          liquiditySource: LiquiditySource.CURVE,
          marketPriceFactor: 0.99,
        },
      };
      const config = {
        curveRouterOverrides: {
          poolConfigs: {
            'COLLATERAL-QUOTE': {
              address: '0x3333333333333333333333333333333333333333',
              poolType: CurvePoolType.STABLE,
            },
          },
          defaultSlippage: 0.5,
          wethAddress: '0x4444444444444444444444444444444444444444',
        },
        tokenAddresses: {
          COLLATERAL: '0x1111111111111111111111111111111111111111',
          QUOTE: '0x2222222222222222222222222222222222222222',
        },
      };
      const quoteSigner = ethers.Wallet.createRandom().connect(
        new ethers.providers.JsonRpcProvider()
      );
      const runtimeCache = takeDirectDex.createDirectDexQuoteProviderRuntimeCache();
      runtimeCache.chainId = 8453;

      await takeDirectDex.getDirectDexTakeQuoteEvaluation(
        pool as any,
        ethers.utils.parseEther('1'),
        ethers.utils.parseEther('1'),
        poolConfig as any,
        config as any,
        quoteSigner as any,
        runtimeCache
      );
      const cachedProvider = runtimeCache.curve;
      expect(cachedProvider).to.not.equal(undefined);
      expect(cachedProvider).to.not.equal(null);

      await takeDirectDex.getDirectDexTakeQuoteEvaluation(
        pool as any,
        ethers.utils.parseEther('1'),
        ethers.utils.parseEther('1'),
        poolConfig as any,
        config as any,
        quoteSigner as any,
        runtimeCache
      );

      expect(initializeStub.calledOnce).to.be.true;
      expect(runtimeCache.curve).to.equal(cachedProvider);
    });

    it('does not sticky-cache failed Curve provider initialization', async () => {
      const initializeStub = sinon
        .stub(CurveQuoteProvider.prototype, 'initialize')
        .onFirstCall()
        .rejects(new Error('rpc unavailable'))
        .onSecondCall()
        .resolves(true);
      const warnStub = sinon.stub(logger, 'warn');
      const runtimeCache = takeDirectDex.createDirectDexQuoteProviderRuntimeCache();
      const routerConfig = {
        poolConfigs: {
          'COLLATERAL-QUOTE': {
            address: '0x3333333333333333333333333333333333333333',
            poolType: CurvePoolType.STABLE,
          },
        },
        defaultSlippage: 0.5,
        wethAddress: '0x4444444444444444444444444444444444444444',
      };

      const firstProvider = await getCurveQuoteProvider({
        signer: mockSigner as any,
        routerConfig,
        tokenAddresses: {
          COLLATERAL: '0x1111111111111111111111111111111111111111',
          QUOTE: '0x2222222222222222222222222222222222222222',
        },
        runtimeCache,
      });
      expect(firstProvider).to.equal(undefined);
      expect(runtimeCache.curve).to.equal(undefined);
      expect(runtimeCache.curveUnavailableUntilMs).to.be.greaterThan(
        Date.now()
      );

      const secondProvider = await getCurveQuoteProvider({
        signer: mockSigner as any,
        routerConfig,
        runtimeCache,
      });
      expect(secondProvider).to.equal(undefined);
      expect(initializeStub.calledOnce).to.be.true;

      runtimeCache.curveUnavailableUntilMs = Date.now() - 1;
      const recoveredProvider = await getCurveQuoteProvider({
        signer: mockSigner as any,
        routerConfig,
        runtimeCache,
      });

      expect(recoveredProvider).to.not.equal(undefined);
      expect(initializeStub.calledTwice).to.be.true;
      expect(warnStub.calledTwice).to.be.true;
      expect(warnStub.secondCall.args[0]).to.contain(
        'Curve quote provider unavailable; retrying initialization'
      );
    });

    it('coalesces concurrent Curve provider initialization', async () => {
      let resolveInitialization: ((value: boolean) => void) | undefined;
      const initializeStub = sinon.stub(
        CurveQuoteProvider.prototype,
        'initialize'
      );
      const initializationStarted = new Promise<void>((resolveStarted) => {
        initializeStub.callsFake(
          () =>
            new Promise<boolean>((resolve) => {
              resolveInitialization = resolve;
              resolveStarted();
            })
        );
      });
      const runtimeCache = takeDirectDex.createDirectDexQuoteProviderRuntimeCache();
      const routerConfig = {
        poolConfigs: {
          'COLLATERAL-QUOTE': {
            address: '0x3333333333333333333333333333333333333333',
            poolType: CurvePoolType.STABLE,
          },
        },
        defaultSlippage: 0.5,
        wethAddress: '0x4444444444444444444444444444444444444444',
      };
      const tokenAddresses = {
        COLLATERAL: '0x1111111111111111111111111111111111111111',
        QUOTE: '0x2222222222222222222222222222222222222222',
      };

      const firstProviderPromise = getCurveQuoteProvider({
        signer: mockSigner as any,
        routerConfig,
        tokenAddresses,
        runtimeCache,
      });
      await initializationStarted;
      expect(runtimeCache.curveInitInflight).to.not.equal(undefined);

      const secondProviderPromise = getCurveQuoteProvider({
        signer: mockSigner as any,
        routerConfig,
        tokenAddresses,
        runtimeCache,
      });
      expect(initializeStub.calledOnce).to.be.true;

      resolveInitialization?.(true);
      const [firstProvider, secondProvider] = await Promise.all([
        firstProviderPromise,
        secondProviderPromise,
      ]);

      expect(firstProvider).to.not.equal(undefined);
      expect(secondProvider).to.equal(firstProvider);
      expect(runtimeCache.curve).to.equal(firstProvider);
      expect(runtimeCache.curveInitInflight).to.equal(undefined);
    });
  });

});
