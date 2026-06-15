import fs from 'fs';
import path from 'path';
import { expect } from 'chai';
import {
  KeeperConfig,
  LifiConcreteAllowlistProductionDexConfig,
  LifiDexConfig,
} from '../../src/config';
import {
  LIFI_FORK_CANARY_BASE_CHAIN_ID,
  getLifiForkCanaryApiKey,
  resolveLifiForkCanaryConfig,
} from '../integration/helpers/lifi-fork-canary-config';

const CALL_TARGET = '0x1111111111111111111111111111111111111111';
const APPROVAL_SPENDER = '0x2222222222222222222222222222222222222222';
const FACTORY = '0x3333333333333333333333333333333333333333';
const LIFI_TAKER = '0x4444444444444444444444444444444444444444';
const SELECTOR = '0xABCDEF12';

function keeperConfigWithLifi(lifi: LifiDexConfig): KeeperConfig {
  return {
    network: {
      rpcUrl: 'http://localhost:8545',
      subgraph: { url: 'http://localhost:8000' },
    },
    signer: { keystore: '/tmp/keeper.json' },
    runtime: { logLevel: 'info', delayBetweenRuns: 60 },
    ajna: {
      erc20PoolFactory: '0x5555555555555555555555555555555555555555',
      erc721PoolFactory: '0x6666666666666666666666666666666666666666',
      poolUtils: '0x7777777777777777777777777777777777777777',
      positionManager: '0x8888888888888888888888888888888888888888',
      ajnaToken: '0x9999999999999999999999999999999999999999',
      grantFund: '',
      burnWrapper: '',
      lenderHelper: '',
    },
    manual: { pools: [] },
    takers: {
      router: FACTORY,
      contracts: { Lifi: LIFI_TAKER },
    },
    dex: { lifi },
  };
}

function productionConfig(
  overrides: Partial<LifiConcreteAllowlistProductionDexConfig> = {}
): KeeperConfig {
  return keeperConfigWithLifi({
    mode: 'production',
    allowExchanges: ['Uniswap'],
    callTargetAllowlist: {
      [LIFI_FORK_CANARY_BASE_CHAIN_ID]: [CALL_TARGET],
    },
    approvalSpenderAllowlist: {
      [LIFI_FORK_CANARY_BASE_CHAIN_ID]: [APPROVAL_SPENDER],
    },
    selectorAllowlist: {
      [LIFI_FORK_CANARY_BASE_CHAIN_ID]: { [CALL_TARGET]: [SELECTOR] },
    },
    ...overrides,
  });
}

describe('LI.FI fork execution canary', () => {
  const hardhatConfig = fs.readFileSync(
    path.join(__dirname, '../../hardhat.config.ts'),
    'utf8'
  );
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')
  );

  it('keeps the command on an opt-in local Base fork path', () => {
    const script = packageJson.scripts['lifi-fork-execution-canary'];

    expect(script).to.include('RUN_LIFI_FORK_CANARY=true');
    expect(script).to.include('HARDHAT_CHAIN_ID=8453');
    expect(script).to.include('FORK_NETWORK=base');
    expect(script).to.include(
      'npx hardhat test tests/integration/lifi-fork-execution-canary.test.ts'
    );
    expect(script).to.not.include('--network');
  });

  it('allows the Base fork canary to use documented Base RPC env fallbacks', () => {
    expect(hardhatConfig).to.include('function baseRpcUrl()');
    expect(hardhatConfig).to.include(
      "optionalEnv('AJNA_AGENT_RPC_URL', 'AJNA_RPC_URL_BASE', 'BASE_RPC_URL')"
    );
    expect(hardhatConfig).to.include("alchemyRpcUrl('base-mainnet')");
    expect(hardhatConfig).to.include('url: baseRpcUrl()');
    expect(hardhatConfig).to.not.include(
      'url: `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`'
    );
  });

  it('resolves reviewed production keeper config before executable calldata fetching', () => {
    const config = resolveLifiForkCanaryConfig({
      keeperConfig: productionConfig(),
      env: {},
    });

    expect(config.mode).to.equal('production');
    expect(config.configuredFactoryAddress).to.equal(FACTORY);
    expect(config.configuredTakerAddress).to.equal(LIFI_TAKER);
    expect(config.allowExchanges).to.deep.equal(['Uniswap']);
    expect(
      config.callTargetAllowlist[LIFI_FORK_CANARY_BASE_CHAIN_ID]
    ).to.deep.equal([CALL_TARGET]);
    expect(
      config.approvalSpenderAllowlist[LIFI_FORK_CANARY_BASE_CHAIN_ID]
    ).to.deep.equal([APPROVAL_SPENDER]);
    expect(
      config.selectorAllowlist[LIFI_FORK_CANARY_BASE_CHAIN_ID]
    ).to.deep.equal({
      [CALL_TARGET]: ['0xabcdef12'],
    });
  });

  it('rejects policy env overrides for the fork execution canary', () => {
    expect(() =>
      resolveLifiForkCanaryConfig({
        keeperConfig: productionConfig(),
        env: { AJNA_AGENT_LIFI_FORK_CANARY_ALLOW_EXCHANGES: 'sushiswap' },
      })
    ).to.throw('refusing LI.FI policy env overrides');
  });

  it('requires production mode, configured factory, and configured LI.FI taker', () => {
    expect(() =>
      resolveLifiForkCanaryConfig({
        keeperConfig: keeperConfigWithLifi({
          mode: 'canary',
          allowExchanges: ['uniswap'],
        }),
        env: {},
      })
    ).to.throw(
      'LI.FI fork canary requires reviewed production keeper config with production dex.lifi'
    );

    expect(() =>
      resolveLifiForkCanaryConfig({
        keeperConfig: {
          ...productionConfig(),
          takers: { contracts: { Lifi: LIFI_TAKER } },
        },
        env: {},
      })
    ).to.throw('LI.FI fork canary requires config.takers.router');
  });

  it('requires the default LI.FI API base URL before fetching executable calldata', () => {
    expect(() =>
      resolveLifiForkCanaryConfig({
        keeperConfig: productionConfig({
          apiBaseUrl: 'https://mock.lifi.local/v1',
        }),
        env: {},
      })
    ).to.throw('requires the default LI.FI API base URL');
  });

  it('rejects broad exchange filters before fetching executable calldata', () => {
    expect(() =>
      resolveLifiForkCanaryConfig({
        keeperConfig: productionConfig({
          allowBroadExchangeFilters: true as false,
        }),
        env: {},
      })
    ).to.throw('config.dex.lifi.allowBroadExchangeFilters is canary-only');

    expect(() =>
      resolveLifiForkCanaryConfig({
        keeperConfig: productionConfig({ allowExchanges: ['all'] }),
        env: {},
      })
    ).to.throw('broad filter keywords are not allowed');
  });

  it('validates selector policy coverage before fetching executable calldata', () => {
    expect(() =>
      resolveLifiForkCanaryConfig({
        keeperConfig: productionConfig({
          selectorAllowlist: {
            [LIFI_FORK_CANARY_BASE_CHAIN_ID]: {},
          },
        }),
        env: {},
      })
    ).to.throw('config.dex.lifi.selectorAllowlist.8453 must be non-empty');

    expect(() =>
      resolveLifiForkCanaryConfig({
        keeperConfig: productionConfig({
          selectorAllowlist: {
            [LIFI_FORK_CANARY_BASE_CHAIN_ID]: {
              [APPROVAL_SPENDER]: [SELECTOR],
            },
          },
        }),
        env: {},
      })
    ).to.throw('is not present in callTargetAllowlist');
  });

  it('bounds fork canary LI.FI numeric policy before quote fetching', () => {
    expect(() =>
      resolveLifiForkCanaryConfig({
        keeperConfig: productionConfig({ quoteTimeoutMs: 10_001 }),
        env: {},
      })
    ).to.throw(
      'config.dex.lifi.quoteTimeoutMs must be an integer between 1 and 10000'
    );

    expect(() =>
      resolveLifiForkCanaryConfig({
        keeperConfig: productionConfig({ defaultSlippage: 0.51 }),
        env: {},
      })
    ).to.throw(
      'config.dex.lifi.defaultSlippage must be greater than 0 and at most 0.5'
    );

    expect(() =>
      resolveLifiForkCanaryConfig({
        keeperConfig: productionConfig({ maxPriceImpact: 0.51 }),
        env: {},
      })
    ).to.throw(
      'config.dex.lifi.maxPriceImpact must be greater than 0 and at most 0.5'
    );
  });

  it('resolves the LI.FI API key from the reviewed config env var before generic fallbacks', () => {
    const config = resolveLifiForkCanaryConfig({
      keeperConfig: productionConfig({ apiKeyEnvVar: 'LIFI_PRIMARY_KEY' }),
      env: {},
    });

    expect(
      getLifiForkCanaryApiKey(config, {
        LIFI_PRIMARY_KEY: 'primary',
        LIFI_API_KEY: 'fallback',
      })
    ).to.equal('primary');
  });
});
