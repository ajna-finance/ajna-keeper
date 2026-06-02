import fs from 'fs';
import path from 'path';
import { expect } from 'chai';
import { buildLifiAllowlistReconciliationPlan } from '../../scripts/deployment/lifi-factory-deployment';

describe('LI.FI factory deployment script support', () => {
  const deploySource = fs.readFileSync(
    path.join(__dirname, '../../scripts/deploy-factory-system.ts'),
    'utf8'
  );
  const lifiDeploymentSource = fs.readFileSync(
    path.join(__dirname, '../../scripts/deployment/lifi-factory-deployment.ts'),
    'utf8'
  );
  const source = `${deploySource}\n${lifiDeploymentSource}`;

  it('deploys and registers the canonical LI.FI taker for production dex.lifi config', () => {
    expect(source).to.include('deployLifiKeeperTaker');
    expect(source).to.include('LifiKeeperTaker.sol');
    expect(source).to.include('hasProductionLifiConfig');
    expect(source).to.include("config.dex?.lifi?.mode === 'production'");
    expect(source).to.include('LiquiditySource.LIFI');
    expect(source).to.include('addresses.lifiTaker');
    expect(source).to.include("Lifi: '");
  });

  it('keeps canary LI.FI config out of live deployment registration', () => {
    expect(source).to.include('Canary configs are');
    expect(source).to.not.include('if (config.dex?.lifi) {');
  });

  it('configures reviewed LI.FI allowlists from the same production config', () => {
    expect(source).to.include('configureLifiAllowlists');
    expect(source).to.include('normalizeLifiProductionChainPolicy');
    expect(source).to.include('policy.callTargets');
    expect(source).to.include('policy.approvalSpenders');
    expect(source).to.include('selectorAllowlist');
    expect(source).to.include('setCallTarget');
    expect(source).to.include('setApprovalSpender');
    expect(source).to.include('setCallSelector');
    expect(source).to.include('getAllowedCallTargets');
    expect(source).to.include('getAllowedApprovalSpenders');
    expect(source).to.include('getAllowedCallSelectors');
    expect(source).to.include('assertExactSet');
  });

  it('validates target-chain LI.FI production allowlists before wallet/deploy actions', () => {
    expect(source).to.include('validateDetectedChainLifiProductionConfig');
    expect(source).to.include(
      'getLifiProductionAllowlists(config, chainInfo.chainId)'
    );

    const validationIndex = deploySource.indexOf(
      'validateDetectedChainLifiProductionConfig(config, chainInfo);'
    );
    const walletIndex = deploySource.indexOf(
      "console.log('\\n🔐 Loading wallet from keystore...');"
    );

    expect(validationIndex).to.be.greaterThan(-1);
    expect(walletIndex).to.be.greaterThan(validationIndex);
  });

  it('reconciles stale LI.FI allowlist entries before final exact verification', () => {
    expect(source).to.include('currentCallTargets');
    expect(source).to.include('currentApprovalSpenders');
    expect(source).to.include('buildLifiAllowlistReconciliationPlan');
    expect(source).to.include('assertContainsSet');
    expect(source).to.include('setCallTarget(target, false)');
    expect(source).to.include('setApprovalSpender(spender, false)');
    expect(source).to.include('setCallSelector(target, selector, false)');
    expect(source).to.include('Disabled stale LI.FI call target');
    expect(source).to.include('Disabled stale LI.FI approval spender');
    expect(source).to.include('Disabled stale LI.FI selector');
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
    expect(source).to.not.include('hexDataSlice(selector, 0, 4)');
  });

  it('prints LI.FI production canary gates before suggesting live startup', () => {
    expect(source).to.include(
      'AJNA_AGENT_LIFI_CANARY_REQUIRE_LIVE=true npm run lifi-route-canary'
    );
    expect(source).to.include(
      'AJNA_AGENT_LIFI_FORK_CANARY_CONFIG=${configPath} npm run lifi-fork-execution-canary'
    );
    expect(source).to.include(
      'For non-Base LI.FI production support, run an equivalent reviewed chain-specific fork canary before live use'
    );
    expect(source).to.include(
      'After both LI.FI gates pass, test startup with: yarn start --config ${configPath}'
    );
  });
});
