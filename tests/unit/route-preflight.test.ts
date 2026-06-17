import { expect } from 'chai';
import sinon from 'sinon';
import { ethers } from 'ethers';
import {
  LiquiditySource,
  KeeperConfig,
  PriceOriginSource,
} from '../../src/config';
import { baseRoutePreflightConfig } from './helpers/route-preflight-config';
import {
  resolveAutodiscoverRoutePreflightRequirements,
  resolveExternalTakeRouteDeploymentPreflight,
  resolveExternalTakeRoutePreflightRequirements,
  shouldValidateExternalTakeRouteDeployments,
  validateAutoDiscoverRouteDeployments,
  validateExternalTakeRouteDeployments,
} from '../../src/discovery/route-preflight-validation';

describe('route deployment preflight', () => {
  afterEach(() => {
    sinon.restore();
  });

  const baseConfig = baseRoutePreflightConfig;

  const lifiConfig = (): KeeperConfig => ({
    ...baseConfig(),
    discovery: {
      enabled: true,
      take: {
        enabled: true,
        validateRouteDeployments: true,
        dexGasOverrides: {
          [LiquiditySource.LIFI]: '900000',
        },
      },
      defaults: {
        take: {
          liquiditySource: LiquiditySource.LIFI,
          marketPriceFactor: 0.99,
        },
      },
    },
    takers: {
      router: '0x1111111111111111111111111111111111111111',
      contracts: {
        Lifi: '0x2222222222222222222222222222222222222222',
      },
    },
    dex: {
      lifi: {
        mode: 'production',
        allowExchanges: ['uniswap'],
        callTargetAllowlist: {
          1: ['0x3333333333333333333333333333333333333333'],
        },
        approvalSpenderAllowlist: {
          1: ['0x4444444444444444444444444444444444444444'],
        },
        selectorAllowlist: {
          1: {
            '0x3333333333333333333333333333333333333333': ['0xabcdef12'],
          },
        },
      },
    },
  });

  function lifiProviderStub(params?: {
    registeredTaker?: string;
    allowedTargets?: string[];
    allowedSpenders?: string[];
    allowedSelectors?: string[];
  }) {
    const config = lifiConfig();
    const routerIface = new ethers.utils.Interface([
      'function takerContracts(uint8 source) view returns (address)',
    ]);
    const lifiIface = new ethers.utils.Interface([
      'function getAllowedCallTargets() view returns (address[])',
      'function getAllowedApprovalSpenders() view returns (address[])',
      'function getAllowedCallSelectors(address target) view returns (bytes4[])',
    ]);
    const registeredTaker =
      params?.registeredTaker ?? config.takers!.contracts!.Lifi;
    const allowedTargets =
      params?.allowedTargets ?? config.dex!.lifi!.callTargetAllowlist![1];
    const allowedSpenders =
      params?.allowedSpenders ?? config.dex!.lifi!.approvalSpenderAllowlist![1];
    const allowedSelectors = params?.allowedSelectors ?? ['0xabcdef12'];

    return {
      config,
      provider: {
        _isProvider: true,
        resolveName: sinon.stub().callsFake(async (name: string) => name),
        getCode: sinon.stub().resolves('0x6000'),
        call: sinon.stub().callsFake(async (tx: { data: string }) => {
          const selector = tx.data.slice(0, 10);
          if (selector === routerIface.getSighash('takerContracts')) {
            return routerIface.encodeFunctionResult('takerContracts', [
              registeredTaker,
            ]);
          }
          if (selector === lifiIface.getSighash('getAllowedCallTargets')) {
            return lifiIface.encodeFunctionResult('getAllowedCallTargets', [
              allowedTargets,
            ]);
          }
          if (selector === lifiIface.getSighash('getAllowedApprovalSpenders')) {
            return lifiIface.encodeFunctionResult(
              'getAllowedApprovalSpenders',
              [allowedSpenders]
            );
          }
          if (selector === lifiIface.getSighash('getAllowedCallSelectors')) {
            return lifiIface.encodeFunctionResult('getAllowedCallSelectors', [
              allowedSelectors,
            ]);
          }
          throw new Error(`unexpected call ${selector}`);
        }),
      },
    };
  }

  function addManualLifiPool(config: KeeperConfig): KeeperConfig {
    config.manual.pools = [
      {
        address: '0x8888888888888888888888888888888888888888',
        price: { source: PriceOriginSource.FIXED, value: 1 },
        take: {
          liquiditySource: LiquiditySource.LIFI,
          marketPriceFactor: 0.99,
        },
      },
    ];
    return config;
  }

  function oneInchConfig(): KeeperConfig {
    return {
      ...baseConfig(),
      discovery: {
        enabled: true,
        take: {
          enabled: true,
          validateRouteDeployments: true,
          allowedExternalTakePaths: ['calldata_aggregator'],
          allowedCalldataAggregatorProviders: ['oneinch'],
          dexGasOverrides: {
            [LiquiditySource.ONEINCH]: '900000',
          },
        },
        defaults: {
          take: {
            liquiditySource: LiquiditySource.ONEINCH,
            marketPriceFactor: 0.99,
          },
        },
      },
      takers: {
        router: '0x1111111111111111111111111111111111111111',
        contracts: {
          OneInchAggregator: '0x2222222222222222222222222222222222222222',
        },
      },
      dex: {
        oneInch: {
          routers: {
            1: '0x3333333333333333333333333333333333333333',
          },
        },
      },
    };
  }

  function oneInchProviderStub(params?: { registeredTaker?: string }) {
    const config = oneInchConfig();
    const routerIface = new ethers.utils.Interface([
      'function takerContracts(uint8 source) view returns (address)',
    ]);
    const registeredTaker =
      params?.registeredTaker ?? config.takers!.contracts!.OneInchAggregator;

    return {
      config,
      provider: {
        _isProvider: true,
        resolveName: sinon.stub().callsFake(async (name: string) => name),
        getCode: sinon.stub().resolves('0x6000'),
        call: sinon.stub().callsFake(async (tx: { data: string }) => {
          const selector = tx.data.slice(0, 10);
          if (selector === routerIface.getSighash('takerContracts')) {
            return routerIface.encodeFunctionResult('takerContracts', [
              registeredTaker,
            ]);
          }
          throw new Error(`unexpected call ${selector}`);
        }),
      },
    };
  }

  function manualLifiConfig(): KeeperConfig {
    const config = addManualLifiPool(lifiConfig());
    delete config.discovery;
    return config;
  }

  // 1inch config WITH a production allowlist policy + a provider that serves the
  // on-chain allowlist reads, so the W3-FINAL validateOneInchAggregatorAllowlist-
  // Preflight reconciliation branch is actually exercised (mirrors lifiProviderStub).
  function oneInchAllowlistProviderStub(params?: {
    registeredTaker?: string;
    allowedTargets?: string[];
    allowedSpenders?: string[];
    allowedSelectors?: string[];
    invalidPolicy?: boolean;
  }) {
    const config = oneInchConfig();
    const callTarget = '0x3333333333333333333333333333333333333333';
    const spender = '0x4444444444444444444444444444444444444444';
    config.dex!.oneInch!.callTargetAllowlist = { 1: [callTarget] };
    config.dex!.oneInch!.approvalSpenderAllowlist = { 1: [spender] };
    config.dex!.oneInch!.selectorAllowlist = params?.invalidPolicy
      ? // selector targets an address NOT in the call-target allowlist: the
        // normalizer rejects it fail-closed before any on-chain read.
        { 1: { [spender]: ['0xabcdef12'] } }
      : { 1: { [callTarget]: ['0xabcdef12'] } };

    const routerIface = new ethers.utils.Interface([
      'function takerContracts(uint8 source) view returns (address)',
    ]);
    const allowlistIface = new ethers.utils.Interface([
      'function getAllowedCallTargets() view returns (address[])',
      'function getAllowedApprovalSpenders() view returns (address[])',
      'function getAllowedCallSelectors(address target) view returns (bytes4[])',
    ]);
    const registeredTaker =
      params?.registeredTaker ?? config.takers!.contracts!.OneInchAggregator;
    const allowedTargets = params?.allowedTargets ?? [callTarget];
    const allowedSpenders = params?.allowedSpenders ?? [spender];
    const allowedSelectors = params?.allowedSelectors ?? ['0xabcdef12'];

    return {
      config,
      provider: {
        _isProvider: true,
        resolveName: sinon.stub().callsFake(async (name: string) => name),
        getCode: sinon.stub().resolves('0x6000'),
        call: sinon.stub().callsFake(async (tx: { data: string }) => {
          const selector = tx.data.slice(0, 10);
          if (selector === routerIface.getSighash('takerContracts')) {
            return routerIface.encodeFunctionResult('takerContracts', [
              registeredTaker,
            ]);
          }
          if (selector === allowlistIface.getSighash('getAllowedCallTargets')) {
            return allowlistIface.encodeFunctionResult('getAllowedCallTargets', [
              allowedTargets,
            ]);
          }
          if (
            selector === allowlistIface.getSighash('getAllowedApprovalSpenders')
          ) {
            return allowlistIface.encodeFunctionResult(
              'getAllowedApprovalSpenders',
              [allowedSpenders]
            );
          }
          if (
            selector === allowlistIface.getSighash('getAllowedCallSelectors')
          ) {
            return allowlistIface.encodeFunctionResult(
              'getAllowedCallSelectors',
              [allowedSelectors]
            );
          }
          throw new Error(`unexpected call ${selector}`);
        }),
      },
    };
  }

  it('passes when enabled route contracts have bytecode and router registry matches', async () => {
    const config = baseConfig();
    const provider = {
      _isProvider: true,
      resolveName: sinon.stub().callsFake(async (name: string) => name),
      getCode: sinon.stub().resolves('0x6000'),
      call: sinon
        .stub()
        .resolves(
          ethers.utils.defaultAbiCoder.encode(
            ['address'],
            [config.takers!.contracts!.UniswapV3]
          )
        ),
    };

    await validateAutoDiscoverRouteDeployments({
      config,
      provider: provider as any,
      chainId: 1,
    });

    expect(provider.getCode.callCount).to.equal(6);
  });

  it('fails startup preflight when a configured taker has no bytecode', async () => {
    const config = baseConfig();
    const uniswapTaker = config.takers!.contracts!.UniswapV3!;
    const provider = {
      _isProvider: true,
      resolveName: sinon.stub().callsFake(async (name: string) => name),
      getCode: sinon
        .stub()
        .callsFake(async (address: string) =>
          address.toLowerCase() === uniswapTaker.toLowerCase() ? '0x' : '0x6000'
        ),
      call: sinon
        .stub()
        .resolves(
          ethers.utils.defaultAbiCoder.encode(['address'], [uniswapTaker])
        ),
    };

    try {
      await validateAutoDiscoverRouteDeployments({
        config,
        provider: provider as any,
        chainId: 1,
      });
      expect.fail('expected preflight to fail');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.include(
        'UNISWAPV3 taker has no contract code'
      );
    }
  });

  it('fails startup preflight when the router registry maps a source to a different taker', async () => {
    const config = baseConfig();
    const provider = {
      _isProvider: true,
      resolveName: sinon.stub().callsFake(async (name: string) => name),
      getCode: sinon.stub().resolves('0x6000'),
      call: sinon
        .stub()
        .resolves(
          ethers.utils.defaultAbiCoder.encode(
            ['address'],
            ['0x9999999999999999999999999999999999999999']
          )
        ),
    };

    try {
      await validateAutoDiscoverRouteDeployments({
        config,
        provider: provider as any,
        chainId: 1,
      });
      expect.fail('expected preflight to fail');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.include(
        'keeperTakerRouter registry maps UNISWAPV3'
      );
    }
  });

  it('fails startup preflight when the router registry has no registered taker', async () => {
    const config = baseConfig();
    const provider = {
      _isProvider: true,
      resolveName: sinon.stub().callsFake(async (name: string) => name),
      getCode: sinon.stub().resolves('0x6000'),
      call: sinon
        .stub()
        .resolves(
          ethers.utils.defaultAbiCoder.encode(
            ['address'],
            [ethers.constants.AddressZero]
          )
        ),
    };

    try {
      await validateAutoDiscoverRouteDeployments({
        config,
        provider: provider as any,
        chainId: 1,
      });
      expect.fail('expected preflight to fail');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.include(
        'keeperTakerRouter registry has no taker for UNISWAPV3'
      );
    }
  });

  it('fails startup preflight when the router registry cannot be read', async () => {
    const config = baseConfig();
    const provider = {
      _isProvider: true,
      resolveName: sinon.stub().callsFake(async (name: string) => name),
      getCode: sinon.stub().resolves('0x6000'),
      call: sinon.stub().rejects(new Error('registry rpc unavailable')),
    };

    try {
      await validateAutoDiscoverRouteDeployments({
        config,
        provider: provider as any,
        chainId: 1,
      });
      expect.fail('expected preflight to fail');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.include(
        'keeperTakerRouter registry for UNISWAPV3 could not be read'
      );
    }
  });

  it('fails startup preflight when transient router registry read errors exhaust retries', async () => {
    const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });
    const config = baseConfig();
    try {
      const provider = {
        _isProvider: true,
        resolveName: sinon.stub().callsFake(async (name: string) => name),
        getCode: sinon.stub().resolves('0x6000'),
        call: sinon.stub().rejects(
          Object.assign(new Error('ECONNRESET'), {
            code: 'ECONNRESET',
          })
        ),
      };

      const validationPromise = validateAutoDiscoverRouteDeployments({
        config,
        provider: provider as any,
        chainId: 1,
      }).then(
        () => undefined,
        (error) => error
      );
      await clock.runAllAsync();

      const error = await validationPromise;
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.include(
        'keeperTakerRouter registry for UNISWAPV3 could not be read after retries'
      );
      expect(provider.call.callCount).to.equal(4);
    } finally {
      clock.restore();
    }
  });

  it('fails startup preflight when transient bytecode read errors exhaust retries', async () => {
    const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });
    const config = baseConfig();
    try {
      const provider = {
        _isProvider: true,
        resolveName: sinon.stub().callsFake(async (name: string) => name),
        getCode: sinon.stub().rejects(
          Object.assign(new Error('ETIMEDOUT'), {
            code: 'ETIMEDOUT',
          })
        ),
        call: sinon
          .stub()
          .resolves(
            ethers.utils.defaultAbiCoder.encode(
              ['address'],
              [config.takers!.contracts!.UniswapV3]
            )
          ),
      };

      const validationPromise = validateAutoDiscoverRouteDeployments({
        config,
        provider: provider as any,
        chainId: 1,
      }).then(
        () => undefined,
        (error) => error
      );
      await clock.runAllAsync();

      const error = await validationPromise;
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.include(
        'code could not be read after retries'
      );
      expect(provider.getCode.callCount).to.equal(24);
    } finally {
      clock.restore();
    }
  });

  it('passes LI.FI preflight when router registry and on-chain allowlists match config', async () => {
    const { config, provider } = lifiProviderStub();

    await validateAutoDiscoverRouteDeployments({
      config,
      provider: provider as any,
      chainId: 1,
    });

    expect(provider.getCode.callCount).to.equal(4);
    expect(provider.call.callCount).to.equal(4);
  });

  it('requires route preflight for manual live LI.FI even without autodiscovery', () => {
    const config = manualLifiConfig();

    expect(resolveExternalTakeRoutePreflightRequirements(config)).to.deep.equal(
      [{ path: 'calldata_aggregator', source: LiquiditySource.LIFI }]
    );
    expect(shouldValidateExternalTakeRouteDeployments(config)).to.equal(true);

    config.runtime.dryRun = true;
    expect(shouldValidateExternalTakeRouteDeployments(config)).to.equal(false);
  });

  it('passes manual LI.FI preflight when router registry and on-chain allowlists match config', async () => {
    const { config, provider } = lifiProviderStub();
    addManualLifiPool(config);
    delete config.discovery;

    await validateExternalTakeRouteDeployments({
      config,
      provider: provider as any,
      chainId: 1,
    });

    expect(provider.getCode.callCount).to.equal(4);
    expect(provider.call.callCount).to.equal(4);
  });

  it('deduplicates LI.FI preflight requirements across manual pools and autodiscovery', () => {
    const config = addManualLifiPool(lifiConfig());

    expect(resolveExternalTakeRoutePreflightRequirements(config)).to.deep.equal(
      [{ path: 'calldata_aggregator', source: LiquiditySource.LIFI }]
    );
  });

  it('resolves autodiscovery calldata aggregator providers to source-specific preflight requirements', () => {
    const config = baseConfig();
    config.discovery!.defaults!.take!.liquiditySource = LiquiditySource.ONEINCH;
    config.discovery!.take = {
      enabled: true,
      validateRouteDeployments: true,
      allowedExternalTakePaths: ['calldata_aggregator'],
      allowedCalldataAggregatorProviders: ['oneinch', 'sushi_aggregator'],
      dexGasOverrides: {
        [LiquiditySource.ONEINCH]: '900000',
        [LiquiditySource.SUSHI_AGGREGATOR]: '900000',
      },
    };

    expect(resolveAutodiscoverRoutePreflightRequirements(config)).to.deep.equal(
      [
        { path: 'calldata_aggregator', source: LiquiditySource.ONEINCH },
        {
          path: 'calldata_aggregator',
          source: LiquiditySource.SUSHI_AGGREGATOR,
        },
      ]
    );
  });

  it('scopes startup validation to autodiscovery requirements and manual required paths', () => {
    const config = baseConfig();
    config.manual.pools = [
      {
        address: '0x8888888888888888888888888888888888888888',
        price: { source: PriceOriginSource.FIXED, value: 1 },
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
      },
    ];

    expect(resolveExternalTakeRoutePreflightRequirements(config)).to.deep.equal(
      [
        { path: 'calldata_aggregator', source: LiquiditySource.ONEINCH },
        { path: 'direct_dex', source: LiquiditySource.UNISWAPV3 },
      ]
    );
    expect(
      resolveExternalTakeRouteDeploymentPreflight(config).requirements
    ).to.deep.equal([
      { path: 'direct_dex', source: LiquiditySource.UNISWAPV3 },
      { path: 'calldata_aggregator', source: LiquiditySource.ONEINCH },
    ]);
  });

  it('fails 1inch preflight when the router registry maps the source to a different taker', async () => {
    const { config, provider } = oneInchProviderStub({
      registeredTaker: '0x9999999999999999999999999999999999999999',
    });

    try {
      await validateAutoDiscoverRouteDeployments({
        config,
        provider: provider as any,
        chainId: 1,
      });
      expect.fail('expected preflight to fail');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.include(
        'keeperTakerRouter registry maps ONEINCH'
      );
      expect((error as Error).message).to.include(
        config.takers!.contracts!.OneInchAggregator
      );
    }
  });

  it('passes 1inch preflight when router registry and on-chain allowlists match config', async () => {
    const { config, provider } = oneInchAllowlistProviderStub();

    await validateAutoDiscoverRouteDeployments({
      config,
      provider: provider as any,
      chainId: 1,
    });

    // registry read + the three on-chain allowlist reads
    // (callTargets/approvalSpenders/selectors) prove the reconciliation ran.
    expect(provider.call.callCount).to.be.greaterThanOrEqual(4);
  });

  it('fails 1inch preflight when on-chain call targets do not exactly match config', async () => {
    const { config, provider } = oneInchAllowlistProviderStub({
      allowedTargets: ['0x5555555555555555555555555555555555555555'],
    });

    try {
      await validateAutoDiscoverRouteDeployments({
        config,
        provider: provider as any,
        chainId: 1,
      });
      expect.fail('expected preflight to fail');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.include(
        '1inch taker call target allowlist'
      );
      expect((error as Error).message).to.include('mismatch');
    }
  });

  it('fails 1inch preflight when on-chain selectors do not exactly match config', async () => {
    const { config, provider } = oneInchAllowlistProviderStub({
      allowedSelectors: ['0xdeadbeef'],
    });

    try {
      await validateAutoDiscoverRouteDeployments({
        config,
        provider: provider as any,
        chainId: 1,
      });
      expect.fail('expected preflight to fail');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.include(
        '1inch taker selector allowlist'
      );
      expect((error as Error).message).to.include('mismatch');
    }
  });

  it('fails 1inch preflight when the production allowlist policy is invalid', async () => {
    const { config, provider } = oneInchAllowlistProviderStub({
      invalidPolicy: true,
    });

    try {
      await validateAutoDiscoverRouteDeployments({
        config,
        provider: provider as any,
        chainId: 1,
      });
      expect.fail('expected preflight to fail');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.include(
        '1inch production policy for chain 1 is invalid'
      );
    }
  });

  it('fails LI.FI preflight when a partial allowlist update leaves only a subset on chain', async () => {
    const { config, provider } = lifiProviderStub();
    const firstTarget = config.dex!.lifi!.callTargetAllowlist![1][0];
    const firstSpender = config.dex!.lifi!.approvalSpenderAllowlist![1][0];
    const secondTarget = '0x5555555555555555555555555555555555555555';
    const secondSpender = '0x6666666666666666666666666666666666666666';

    config.dex!.lifi!.callTargetAllowlist![1] = [firstTarget, secondTarget];
    config.dex!.lifi!.approvalSpenderAllowlist![1] = [
      firstSpender,
      secondSpender,
    ];
    (config.dex!.lifi! as any).selectorAllowlist[1] = {
      [firstTarget]: ['0xabcdef12'],
      [secondTarget]: ['0xdeadbeef'],
    };

    try {
      await validateAutoDiscoverRouteDeployments({
        config,
        provider: provider as any,
        chainId: 1,
      });
      expect.fail('expected preflight to fail');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.include(
        'LI.FI taker call target allowlist'
      );
      expect((error as Error).message).to.include('mismatch');
    }
  });

  it('fails LI.FI preflight when only noncanonical taker aliases are configured', async () => {
    const { config, provider } = lifiProviderStub();
    (config.takers!.contracts as any).LIFI = config.takers!.contracts!.Lifi;
    delete (config.takers!.contracts as any).Lifi;

    try {
      await validateAutoDiscoverRouteDeployments({
        config,
        provider: provider as any,
        chainId: 1,
      });
      expect.fail('expected preflight to fail');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.include(
        'LI.FI taker address is not configured'
      );
    }
  });

  it('fails LI.FI preflight when on-chain selectors do not exactly match config', async () => {
    const { config, provider } = lifiProviderStub({
      allowedSelectors: ['0xdeadbeef'],
    });

    try {
      await validateAutoDiscoverRouteDeployments({
        config,
        provider: provider as any,
        chainId: 1,
      });
      expect.fail('expected preflight to fail');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.include(
        'LI.FI taker selector allowlist'
      );
      expect((error as Error).message).to.include('mismatch');
    }
  });

  it('fails LI.FI preflight when a configured call target has no bytecode', async () => {
    const { config, provider } = lifiProviderStub();
    const target = config.dex!.lifi!.callTargetAllowlist![1][0];
    provider.getCode.callsFake(async (address: string) =>
      address.toLowerCase() === target.toLowerCase() ? '0x' : '0x6000'
    );

    try {
      await validateAutoDiscoverRouteDeployments({
        config,
        provider: provider as any,
        chainId: 1,
      });
      expect.fail('expected preflight to fail');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.include(
        `LI.FI call target ${target.toLowerCase()} has no contract code`
      );
    }
  });

  it('fails LI.FI preflight when a configured approval spender has no bytecode', async () => {
    const { config, provider } = lifiProviderStub();
    const spender = config.dex!.lifi!.approvalSpenderAllowlist![1][0];
    provider.getCode.callsFake(async (address: string) =>
      address.toLowerCase() === spender.toLowerCase() ? '0x' : '0x6000'
    );

    try {
      await validateAutoDiscoverRouteDeployments({
        config,
        provider: provider as any,
        chainId: 1,
      });
      expect.fail('expected preflight to fail');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.include(
        `LI.FI approval spender ${spender.toLowerCase()} has no contract code`
      );
    }
  });

  it('fails LI.FI preflight when on-chain call targets do not exactly match config', async () => {
    const { config, provider } = lifiProviderStub({
      allowedTargets: ['0x9999999999999999999999999999999999999999'],
    });

    try {
      await validateAutoDiscoverRouteDeployments({
        config,
        provider: provider as any,
        chainId: 1,
      });
      expect.fail('expected preflight to fail');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.include(
        'LI.FI taker call target allowlist'
      );
      expect((error as Error).message).to.include('mismatch');
    }
  });

  it('fails LI.FI preflight when on-chain approval spenders do not exactly match config', async () => {
    const { config, provider } = lifiProviderStub({
      allowedSpenders: ['0x9999999999999999999999999999999999999999'],
    });

    try {
      await validateAutoDiscoverRouteDeployments({
        config,
        provider: provider as any,
        chainId: 1,
      });
      expect.fail('expected preflight to fail');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.include(
        'LI.FI taker approval spender allowlist'
      );
      expect((error as Error).message).to.include('mismatch');
    }
  });

  it('fails LI.FI preflight when selector policy includes a non-call-target entry', async () => {
    const { config, provider } = lifiProviderStub();
    (config.dex!.lifi! as any).selectorAllowlist = {
      1: {
        '0x3333333333333333333333333333333333333333': ['0xabcdef12'],
        '0x5555555555555555555555555555555555555555': ['0xdeadbeef'],
      },
    };

    try {
      await validateAutoDiscoverRouteDeployments({
        config,
        provider: provider as any,
        chainId: 1,
      });
      expect.fail('expected preflight to fail');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.include(
        'LI.FI production policy for chain 1 is invalid'
      );
      expect((error as Error).message).to.include(
        'is not present in callTargetAllowlist'
      );
    }
  });

  it('fails LI.FI preflight when a configured call target has no selector policy', async () => {
    const { config, provider } = lifiProviderStub();
    (config.dex!.lifi! as any).selectorAllowlist = {
      1: {},
    };

    try {
      await validateAutoDiscoverRouteDeployments({
        config,
        provider: provider as any,
        chainId: 1,
      });
      expect.fail('expected preflight to fail');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.include(
        'LI.FI production policy for chain 1 is invalid'
      );
      expect((error as Error).message).to.include('must be non-empty');
    }
  });

  it('fails LI.FI preflight when configured LI.FI address allowlists are malformed', async () => {
    const { config, provider } = lifiProviderStub();
    const target = config.dex!.lifi!.callTargetAllowlist![1][0];
    (config.dex!.lifi!.callTargetAllowlist as any)[1] = [target, target];

    try {
      await validateAutoDiscoverRouteDeployments({
        config,
        provider: provider as any,
        chainId: 1,
      });
      expect.fail('expected preflight to fail');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.include(
        'LI.FI production policy for chain 1 is invalid'
      );
      expect((error as Error).message).to.include(
        'cannot contain duplicate addresses'
      );
    }
  });

  it('fails LI.FI preflight when on-chain LI.FI address allowlists contain zero address', async () => {
    const { config, provider } = lifiProviderStub({
      allowedTargets: [ethers.constants.AddressZero],
    });

    try {
      await validateAutoDiscoverRouteDeployments({
        config,
        provider: provider as any,
        chainId: 1,
      });
      expect.fail('expected preflight to fail');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.include(
        'LI.FI taker call target allowlist is invalid'
      );
      expect((error as Error).message).to.include(
        'cannot contain zero address'
      );
    }
  });
});
