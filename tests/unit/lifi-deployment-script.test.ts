import fs from 'fs';
import path from 'path';
import { expect } from 'chai';

describe('LI.FI factory deployment script support', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../../scripts/deploy-factory-system.ts'),
    'utf8'
  );

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
    expect(source).to.include('callTargetAllowlist');
    expect(source).to.include('approvalSpenderAllowlist');
    expect(source).to.include('selectorAllowlist');
    expect(source).to.include('normalizeLifiAddressAllowlist');
    expect(source).to.include('normalizeLifiSelectorAllowlistRecord');
    expect(source).to.include('requireCallTargetCoverage: true');
    expect(source).to.include('setCallTarget');
    expect(source).to.include('setApprovalSpender');
    expect(source).to.include('setCallSelector');
    expect(source).to.include('getAllowedCallTargets');
    expect(source).to.include('getAllowedApprovalSpenders');
    expect(source).to.include('getAllowedCallSelectors');
    expect(source).to.include('assertExactSet');
  });

  it('reconciles stale LI.FI allowlist entries before final exact verification', () => {
    expect(source).to.include('currentCallTargets');
    expect(source).to.include('currentApprovalSpenders');
    expect(source).to.include('selectorTargets');
    expect(source).to.include('setCallTarget(target, false)');
    expect(source).to.include('setApprovalSpender(spender, false)');
    expect(source).to.include('setCallSelector(target, selector, false)');
    expect(source).to.include('Disabled stale LI.FI call target');
    expect(source).to.include('Disabled stale LI.FI approval spender');
    expect(source).to.include('Disabled stale LI.FI selector');
  });

  it('does not silently truncate configured LI.FI selectors during deployment', () => {
    expect(source).to.not.include('hexDataSlice(selector, 0, 4)');
  });
});
