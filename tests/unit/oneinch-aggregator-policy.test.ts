import { expect } from 'chai';
import {
  assertValidOneInchAggregatorDexConfig,
  hasOneInchAggregatorAllowlistPolicy,
  normalizeOneInchChainPolicy,
} from '../../src/config/oneinch-aggregator-policy';
import { OneInchDexConfig } from '../../src/config/schema';

const CALL_TARGET = '0x1111111111111111111111111111111111111111';
const SPENDER = '0x2222222222222222222222222222222222222222';
const SELECTOR = '0xabcdef12';

function policyConfig(
  overrides: Partial<OneInchDexConfig> = {}
): OneInchDexConfig {
  return {
    callTargetAllowlist: { 1: [CALL_TARGET] },
    approvalSpenderAllowlist: { 1: [SPENDER] },
    selectorAllowlist: { 1: { [CALL_TARGET]: [SELECTOR] } },
    ...overrides,
  };
}

describe('1inch aggregator policy', () => {
  describe('normalizeOneInchChainPolicy', () => {
    it('normalizes a complete per-chain allowlist policy', () => {
      const policy = normalizeOneInchChainPolicy({
        config: policyConfig(),
        fieldName: 'dex.oneInch',
        chainId: 1,
      });
      expect(policy.callTargets).to.deep.equal([CALL_TARGET.toLowerCase()]);
      expect(policy.approvalSpenders).to.deep.equal([SPENDER.toLowerCase()]);
      expect(policy.selectorAllowlist[CALL_TARGET.toLowerCase()]).to.deep.equal([
        SELECTOR,
      ]);
    });

    it('rejects a missing call-target allowlist for the chain', () => {
      expect(() =>
        normalizeOneInchChainPolicy({
          config: policyConfig({ callTargetAllowlist: { 1: [] } }),
          fieldName: 'dex.oneInch',
          chainId: 1,
        })
      ).to.throw('dex.oneInch.callTargetAllowlist[1] must be non-empty');
    });

    it('fails closed when a selector targets a non-allowlisted call target', () => {
      expect(() =>
        normalizeOneInchChainPolicy({
          config: policyConfig({
            selectorAllowlist: { 1: { [SPENDER]: [SELECTOR] } },
          }),
          fieldName: 'dex.oneInch',
          chainId: 1,
        })
      ).to.throw('is not present in callTargetAllowlist');
    });

    it('fails closed when a call target has no selector coverage', () => {
      const otherTarget = '0x3333333333333333333333333333333333333333';
      expect(() =>
        normalizeOneInchChainPolicy({
          config: policyConfig({
            callTargetAllowlist: { 1: [CALL_TARGET, otherTarget] },
          }),
          fieldName: 'dex.oneInch',
          chainId: 1,
        })
      ).to.throw('must include selectors for every configured call target');
    });
  });

  describe('hasOneInchAggregatorAllowlistPolicy', () => {
    it('is false for quote-only / undefined 1inch config', () => {
      expect(hasOneInchAggregatorAllowlistPolicy(undefined)).to.equal(false);
      expect(
        hasOneInchAggregatorAllowlistPolicy({ routers: { 1: CALL_TARGET } })
      ).to.equal(false);
    });

    it('is true once any allowlist policy field is present', () => {
      expect(hasOneInchAggregatorAllowlistPolicy(policyConfig())).to.equal(true);
    });
  });

  describe('assertValidOneInchAggregatorDexConfig', () => {
    it('rejects a production 1inch source without an allowlist policy', () => {
      expect(() =>
        assertValidOneInchAggregatorDexConfig({
          config: { routers: { 1: CALL_TARGET } },
          fieldName: 'KeeperConfig.dex.oneInch',
          requireProduction: true,
        })
      ).to.throw(
        'KeeperConfig.dex.oneInch requires callTargetAllowlist/approvalSpenderAllowlist/selectorAllowlist policy for live 1inch external takes'
      );
    });

    it('accepts a quote-only 1inch source without a policy when not production', () => {
      expect(() =>
        assertValidOneInchAggregatorDexConfig({
          config: { routers: { 1: CALL_TARGET } },
          fieldName: 'KeeperConfig.dex.oneInch',
          requireProduction: false,
        })
      ).to.not.throw();
    });

    it('accepts a complete production policy', () => {
      expect(() =>
        assertValidOneInchAggregatorDexConfig({
          config: policyConfig(),
          fieldName: 'KeeperConfig.dex.oneInch',
          chainId: 1,
          requireProduction: true,
        })
      ).to.not.throw();
    });

    it('rejects a present-but-incomplete policy fail-closed', () => {
      expect(() =>
        assertValidOneInchAggregatorDexConfig({
          config: { callTargetAllowlist: { 1: [CALL_TARGET] } },
          fieldName: 'KeeperConfig.dex.oneInch',
          requireProduction: true,
        })
      ).to.throw('approvalSpenderAllowlist[1] must be non-empty');
    });
  });
});
