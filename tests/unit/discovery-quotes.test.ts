import { expect } from 'chai';
import { BigNumber, ethers } from 'ethers';
import sinon from 'sinon';
import { LiquiditySource } from '../../src/config';
import { quoteOneInchAggregatorPathForDiscovery } from '../../src/discovery/external-take/oneinch-aggregator-quote';
import * as oneInchAggregatorQuoteModule from '../../src/take/oneinch-aggregator/quote-evaluation';
import { ExternalTakeQuoteEvaluation } from '../../src/take/types';

function buildExecutableOneInchQuote(
  overrides: Partial<ExternalTakeQuoteEvaluation> = {}
): ExternalTakeQuoteEvaluation {
  const quoteAmountRaw = overrides.quoteAmountRaw ?? BigNumber.from(10);
  const routeMinOutRaw = overrides.routeMinOutRaw ?? quoteAmountRaw;
  return {
    isTakeable: true,
    externalTakePath: 'calldata_aggregator',
    providerId: 'oneinch',
    selectedLiquiditySource: LiquiditySource.ONEINCH,
    quoteAmountRaw,
    routeMinOutRaw,
    routeExecutionFloorRaw: routeMinOutRaw,
    approvedMinOutRaw: routeMinOutRaw,
    calldataQuote: {
      providerId: 'oneinch',
      quotedAtMs: Date.now(),
      chainId: 1,
      srcToken: '0x3333333333333333333333333333333333333333',
      dstToken: '0x2222222222222222222222222222222222222222',
      dstReceiver: '0x4444444444444444444444444444444444444444',
      amountInTokenUnits: BigNumber.from(1),
      quoteAmountRaw,
      routeMinOutRaw,
      transactionTarget: '0x5555555555555555555555555555555555555555',
      approvalSpender: '0x6666666666666666666666666666666666666666',
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

describe('discovery external take quotes', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('rejects calldata aggregator quotes that omit selected source identity', async () => {
    sinon
      .stub(
        oneInchAggregatorQuoteModule,
        'getOneInchAggregatorPathQuoteEvaluation'
      )
      .resolves(
        buildExecutableOneInchQuote({
          selectedLiquiditySource: undefined,
        })
      );

    const result = await quoteOneInchAggregatorPathForDiscovery({
      pool: {
        name: 'Identity Guard Pool',
        collateralAddress: '0x3333333333333333333333333333333333333333',
        quoteAddress: '0x2222222222222222222222222222222222222222',
      } as any,
      signer: {} as any,
      poolConfig: {
        name: 'Identity Guard Pool',
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
      } as any,
      price: 100,
      auctionPrice: ethers.utils.parseEther('100'),
      collateral: ethers.utils.parseEther('1'),
      config: {
        oneInchAggregatorTaker: '0x4444444444444444444444444444444444444444',
        oneInchRouters: {
          1: '0x5555555555555555555555555555555555555555',
        },
      } as any,
      rpcCache: {
        chainId: 1,
      } as any,
      takePolicy: {},
      probeTimeoutMs: 1000,
      getTokenDecimalsCache: () => undefined,
    });

    expect(result.isTakeable).to.equal(false);
    expect(result.quoteFailureRetryable).to.equal(false);
    expect(result.quoteFailureCode).to.equal('identity_mismatch');
    expect(result.reason).to.include(
      '1inch quote returned source n/a instead of ONEINCH'
    );
  });

  it('rejects calldata aggregator quotes with conflicting provider identities', async () => {
    const conflictingQuote = buildExecutableOneInchQuote();
    sinon
      .stub(
        oneInchAggregatorQuoteModule,
        'getOneInchAggregatorPathQuoteEvaluation'
      )
      .resolves({
        ...conflictingQuote,
        calldataQuote: {
          ...conflictingQuote.calldataQuote!,
          providerId: 'lifi',
        },
      });

    const result = await quoteOneInchAggregatorPathForDiscovery({
      pool: {
        name: 'Identity Guard Pool',
        collateralAddress: '0x3333333333333333333333333333333333333333',
        quoteAddress: '0x2222222222222222222222222222222222222222',
      } as any,
      signer: {} as any,
      poolConfig: {
        name: 'Identity Guard Pool',
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
      } as any,
      price: 100,
      auctionPrice: ethers.utils.parseEther('100'),
      collateral: ethers.utils.parseEther('1'),
      config: {
        oneInchAggregatorTaker: '0x4444444444444444444444444444444444444444',
        oneInchRouters: {
          1: '0x5555555555555555555555555555555555555555',
        },
      } as any,
      rpcCache: {
        chainId: 1,
      } as any,
      takePolicy: {},
      probeTimeoutMs: 1000,
      getTokenDecimalsCache: () => undefined,
    });

    expect(result.isTakeable).to.equal(false);
    expect(result.quoteFailureRetryable).to.equal(false);
    expect(result.quoteFailureCode).to.equal('identity_mismatch');
    expect(result.reason).to.include(
      '1inch quote returned conflicting provider identity provider=oneinch calldataQuoteProvider=lifi'
    );
  });
});
