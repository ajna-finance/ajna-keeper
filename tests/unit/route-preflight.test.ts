import { expect } from 'chai';
import sinon from 'sinon';
import { ethers } from 'ethers';
import { LiquiditySource, KeeperConfig } from '../../src/config';
import { validateAutoDiscoverRouteDeployments } from '../../src/discovery/route-preflight';

describe('route deployment preflight', () => {
  afterEach(() => {
    sinon.restore();
  });

  const baseConfig = (): KeeperConfig => ({
    network: {
      rpcUrl: 'http://localhost:8545',
      subgraph: {
        url: 'http://example-subgraph',
      },
    },
    signer: {
      keystore: '/tmp/keeper.json',
    },
    runtime: {
      logLevel: 'debug',
      delayBetweenRuns: 1,
    },
    ajna: {
      erc20PoolFactory: '0x0000000000000000000000000000000000000001',
      erc721PoolFactory: '0x0000000000000000000000000000000000000002',
      poolUtils: '0x0000000000000000000000000000000000000003',
      positionManager: '0x0000000000000000000000000000000000000004',
      ajnaToken: '0x0000000000000000000000000000000000000005',
    },
    manual: {
      pools: [],
    },
    discovery: {
      enabled: true,
      take: {
        enabled: true,
        validateRouteDeployments: true,
      },
      defaults: {
        take: {
          liquiditySource: LiquiditySource.UNISWAPV3,
          marketPriceFactor: 0.99,
        },
      },
    },
    takers: {
      factory: '0x1111111111111111111111111111111111111111',
      contracts: {
        UniswapV3: '0x2222222222222222222222222222222222222222',
      },
    },
    dex: {
      uniswapV3: {
        router: {
          swapRouter02Address: '0x3333333333333333333333333333333333333333',
          poolFactoryAddress: '0x5555555555555555555555555555555555555555',
          quoterV2Address: '0x6666666666666666666666666666666666666666',
          wethAddress: '0x7777777777777777777777777777777777777777',
        },
      },
    },
  });

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
      factory: '0x1111111111111111111111111111111111111111',
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
    const factoryIface = new ethers.utils.Interface([
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
          if (selector === factoryIface.getSighash('takerContracts')) {
            return factoryIface.encodeFunctionResult('takerContracts', [
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

  it('passes when enabled route contracts have bytecode and factory registry matches', async () => {
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
    const provider = {
      _isProvider: true,
      resolveName: sinon.stub().callsFake(async (name: string) => name),
      getCode: sinon
        .stub()
        .callsFake(async (address: string) =>
          address.toLowerCase() ===
          config.takers!.contracts!.UniswapV3.toLowerCase()
            ? '0x'
            : '0x6000'
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

  it('fails startup preflight when the factory registry maps a source to a different taker', async () => {
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
        'keeperTakerFactory registry maps UNISWAPV3'
      );
    }
  });

  it('fails startup preflight when the factory registry has no registered taker', async () => {
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
        'keeperTakerFactory registry has no taker for UNISWAPV3'
      );
    }
  });

  it('fails startup preflight when the factory registry cannot be read', async () => {
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
        'keeperTakerFactory registry for UNISWAPV3 could not be read'
      );
    }
  });

  it('fails startup preflight when transient factory registry read errors exhaust retries', async () => {
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
        'keeperTakerFactory registry for UNISWAPV3 could not be read after retries'
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

  it('passes LI.FI preflight when factory registry and on-chain allowlists match config', async () => {
    const { config, provider } = lifiProviderStub();

    await validateAutoDiscoverRouteDeployments({
      config,
      provider: provider as any,
      chainId: 1,
    });

    expect(provider.getCode.callCount).to.equal(4);
    expect(provider.call.callCount).to.equal(4);
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
        'LI.FI selectorAllowlist.1 is invalid'
      );
      expect((error as Error).message).to.include(
        'is not present in callTargetAllowlist'
      );
    }
  });

  it('fails LI.FI preflight when a configured call target has no selector policy', async () => {
    const { config, provider } = lifiProviderStub();
    const target = config.dex!.lifi!.callTargetAllowlist![1][0];
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
        `LI.FI selectorAllowlist.1.${target.toLowerCase()} is not configured`
      );
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
        'LI.FI callTargetAllowlist.1 is invalid'
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
