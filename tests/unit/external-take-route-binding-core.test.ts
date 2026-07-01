import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { LiquiditySource } from '../../src/config';
import {
  bindExternalTakeRoute,
  resolveExternalTakeRouteIdentity,
} from '../../src/take/external-take/route-binding';
import { ExternalTakeQuoteEvaluation } from '../../src/take/types';

function calldataQuote(
  overrides: Partial<ExternalTakeQuoteEvaluation> = {}
): ExternalTakeQuoteEvaluation {
  const quoteAmountRaw = BigNumber.from(100);
  return {
    isTakeable: true,
    externalTakePath: 'calldata_aggregator',
    providerId: 'oneinch',
    selectedLiquiditySource: LiquiditySource.ONEINCH,
    quoteAmountRaw,
    routeExecutionFloorRaw: BigNumber.from(90),
    calldataQuote: {
      providerId: 'oneinch',
      quotedAtMs: 1,
      chainId: 1,
      srcToken: '0x1111111111111111111111111111111111111111',
      dstToken: '0x2222222222222222222222222222222222222222',
      dstReceiver: '0x3333333333333333333333333333333333333333',
      amountInTokenUnits: BigNumber.from(1),
      quoteAmountRaw,
      routeMinOutRaw: BigNumber.from(90),
      transactionTarget: '0x4444444444444444444444444444444444444444',
      approvalSpender: '0x5555555555555555555555555555555555555555',
      callData: '0x12345678',
      selector: '0x12345678',
      txValue: '0',
      routeSummary: {
        providerId: 'oneinch',
        tool: '1inch',
        feeCosts: [],
      },
    },
    ...overrides,
  };
}

function directDexQuote(
  overrides: Partial<ExternalTakeQuoteEvaluation> = {}
): ExternalTakeQuoteEvaluation {
  return {
    isTakeable: true,
    externalTakePath: 'direct_dex',
    selectedLiquiditySource: LiquiditySource.UNISWAPV3,
    selectedFeeTier: 3000,
    quoteAmountRaw: BigNumber.from(100),
    routeExecutionFloorRaw: BigNumber.from(90),
    ...overrides,
  };
}

describe('external take route binding core failures', () => {
  it('binds direct DEX and calldata aggregator quotes to canonical route identities', () => {
    const direct = bindExternalTakeRoute({
      quoteEvaluation: directDexQuote(),
    });
    expect(direct.bound).to.equal(true);
    if (!direct.bound) throw new Error('expected direct binding');
    expect(direct.path).to.equal('direct_dex');
    expect(direct.source).to.equal(LiquiditySource.UNISWAPV3);

    const calldata = bindExternalTakeRoute({
      quoteEvaluation: calldataQuote(),
    });
    expect(calldata.bound).to.equal(true);
    if (!calldata.bound) throw new Error('expected calldata binding');
    expect(calldata.path).to.equal('calldata_aggregator');
    if (calldata.path !== 'calldata_aggregator') {
      throw new Error('expected calldata path');
    }
    expect(calldata.providerId).to.equal('oneinch');
    expect(
      resolveExternalTakeRouteIdentity(calldata.quoteEvaluation)
    ).to.deep.equal(calldata.identity);
  });

  it('rejects mismatched calldata provider identity before execution binding', () => {
    const binding = bindExternalTakeRoute({
      quoteEvaluation: calldataQuote({
        calldataQuote: {
          ...(calldataQuote().calldataQuote as any),
          providerId: 'lifi',
        },
      }),
    });

    expect(binding.bound).to.equal(false);
    if (binding.bound) throw new Error('expected provider mismatch');
    expect(binding.code).to.equal('provider_mismatch');
    expect((binding as any).providerId).to.equal('oneinch');
    expect((binding as any).calldataQuoteProviderId).to.equal('lifi');
  });

  it('rejects disabled external-take paths even when the quote is otherwise bound', () => {
    const binding = bindExternalTakeRoute({
      quoteEvaluation: directDexQuote(),
      resolvedExternalTakePaths: ['calldata_aggregator'],
    });

    expect(binding.bound).to.equal(false);
    if (binding.bound) throw new Error('expected disabled path');
    expect(binding.code).to.equal('disabled_path');
    expect((binding as any).path).to.equal('direct_dex');
  });

  it('rejects unsupported legacy liquidity sources instead of guessing a path', () => {
    const binding = bindExternalTakeRoute({
      quoteEvaluation: {
        isTakeable: true,
        selectedLiquiditySource: LiquiditySource.SUSHISWAP,
      },
    });

    expect(binding.bound).to.equal(false);
    if (binding.bound) throw new Error('expected unsupported source');
    expect(binding.code).to.equal('unsupported_source');
    expect(binding.source).to.equal(LiquiditySource.SUSHISWAP);
  });

  it('requires both a concrete path and a concrete source', () => {
    const missingPath = bindExternalTakeRoute({
      quoteEvaluation: {
        isTakeable: true,
        selectedLiquiditySource: LiquiditySource.UNISWAPV3,
      },
    });
    expect(missingPath.bound).to.equal(false);
    if (missingPath.bound) throw new Error('expected missing path');
    expect(missingPath.code).to.equal('missing_path');

    const missingSource = bindExternalTakeRoute({
      quoteEvaluation: {
        isTakeable: true,
        externalTakePath: 'direct_dex',
      },
    });
    expect(missingSource.bound).to.equal(false);
    if (missingSource.bound) throw new Error('expected missing source');
    expect(missingSource.code).to.equal('missing_source');
  });
});
