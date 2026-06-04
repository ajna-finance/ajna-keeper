import { expect } from 'chai';
import {
  buildLifiAllowlistReconciliationPlan,
  getLifiProductionAllowlists,
  getLifiProductionDeploymentGateMessages,
  hasProductionLifiConfig,
  validateDetectedChainLifiProductionConfig,
} from '../../scripts/deployment/lifi-factory-deployment';
import { KeeperConfig, LifiDexConfig } from '../../src/config';

const BASE_CHAIN_ID = 8453;
const CALL_TARGET = '0x1111111111111111111111111111111111111111';
const APPROVAL_SPENDER = '0x2222222222222222222222222222222222222222';
const SELECTOR = '0xabcdef12';

function keeperConfigWithLifi(lifi: LifiDexConfig): KeeperConfig {
  return {
    network: {
      rpcUrl: 'http://localhost:8545',
      subgraph: { url: 'http://localhost:8000' },
    },
    signer: { keystore: '/tmp/keeper.json' },
    runtime: { logLevel: 'info', delayBetweenRuns: 60 },
    ajna: {
      erc20PoolFactory: '0x3333333333333333333333333333333333333333',
      erc721PoolFactory: '0x4444444444444444444444444444444444444444',
      poolUtils: '0x5555555555555555555555555555555555555555',
      positionManager: '0x6666666666666666666666666666666666666666',
      ajnaToken: '0x7777777777777777777777777777777777777777',
      grantFund: '',
      burnWrapper: '',
      lenderHelper: '',
    },
    manual: { pools: [] },
    dex: { lifi },
  };
}

function productionConfig(
  overrides: Partial<
    Extract<NonNullable<KeeperConfig['dex']>['lifi'], { mode: 'production' }>
  > = {}
): KeeperConfig {
  return keeperConfigWithLifi({
    mode: 'production',
    allowExchanges: ['Uniswap'],
    callTargetAllowlist: { [BASE_CHAIN_ID]: [CALL_TARGET] },
    approvalSpenderAllowlist: { [BASE_CHAIN_ID]: [APPROVAL_SPENDER] },
    selectorAllowlist: { [BASE_CHAIN_ID]: { [CALL_TARGET]: [SELECTOR] } },
    ...overrides,
  });
}

describe('LI.FI factory deployment script support', () => {
  it('enables LI.FI taker deployment only for production dex.lifi config', () => {
    expect(hasProductionLifiConfig(productionConfig())).to.equal(true);
    expect(
      hasProductionLifiConfig(
        keeperConfigWithLifi({
          mode: 'canary',
          allowExchanges: ['uniswap'],
        })
      )
    ).to.equal(false);
    expect(
      hasProductionLifiConfig({ ...productionConfig(), dex: {} })
    ).to.equal(false);
  });

  it('resolves reviewed production allowlists for the detected chain', () => {
    const allowlists = getLifiProductionAllowlists(
      productionConfig(),
      BASE_CHAIN_ID
    );

    expect(allowlists.callTargets).to.deep.equal([CALL_TARGET]);
    expect(allowlists.approvalSpenders).to.deep.equal([APPROVAL_SPENDER]);
    expect(allowlists.selectorAllowlist).to.deep.equal({
      [CALL_TARGET]: [SELECTOR],
    });
  });

  it('validates target-chain LI.FI production allowlists before wallet/deploy actions can use them', () => {
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => {
      logs.push(args.join(' '));
    };
    try {
      validateDetectedChainLifiProductionConfig(productionConfig(), {
        chainId: BASE_CHAIN_ID,
        name: 'Base',
      });
    } finally {
      console.log = originalLog;
    }

    expect(logs.join('\n')).to.include(
      'LI.FI production allowlists validated for Base (8453)'
    );
  });

  it('fails closed when production config does not cover the detected chain', () => {
    expect(() =>
      validateDetectedChainLifiProductionConfig(productionConfig(), {
        chainId: 1,
        name: 'Ethereum Mainnet',
      })
    ).to.throw('LI.FI.callTargetAllowlist.1 is required');
  });

  it('plans desired LI.FI allowlist additions before stale removals', () => {
    const targetA = '0x1111111111111111111111111111111111111111';
    const targetB = '0x2222222222222222222222222222222222222222';
    const spenderA = '0x3333333333333333333333333333333333333333';
    const spenderB = '0x4444444444444444444444444444444444444444';

    const plan = buildLifiAllowlistReconciliationPlan({
      desired: {
        callTargets: [targetB],
        approvalSpenders: [spenderB],
        selectorAllowlist: {
          [targetB]: ['0xbbbbbbbb'],
        },
      },
      currentCallTargets: [targetA],
      currentApprovalSpenders: [spenderA],
      currentSelectorsByTarget: {
        [targetA]: ['0xaaaaaaaa'],
      },
    });

    expect(plan.callTargetsToEnable).to.deep.equal([targetB]);
    expect(plan.approvalSpendersToEnable).to.deep.equal([spenderB]);
    expect(plan.selectorsToEnable).to.deep.equal([
      { target: targetB, selector: '0xbbbbbbbb' },
    ]);
    expect(plan.selectorsToDisable).to.deep.equal([
      { target: targetA, selector: '0xaaaaaaaa' },
    ]);
    expect(plan.callTargetsToDisable).to.deep.equal([targetA]);
    expect(plan.approvalSpendersToDisable).to.deep.equal([spenderA]);
  });

  it('does not silently truncate configured LI.FI selectors during deployment', () => {
    expect(() =>
      getLifiProductionAllowlists(
        productionConfig({
          selectorAllowlist: {
            [BASE_CHAIN_ID]: { [CALL_TARGET]: ['0xabcdef1234'] },
          },
        }),
        BASE_CHAIN_ID
      )
    ).to.throw('LI.FI.selectorAllowlist.8453 entry is invalid: 0xabcdef1234');
  });

  it('prints LI.FI production canary gates before suggesting live startup', () => {
    expect(
      getLifiProductionDeploymentGateMessages('base-config.ts')
    ).to.deep.equal([
      'Run the LI.FI route-shape gate: AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE=true npm run lifi-route-canary -- --config base-config.ts',
      'Run the LI.FI callback-path fork gate: AJNA_AGENT_LIFI_FORK_CANARY_CONFIG=base-config.ts npm run lifi-fork-execution-canary',
      'For non-Base LI.FI production support, run an equivalent reviewed chain-specific fork canary before live use',
      'After both LI.FI gates pass, test startup with: yarn start --config base-config.ts',
    ]);
  });
});
