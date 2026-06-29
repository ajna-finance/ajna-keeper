import { expect } from 'chai';
import { SushiAggregatorRouteValidationError } from '../../src/dex/sushi-aggregator/validate-route';
import { getSushiAggregatorQuoteFailureMetadata } from '../../src/take/sushi-aggregator/quote-service';
import {
  NonceConsumedTransactionError,
  isNonceConsumedTransactionError,
} from '../../src/nonce';

// Regression guard for the es5 Error-subclass downlevel bug.
//
// While tsconfig `target` was es5, TypeScript down-leveled `class X extends
// Error` in a way that broke the prototype chain, so `err instanceof X`
// returned FALSE for these subclasses. That silently mis-routed
// getSushiAggregatorQuoteFailureMetadata: a local fail-closed route-validation
// reject (which MUST be {retryable:false}) was instead classified as a
// retryable provider failure and counted against the Sushi quote circuit
// breaker — the opposite of the coded intent ("local validation rejects are
// not provider health signals"). These assertions FAIL under target es5 and
// pass under es2015+; they pin the contract regardless of future
// target/bundler/toolchain changes (see tsconfig.json `target`).
describe('Error-subclass classification (es5 downlevel regression)', () => {
  it('SushiAggregatorRouteValidationError survives instanceof', () => {
    const err = new SushiAggregatorRouteValidationError('bad route');
    expect(err).to.be.instanceOf(SushiAggregatorRouteValidationError);
    expect(err).to.be.instanceOf(Error);
  });

  it('classifies a local route-validation reject as non-retryable', () => {
    const err = new SushiAggregatorRouteValidationError('bad route');
    const meta = getSushiAggregatorQuoteFailureMetadata(err);
    expect(meta.retryable).to.equal(false);
    expect(meta.code).to.equal('route_validation');
  });

  it('still classifies a genuine provider HTTP failure by status (discrimination is real)', () => {
    const httpError = Object.assign(new Error('upstream 500'), {
      response: { status: 500 },
    });
    const meta = getSushiAggregatorQuoteFailureMetadata(httpError);
    expect(meta.code).to.equal(500);
    // A route-validation reject and a real provider error must NOT classify
    // identically — that distinction is exactly what the instanceof branch
    // protects, and what broke silently under es5.
    expect(meta.code).to.not.equal('route_validation');
  });

  it('NonceConsumedTransactionError survives instanceof and the duck-type guard', () => {
    const err = new NonceConsumedTransactionError('nonce already used');
    expect(err).to.be.instanceOf(NonceConsumedTransactionError);
    expect(isNonceConsumedTransactionError(err)).to.equal(true);
  });
});
