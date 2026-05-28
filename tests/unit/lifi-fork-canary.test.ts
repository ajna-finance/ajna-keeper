import fs from 'fs';
import path from 'path';
import { expect } from 'chai';

describe('LI.FI fork execution canary', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../integration/lifi-fork-execution-canary.test.ts'),
    'utf8'
  );
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
    expect(source).to.include("network.name !== 'hardhat'");
    expect(source).to.include("process.env.FORK_NETWORK ?? 'mainnet'");
    expect(source).to.include("process.env.HARDHAT_CHAIN_ID ?? '31337'");
    expect(source).to.include('function requireConfiguredBaseForkRpc');
    expect(source).to.include('Base fork RPC is required');
    expect(source).to.include('AJNA_AGENT_RPC_URL');
    expect(source).to.include('AJNA_RPC_URL_BASE');
    expect(source).to.include('BASE_RPC_URL');
    expect(source).to.include('ALCHEMY_API_KEY');
    expect(source).to.include('requireConfiguredBaseForkRpc();');
    expect(source).to.include('buildForkCanaryConfig();');
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

  it('requires reviewed production keeper config before fetching executable calldata', () => {
    expect(source).to.include('readConfigFile');
    expect(source).to.include('function loadForkCanaryKeeperConfig');
    expect(source).to.include('AJNA_AGENT_LIFI_FORK_CANARY_CONFIG');
    expect(source).to.include('AJNA_AGENT_LIFI_CANARY_CONFIG');
    expect(source).to.include(
      'LI.FI fork canary requires reviewed production keeper config with production dex.lifi'
    );
    expect(source).to.include(
      'LI.FI fork canary requires reviewed production keeper config'
    );
    expect(source).to.include(
      'LI.FI fork canary requires config.takers.contracts.Lifi'
    );
    expect(source).to.include(
      'LI.FI fork canary requires config.takers.factory'
    );
    expect(source).to.include(
      'LI.FI fork canary requires config.dex.lifi.allowExchanges'
    );
    expect(source).to.include(
      'config.dex.lifi.callTargetAllowlist.${BASE_CHAIN_ID}'
    );
    expect(source).to.include(
      'config.dex.lifi.approvalSpenderAllowlist.${BASE_CHAIN_ID}'
    );
    expect(source).to.include('FORK_CANARY_POLICY_OVERRIDE_ENVS');
    expect(source).to.include('refusing LI.FI policy env overrides');
    expect(source).to.include('AJNA_AGENT_LIFI_FORK_CANARY_PROFIT_FLOOR_RAW');
    expect(source).to.include('approvedMinOutRaw');
    expect(source).to.include('validateLifiQuote');
    expect(source).to.include('setCallTarget');
    expect(source).to.include('setApprovalSpender');
    expect(source).to.include('setCallSelector');
  });

  it('verifies configured production factory registration before local callback setup', () => {
    expect(source).to.include(
      'function requireConfiguredProductionTakerRegistration'
    );
    expect(source).to.include(
      'configuredFactory.takerContracts(LiquiditySource.LIFI)'
    );
    expect(source).to.include(
      'LI.FI configured factory registration mismatch'
    );
    expect(source).to.include(
      'config.takers.contracts.Lifi'
    );
    const registrationCheckIndex = source.indexOf(
      'await requireConfiguredProductionTakerRegistration({'
    );
    const localPoolDeployIndex = source.indexOf(
      'const pool = await new MockAtomicSwapPool__factory(owner).deploy'
    );
    const quoteFetchIndex = source.indexOf('await fetchLifiQuote({');
    expect(registrationCheckIndex).to.be.greaterThan(-1);
    expect(localPoolDeployIndex).to.be.greaterThan(registrationCheckIndex);
    expect(quoteFetchIndex).to.be.greaterThan(registrationCheckIndex);
  });

  it('requires the default LI.FI API base URL before fetching executable calldata', () => {
    expect(source).to.include('DEFAULT_LIFI_API_BASE_URL');
    expect(source).to.include('function normalizeApiBaseUrlForGate');
    expect(source).to.include('function requireDefaultLifiApiBaseUrl');
    expect(source).to.include(
      'requireDefaultLifiApiBaseUrl(configured.apiBaseUrl);'
    );
    expect(source).to.include(
      'LI.FI fork canary requires the default LI.FI API base URL'
    );
    const apiBaseCheckIndex = source.indexOf(
      'requireDefaultLifiApiBaseUrl(configured.apiBaseUrl);'
    );
    const quoteFetchIndex = source.indexOf('await fetchLifiQuote({');
    expect(apiBaseCheckIndex).to.be.greaterThan(-1);
    expect(quoteFetchIndex).to.be.greaterThan(apiBaseCheckIndex);
  });

  it('rejects broad exchange filters before fetching executable calldata', () => {
    expect(source).to.include('isBroadLifiExchangeFilter');
    expect(source).to.include('function hasBroadForkExchangeFilter');
    expect(source).to.include(
      'config.dex.lifi.allowBroadExchangeFilters is canary-only'
    );
    expect(source).to.include('broad filter keywords are not allowed');
    const broadModeCheckIndex = source.indexOf(
      'config.dex.lifi.allowBroadExchangeFilters is canary-only'
    );
    const broadFilterCheckIndex = source.indexOf(
      'hasBroadForkExchangeFilter(configured)'
    );
    const quoteFetchIndex = source.indexOf('await fetchLifiQuote({');
    expect(broadModeCheckIndex).to.be.greaterThan(-1);
    expect(broadFilterCheckIndex).to.be.greaterThan(-1);
    expect(quoteFetchIndex).to.be.greaterThan(broadModeCheckIndex);
    expect(quoteFetchIndex).to.be.greaterThan(broadFilterCheckIndex);
  });

  it('validates LI.FI exchange filters with tools before fetching executable calldata', () => {
    expect(source).to.include('fetchLifiTools');
    expect(source).to.include('assertLifiToolsContainFilters');
    expect(source).to.include('normalizeLifiExchangeFilters');
    expect(source).to.include('function requireLifiToolsContainForkFilters');
    const toolsCheckIndex = source.indexOf(
      'await requireLifiToolsContainForkFilters({'
    );
    const quoteFetchIndex = source.indexOf('await fetchLifiQuote({');
    expect(toolsCheckIndex).to.be.greaterThan(-1);
    expect(quoteFetchIndex).to.be.greaterThan(toolsCheckIndex);
  });

  it('validates selector policy before fetching executable calldata', () => {
    expect(source).to.include('normalizeLifiAddressAllowlist');
    expect(source).to.include('normalizeLifiSelectorAllowlistRecord');
    expect(source).to.include('function normalizeSelectorAllowlistConfig');
    expect(source).to.include(
      'callTargetAllowlist: params.callTargetAllowlist'
    );
    expect(source).to.include('requireCallTargetCoverage: true');
    expect(source).to.include('requireNonEmpty: true');
    const configIndex = source.indexOf(
      'const lifiConfig = await buildForkCanaryConfig();'
    );
    const quoteFetchIndex = source.indexOf('await fetchLifiQuote({');
    expect(configIndex).to.be.greaterThan(-1);
    expect(quoteFetchIndex).to.be.greaterThan(configIndex);
  });

  it('bounds fork canary LI.FI numeric policy before quote fetching', () => {
    expect(source).to.include('function requirePositiveIntegerPolicy');
    expect(source).to.include('function requireBoundedDecimalPolicy');
    expect(source).to.include('function requireOptionalBoundedDecimalPolicy');
    expect(source).to.include('MAX_LIFI_CANARY_TIMEOUT_MS');
    expect(source).to.include('MAX_LIFI_CANARY_SLIPPAGE');
    expect(source).to.include('MAX_LIFI_CANARY_PRICE_IMPACT');
    expect(source).to.include('quoteTimeoutMs: requirePositiveIntegerPolicy');
    expect(source).to.include('defaultSlippage: requireBoundedDecimalPolicy');
    expect(source).to.include(
      'maxPriceImpact: requireOptionalBoundedDecimalPolicy'
    );
    expect(source).to.not.include('quoteTimeoutMs: Number(');
    expect(source).to.not.include('defaultSlippage: Number(');
  });
});
