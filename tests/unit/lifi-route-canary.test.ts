import fs from 'fs';
import os from 'os';
import path from 'path';
import { expect } from 'chai';
import {
  runLifiRouteCanaryTest as runCanary,
  writeKeeperConfig,
  writeNoContactAxiosMock,
} from './helpers/lifi-route-canary';

describe('LI.FI route canary', function () {
  this.timeout(60000);

  const repoRoot = path.join(__dirname, '../..');
  const scriptPath = path.join(repoRoot, 'scripts/lifi-route-canary.ts');
  const source = fs.readFileSync(scriptPath, 'utf8');
  const routeCanarySource = fs.readFileSync(
    path.join(repoRoot, 'src/dex/lifi/route-canary.ts'),
    'utf8'
  );

  // The no-broadcast guarantee must hold for the canary's whole first-party LI.FI
  // import surface, not just the entry script: a write primitive introduced into
  // src/dex/lifi/* (the modules the canary imports for fetch/validate) would
  // otherwise slip past a scan of scriptPath alone. Shared modules like
  // src/utils / src/config legitimately reference ethers Wallet/providers for
  // non-canary reasons, so they are intentionally out of scope here.
  const lifiModuleDir = path.join(repoRoot, 'src/dex/lifi');
  const noBroadcastScanSources = [
    source,
    ...fs
      .readdirSync(lifiModuleDir)
      .filter((file) => file.endsWith('.ts'))
      .map((file) => fs.readFileSync(path.join(lifiModuleDir, file), 'utf8')),
  ];

  it('keeps the route-shape canary on a no-broadcast path', async () => {
    const forbiddenWriteHooks = [
      'sendTransaction',
      'verifyAndSubmit',
      'submitTakeTransaction',
      'resolveTakeWriteTransport',
      'NonceTracker',
      'approveErc20',
      'transferErc20',
      'clearAllowances',
      'new ethers.Contract',
      'Wallet.createRandom',
      'JsonRpcProvider',
      'populateTransaction',
      'estimateGas',
      'takeWithAtomicSwap',
      '.approve(',
      '.transfer(',
      '.deploy(',
      '.setTaker(',
      '.setCallTarget(',
      '.setCallTargets(',
      '.setApprovalSpender(',
      '.setApprovalSpenders(',
      '.setCallSelector(',
      '.setSelectorAllowed(',
      '.recoverFromTaker(',
      '.recover(',
    ];

    for (const forbidden of forbiddenWriteHooks) {
      for (const scanned of noBroadcastScanSources) {
        expect(scanned).to.not.include(forbidden);
      }
    }
  });

  it('uses LI.FI tools, quote fetching, and local quote validation only', async () => {
    expect(routeCanarySource).to.include('fetchLifiTools');
    expect(routeCanarySource).to.include('assertLifiToolsContainFilters');
    expect(routeCanarySource).to.include('fetchLifiQuote');
    expect(routeCanarySource).to.include('validateLifiQuote');
  });

  it('preserves optional local skip behavior when required canary config is absent', async () => {
    const { result, summary } = await runCanary();

    expect(result.status, result.stderr).to.equal(0);
    expect(summary, result.stderr).to.not.equal(undefined);
    expect(summary.status).to.equal('skipped');
    expect(summary.requireLive).to.equal(false);
  });

  it('fails closed for LI.FI production enablement gate runs when required canary config is absent', async () => {
    const { result, summary } = await runCanary({
      AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE: 'true',
    });

    expect(result.status, result.stderr).to.equal(1);
    expect(summary, result.stderr).to.not.equal(undefined);
    expect(summary.status).to.equal('skipped');
    expect(summary.requireLive).to.equal(true);
  });

  it('fails closed before contacting LI.FI when required-live runs use env-only policy', async () => {
    const takerAddress = '0x1111111111111111111111111111111111111111';
    const fromToken = '0x2222222222222222222222222222222222222222';
    const toToken = '0x3333333333333333333333333333333333333333';
    const callTarget = '0x4444444444444444444444444444444444444444';
    const approvalSpender = '0x5555555555555555555555555555555555555555';
    const selector = '0xabcdef12';
    const mockDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'lifi-route-canary-required-live-env-only-')
    );
    const { requestsPath } = writeNoContactAxiosMock(
      mockDir,
      'LI.FI should not be contacted for env-only required-live policy'
    );

    const { result, summary } = await runCanary({
      AJNA_AGENT_LIFI_CANARY_MOCK_REQUESTS_PATH: requestsPath,
      AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE: 'true',
      AJNA_AGENT_LIFI_CANARY_CHAIN_ID: '8453',
      AJNA_AGENT_LIFI_CANARY_TAKER_ADDRESS: takerAddress,
      AJNA_AGENT_LIFI_CANARY_ALLOW_EXCHANGES: 'uniswap',
      AJNA_AGENT_LIFI_CANARY_CALL_TARGET_ALLOWLIST: callTarget,
      AJNA_AGENT_LIFI_CANARY_APPROVAL_SPENDER_ALLOWLIST: approvalSpender,
      AJNA_AGENT_LIFI_CANARY_SELECTOR_ALLOWLIST_JSON: JSON.stringify({
        [callTarget]: [selector],
      }),
      AJNA_AGENT_LIFI_CANARY_ROUTES_JSON: JSON.stringify([
        {
          label: 'env-only-policy',
          fromToken,
          toToken,
          fromAmount: '1000000',
        },
      ]),
    });

    expect(result.status, result.stderr).to.equal(1);
    expect(summary, result.stderr).to.not.equal(undefined);
    expect(summary.status).to.equal('skipped');
    expect(summary.checks[0].error).to.include('requires --config');
    expect(fs.existsSync(requestsPath)).to.equal(false);
  });

  it('fails closed before contacting LI.FI when required-live runs use a custom API base URL', async () => {
    const takerAddress = '0x1111111111111111111111111111111111111111';
    const fromToken = '0x2222222222222222222222222222222222222222';
    const toToken = '0x3333333333333333333333333333333333333333';
    const callTarget = '0x4444444444444444444444444444444444444444';
    const approvalSpender = '0x5555555555555555555555555555555555555555';
    const selector = '0xabcdef12';
    const mockDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'lifi-route-canary-required-live-api-base-')
    );
    const { requestsPath } = writeNoContactAxiosMock(
      mockDir,
      'LI.FI should not be contacted for custom required-live API base'
    );

    const { result, summary } = await runCanary({
      AJNA_AGENT_LIFI_CANARY_MOCK_REQUESTS_PATH: requestsPath,
      AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE: 'true',
      AJNA_AGENT_LIFI_CANARY_API_BASE_URL: 'https://local.lifi.test/v1',
      AJNA_AGENT_LIFI_CANARY_CHAIN_ID: '8453',
      AJNA_AGENT_LIFI_CANARY_TAKER_ADDRESS: takerAddress,
      AJNA_AGENT_LIFI_CANARY_ALLOW_EXCHANGES: 'uniswap',
      AJNA_AGENT_LIFI_CANARY_CALL_TARGET_ALLOWLIST: callTarget,
      AJNA_AGENT_LIFI_CANARY_APPROVAL_SPENDER_ALLOWLIST: approvalSpender,
      AJNA_AGENT_LIFI_CANARY_SELECTOR_ALLOWLIST_JSON: JSON.stringify({
        [callTarget]: [selector],
      }),
      AJNA_AGENT_LIFI_CANARY_ROUTES_JSON: JSON.stringify([
        {
          label: 'custom-api-base',
          fromToken,
          toToken,
          fromAmount: '1000000',
        },
      ]),
    });

    expect(result.status, result.stderr).to.equal(1);
    expect(summary, result.stderr).to.not.equal(undefined);
    expect(summary.status).to.equal('skipped');
    expect(summary.requireLive).to.equal(true);
    expect(summary.checks[0].error).to.include(
      'requires the default LI.FI API base URL'
    );
    expect(fs.existsSync(requestsPath)).to.equal(false);
  });

  it('fails closed before contacting LI.FI when required-live config is canary mode', async () => {
    const takerAddress = '0x1111111111111111111111111111111111111111';
    const callTarget = '0x4444444444444444444444444444444444444444';
    const approvalSpender = '0x5555555555555555555555555555555555555555';
    const selector = '0xabcdef12';
    const mockDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'lifi-route-canary-required-live-canary-config-')
    );
    const { requestsPath } = writeNoContactAxiosMock(
      mockDir,
      'LI.FI should not be contacted for canary-mode required-live config'
    );
    const configPath = writeKeeperConfig({
      dir: mockDir,
      mode: 'canary',
      takerAddress,
      callTarget,
      approvalSpender,
      selector,
    });

    const { result, summary } = await runCanary(
      {
        AJNA_AGENT_LIFI_CANARY_MOCK_REQUESTS_PATH: requestsPath,
        AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE: 'true',
      },
      ['--config', configPath]
    );

    expect(result.status, result.stderr).to.equal(1);
    expect(summary, result.stderr).to.not.equal(undefined);
    expect(summary.status).to.equal('skipped');
    expect(summary.checks[0].error).to.include(
      'requires config.dex.lifi.mode to be production'
    );
    expect(fs.existsSync(requestsPath)).to.equal(false);
  });

  it('fails closed before contacting LI.FI when required-live policy is overridden from env', async () => {
    const takerAddress = '0x1111111111111111111111111111111111111111';
    const overrideTakerAddress = '0x9999999999999999999999999999999999999999';
    const callTarget = '0x4444444444444444444444444444444444444444';
    const approvalSpender = '0x5555555555555555555555555555555555555555';
    const selector = '0xabcdef12';
    const mockDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'lifi-route-canary-required-live-policy-override-')
    );
    const { requestsPath } = writeNoContactAxiosMock(
      mockDir,
      'LI.FI should not be contacted for required-live policy overrides'
    );
    const configPath = writeKeeperConfig({
      dir: mockDir,
      mode: 'production',
      takerAddress,
      callTarget,
      approvalSpender,
      selector,
    });

    const { result, summary } = await runCanary(
      {
        AJNA_AGENT_LIFI_CANARY_MOCK_REQUESTS_PATH: requestsPath,
        AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE: 'true',
        AJNA_AGENT_LIFI_CANARY_TAKER_ADDRESS: overrideTakerAddress,
      },
      ['--config', configPath]
    );

    expect(result.status, result.stderr).to.equal(1);
    expect(summary, result.stderr).to.not.equal(undefined);
    expect(summary.status).to.equal('skipped');
    expect(summary.checks[0].error).to.include(
      'does not allow LI.FI policy env overrides'
    );
    expect(summary.checks[0].error).to.include(
      'AJNA_AGENT_LIFI_CANARY_TAKER_ADDRESS'
    );
    expect(fs.existsSync(requestsPath)).to.equal(false);
  });

  it('fails closed before contacting LI.FI when required-live broad filter mode is set from env', async () => {
    const takerAddress = '0x1111111111111111111111111111111111111111';
    const callTarget = '0x4444444444444444444444444444444444444444';
    const approvalSpender = '0x5555555555555555555555555555555555555555';
    const selector = '0xabcdef12';
    const mockDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'lifi-route-canary-required-live-broad-filter-')
    );
    const { requestsPath } = writeNoContactAxiosMock(
      mockDir,
      'LI.FI should not be contacted for required-live broad filter override'
    );
    const configPath = writeKeeperConfig({
      dir: mockDir,
      mode: 'production',
      takerAddress,
      callTarget,
      approvalSpender,
      selector,
    });

    const { result, summary } = await runCanary(
      {
        AJNA_AGENT_LIFI_CANARY_MOCK_REQUESTS_PATH: requestsPath,
        AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE: 'true',
        AJNA_AGENT_LIFI_CANARY_ALLOW_BROAD_EXCHANGE_FILTERS: 'true',
      },
      ['--config', configPath]
    );

    expect(result.status, result.stderr).to.equal(1);
    expect(summary, result.stderr).to.not.equal(undefined);
    expect(summary.status).to.equal('skipped');
    expect(summary.checks[0].error).to.include(
      'does not allow LI.FI policy env overrides'
    );
    expect(summary.checks[0].error).to.include(
      'AJNA_AGENT_LIFI_CANARY_ALLOW_BROAD_EXCHANGE_FILTERS'
    );
    expect(fs.existsSync(requestsPath)).to.equal(false);
  });

  it('fails closed before contacting LI.FI when required-live config uses broad exchange filters', async () => {
    const takerAddress = '0x1111111111111111111111111111111111111111';
    const callTarget = '0x4444444444444444444444444444444444444444';
    const approvalSpender = '0x5555555555555555555555555555555555555555';
    const selector = '0xabcdef12';
    const mockDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'lifi-route-canary-required-live-broad-config-')
    );
    const { requestsPath } = writeNoContactAxiosMock(
      mockDir,
      'LI.FI should not be contacted for required-live broad config filters'
    );
    const configPath = writeKeeperConfig({
      dir: mockDir,
      mode: 'production',
      takerAddress,
      callTarget,
      approvalSpender,
      selector,
      allowExchanges: ['all'],
      allowBroadExchangeFilters: true,
    });

    const { result, summary } = await runCanary(
      {
        AJNA_AGENT_LIFI_CANARY_MOCK_REQUESTS_PATH: requestsPath,
        AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE: 'true',
      },
      ['--config', configPath]
    );

    expect(result.status, result.stderr).to.equal(1);
    expect(summary, result.stderr).to.not.equal(undefined);
    expect(summary.status).to.equal('skipped');
    expect(summary.checks[0].error).to.include(
      'requires concrete production LI.FI exchange filters'
    );
    expect(summary.checks[0].error).to.include(
      'allowBroadExchangeFilters is canary-only'
    );
    expect(fs.existsSync(requestsPath)).to.equal(false);
  });

  it('fails closed before contacting LI.FI when required-live API base is masked by env', async () => {
    const takerAddress = '0x1111111111111111111111111111111111111111';
    const callTarget = '0x4444444444444444444444444444444444444444';
    const approvalSpender = '0x5555555555555555555555555555555555555555';
    const selector = '0xabcdef12';
    const mockDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'lifi-route-canary-required-live-api-mask-')
    );
    const { requestsPath } = writeNoContactAxiosMock(
      mockDir,
      'LI.FI should not be contacted when env masks configured API base'
    );
    const configPath = writeKeeperConfig({
      dir: mockDir,
      mode: 'production',
      takerAddress,
      callTarget,
      approvalSpender,
      selector,
      apiBaseUrl: 'https://custom.lifi.test/v1',
    });

    const { result, summary } = await runCanary(
      {
        AJNA_AGENT_LIFI_CANARY_MOCK_REQUESTS_PATH: requestsPath,
        AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE: 'true',
        AJNA_AGENT_LIFI_CANARY_API_BASE_URL: 'https://li.quest/v1',
      },
      ['--config', configPath]
    );

    expect(result.status, result.stderr).to.equal(1);
    expect(summary, result.stderr).to.not.equal(undefined);
    expect(summary.status).to.equal('skipped');
    expect(summary.checks[0].error).to.include(
      'does not allow LI.FI policy env overrides'
    );
    expect(summary.checks[0].error).to.include(
      'AJNA_AGENT_LIFI_CANARY_API_BASE_URL'
    );
    expect(fs.existsSync(requestsPath)).to.equal(false);
  });

  it('fails closed before contacting LI.FI when required-live routes override the production taker', async () => {
    const takerAddress = '0x1111111111111111111111111111111111111111';
    const overrideTakerAddress = '0x9999999999999999999999999999999999999999';
    const fromToken = '0x2222222222222222222222222222222222222222';
    const toToken = '0x3333333333333333333333333333333333333333';
    const callTarget = '0x4444444444444444444444444444444444444444';
    const approvalSpender = '0x5555555555555555555555555555555555555555';
    const selector = '0xabcdef12';
    const mockDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'lifi-route-canary-required-live-route-taker-')
    );
    const { requestsPath } = writeNoContactAxiosMock(
      mockDir,
      'LI.FI should not be contacted for required-live route taker overrides'
    );
    const configPath = writeKeeperConfig({
      dir: mockDir,
      mode: 'production',
      takerAddress,
      callTarget,
      approvalSpender,
      selector,
    });

    const { result, summary } = await runCanary(
      {
        AJNA_AGENT_LIFI_CANARY_MOCK_REQUESTS_PATH: requestsPath,
        AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE: 'true',
        AJNA_AGENT_LIFI_CANARY_ROUTES_JSON: JSON.stringify([
          {
            label: 'wrong-taker',
            fromToken,
            toToken,
            fromAmount: '1000000',
            takerAddress: overrideTakerAddress,
          },
        ]),
      },
      ['--config', configPath]
    );

    expect(result.status, result.stderr).to.equal(1);
    expect(summary, result.stderr).to.not.equal(undefined);
    expect(summary.status).to.equal('skipped');
    expect(summary.checks[0].error).to.include(
      'does not allow route-level takerAddress overrides'
    );
    expect(summary.checks[0].error).to.include('wrong-taker');
    expect(fs.existsSync(requestsPath)).to.equal(false);
  });

  it('fails closed before contacting LI.FI when required-live config has incomplete chain policy', async () => {
    const takerAddress = '0x1111111111111111111111111111111111111111';
    const callTarget = '0x4444444444444444444444444444444444444444';
    const approvalSpender = '0x5555555555555555555555555555555555555555';
    const selector = '0xabcdef12';
    const mockDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'lifi-route-canary-incomplete-chain-policy-')
    );
    const { requestsPath } = writeNoContactAxiosMock(
      mockDir,
      'LI.FI should not be contacted for incomplete required-live chain policy'
    );
    const configPath = writeKeeperConfig({
      dir: mockDir,
      mode: 'production',
      takerAddress,
      callTarget,
      approvalSpender,
      selector,
      chainId: 8453,
      incompleteExtraChainId: 1,
    });

    const { result, summary } = await runCanary(
      {
        AJNA_AGENT_LIFI_CANARY_MOCK_REQUESTS_PATH: requestsPath,
        AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE: 'true',
        AJNA_AGENT_LIFI_CANARY_CHAIN_ID: '8453',
      },
      ['--config', configPath]
    );

    expect(result.status, result.stderr).to.equal(1);
    expect(summary, result.stderr).to.not.equal(undefined);
    expect(summary.status).to.equal('skipped');
    expect(summary.checks[0].error).to.include(
      'requires complete production LI.FI policy for every configured chain'
    );
    expect(summary.checks[0].error).to.include(
      'config.dex.lifi.approvalSpenderAllowlist.1'
    );
    expect(fs.existsSync(requestsPath)).to.equal(false);
  });

  it('reports a skipped summary before contacting LI.FI when required-live config omits selector policy', async () => {
    const takerAddress = '0x1111111111111111111111111111111111111111';
    const callTarget = '0x4444444444444444444444444444444444444444';
    const approvalSpender = '0x5555555555555555555555555555555555555555';
    const selector = '0xabcdef12';
    const mockDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'lifi-route-canary-missing-selector-policy-')
    );
    const { requestsPath } = writeNoContactAxiosMock(
      mockDir,
      'LI.FI should not be contacted for missing required-live selector policy'
    );
    const configPath = writeKeeperConfig({
      dir: mockDir,
      mode: 'production',
      takerAddress,
      callTarget,
      approvalSpender,
      selector,
      chainId: 8453,
    });
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    delete config.dex.lifi.selectorAllowlist;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    const { result, summary } = await runCanary(
      {
        AJNA_AGENT_LIFI_CANARY_MOCK_REQUESTS_PATH: requestsPath,
        AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE: 'true',
        AJNA_AGENT_LIFI_CANARY_CHAIN_ID: '8453',
      },
      ['--config', configPath]
    );

    expect(result.error, result.error?.message).to.equal(undefined);
    expect(result.status, result.stderr).to.equal(1);
    expect(summary, result.stderr).to.not.equal(undefined);
    expect(summary.status).to.equal('skipped');
    expect(summary.checks[0].error).to.include(
      'config.dex.lifi.selectorAllowlist is required'
    );
    expect(fs.existsSync(requestsPath)).to.equal(false);
  });

  it('infers the required-live canary chain from a single-chain production config', async () => {
    const chainId = '43114';
    const takerAddress = '0x1111111111111111111111111111111111111111';
    const fromToken = '0x2222222222222222222222222222222222222222';
    const toToken = '0x3333333333333333333333333333333333333333';
    const callTarget = '0x4444444444444444444444444444444444444444';
    const approvalSpender = '0x5555555555555555555555555555555555555555';
    const selector = '0xabcdef12';
    const fromAmount = '1000000';
    const mockDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'lifi-route-canary-infer-chain-')
    );
    const { requestsPath } = writeNoContactAxiosMock(
      mockDir,
      'LI.FI should be mocked in-process'
    );
    const configPath = writeKeeperConfig({
      dir: mockDir,
      mode: 'production',
      takerAddress,
      callTarget,
      approvalSpender,
      selector,
      chainId: Number(chainId),
      allowExchanges: ['traderjoe'],
    });

    const { result, summary } = await runCanary(
      {
        AJNA_AGENT_LIFI_CANARY_MOCK_REQUESTS_PATH: requestsPath,
        AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE: 'true',
        AJNA_AGENT_LIFI_CANARY_ROUTES_JSON: JSON.stringify([
          {
            label: 'avax-fixture',
            fromToken,
            toToken,
            fromAmount,
          },
        ]),
      },
      ['--config', configPath]
    );

    expect(result.status, result.stderr || result.stdout).to.equal(0);
    expect(summary, result.stderr).to.not.equal(undefined);
    expect(summary.status).to.equal('passed');
    expect(summary.chainId).to.equal(Number(chainId));
    expect(summary.checks[1]).to.deep.include({
      success: true,
      chainId: Number(chainId),
      tool: 'traderjoe',
      transactionTarget: callTarget,
      approvalSpender,
      selector,
    });
    const requestedUrls = fs
      .readFileSync(requestsPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).url as string);
    const quoteRequest = requestedUrls.find((url) => url.includes('/quote?'));
    expect(quoteRequest).to.not.equal(undefined);
    const quoteUrl = new URL(quoteRequest!);
    expect(quoteUrl.searchParams.get('fromChain')).to.equal(chainId);
    expect(quoteUrl.searchParams.get('toChain')).to.equal(chainId);
  });

  it('fails closed before contacting LI.FI when production config has multiple chains and no target chain is selected', async () => {
    const takerAddress = '0x1111111111111111111111111111111111111111';
    const callTarget = '0x4444444444444444444444444444444444444444';
    const approvalSpender = '0x5555555555555555555555555555555555555555';
    const selector = '0xabcdef12';
    const mockDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'lifi-route-canary-multi-chain-')
    );
    const { requestsPath } = writeNoContactAxiosMock(
      mockDir,
      'LI.FI should not be contacted when target chain is ambiguous'
    );
    const configPath = writeKeeperConfig({
      dir: mockDir,
      mode: 'production',
      takerAddress,
      callTarget,
      approvalSpender,
      selector,
      chainId: 8453,
      extraChainId: 43114,
    });

    const { result, summary } = await runCanary(
      {
        AJNA_AGENT_LIFI_CANARY_MOCK_REQUESTS_PATH: requestsPath,
        AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE: 'true',
      },
      ['--config', configPath]
    );

    expect(result.error, result.error?.message).to.equal(undefined);
    expect(result.status).to.equal(1);
    expect(`${result.stderr}${result.stdout}`).to.include(
      'AJNA_AGENT_LIFI_CANARY_CHAIN_ID is required'
    );
    expect(summary).to.equal(undefined);
    expect(fs.existsSync(requestsPath)).to.equal(false);
  });

  it('rejects non-positive route amounts before contacting LI.FI', async () => {
    const takerAddress = '0x1111111111111111111111111111111111111111';
    const fromToken = '0x2222222222222222222222222222222222222222';
    const toToken = '0x3333333333333333333333333333333333333333';
    const callTarget = '0x4444444444444444444444444444444444444444';
    const approvalSpender = '0x5555555555555555555555555555555555555555';
    const selector = '0xabcdef12';
    const mockDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'lifi-route-canary-no-call-')
    );
    const { requestsPath } = writeNoContactAxiosMock(
      mockDir,
      'LI.FI should not be contacted for invalid local canary input'
    );

    const { result, summary } = await runCanary({
      AJNA_AGENT_LIFI_CANARY_MOCK_REQUESTS_PATH: requestsPath,
      AJNA_AGENT_LIFI_CANARY_API_BASE_URL: 'https://local.lifi.test/v1',
      AJNA_AGENT_LIFI_CANARY_CHAIN_ID: '8453',
      AJNA_AGENT_LIFI_CANARY_TAKER_ADDRESS: takerAddress,
      AJNA_AGENT_LIFI_CANARY_ALLOW_EXCHANGES: 'uniswap',
      AJNA_AGENT_LIFI_CANARY_CALL_TARGET_ALLOWLIST: callTarget,
      AJNA_AGENT_LIFI_CANARY_APPROVAL_SPENDER_ALLOWLIST: approvalSpender,
      AJNA_AGENT_LIFI_CANARY_SELECTOR_ALLOWLIST_JSON: JSON.stringify({
        [callTarget]: [selector],
      }),
      AJNA_AGENT_LIFI_CANARY_ROUTES_JSON: JSON.stringify([
        {
          label: 'zero-amount',
          fromToken,
          toToken,
          fromAmount: '0',
        },
      ]),
    });

    expect(result.status).to.equal(1);
    expect(summary).to.equal(undefined);
    expect(fs.existsSync(requestsPath)).to.equal(false);
  });

  it('rejects empty selector allowlists before contacting LI.FI', async () => {
    const takerAddress = '0x1111111111111111111111111111111111111111';
    const fromToken = '0x2222222222222222222222222222222222222222';
    const toToken = '0x3333333333333333333333333333333333333333';
    const callTarget = '0x4444444444444444444444444444444444444444';
    const approvalSpender = '0x5555555555555555555555555555555555555555';
    const mockDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'lifi-route-canary-empty-selector-')
    );
    const { requestsPath } = writeNoContactAxiosMock(
      mockDir,
      'LI.FI should not be contacted for invalid selector policy'
    );

    const { result, summary } = await runCanary({
      AJNA_AGENT_LIFI_CANARY_MOCK_REQUESTS_PATH: requestsPath,
      AJNA_AGENT_LIFI_CANARY_API_BASE_URL: 'https://local.lifi.test/v1',
      AJNA_AGENT_LIFI_CANARY_CHAIN_ID: '8453',
      AJNA_AGENT_LIFI_CANARY_TAKER_ADDRESS: takerAddress,
      AJNA_AGENT_LIFI_CANARY_ALLOW_EXCHANGES: 'uniswap',
      AJNA_AGENT_LIFI_CANARY_CALL_TARGET_ALLOWLIST: callTarget,
      AJNA_AGENT_LIFI_CANARY_APPROVAL_SPENDER_ALLOWLIST: approvalSpender,
      AJNA_AGENT_LIFI_CANARY_SELECTOR_ALLOWLIST_JSON: JSON.stringify({
        [callTarget]: [],
      }),
      AJNA_AGENT_LIFI_CANARY_ROUTES_JSON: JSON.stringify([
        {
          label: 'empty-selector-policy',
          fromToken,
          toToken,
          fromAmount: '1000000',
        },
      ]),
    });

    expect(result.status).to.equal(1);
    expect(summary).to.equal(undefined);
    expect(fs.existsSync(requestsPath)).to.equal(false);
  });

  it('rejects duplicate address allowlists before contacting LI.FI', async () => {
    const takerAddress = '0x1111111111111111111111111111111111111111';
    const fromToken = '0x2222222222222222222222222222222222222222';
    const toToken = '0x3333333333333333333333333333333333333333';
    const callTarget = '0x4444444444444444444444444444444444444444';
    const approvalSpender = '0x5555555555555555555555555555555555555555';
    const selector = '0xabcdef12';
    const mockDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'lifi-route-canary-duplicate-address-')
    );
    const { requestsPath } = writeNoContactAxiosMock(
      mockDir,
      'LI.FI should not be contacted for duplicate address policy'
    );

    const { result, summary } = await runCanary({
      AJNA_AGENT_LIFI_CANARY_MOCK_REQUESTS_PATH: requestsPath,
      AJNA_AGENT_LIFI_CANARY_API_BASE_URL: 'https://local.lifi.test/v1',
      AJNA_AGENT_LIFI_CANARY_CHAIN_ID: '8453',
      AJNA_AGENT_LIFI_CANARY_TAKER_ADDRESS: takerAddress,
      AJNA_AGENT_LIFI_CANARY_ALLOW_EXCHANGES: 'uniswap',
      AJNA_AGENT_LIFI_CANARY_CALL_TARGET_ALLOWLIST: `${callTarget},${callTarget}`,
      AJNA_AGENT_LIFI_CANARY_APPROVAL_SPENDER_ALLOWLIST: approvalSpender,
      AJNA_AGENT_LIFI_CANARY_SELECTOR_ALLOWLIST_JSON: JSON.stringify({
        [callTarget]: [selector],
      }),
      AJNA_AGENT_LIFI_CANARY_ROUTES_JSON: JSON.stringify([
        {
          label: 'duplicate-address-policy',
          fromToken,
          toToken,
          fromAmount: '1000000',
        },
      ]),
    });

    expect(result.status).to.equal(1);
    expect(summary).to.equal(undefined);
    expect(fs.existsSync(requestsPath)).to.equal(false);
  });

  it('rejects selector policies that miss a call target before contacting LI.FI', async () => {
    const takerAddress = '0x1111111111111111111111111111111111111111';
    const fromToken = '0x2222222222222222222222222222222222222222';
    const toToken = '0x3333333333333333333333333333333333333333';
    const callTargetA = '0x4444444444444444444444444444444444444444';
    const callTargetB = '0x6666666666666666666666666666666666666666';
    const approvalSpender = '0x5555555555555555555555555555555555555555';
    const selector = '0xabcdef12';
    const mockDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'lifi-route-canary-missing-selector-target-')
    );
    const { requestsPath } = writeNoContactAxiosMock(
      mockDir,
      'LI.FI should not be contacted for mismatched selector policy'
    );

    const { result, summary } = await runCanary({
      AJNA_AGENT_LIFI_CANARY_MOCK_REQUESTS_PATH: requestsPath,
      AJNA_AGENT_LIFI_CANARY_API_BASE_URL: 'https://local.lifi.test/v1',
      AJNA_AGENT_LIFI_CANARY_CHAIN_ID: '8453',
      AJNA_AGENT_LIFI_CANARY_TAKER_ADDRESS: takerAddress,
      AJNA_AGENT_LIFI_CANARY_ALLOW_EXCHANGES: 'uniswap',
      AJNA_AGENT_LIFI_CANARY_CALL_TARGET_ALLOWLIST: `${callTargetA},${callTargetB}`,
      AJNA_AGENT_LIFI_CANARY_APPROVAL_SPENDER_ALLOWLIST: approvalSpender,
      AJNA_AGENT_LIFI_CANARY_SELECTOR_ALLOWLIST_JSON: JSON.stringify({
        [callTargetA]: [selector],
      }),
      AJNA_AGENT_LIFI_CANARY_ROUTES_JSON: JSON.stringify([
        {
          label: 'missing-selector-target',
          fromToken,
          toToken,
          fromAmount: '1000000',
        },
      ]),
    });

    expect(result.status).to.equal(1);
    expect(summary).to.equal(undefined);
    expect(fs.existsSync(requestsPath)).to.equal(false);
  });

  it('validates an allowlisted same-chain quote through the no-broadcast LI.FI canary command', async () => {
    const chainId = '8453';
    const takerAddress = '0x1111111111111111111111111111111111111111';
    const fromToken = '0x2222222222222222222222222222222222222222';
    const toToken = '0x3333333333333333333333333333333333333333';
    const callTarget = '0x4444444444444444444444444444444444444444';
    const approvalSpender = '0x5555555555555555555555555555555555555555';
    const selector = '0xabcdef12';
    const fromAmount = '1000000';
    const mockDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'lifi-route-canary-mock-')
    );
    const { requestsPath } = writeNoContactAxiosMock(
      mockDir,
      'LI.FI should be mocked in-process'
    );

    const { result, summary } = await runCanary({
      AJNA_AGENT_LIFI_CANARY_MOCK_REQUESTS_PATH: requestsPath,
      AJNA_AGENT_LIFI_CANARY_API_BASE_URL: 'https://local.lifi.test/v1',
      AJNA_AGENT_LIFI_CANARY_CHAIN_ID: chainId,
      AJNA_AGENT_LIFI_CANARY_TAKER_ADDRESS: takerAddress,
      AJNA_AGENT_LIFI_CANARY_ALLOW_EXCHANGES: 'uniswap',
      AJNA_AGENT_LIFI_CANARY_CALL_TARGET_ALLOWLIST: callTarget,
      AJNA_AGENT_LIFI_CANARY_APPROVAL_SPENDER_ALLOWLIST: approvalSpender,
      AJNA_AGENT_LIFI_CANARY_SELECTOR_ALLOWLIST_JSON: JSON.stringify({
        [callTarget]: [selector],
      }),
      AJNA_AGENT_LIFI_CANARY_ROUTES_JSON: JSON.stringify([
        {
          label: 'local-fixture',
          fromToken,
          toToken,
          fromAmount,
        },
      ]),
    });

    expect(result.status, result.stderr || result.stdout).to.equal(0);
    expect(summary, result.stderr).to.not.equal(undefined);
    expect(summary.status).to.equal('passed');
    expect(summary.failureCount).to.equal(0);
    expect(summary.checks.map((check: any) => check.label)).to.deep.equal([
      'lifi-tools-filter-validation',
      'local-fixture',
    ]);
    const quoteCheck = summary.checks[1];
    expect(quoteCheck).to.deep.include({
      success: true,
      source: 'lifi-quote',
      chainId: Number(chainId),
      fromToken,
      toToken,
      fromAmount,
      toAmountRaw: '1250000',
      toAmountMinRaw: '1200000',
      tool: 'uniswap',
      transactionTarget: callTarget,
      approvalSpender,
      selector,
    });
    expect(summary.observedSelectorAllowlist).to.deep.equal({
      [chainId]: {
        [callTarget]: [selector],
      },
    });
    expect(summary.observedSelectorsByTool).to.deep.equal({
      [chainId]: {
        uniswap: {
          [callTarget]: [selector],
        },
      },
    });

    const requestedUrls = fs
      .readFileSync(requestsPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).url as string);
    const quoteRequest = requestedUrls.find((url) => url.includes('/quote?'));
    expect(quoteRequest).to.not.equal(undefined);
    const quoteUrl = new URL(quoteRequest!);
    expect(quoteUrl.searchParams.get('fromChain')).to.equal(chainId);
    expect(quoteUrl.searchParams.get('toChain')).to.equal(chainId);
    expect(quoteUrl.searchParams.get('fromToken')).to.equal(fromToken);
    expect(quoteUrl.searchParams.get('toToken')).to.equal(toToken);
    expect(quoteUrl.searchParams.get('fromAmount')).to.equal(fromAmount);
    expect(quoteUrl.searchParams.get('fromAddress')).to.equal(takerAddress);
    expect(quoteUrl.searchParams.get('toAddress')).to.equal(takerAddress);
    expect(quoteUrl.searchParams.get('skipSimulation')).to.equal('true');
    expect(quoteUrl.searchParams.get('allowDestinationCall')).to.equal('false');
    expect(quoteUrl.searchParams.get('denyBridges')).to.equal('all');
    expect(quoteUrl.searchParams.get('allowExchanges')).to.equal('uniswap');
  });

  it('allows explicit broad exchange filters only on the no-broadcast canary path', async () => {
    const chainId = '8453';
    const takerAddress = '0x1111111111111111111111111111111111111111';
    const fromToken = '0x2222222222222222222222222222222222222222';
    const toToken = '0x3333333333333333333333333333333333333333';
    const callTarget = '0x4444444444444444444444444444444444444444';
    const approvalSpender = '0x5555555555555555555555555555555555555555';
    const selector = '0xabcdef12';
    const fromAmount = '1000000';
    const mockDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'lifi-route-canary-broad-filter-')
    );
    const { requestsPath } = writeNoContactAxiosMock(
      mockDir,
      'LI.FI should be mocked in-process'
    );

    const { result, summary } = await runCanary({
      AJNA_AGENT_LIFI_CANARY_MOCK_REQUESTS_PATH: requestsPath,
      AJNA_AGENT_LIFI_CANARY_API_BASE_URL: 'https://local.lifi.test/v1',
      AJNA_AGENT_LIFI_CANARY_CHAIN_ID: chainId,
      AJNA_AGENT_LIFI_CANARY_TAKER_ADDRESS: takerAddress,
      AJNA_AGENT_LIFI_CANARY_ALLOW_EXCHANGES: 'all',
      AJNA_AGENT_LIFI_CANARY_ALLOW_BROAD_EXCHANGE_FILTERS: 'true',
      AJNA_AGENT_LIFI_CANARY_CALL_TARGET_ALLOWLIST: callTarget,
      AJNA_AGENT_LIFI_CANARY_APPROVAL_SPENDER_ALLOWLIST: approvalSpender,
      AJNA_AGENT_LIFI_CANARY_SELECTOR_ALLOWLIST_JSON: JSON.stringify({
        [callTarget]: [selector],
      }),
      AJNA_AGENT_LIFI_CANARY_ROUTES_JSON: JSON.stringify([
        {
          label: 'broad-filter-local-fixture',
          fromToken,
          toToken,
          fromAmount,
        },
      ]),
    });

    expect(result.status, result.stderr || result.stdout).to.equal(0);
    expect(summary, result.stderr).to.not.equal(undefined);
    expect(summary.status).to.equal('passed');
    expect(summary.failureCount).to.equal(0);
    expect(summary.checks[1]).to.deep.include({
      success: true,
      source: 'lifi-quote',
      tool: 'uniswap',
      transactionTarget: callTarget,
      approvalSpender,
      selector,
    });

    const requestedUrls = fs
      .readFileSync(requestsPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).url as string);
    const quoteRequest = requestedUrls.find((url) => url.includes('/quote?'));
    expect(quoteRequest).to.not.equal(undefined);
    const quoteUrl = new URL(quoteRequest!);
    expect(quoteUrl.searchParams.get('allowExchanges')).to.equal('all');
    expect(quoteUrl.searchParams.get('denyBridges')).to.equal('all');
    expect(quoteUrl.searchParams.get('skipSimulation')).to.equal('true');
  });
});
