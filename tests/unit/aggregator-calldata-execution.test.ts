import { expect } from 'chai';
import { BigNumber, ethers } from 'ethers';
import sinon from 'sinon';
import { LiquiditySource, TakeWriteTransportMode } from '../../src/config';
import { logger } from '../../src/logging';
import {
  AGGREGATOR_SWAP_DETAILS_TUPLE_ABI,
  encodeAggregatorSwapDetails,
  getAggregatorFreshQuoteFloorError,
  getAggregatorQuoteAgeError,
  getAggregatorQuoteContextMismatch,
  isCalldataAggregatorExecutionPathSelected,
  prepareCalldataAggregatorExecution,
  recordCalldataAggregatorPreBroadcastRejection,
} from '../../src/take/aggregator-calldata/execution';
import { ApprovedCalldataAggregatorQuote } from '../../src/take/aggregator-calldata/types';
import {
  ApprovedCalldataAggregatorQuoteEvaluation,
  ExternalTakeExecutionPlan,
  ExternalTakeQuoteEvaluation,
  TakeLiquidationPlan,
} from '../../src/take/types';
import { TakerRouter__factory } from '../../typechain-types/factories/contracts/factories';

const CHAIN_ID = 8453;
const COLLATERAL = '0x1111111111111111111111111111111111111111';
const QUOTE = '0x2222222222222222222222222222222222222222';
const TAKER = '0x3333333333333333333333333333333333333333';
const TARGET = '0x4444444444444444444444444444444444444444';
const SPENDER = '0x5555555555555555555555555555555555555555';
const ROUTER = '0x6666666666666666666666666666666666666666';
const POOL = '0x7777777777777777777777777777777777777777';
const BORROWER = '0x8888888888888888888888888888888888888888';
const AUCTION_PRICE = ethers.utils.parseEther('100');
const COLLATERAL_WAD = ethers.utils.parseEther('1');
const APPROVED_MIN_OUT = BigNumber.from(150);

function calldataQuote(
  overrides: Partial<ApprovedCalldataAggregatorQuote> = {}
): ApprovedCalldataAggregatorQuote {
  const providerId = overrides.providerId ?? 'oneinch';
  return {
    providerId,
    quotedAtMs: Date.now(),
    chainId: CHAIN_ID,
    srcToken: COLLATERAL,
    dstToken: QUOTE,
    dstReceiver: TAKER,
    amountInTokenUnits: COLLATERAL_WAD,
    quoteAmountRaw: BigNumber.from(200),
    routeMinOutRaw: APPROVED_MIN_OUT,
    transactionTarget: TARGET,
    approvalSpender: SPENDER,
    callData: '0x12345678',
    selector: '0x12345678',
    txValue: '0',
    routeSummary: {
      providerId,
      tool: providerId,
      feeCosts: [],
    },
    ...overrides,
  };
}

function calldataEvaluation(
  overrides: Partial<ExternalTakeQuoteEvaluation> = {}
): ExternalTakeQuoteEvaluation {
  const quote =
    overrides.calldataQuote ??
    calldataQuote({
      providerId: overrides.providerId ?? 'oneinch',
    });
  return {
    isTakeable: true,
    externalTakePath: 'calldata_aggregator',
    selectedLiquiditySource: LiquiditySource.ONEINCH,
    providerId: 'oneinch',
    quoteAmountRaw: BigNumber.from(200),
    routeMinOutRaw: APPROVED_MIN_OUT,
    approvedMinOutRaw: APPROVED_MIN_OUT,
    calldataQuote: quote,
    ...overrides,
  };
}

function executionPlan(
  evaluation: ExternalTakeQuoteEvaluation
): ExternalTakeExecutionPlan {
  return {
    primary: { evaluation: evaluation as any },
    fallbacks: [],
  };
}

function liquidation(
  overrides: Partial<TakeLiquidationPlan> = {}
): TakeLiquidationPlan {
  return {
    borrower: BORROWER,
    hpbIndex: 1234,
    isTakeable: true,
    isArbTakeable: false,
    auctionPrice: AUCTION_PRICE,
    collateral: COLLATERAL_WAD,
    ...overrides,
  };
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    keeperTakerRouter: ROUTER,
    tokenDecimalsCache: new Map([[`${CHAIN_ID}:${COLLATERAL}`, 18]]),
    takeWriteTransport: {
      mode: TakeWriteTransportMode.PUBLIC_RPC,
      signer: {
        getAddress: sinon.stub().resolves(TAKER),
      },
      submitTransaction: sinon.stub(),
    },
    ...overrides,
  };
}

async function prepare(overrides: {
  quoteEvaluation?: ExternalTakeQuoteEvaluation;
  freshQuote?: ApprovedCalldataAggregatorQuote;
  liquidation?: TakeLiquidationPlan;
  config?: ReturnType<typeof config>;
  getPathQuoteEvaluation?: sinon.SinonStub;
  getTakerAddress?: sinon.SinonStub | (() => string | undefined);
  resolveChainId?: sinon.SinonStub;
  requestValidatedQuote?: sinon.SinonStub;
  getFailureMetadata?: (error: unknown) => {
    retryable?: boolean;
    code?: number | string;
  };
  getMaxQuoteAgeMs?: sinon.SinonStub | (() => number);
} = {}) {
  const getPathQuoteEvaluation =
    overrides.getPathQuoteEvaluation ??
    sinon.stub().resolves(overrides.quoteEvaluation ?? calldataEvaluation());
  const requestValidatedQuote =
    overrides.requestValidatedQuote ??
    sinon.stub().resolves(overrides.freshQuote ?? calldataQuote());

  return await prepareCalldataAggregatorExecution({
    pool: {
      name: 'Aggregator Execution Pool',
      poolAddress: POOL,
      collateralAddress: COLLATERAL,
      quoteAddress: QUOTE,
    } as any,
    signer: {} as any,
    poolConfig: {
      take: {
        liquiditySource: LiquiditySource.ONEINCH,
      },
    },
    liquidation: overrides.liquidation ?? liquidation(),
    config: overrides.config ?? config(),
    providerId: 'oneinch',
    missingRouterReason: 'missing keeper router',
    missingTakerReason: 'missing taker',
    collateralRoundsToZeroReason: 'collateral rounds to zero',
    getPathQuoteEvaluation,
    getTakerAddress: overrides.getTakerAddress ?? (() => TAKER),
    resolveChainId: overrides.resolveChainId ?? sinon.stub().resolves(CHAIN_ID),
    requestValidatedQuote,
    getFailureMetadata:
      overrides.getFailureMetadata ??
      (() => ({
        retryable: true,
        code: 'QUOTE_DOWN',
      })),
    getMaxQuoteAgeMs: overrides.getMaxQuoteAgeMs ?? (() => 60_000),
  });
}

describe('aggregator calldata execution guards', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('records pre-broadcast rejection callbacks and quote-result telemetry', () => {
    const quoteResult = {
      success: false,
      retryable: false,
      error: 'below floor',
    };
    const onQuote = sinon.spy();
    const onFailure = sinon.spy();
    const logError = sinon.stub(logger, 'error');

    recordCalldataAggregatorPreBroadcastRejection({
      config: {
        onCalldataAggregatorQuoteResult: onQuote,
        onCalldataAggregatorExecutionFailure: onFailure,
      },
      rejection: {
        kind: 'rejected',
        reason: 'below floor',
        logError: true,
        quoteResult,
      },
    });

    expect(logError.calledOnce).to.equal(true);
    expect(logError.firstCall.args[0]).to.equal('below floor');
    expect(onQuote.calledOnceWith(quoteResult)).to.equal(true);
    expect(onFailure.calledOnceWith({
      preBroadcast: true,
      error: 'below floor',
    })).to.equal(true);
  });

  it('encodes swap details with the approved execution floor', () => {
    const quote = calldataQuote();
    const encoded = encodeAggregatorSwapDetails({
      quote,
      amountOutMinimum: BigNumber.from(175),
    });
    const [decoded] = ethers.utils.defaultAbiCoder.decode(
      [AGGREGATOR_SWAP_DETAILS_TUPLE_ABI],
      encoded
    );

    expect(decoded.approvalSpender).to.equal(quote.approvalSpender);
    expect(decoded.srcToken).to.equal(quote.srcToken);
    expect(decoded.dstToken).to.equal(quote.dstToken);
    expect(decoded.amountOutMinimum.eq(175)).to.equal(true);
    expect(decoded.callData).to.equal(quote.callData);
  });

  it('returns undefined for fresh quotes and reports stale quote age', () => {
    const now = Date.now();

    expect(
      getAggregatorQuoteAgeError({
        quote: { quotedAtMs: now },
        maxQuoteAgeMs: 1_000,
        label: '1inch',
      })
    ).to.equal(undefined);
    expect(
      getAggregatorQuoteAgeError({
        quote: { quotedAtMs: now - 2_000 },
        maxQuoteAgeMs: 1_000,
        label: '1inch',
      })
    ).to.equal('1inch fresh quote exceeded maxQuoteAgeMs');
  });

  it('detects context mismatch only when approved quote context drifts', () => {
    const approved = calldataEvaluation({
      quotedCollateralWad: COLLATERAL_WAD,
      quotedAuctionPriceWad: AUCTION_PRICE,
    }) as ApprovedCalldataAggregatorQuoteEvaluation;

    expect(
      getAggregatorQuoteContextMismatch({
        quoteEvaluation: approved,
        liquidation: liquidation(),
        executionCollateralWad: COLLATERAL_WAD,
        label: '1inch',
      })
    ).to.equal(undefined);
    expect(
      getAggregatorQuoteContextMismatch({
        quoteEvaluation: {
          ...approved,
          quotedAuctionPriceWad: AUCTION_PRICE.add(1),
        },
        liquidation: liquidation(),
        executionCollateralWad: COLLATERAL_WAD,
        label: '1inch',
      })
    ).to.equal(
      '1inch approved quote auction price does not match current liquidation auction price'
    );
  });

  it('checks both fresh quote expected output and route min-out floors', () => {
    expect(
      getAggregatorFreshQuoteFloorError({
        freshQuote: calldataQuote({
          quoteAmountRaw: BigNumber.from(149),
          routeMinOutRaw: APPROVED_MIN_OUT,
        }),
        approvedMinOutRaw: APPROVED_MIN_OUT,
        label: '1inch',
      })
    ).to.equal('1inch fresh quote expected output below execution floor');
    expect(
      getAggregatorFreshQuoteFloorError({
        freshQuote: calldataQuote({
          quoteAmountRaw: BigNumber.from(200),
          routeMinOutRaw: BigNumber.from(149),
        }),
        approvedMinOutRaw: APPROVED_MIN_OUT,
        label: '1inch',
      })
    ).to.equal('1inch fresh quote min output below execution floor');
  });

  it('selects calldata aggregator execution by default source or approved quote identity', () => {
    expect(
      isCalldataAggregatorExecutionPathSelected({
        poolConfig: { take: { liquiditySource: LiquiditySource.ONEINCH } },
        liquidation: liquidation(),
        providerId: 'oneinch',
      })
    ).to.equal(true);

    expect(
      isCalldataAggregatorExecutionPathSelected({
        poolConfig: { take: { liquiditySource: LiquiditySource.ONEINCH } },
        liquidation: liquidation({
          externalTakeExecutionPlan: executionPlan(
            calldataEvaluation({
              providerId: 'lifi',
              selectedLiquiditySource: LiquiditySource.LIFI,
              calldataQuote: calldataQuote({ providerId: 'lifi' }),
            })
          ),
        }),
        providerId: 'oneinch',
      })
    ).to.equal(false);
  });

  it('rejects unapproved quote evaluations before resolving execution dependencies', async () => {
    const result = await prepare({
      quoteEvaluation: calldataEvaluation({
        isTakeable: false,
        reason: 'below floor',
      }),
      getTakerAddress: sinon.stub().throws(new Error('must not resolve taker')),
    });

    expect(result).to.deep.equal({
      kind: 'rejected',
      reason:
        '1inch quote no longer satisfies execution policy for Aggregator Execution Pool/0x8888888888888888888888888888888888888888: below floor',
      logError: true,
    });
  });

  it('rejects approved quote context drift before requesting a fresh quote', async () => {
    const requestValidatedQuote = sinon.stub().resolves(calldataQuote());

    const result = await prepare({
      liquidation: liquidation({
        externalTakeExecutionPlan: executionPlan(
          calldataEvaluation({
            quotedCollateralWad: COLLATERAL_WAD.add(1),
          })
        ),
      }),
      requestValidatedQuote,
    });

    expect(result).to.deep.equal({
      kind: 'rejected',
      reason:
        '1inch approved quote collateral does not match current liquidation collateral',
    });
    expect(requestValidatedQuote.called).to.equal(false);
  });

  it('returns dry-run after approval without router, taker, or quote requests', async () => {
    const requestValidatedQuote = sinon.stub().resolves(calldataQuote());
    const result = await prepare({
      config: config({
        dryRun: true,
        keeperTakerRouter: undefined,
      }),
      getTakerAddress: sinon.stub().throws(new Error('must not resolve taker')),
      requestValidatedQuote,
    });

    expect(result.kind).to.equal('dry_run');
    expect(requestValidatedQuote.called).to.equal(false);
  });

  it('throws structural router and taker configuration errors before quote requests', async () => {
    const requestValidatedQuote = sinon.stub().resolves(calldataQuote());

    try {
      await prepare({
        config: config({ keeperTakerRouter: undefined }),
        requestValidatedQuote,
      });
      throw new Error('expected missing router throw');
    } catch (error) {
      expect((error as Error).message).to.equal('missing keeper router');
    }
    expect(requestValidatedQuote.called).to.equal(false);

    try {
      await prepare({
        getTakerAddress: sinon.stub().returns(undefined),
        requestValidatedQuote,
      });
      throw new Error('expected missing taker throw');
    } catch (error) {
      expect((error as Error).message).to.equal('missing taker');
    }
    expect(requestValidatedQuote.called).to.equal(false);
  });

  it('rejects before provider quote when collateral rounds to zero token units', async () => {
    const requestValidatedQuote = sinon.stub().resolves(calldataQuote());

    const result = await prepare({
      liquidation: liquidation({
        collateral: BigNumber.from(1),
      }),
      config: config({
        tokenDecimalsCache: new Map([[`${CHAIN_ID}:${COLLATERAL}`, 6]]),
      }),
      requestValidatedQuote,
    });

    expect(result).to.deep.equal({
      kind: 'rejected',
      reason: 'collateral rounds to zero',
    });
    expect(requestValidatedQuote.called).to.equal(false);
  });

  it('reports provider quote failures with retry metadata and rethrows', async () => {
    const onQuote = sinon.spy();
    const failure = new Error('provider unavailable');

    try {
      await prepare({
        config: config({ onCalldataAggregatorQuoteResult: onQuote }),
        requestValidatedQuote: sinon.stub().rejects(failure),
        getFailureMetadata: () => ({ retryable: true, code: 429 }),
      });
      throw new Error('expected provider failure');
    } catch (error) {
      expect(error).to.equal(failure);
    }

    expect(onQuote.calledOnce).to.equal(true);
    expect(onQuote.firstCall.args[0]).to.deep.equal({
      success: false,
      retryable: true,
      errorCode: 429,
      error: 'provider unavailable',
    });
  });

  it('rejects fresh quotes that do not clear the approved execution floor', async () => {
    const result = await prepare({
      freshQuote: calldataQuote({
        quoteAmountRaw: BigNumber.from(200),
        routeMinOutRaw: BigNumber.from(149),
      }),
    });

    expect(result).to.deep.equal({
      kind: 'rejected',
      reason: '1inch fresh quote min output below execution floor',
      quoteResult: {
        success: false,
        retryable: false,
        error: '1inch fresh quote min output below execution floor',
      },
    });
  });

  it('rejects stale fresh quotes as retryable pre-broadcast failures', async () => {
    const result = await prepare({
      freshQuote: calldataQuote({
        quotedAtMs: Date.now() - 10_000,
      }),
      getMaxQuoteAgeMs: () => 1,
    });

    expect(result).to.deep.equal({
      kind: 'rejected',
      reason: '1inch fresh quote exceeded maxQuoteAgeMs',
      quoteResult: {
        success: false,
        retryable: true,
        error: '1inch fresh quote exceeded maxQuoteAgeMs',
      },
    });
  });

  it('returns ready execution and rechecks quote freshness before irreversible steps', async () => {
    const clock = sinon.useFakeTimers({ now: 1_000_000 });
    const onQuote = sinon.spy();
    const connectStub = sinon.stub(TakerRouter__factory, 'connect').returns({
      estimateGas: { takeWithAtomicSwap: sinon.stub() },
      populateTransaction: { takeWithAtomicSwap: sinon.stub() },
    } as any);

    const result = await prepare({
      config: config({ onCalldataAggregatorQuoteResult: onQuote }),
      freshQuote: calldataQuote({ quotedAtMs: Date.now() }),
      getMaxQuoteAgeMs: () => 100,
    });

    expect(result.kind).to.equal('ready');
    if (result.kind !== 'ready') {
      throw new Error(`expected ready, got ${result.kind}`);
    }
    expect(connectStub.calledOnceWith(ROUTER)).to.equal(true);

    result.assertFreshQuoteStillCurrent();
    clock.tick(101);
    expect(() => result.assertFreshQuoteStillCurrent()).to.throw(
      '1inch fresh quote exceeded maxQuoteAgeMs'
    );
    expect(onQuote.calledOnce).to.equal(true);
    expect(onQuote.firstCall.args[0]).to.deep.equal({
      success: false,
      retryable: false,
      error: '1inch fresh quote exceeded maxQuoteAgeMs',
    });
  });
});
