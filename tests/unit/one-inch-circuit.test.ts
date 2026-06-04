import { expect } from 'chai';
import sinon from 'sinon';
import {
  MAX_ONEINCH_QUOTE_FAILURE_COOLDOWN_MS,
  getOneInchCircuitOpenReason,
  recordOneInchQuoteFailure,
  recordOneInchQuoteSuccess,
} from '../../src/discovery/external-take/one-inch-circuit';
import { DiscoveryRpcCache } from '../../src/discovery/types';
import { logger } from '../../src/logging';

describe('1inch quote circuit', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('resets expired cooldown state before recording a new failure', () => {
    const cache = {
      oneInchQuoteCircuit: {
        failures: 2,
        cooldownUntilMs: 1_000,
      },
    } as DiscoveryRpcCache;

    recordOneInchQuoteFailure({
      rpcCache: cache,
      takePolicy: {
        oneInchQuoteFailureThreshold: 2,
        oneInchQuoteFailureCooldownMs: 30_000,
      },
      nowMs: 2_000,
    });

    expect(cache.oneInchQuoteCircuit?.failures).to.equal(1);
    expect(cache.oneInchQuoteCircuit?.cooldownUntilMs).to.be.undefined;
    expect(cache.providerCircuits?.oneinch?.route_quote).to.equal(
      cache.oneInchQuoteCircuit
    );
  });

  it('clamps excessive cooldowns and emits bounded open-heartbeat logs', () => {
    const infoStub = sinon.stub(logger, 'info');
    const cache = {
      oneInchQuoteCircuit: {
        failures: 0,
      },
    } as DiscoveryRpcCache;

    recordOneInchQuoteFailure({
      rpcCache: cache,
      takePolicy: {
        oneInchQuoteFailureThreshold: 1,
        oneInchQuoteFailureCooldownMs:
          MAX_ONEINCH_QUOTE_FAILURE_COOLDOWN_MS * 10,
      },
      nowMs: 10_000,
    });

    expect(cache.oneInchQuoteCircuit?.cooldownUntilMs).to.equal(
      10_000 + MAX_ONEINCH_QUOTE_FAILURE_COOLDOWN_MS
    );
    expect(cache.providerCircuits?.oneinch?.route_quote).to.equal(
      cache.oneInchQuoteCircuit
    );
    expect(
      getOneInchCircuitOpenReason({
        rpcCache: cache,
        takePolicy: undefined,
        nowMs: 20_000,
      })
    ).to.include('1inch quote circuit open');
    expect(
      getOneInchCircuitOpenReason({
        rpcCache: cache,
        takePolicy: undefined,
        nowMs: 21_000,
      })
    ).to.include('1inch quote circuit open');
    expect(infoStub.calledOnce).to.be.true;
  });

  it('re-arms heartbeat logging after cooldown expiry and retrip', () => {
    const infoStub = sinon.stub(logger, 'info');
    const cache = {
      oneInchQuoteCircuit: {
        failures: 0,
      },
    } as DiscoveryRpcCache;
    const policy = {
      oneInchQuoteFailureThreshold: 1,
      oneInchQuoteFailureCooldownMs: 1_000,
    };

    recordOneInchQuoteFailure({
      rpcCache: cache,
      takePolicy: policy,
      nowMs: 10_000,
    });
    expect(
      getOneInchCircuitOpenReason({
        rpcCache: cache,
        takePolicy: policy,
        nowMs: 10_100,
      })
    ).to.include('1inch quote circuit open');
    expect(
      getOneInchCircuitOpenReason({
        rpcCache: cache,
        takePolicy: policy,
        nowMs: 10_200,
      })
    ).to.include('1inch quote circuit open');
    expect(infoStub.calledOnce).to.be.true;

    expect(
      getOneInchCircuitOpenReason({
        rpcCache: cache,
        takePolicy: policy,
        nowMs: 11_001,
      })
    ).to.be.undefined;

    recordOneInchQuoteFailure({
      rpcCache: cache,
      takePolicy: policy,
      nowMs: 11_002,
    });
    expect(cache.providerCircuits?.oneinch?.route_quote).to.equal(
      cache.oneInchQuoteCircuit
    );
    expect(
      getOneInchCircuitOpenReason({
        rpcCache: cache,
        takePolicy: policy,
        nowMs: 11_003,
      })
    ).to.include('1inch quote circuit open');
    expect(infoStub.calledTwice).to.be.true;
  });

  it('keeps gas-conversion circuit state separate from route quote circuit state', () => {
    const cache = {} as DiscoveryRpcCache;
    const policy = {
      oneInchQuoteFailureThreshold: 1,
      oneInchQuoteFailureCooldownMs: 30_000,
    };

    recordOneInchQuoteFailure({
      rpcCache: cache,
      takePolicy: policy,
      purpose: 'gas_conversion',
      nowMs: 10_000,
    });

    expect(
      getOneInchCircuitOpenReason({
        rpcCache: cache,
        takePolicy: policy,
        purpose: 'gas_conversion',
        nowMs: 10_001,
      })
    ).to.include('purpose=gas_conversion');
    expect(
      getOneInchCircuitOpenReason({
        rpcCache: cache,
        takePolicy: policy,
        purpose: 'route_quote',
        nowMs: 10_001,
      })
    ).to.be.undefined;
    expect(cache.providerCircuits?.oneinch?.gas_conversion).to.equal(
      cache.oneInchQuoteCircuits?.gas_conversion
    );
    expect(cache.providerCircuits?.oneinch?.route_quote).to.equal(
      cache.oneInchQuoteCircuit
    );
    expect(cache.providerCircuits?.oneinch?.gas_conversion).to.not.equal(
      cache.providerCircuits?.oneinch?.route_quote
    );
  });

  it('clears provider-keyed route state while restoring legacy aliases', () => {
    const providerRouteState = {
      failures: 2,
      cooldownUntilMs: 5_000,
      lastOpenLogAtMs: 1_000,
    };
    const cache = {
      providerCircuits: {
        oneinch: {
          route_quote: providerRouteState,
        },
      },
    } as DiscoveryRpcCache;

    recordOneInchQuoteSuccess(cache);

    expect(cache.oneInchQuoteCircuit).to.equal(providerRouteState);
    expect(cache.oneInchQuoteCircuits?.route_quote).to.equal(
      providerRouteState
    );
    expect(cache.providerCircuits?.oneinch?.route_quote?.failures).to.equal(0);
    expect(cache.providerCircuits?.oneinch?.route_quote?.cooldownUntilMs).to.be
      .undefined;
    expect(cache.providerCircuits?.oneinch?.route_quote?.lastOpenLogAtMs).to.be
      .undefined;
  });
});
