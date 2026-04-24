import { expect } from 'chai';
import sinon from 'sinon';
import { ethers } from 'ethers';
import { LiquiditySource, KeeperConfig } from '../config';
import { validateAutoDiscoverRouteDeployments } from '../discovery/route-preflight';

describe('route deployment preflight', () => {
  afterEach(() => {
    sinon.restore();
  });

  const baseConfig = (): KeeperConfig =>
    ({
      ethRpcUrl: 'http://localhost:8545',
      logLevel: 'debug',
      subgraphUrl: 'http://example-subgraph',
      keeperKeystore: '/tmp/keeper.json',
      ajna: {
        erc20PoolFactory: '0x0000000000000000000000000000000000000001',
        erc721PoolFactory: '0x0000000000000000000000000000000000000002',
        poolUtils: '0x0000000000000000000000000000000000000003',
        positionManager: '0x0000000000000000000000000000000000000004',
        ajnaToken: '0x0000000000000000000000000000000000000005',
      },
      delayBetweenActions: 0,
      delayBetweenRuns: 1,
      pools: [],
      autoDiscover: {
        enabled: true,
        take: {
          enabled: true,
          validateRouteDeployments: true,
        },
      },
      discoveredDefaults: {
        take: {
          liquiditySource: LiquiditySource.UNISWAPV3,
          marketPriceFactor: 0.99,
        },
      },
      keeperTakerFactory: '0x1111111111111111111111111111111111111111',
      takerContracts: {
        UniswapV3: '0x2222222222222222222222222222222222222222',
      },
      universalRouterOverrides: {
        universalRouterAddress: '0x3333333333333333333333333333333333333333',
        permit2Address: '0x4444444444444444444444444444444444444444',
        poolFactoryAddress: '0x5555555555555555555555555555555555555555',
        quoterV2Address: '0x6666666666666666666666666666666666666666',
        wethAddress: '0x7777777777777777777777777777777777777777',
      },
    }) as KeeperConfig;

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
            [config.takerContracts!.UniswapV3]
          )
        ),
    };

    await validateAutoDiscoverRouteDeployments({
      config,
      provider: provider as any,
      chainId: 1,
    });

    expect(provider.getCode.callCount).to.equal(7);
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
          config.takerContracts!.UniswapV3.toLowerCase()
            ? '0x'
            : '0x6000'
        ),
      call: sinon
        .stub()
        .resolves(
          ethers.utils.defaultAbiCoder.encode(
            ['address'],
            [config.takerContracts!.UniswapV3]
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
});
