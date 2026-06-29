import { expect } from 'chai';
import sinon from 'sinon';
import {
  DEFAULT_LIFI_QUOTE_FAILURE_COOLDOWN_MS,
  MAX_LIFI_QUOTE_FAILURE_COOLDOWN_MS,
  getLifiCircuitOpenReason,
  recordLifiQuoteFailure,
  recordLifiQuoteSuccess,
} from '../../src/discovery/external-take/lifi-circuit';
import { DiscoveryRpcCache } from '../../src/discovery/types';
import { logger } from '../../src/logging';

describe('LI.FI quote circuit', () => {
  it('opens only the LI.FI provider circuit after retryable failures', () => {
    const rpcCache: DiscoveryRpcCache = {
      providerCircuits: {
        oneinch: { route_quote: { failures: 1 } },
      },
    };
    const lifiConfig = {
      mode: 'production' as const,
      allowExchanges: ['uniswap'],
      callTargetAllowlist: {
        8453: ['0x1111111111111111111111111111111111111111'],
      },
      approvalSpenderAllowlist: {
        8453: ['0x2222222222222222222222222222222222222222'],
      },
      selectorAllowlist: {
        8453: {
          '0x1111111111111111111111111111111111111111': ['0x12345678'],
        },
      },
      quoteFailureThreshold: 2,
      quoteFailureCooldownMs: 5_000,
    };

    recordLifiQuoteFailure({
      rpcCache,
      lifiConfig,
      nowMs: 1_000,
    });
    expect(
      getLifiCircuitOpenReason({
        rpcCache,
        lifiConfig,
        nowMs: 1_000,
      })
    ).to.equal(undefined);

    recordLifiQuoteFailure({
      rpcCache,
      lifiConfig,
      nowMs: 2_000,
    });

    expect(
      getLifiCircuitOpenReason({
        rpcCache,
        lifiConfig,
        nowMs: 2_001,
      })
    ).to.include('LI.FI quote circuit open for purpose=route_quote');
    expect(rpcCache.providerCircuits?.lifi?.route_quote?.failures).to.equal(2);
    expect(
      rpcCache.providerCircuits?.oneinch?.route_quote?.failures
    ).to.equal(1);
  });

  it('keeps route quote and execution refresh circuits independent', () => {
    const rpcCache: DiscoveryRpcCache = {};
    const lifiConfig = {
      mode: 'production' as const,
      allowExchanges: ['uniswap'],
      callTargetAllowlist: {
        8453: ['0x1111111111111111111111111111111111111111'],
      },
      approvalSpenderAllowlist: {
        8453: ['0x2222222222222222222222222222222222222222'],
      },
      selectorAllowlist: {
        8453: {
          '0x1111111111111111111111111111111111111111': ['0x12345678'],
        },
      },
      quoteFailureThreshold: 1,
      quoteFailureCooldownMs: 10_000,
    };

    recordLifiQuoteFailure({
      rpcCache,
      lifiConfig,
      purpose: 'execution_refresh',
      nowMs: 10,
    });

    expect(
      getLifiCircuitOpenReason({
        rpcCache,
        lifiConfig,
        purpose: 'execution_refresh',
        nowMs: 11,
      })
    ).to.include('purpose=execution_refresh');
    expect(
      getLifiCircuitOpenReason({
        rpcCache,
        lifiConfig,
        purpose: 'route_quote',
        nowMs: 11,
      })
    ).to.equal(undefined);

    recordLifiQuoteSuccess(rpcCache, 'execution_refresh');
    expect(
      getLifiCircuitOpenReason({
        rpcCache,
        lifiConfig,
        purpose: 'execution_refresh',
        nowMs: 12,
      })
    ).to.equal(undefined);
  });
});

// Parity with the 1inch circuit suite (one-inch-circuit.test.ts): lifi-circuit.ts
// has the same clamp / reset-on-expiry / heartbeat machinery, but it was
// untested. A LI.FI-specific regression (cooldown not bounded, failures not
// cleared on expiry, heartbeat spamming or never re-arming, or a non-positive
// configured cooldown collapsing to zero) would otherwise ship silently.
describe('LI.FI quote circuit — cooldown clamp / reset / heartbeat', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('resets expired cooldown state before recording a new failure', () => {
    const rpcCache: DiscoveryRpcCache = {
      providerCircuits: {
        lifi: { route_quote: { failures: 2, cooldownUntilMs: 1_000 } },
      },
    };

    recordLifiQuoteFailure({
      rpcCache,
      lifiConfig: { quoteFailureThreshold: 2, quoteFailureCooldownMs: 30_000 },
      nowMs: 2_000,
    });

    expect(rpcCache.providerCircuits?.lifi?.route_quote?.failures).to.equal(1);
    expect(rpcCache.providerCircuits?.lifi?.route_quote?.cooldownUntilMs).to.be
      .undefined;
  });

  it('clamps excessive cooldowns and emits a single bounded open-heartbeat log', () => {
    const infoStub = sinon.stub(logger, 'info');
    const rpcCache: DiscoveryRpcCache = {
      providerCircuits: { lifi: { route_quote: { failures: 0 } } },
    };

    recordLifiQuoteFailure({
      rpcCache,
      lifiConfig: {
        quoteFailureThreshold: 1,
        quoteFailureCooldownMs: MAX_LIFI_QUOTE_FAILURE_COOLDOWN_MS * 10,
      },
      nowMs: 10_000,
    });

    expect(
      rpcCache.providerCircuits?.lifi?.route_quote?.cooldownUntilMs
    ).to.equal(10_000 + MAX_LIFI_QUOTE_FAILURE_COOLDOWN_MS);
    expect(
      getLifiCircuitOpenReason({ rpcCache, lifiConfig: undefined, nowMs: 20_000 })
    ).to.include('LI.FI quote circuit open');
    expect(
      getLifiCircuitOpenReason({ rpcCache, lifiConfig: undefined, nowMs: 21_000 })
    ).to.include('LI.FI quote circuit open');
    expect(infoStub.calledOnce).to.equal(true);
  });

  it('re-arms heartbeat logging after cooldown expiry and retrip', () => {
    const infoStub = sinon.stub(logger, 'info');
    const rpcCache: DiscoveryRpcCache = {
      providerCircuits: { lifi: { route_quote: { failures: 0 } } },
    };
    const lifiConfig = {
      quoteFailureThreshold: 1,
      quoteFailureCooldownMs: 1_000,
    };

    recordLifiQuoteFailure({ rpcCache, lifiConfig, nowMs: 10_000 });
    expect(
      getLifiCircuitOpenReason({ rpcCache, lifiConfig, nowMs: 10_100 })
    ).to.include('LI.FI quote circuit open');
    expect(
      getLifiCircuitOpenReason({ rpcCache, lifiConfig, nowMs: 10_200 })
    ).to.include('LI.FI quote circuit open');
    expect(infoStub.calledOnce).to.equal(true);

    // Cooldown (11_000) has elapsed -> reset clears state -> not open.
    expect(
      getLifiCircuitOpenReason({ rpcCache, lifiConfig, nowMs: 11_001 })
    ).to.equal(undefined);

    recordLifiQuoteFailure({ rpcCache, lifiConfig, nowMs: 11_002 });
    expect(
      getLifiCircuitOpenReason({ rpcCache, lifiConfig, nowMs: 11_003 })
    ).to.include('LI.FI quote circuit open');
    expect(infoStub.calledTwice).to.equal(true);
  });

  it('falls back to the default cooldown when the configured cooldown is non-positive', () => {
    const rpcCache: DiscoveryRpcCache = {
      providerCircuits: { lifi: { route_quote: { failures: 0 } } },
    };

    recordLifiQuoteFailure({
      rpcCache,
      lifiConfig: { quoteFailureThreshold: 1, quoteFailureCooldownMs: 0 },
      nowMs: 5_000,
    });

    // A non-positive configured cooldown must NOT collapse to Math.min(0, MAX)=0
    // (which would leave the circuit instantly closed); it falls back to the
    // default so the circuit actually stays open for a meaningful window.
    expect(
      rpcCache.providerCircuits?.lifi?.route_quote?.cooldownUntilMs
    ).to.equal(5_000 + DEFAULT_LIFI_QUOTE_FAILURE_COOLDOWN_MS);
  });
});
