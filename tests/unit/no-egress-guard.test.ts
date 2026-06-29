import { expect } from 'chai';

// The egress guard is the load-bearing safety control behind every "no-spend"
// validation: it monkeypatches http/https/fetch to block non-localhost egress.
// It is a .cjs module loaded via NODE_OPTIONS=--require in the harness; here we
// require it directly to unit-test its pure allowlist decision. Requiring it is
// side-effect-free unless AJNA_NO_EGRESS_GUARD_ENABLED=1 (unset under mocha), so
// no global http patching happens.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const guard = require('../../scripts/no-egress-guard.cjs');

describe('no-egress guard: host normalization + allowlist decision', () => {
  const allowed = guard.parseAllowedHosts('base-mainnet.g.alchemy.com');

  // Would the guard ALLOW this call (i.e. no candidate host is blocked)?
  const isAllowed = (
    input: unknown,
    options?: unknown,
    hint = 'https:'
  ): boolean =>
    guard.findBlockedTarget(
      guard.collectTargets(input, options, hint),
      allowed
    ) === null;

  it('canonicalizes bracketed IPv6 and lowercases', () => {
    expect(guard.canonicalizeHost('[::1]')).to.equal('::1');
    expect(guard.canonicalizeHost('EXAMPLE.Com')).to.equal('example.com');
    expect(guard.extractHostFromAuthority('[::1]:8545')).to.equal('::1');
    expect(guard.extractHostFromAuthority('127.0.0.1:8545')).to.equal(
      '127.0.0.1'
    );
  });

  it('allows localhost in every form (incl. IPv6, which previously over-blocked)', () => {
    expect(isAllowed('http://127.0.0.1:8545/')).to.equal(true);
    expect(isAllowed('http://localhost/')).to.equal(true);
    expect(isAllowed('http://[::1]:8545/')).to.equal(true);
    expect(isAllowed({ hostname: '::1', port: 8545 })).to.equal(true);
    expect(isAllowed({ host: '[::1]:8545' })).to.equal(true);
  });

  it('allows the explicitly allow-listed upstream fork host', () => {
    expect(
      isAllowed('https://base-mainnet.g.alchemy.com/v2/secret-key')
    ).to.equal(true);
  });

  it('blocks non-allowlisted hosts (string URL and options object)', () => {
    expect(isAllowed('https://li.quest/v1/quote')).to.equal(false);
    expect(isAllowed('https://api.1inch.dev/swap/v6.0')).to.equal(false);
    expect(isAllowed({ hostname: 'evil.example' })).to.equal(false);
  });

  it('closes the two-arg override bypass (benign URL + disallowed options host)', () => {
    // Node assigns options over the parsed URL, so this would actually dial
    // evil.example even though the URL host (127.0.0.1) is allow-listed.
    expect(isAllowed('http://127.0.0.1/', { hostname: 'evil.example' })).to.equal(
      false
    );
    // A disallowed URL host can't be rescued by an allowed override either
    // (every candidate must pass — most-restrictive).
    expect(isAllowed('https://li.quest/x', { hostname: '127.0.0.1' })).to.equal(
      false
    );
  });

  it('fails closed on unparseable / host-less input', () => {
    expect(isAllowed('not-a-url')).to.equal(false);
    expect(isAllowed(12345)).to.equal(false);
    expect(isAllowed(undefined)).to.equal(false);
  });

  it('returns the blocked host on the target (for the egress report)', () => {
    const blocked = guard.findBlockedTarget(
      guard.collectTargets('https://li.quest/v1/quote', undefined, 'https:'),
      allowed
    );
    expect(blocked).to.not.equal(null);
    expect(blocked.hostname).to.equal('li.quest');
  });
});
