import fs from 'fs';
import path from 'path';
import { expect } from 'chai';
import { LifiDexConfig, LiquiditySource } from '../../src/config';
import {
  buildForcedDiscoveryPolicy,
  fixtureLiquiditySourceForHybridPaths,
  getHybridLifiApiKey,
  loadHybridForkFixture,
  parseHybridPaths,
  requireDefaultHybridLifiApiBaseUrl,
  requireProductionLifi,
  shouldRunLifiCallbackProof,
} from '../integration/helpers/hybrid-fork-loop-config';

const LENDER = '0x1111111111111111111111111111111111111111';
const BORROWER = '0x2222222222222222222222222222222222222222';
const KICKER = '0x3333333333333333333333333333333333333333';

function fixtureEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    AJNA_AGENT_HYBRID_LENDER_WHALE: LENDER,
    AJNA_AGENT_HYBRID_BORROWER_WHALE: BORROWER,
    ...overrides,
  };
}

describe('Hybrid fork loop harness', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')
  );

  it('keeps the command on an opt-in local Base fork path', () => {
    const script = packageJson.scripts['hybrid-fork-loop'];
    expect(script).to.include('RUN_HYBRID_FORK_LOOP=true');
    expect(script).to.include('HARDHAT_CHAIN_ID=8453');
    expect(script).to.include('FORK_NETWORK=base');
    expect(script).to.include(
      'npx hardhat test tests/integration/hybrid-fork-loop.test.ts'
    );
    expect(script).to.not.include('--network');
  });

  it('exposes a LI.FI-only fork proof command with callback execution enabled', () => {
    const script = packageJson.scripts['hybrid-lifi-fork-proof'];
    expect(script).to.include('RUN_HYBRID_FORK_LOOP=true');
    expect(script).to.include('HARDHAT_CHAIN_ID=8453');
    expect(script).to.include('FORK_NETWORK=base');
    expect(script).to.include('AJNA_AGENT_HYBRID_PATHS=calldata_aggregator');
    expect(script).to.include('AJNA_AGENT_HYBRID_LIFI_CALLBACK_PROOF=true');
    expect(script).to.include(
      'npx hardhat test tests/integration/hybrid-fork-loop.test.ts'
    );
    expect(script).to.not.include('--network');
  });

  it('defaults to both external-take path families and allows focused LI.FI proofs', () => {
    expect(parseHybridPaths({})).to.deep.equal([
      'calldata_aggregator',
      'direct_dex',
    ]);
    expect(
      parseHybridPaths({
        AJNA_AGENT_HYBRID_PATHS: ' calldata_aggregator , direct_dex ',
      })
    ).to.deep.equal(['calldata_aggregator', 'direct_dex']);
    expect(() =>
      parseHybridPaths({
        AJNA_AGENT_HYBRID_PATHS: 'calldata_aggregator,unknown',
      })
    ).to.throw(
      'AJNA_AGENT_HYBRID_PATHS must be a non-empty CSV subset of: calldata_aggregator,direct_dex'
    );
  });

  it('selects the default liquidity source from the enabled path set', () => {
    expect(
      fixtureLiquiditySourceForHybridPaths([
        'calldata_aggregator',
        'direct_dex',
      ])
    ).to.equal(LiquiditySource.UNISWAPV3);
    expect(
      fixtureLiquiditySourceForHybridPaths(['calldata_aggregator'])
    ).to.equal(LiquiditySource.LIFI);
  });

  it('builds a dry-run Base fork fixture with tunable economics', () => {
    const fixture = loadHybridForkFixture(
      fixtureEnv({
        AJNA_AGENT_HYBRID_KICKER_WHALE: KICKER,
        AJNA_AGENT_HYBRID_PATHS: 'calldata_aggregator',
        AJNA_AGENT_HYBRID_DEPOSIT_PRICE: '2015',
        AJNA_AGENT_HYBRID_FORK_LIVE_TAKE: 'false',
      })
    );

    expect(fixture.lenderWhale).to.equal(LENDER);
    expect(fixture.borrowerWhale).to.equal(BORROWER);
    expect(fixture.kickerWhale).to.equal(KICKER);
    expect(fixture.paths).to.deep.equal(['calldata_aggregator']);
    expect(fixture.depositPrice).to.equal(2015);
    expect(fixture.liveTake).to.equal(false);
  });

  it('requires fork fixture whales and numeric economics', () => {
    expect(() => loadHybridForkFixture({})).to.throw(
      'AJNA_AGENT_HYBRID_LENDER_WHALE is required'
    );
    expect(() =>
      loadHybridForkFixture(
        fixtureEnv({ AJNA_AGENT_HYBRID_DEPOSIT_PRICE: 'not-a-number' })
      )
    ).to.throw('AJNA_AGENT_HYBRID_DEPOSIT_PRICE must be a finite number');
  });

  it('gates the optional LI.FI callback proof on both path and env flag', () => {
    const lifiFixture = loadHybridForkFixture(
      fixtureEnv({ AJNA_AGENT_HYBRID_PATHS: 'calldata_aggregator' })
    );
    const factoryFixture = loadHybridForkFixture(
      fixtureEnv({ AJNA_AGENT_HYBRID_PATHS: 'direct_dex' })
    );

    expect(
      shouldRunLifiCallbackProof(lifiFixture, {
        AJNA_AGENT_HYBRID_LIFI_CALLBACK_PROOF: 'true',
      })
    ).to.equal(true);
    expect(
      shouldRunLifiCallbackProof(factoryFixture, {
        AJNA_AGENT_HYBRID_LIFI_CALLBACK_PROOF: 'true',
      })
    ).to.equal(false);
    expect(shouldRunLifiCallbackProof(lifiFixture, {})).to.equal(false);
  });

  it('builds the real keeper discovery loop policy with all three providers enabled', () => {
    const policy = buildForcedDiscoveryPolicy(
      loadHybridForkFixture(fixtureEnv())
    );

    expect(policy.take?.allowedExternalTakePaths).to.deep.equal([
      'calldata_aggregator',
      'direct_dex',
    ]);
    expect(policy.take?.externalTakeRouteSelectionMode).to.equal(
      'maximize_profit'
    );
    expect(policy.take?.validateRouteDeployments).to.equal(true);
    expect(policy.take?.dexGasOverrides?.[LiquiditySource.LIFI]).to.equal(
      '900000'
    );
    expect(policy.defaults.take.liquiditySource).to.equal(
      LiquiditySource.UNISWAPV3
    );
  });

  it('requires a reviewed production keeper config with production dex.lifi', () => {
    const production = requireProductionLifi({
      mode: 'production',
      allowExchanges: ['uniswap'],
      callTargetAllowlist: { 8453: [LENDER] },
      approvalSpenderAllowlist: { 8453: [BORROWER] },
      selectorAllowlist: { 8453: { [LENDER]: ['0xabcdef12'] } },
    });
    expect(production.mode).to.equal('production');

    expect(() =>
      requireProductionLifi({
        mode: 'canary',
        allowExchanges: ['uniswap'],
      } as LifiDexConfig)
    ).to.throw('reviewed config dex.lifi must be production mode');
  });

  it('requires the default LI.FI API base URL for the callback execution proof', () => {
    expect(() => requireDefaultHybridLifiApiBaseUrl(undefined)).to.not.throw();
    expect(() =>
      requireDefaultHybridLifiApiBaseUrl('https://mock.lifi.local/v1')
    ).to.throw('requires the default LI.FI API base URL');
  });

  it('defaults to dry-run and supports an opt-in live take', () => {
    expect(loadHybridForkFixture(fixtureEnv()).liveTake).to.equal(false);
    expect(
      loadHybridForkFixture(
        fixtureEnv({ AJNA_AGENT_HYBRID_FORK_LIVE_TAKE: 'true' })
      ).liveTake
    ).to.equal(true);
  });

  it('resolves the LI.FI API key from config-specific env before generic fallback', () => {
    expect(
      getHybridLifiApiKey(
        { mode: 'canary', apiKeyEnvVar: 'LIFI_PRIMARY_KEY' },
        { LIFI_PRIMARY_KEY: 'primary', LIFI_API_KEY: 'fallback' }
      )
    ).to.equal('primary');
  });
});
