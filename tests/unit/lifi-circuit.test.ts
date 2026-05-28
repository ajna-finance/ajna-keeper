import { expect } from 'chai';
import {
  getLifiCircuitOpenReason,
  recordLifiQuoteFailure,
  recordLifiQuoteSuccess,
} from '../../src/discovery/lifi-circuit';
import { DiscoveryRpcCache } from '../../src/discovery/types';

describe('LI.FI quote circuit', () => {
  it('opens only the LI.FI provider circuit after retryable failures', () => {
    const rpcCache: DiscoveryRpcCache = {
      oneInchQuoteCircuit: {
        failures: 1,
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
    expect(rpcCache.oneInchQuoteCircuit?.failures).to.equal(1);
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
