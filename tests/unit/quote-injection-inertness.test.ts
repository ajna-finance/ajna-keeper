import { expect } from 'chai';
import {
  installAggregatorQuoteInjector,
  getAggregatorQuoteInjector,
  clearAggregatorQuoteInjector,
  AGGREGATOR_QUOTE_INJECTION_ENV_FLAG,
  AggregatorQuoteInjector,
} from '../../src/take/aggregator-calldata/quote-injection';

// The no-spend aggregator take seam is threaded into the LIVE probe/execution
// pipeline. The entire fund-safety argument is that it is INERT in production:
// it must do nothing unless the harness-only env flag is set. These tests pin
// that double-gated contract so it cannot silently regress (a reachable
// injector in production would bypass the fail-closed quote validators).
describe('aggregator quote-injection production inertness', () => {
  const FLAG = AGGREGATOR_QUOTE_INJECTION_ENV_FLAG;
  const dummy = (() => ({})) as unknown as AggregatorQuoteInjector;
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[FLAG];
  });
  afterEach(() => {
    if (original === undefined) {
      delete process.env[FLAG];
    } else {
      process.env[FLAG] = original;
    }
    clearAggregatorQuoteInjector();
  });

  it('is inert when the flag is unset: get() is undefined and install() throws', () => {
    delete process.env[FLAG];
    expect(getAggregatorQuoteInjector()).to.equal(undefined);
    expect(() => installAggregatorQuoteInjector(dummy)).to.throw(new RegExp(FLAG));
  });

  it('is inert when the flag is anything other than "1"', () => {
    process.env[FLAG] = '0';
    expect(getAggregatorQuoteInjector()).to.equal(undefined);
    expect(() => installAggregatorQuoteInjector(dummy)).to.throw();
    process.env[FLAG] = 'true';
    expect(getAggregatorQuoteInjector()).to.equal(undefined);
  });

  it('activates only when the flag is exactly "1"', () => {
    process.env[FLAG] = '1';
    installAggregatorQuoteInjector(dummy);
    expect(getAggregatorQuoteInjector()).to.equal(dummy);
  });

  it('double-gates: an installed injector is still unreachable once the flag is removed', () => {
    process.env[FLAG] = '1';
    installAggregatorQuoteInjector(dummy);
    delete process.env[FLAG];
    expect(getAggregatorQuoteInjector()).to.equal(undefined);
  });
});
