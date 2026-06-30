import { expect } from 'chai';
import { validateAutoDiscoverConfig } from '../../src/config';
import { baseAutoDiscoverConfig as baseConfig } from './auto-discover-validation-helpers';

// P6 auto-kick config: discovery.kick is promoted from a bare boolean to an
// AutoDiscoverKickPolicy. Validation enforces the Option-1 invariants — kick
// requires take (only auto-kick pools you can take), a per-pool bond cap, an
// enabled discovery.defaults.kick, and priceFactor < 1 (reward margin).
describe('auto-discover kick validation', () => {
  const validKick = () => {
    const config = baseConfig();
    config.discovery!.kick = { enabled: true, maxBondExposure: 100 };
    config.discovery!.defaults!.kick = {
      enabled: true,
      minDebt: 1,
      priceFactor: 0.9,
    };
    return config;
  };

  it('accepts a valid kick policy alongside take discovery', () => {
    expect(() => validateAutoDiscoverConfig(validKick())).to.not.throw();
  });

  it('treats kick { enabled: false } as off (no kick validation)', () => {
    const config = baseConfig();
    config.discovery!.kick = { enabled: false };
    // no discovery.defaults.kick, no bond cap — still valid because kick is off
    expect(() => validateAutoDiscoverConfig(config)).to.not.throw();
  });

  it('rejects kick discovery without take discovery (Option-1 coupling)', () => {
    const config = baseConfig();
    config.discovery!.take = false;
    config.discovery!.kick = { enabled: true, maxBondExposure: 100 };
    config.discovery!.defaults!.kick = {
      enabled: true,
      minDebt: 1,
      priceFactor: 0.9,
    };
    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'kick discovery requires take discovery'
    );
  });

  it('rejects a kick policy without a per-pool bond cap', () => {
    const config = baseConfig();
    config.discovery!.kick = { enabled: true };
    config.discovery!.defaults!.kick = {
      enabled: true,
      minDebt: 1,
      priceFactor: 0.9,
    };
    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'maxBondExposure (per-pool bond cap) is required'
    );
  });

  it('rejects kick discovery without an enabled discovery.defaults.kick', () => {
    const config = baseConfig();
    config.discovery!.kick = { enabled: true, maxBondExposure: 100 };
    // no defaults.kick
    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'enabled discovery.defaults.kick required'
    );
  });

  it('rejects discovery.defaults.kick with priceFactor >= 1 (no reward margin)', () => {
    const config = validKick();
    config.discovery!.defaults!.kick = {
      enabled: true,
      minDebt: 1,
      priceFactor: 1,
    };
    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'priceFactor must be less than 1'
    );
  });

  it('rejects a non-positive maxTotalBondExposure', () => {
    const config = validKick();
    config.discovery!.kick = {
      enabled: true,
      maxBondExposure: 100,
      maxTotalBondExposure: 0,
    };
    expect(() => validateAutoDiscoverConfig(config)).to.throw(
      'maxTotalBondExposure must be greater than 0'
    );
  });
});
