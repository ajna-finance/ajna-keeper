import { expect } from 'chai';
import {
  KeeperConfig,
  LiquiditySource,
  validateAutoDiscoverConfig,
} from '../../src/config';

describe('LI.FI config validation', () => {
  const chainId = 8453;
  const callTarget = '0x4444444444444444444444444444444444444444';
  const spender = '0x5555555555555555555555555555555555555555';

  function baseConfig(): KeeperConfig {
    return {
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
          dexGasOverrides: {
            [LiquiditySource.LIFI]: '900000',
          },
        },
        settlement: false,
        defaults: {
          take: {
            liquiditySource: LiquiditySource.LIFI,
            marketPriceFactor: 0.99,
          },
        },
      },
      takers: {
        factory: '0x1234567890123456789012345678901234567890',
        contracts: {
          Lifi: '0x3333333333333333333333333333333333333333',
        },
      },
      dex: {
        lifi: {
          mode: 'production',
          allowExchanges: ['uniswap'],
          callTargetAllowlist: {
            [chainId]: [callTarget],
          },
          approvalSpenderAllowlist: {
            [chainId]: [spender],
          },
          selectorAllowlist: {
            [chainId]: {
              [callTarget]: ['0xabcdef12'],
            },
          },
          defaultSlippage: 0.005,
          maxQuoteAgeMs: 30_000,
        },
      },
    };
  }

  it('accepts production LI.FI autodiscovery config with explicit gas and allowlists', () => {
    expect(() =>
      validateAutoDiscoverConfig(baseConfig(), chainId)
    ).to.not.throw();
  });

  it('rejects LI.FI autodiscovery without the canonical factory taker config', () => {
    const missingFactory = baseConfig();
    delete (missingFactory.takers as any).factory;

    expect(() => validateAutoDiscoverConfig(missingFactory, chainId)).to.throw(
      'TakeSettings: takers.factory required when liquiditySource is LIFI'
    );

    const missingLifiTaker = baseConfig();
    delete (missingLifiTaker.takers!.contracts as any).Lifi;

    expect(() =>
      validateAutoDiscoverConfig(missingLifiTaker, chainId)
    ).to.throw(
      'TakeSettings: takers.contracts.Lifi required when liquiditySource is LIFI'
    );
  });

  it('rejects LI.FI autodiscovery without production dex.lifi config', () => {
    const config = baseConfig();
    delete (config.dex as any).lifi;

    expect(() => validateAutoDiscoverConfig(config, chainId)).to.throw(
      'KeeperConfig.dex.lifi required when LI.FI is enabled'
    );
  });

  it('requires deployment preflight for default LI.FI autodiscovery', () => {
    const config = baseConfig();
    delete (config.discovery!.take as any).validateRouteDeployments;

    expect(() => validateAutoDiscoverConfig(config, chainId)).to.throw(
      'AutoDiscoverConfig.take: validateRouteDeployments=true required when resolved external take paths include lifi'
    );
  });

  it('requires deployment preflight for explicit LI.FI hybrid paths', () => {
    const config = baseConfig();
    config.discovery!.defaults!.take!.liquiditySource =
      LiquiditySource.UNISWAPV3;
    config.discovery!.take = {
      enabled: true,
      allowedExternalTakePaths: ['factory', 'lifi'],
      defaultFactoryLiquiditySource: LiquiditySource.UNISWAPV3,
      dexGasOverrides: {
        [LiquiditySource.UNISWAPV3]: '900000',
        [LiquiditySource.LIFI]: '900000',
      },
    };
    config.takers!.contracts = {
      ...config.takers!.contracts,
      UniswapV3: '0x8888888888888888888888888888888888888888',
    };
    config.dex!.uniswapV3 = {
      router: {
        swapRouter02Address: '0x9999999999999999999999999999999999999999',
        poolFactoryAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        quoterV2Address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        wethAddress: '0x4200000000000000000000000000000000000006',
      },
    };

    expect(() => validateAutoDiscoverConfig(config, chainId)).to.throw(
      'AutoDiscoverConfig.take: validateRouteDeployments=true required when resolved external take paths include lifi'
    );
  });

  it('rejects LI.FI autodiscovery without a gas override', () => {
    const config = baseConfig();
    delete (config.discovery!.take as any).dexGasOverrides;

    expect(() => validateAutoDiscoverConfig(config, chainId)).to.throw(
      'AutoDiscoverConfig.take: dexGasOverrides.LIFI required when resolved external take paths include lifi'
    );
  });

  it('rejects canary mode for live LI.FI autodiscovery', () => {
    const config = baseConfig();
    config.dex!.lifi = {
      mode: 'canary',
      allowExchanges: ['uniswap'],
    };

    expect(() => validateAutoDiscoverConfig(config, chainId)).to.throw(
      'KeeperConfig.dex.lifi.mode must be production for live LI.FI external takes'
    );
  });

  it('rejects HTTP LI.FI API base URLs in production', () => {
    const config = baseConfig();
    config.dex!.lifi = {
      ...(config.dex!.lifi as any),
      apiBaseUrl: 'http://localhost:9000',
    };

    expect(() => validateAutoDiscoverConfig(config, chainId)).to.throw(
      'KeeperConfig.dex.lifi.apiBaseUrl must be HTTPS in production'
    );
  });

  it('allows canary mode only when runtime dryRun is enabled', () => {
    const config = baseConfig();
    config.runtime.dryRun = true;
    config.dex!.lifi = {
      mode: 'canary',
      allowExchanges: ['uniswap'],
    };

    expect(() => validateAutoDiscoverConfig(config, chainId)).to.not.throw();
  });

  it('allows HTTP LI.FI API base URLs for canary dry-run workflows', () => {
    const config = baseConfig();
    config.runtime.dryRun = true;
    config.dex!.lifi = {
      mode: 'canary',
      apiBaseUrl: 'http://localhost:9000',
      allowExchanges: ['uniswap'],
    };

    expect(() => validateAutoDiscoverConfig(config, chainId)).to.not.throw();
  });

  it('rejects unsafe LI.FI scalar and enum policy values', () => {
    const invalidCases: Array<{
      patch: Record<string, unknown>;
      message: string;
    }> = [
      {
        patch: { defaultSlippage: 0 },
        message:
          'KeeperConfig.dex.lifi.defaultSlippage must be greater than 0 and at most 0.5',
      },
      {
        patch: { defaultSlippage: 0.5001 },
        message:
          'KeeperConfig.dex.lifi.defaultSlippage must be greater than 0 and at most 0.5',
      },
      {
        patch: { maxPriceImpact: 0 },
        message:
          'KeeperConfig.dex.lifi.maxPriceImpact must be greater than 0 and at most 0.5',
      },
      {
        patch: { maxPriceImpact: 0.5001 },
        message:
          'KeeperConfig.dex.lifi.maxPriceImpact must be greater than 0 and at most 0.5',
      },
      {
        patch: { maxQuoteAgeMs: 0 },
        message:
          'KeeperConfig.dex.lifi.maxQuoteAgeMs must be an integer between 1 and 60000',
      },
      {
        patch: { maxQuoteAgeMs: 60_001 },
        message:
          'KeeperConfig.dex.lifi.maxQuoteAgeMs must be an integer between 1 and 60000',
      },
      {
        patch: { quoteTimeoutMs: 0 },
        message:
          'KeeperConfig.dex.lifi.quoteTimeoutMs must be an integer between 1 and 10000',
      },
      {
        patch: { quoteTimeoutMs: 10_001 },
        message:
          'KeeperConfig.dex.lifi.quoteTimeoutMs must be an integer between 1 and 10000',
      },
      {
        patch: { quoteFailureThreshold: 0 },
        message:
          'KeeperConfig.dex.lifi.quoteFailureThreshold must be an integer between 1 and 100',
      },
      {
        patch: { quoteFailureThreshold: 101 },
        message:
          'KeeperConfig.dex.lifi.quoteFailureThreshold must be an integer between 1 and 100',
      },
      {
        patch: { quoteFailureCooldownMs: 0 },
        message:
          'KeeperConfig.dex.lifi.quoteFailureCooldownMs must be greater than 0',
      },
      {
        patch: { feeCostPolicy: 'all' },
        message:
          'KeeperConfig.dex.lifi.feeCostPolicy must be included_only or reject_all',
      },
    ];

    for (const invalidCase of invalidCases) {
      const config = baseConfig();
      config.dex!.lifi = {
        ...(config.dex!.lifi as any),
        ...invalidCase.patch,
      };

      expect(() => validateAutoDiscoverConfig(config, chainId)).to.throw(
        invalidCase.message
      );
    }
  });

  it('rejects canary-only or malformed LI.FI metadata in production', () => {
    const invalidCases: Array<{
      patch: Record<string, unknown>;
      message: string;
    }> = [
      {
        patch: { allowBroadExchangeFilters: true },
        message:
          'KeeperConfig.dex.lifi.allowBroadExchangeFilters is canary-only',
      },
      {
        patch: { apiBaseUrl: 'ftp://lifi.invalid/v1' },
        message:
          'KeeperConfig.dex.lifi.apiBaseUrl must be an http(s) URL without credentials, query, or fragment',
      },
      {
        patch: { apiBaseUrl: 'https://user:pass@li.quest/v1' },
        message:
          'KeeperConfig.dex.lifi.apiBaseUrl must be an http(s) URL without credentials, query, or fragment',
      },
      {
        patch: { apiBaseUrl: 'https://li.quest/v1?source=keeper' },
        message:
          'KeeperConfig.dex.lifi.apiBaseUrl must be an http(s) URL without credentials, query, or fragment',
      },
      {
        patch: { apiBaseUrl: 'https://li.quest/v1#quotes' },
        message:
          'KeeperConfig.dex.lifi.apiBaseUrl must be an http(s) URL without credentials, query, or fragment',
      },
      {
        patch: { apiKeyEnvVar: '1BAD_ENV' },
        message:
          'KeeperConfig.dex.lifi.apiKeyEnvVar must be an environment variable name',
      },
      {
        patch: { integrator: '' },
        message:
          'KeeperConfig.dex.lifi.integrator must be 1-23 characters and contain only letters, numbers, hyphens, underscores, or dots',
      },
      {
        patch: { integrator: 'x'.repeat(24) },
        message:
          'KeeperConfig.dex.lifi.integrator must be 1-23 characters and contain only letters, numbers, hyphens, underscores, or dots',
      },
      {
        patch: { integrator: 'ajna keeper' },
        message:
          'KeeperConfig.dex.lifi.integrator must be 1-23 characters and contain only letters, numbers, hyphens, underscores, or dots',
      },
    ];

    for (const invalidCase of invalidCases) {
      const config = baseConfig();
      config.dex!.lifi = {
        ...(config.dex!.lifi as any),
        ...invalidCase.patch,
      };

      expect(() => validateAutoDiscoverConfig(config, chainId)).to.throw(
        invalidCase.message
      );
    }
  });

  it('rejects broad production exchange filters', () => {
    const config = baseConfig();
    config.dex!.lifi = {
      ...(config.dex!.lifi as any),
      allowExchanges: ['all'],
    };

    expect(() => validateAutoDiscoverConfig(config, chainId)).to.throw(
      'KeeperConfig.dex.lifi.allowExchanges cannot use broad LI.FI filter keyword'
    );
  });

  it('rejects reserved production exchange filter keywords', () => {
    const config = baseConfig();
    config.dex!.lifi = {
      ...(config.dex!.lifi as any),
      allowExchanges: ['none'],
    };

    expect(() => validateAutoDiscoverConfig(config, chainId)).to.throw(
      'KeeperConfig.dex.lifi.allowExchanges cannot use broad LI.FI filter keyword'
    );

    config.dex!.lifi = {
      ...(baseConfig().dex!.lifi as any),
      denyExchanges: ['[]'],
    };

    expect(() => validateAutoDiscoverConfig(config, chainId)).to.throw(
      'KeeperConfig.dex.lifi.denyExchanges cannot use broad LI.FI filter keyword'
    );
  });

  it('rejects empty production exchange allowlists', () => {
    const config = baseConfig();
    config.dex!.lifi = {
      ...(config.dex!.lifi as any),
      allowExchanges: [],
    };

    expect(() => validateAutoDiscoverConfig(config, chainId)).to.throw(
      'KeeperConfig.dex.lifi.allowExchanges must be non-empty in production'
    );
  });

  it('rejects fee-collection exchange filters', () => {
    const config = baseConfig();
    config.dex!.lifi = {
      ...(config.dex!.lifi as any),
      allowExchanges: ['feeCollection'],
    };

    expect(() => validateAutoDiscoverConfig(config, chainId)).to.throw(
      'KeeperConfig.dex.lifi.allowExchanges cannot use unsupported LI.FI filter keyword'
    );
  });

  it('rejects duplicate exchange filters across allow and prefer policy', () => {
    const config = baseConfig();
    config.dex!.lifi = {
      ...(config.dex!.lifi as any),
      allowExchanges: ['Uniswap'],
      preferExchanges: ['uniswap'],
    };

    expect(() => validateAutoDiscoverConfig(config, chainId)).to.throw(
      'KeeperConfig.dex.lifi exchange filter uniswap cannot appear in both allowExchanges and preferExchanges'
    );
  });

  it('requires production LI.FI allowlists for the active chain', () => {
    const missingTargets = baseConfig();
    delete (missingTargets.dex!.lifi as any).callTargetAllowlist[chainId];

    expect(() => validateAutoDiscoverConfig(missingTargets, chainId)).to.throw(
      'KeeperConfig.dex.lifi.callTargetAllowlist.8453 is required'
    );

    const missingSpenders = baseConfig();
    delete (missingSpenders.dex!.lifi as any).approvalSpenderAllowlist[chainId];

    expect(() => validateAutoDiscoverConfig(missingSpenders, chainId)).to.throw(
      'KeeperConfig.dex.lifi.approvalSpenderAllowlist.8453 is required'
    );

    const missingSelectors = baseConfig();
    delete (missingSelectors.dex!.lifi as any).selectorAllowlist[chainId];

    expect(() =>
      validateAutoDiscoverConfig(missingSelectors, chainId)
    ).to.throw('KeeperConfig.dex.lifi.selectorAllowlist.8453 is required');
  });

  it('requires selectors for every production call target on the chain', () => {
    const config = baseConfig();
    (config.dex!.lifi as any).selectorAllowlist = {
      [chainId]: {},
    };

    expect(() => validateAutoDiscoverConfig(config, chainId)).to.throw(
      'KeeperConfig.dex.lifi.selectorAllowlist.8453 must be non-empty'
    );
  });

  it('requires selectors for every configured production LI.FI call-target chain', () => {
    const config = baseConfig();
    const otherChainId = 1;
    const otherTarget = '0x6666666666666666666666666666666666666666';
    (config.dex!.lifi as any).callTargetAllowlist[otherChainId] = [otherTarget];
    (config.dex!.lifi as any).approvalSpenderAllowlist[otherChainId] = [
      spender,
    ];

    expect(() => validateAutoDiscoverConfig(config, chainId)).to.throw(
      'KeeperConfig.dex.lifi.selectorAllowlist.1 is required'
    );
  });

  it('requires approval spenders for every configured production LI.FI call-target chain', () => {
    const config = baseConfig();
    const otherChainId = 1;
    const otherTarget = '0x6666666666666666666666666666666666666666';
    (config.dex!.lifi as any).callTargetAllowlist[otherChainId] = [otherTarget];
    (config.dex!.lifi as any).selectorAllowlist[otherChainId] = {
      [otherTarget]: ['0xabcdef12'],
    };

    expect(() => validateAutoDiscoverConfig(config, chainId)).to.throw(
      'KeeperConfig.dex.lifi.approvalSpenderAllowlist.1 is required'
    );
  });

  it('requires selectors for every configured production LI.FI call target on non-active chains', () => {
    const config = baseConfig();
    const otherChainId = 1;
    const otherTarget = '0x6666666666666666666666666666666666666666';
    const missingTarget = '0x7777777777777777777777777777777777777777';
    (config.dex!.lifi as any).callTargetAllowlist[otherChainId] = [
      otherTarget,
      missingTarget,
    ];
    (config.dex!.lifi as any).approvalSpenderAllowlist[otherChainId] = [
      spender,
    ];
    (config.dex!.lifi as any).selectorAllowlist[otherChainId] = {
      [otherTarget]: ['0xabcdef12'],
    };

    expect(() => validateAutoDiscoverConfig(config, chainId)).to.throw(
      'KeeperConfig.dex.lifi.selectorAllowlist.1 must include selectors for every configured LI.FI call target'
    );
  });

  it('keeps LI.FI out of factory-only allowedLiquiditySources', () => {
    const config = baseConfig();
    config.discovery!.defaults!.take!.liquiditySource =
      LiquiditySource.UNISWAPV3;
    config.discovery!.take = {
      enabled: true,
      allowedExternalTakePaths: ['factory', 'lifi'],
      defaultFactoryLiquiditySource: LiquiditySource.UNISWAPV3,
      allowedLiquiditySources: [LiquiditySource.LIFI],
      validateRouteDeployments: true,
      dexGasOverrides: {
        [LiquiditySource.LIFI]: '900000',
      },
    };
    config.takers!.contracts = {
      ...config.takers!.contracts,
      UniswapV3: '0x8888888888888888888888888888888888888888',
    };
    config.dex!.uniswapV3 = {
      router: {
        swapRouter02Address: '0x9999999999999999999999999999999999999999',
        poolFactoryAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        quoterV2Address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        wethAddress: '0x4200000000000000000000000000000000000006',
      },
    };

    expect(() => validateAutoDiscoverConfig(config, chainId)).to.throw(
      'AutoDiscoverConfig.take: allowedLiquiditySources currently supports only UNISWAPV3, SUSHISWAP, and CURVE'
    );
  });
});
