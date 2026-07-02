import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, ethers } from 'ethers';
import { LiquiditySource } from '../../src/config';
import {
  HYBRID_GAS_QUOTE_FALLBACK_KIND,
  ExternalTakeApprovalResult,
} from '../../src/discovery/external-take/approval';
import {
  applyDiscoveryApprovalProfitabilityPolicy,
  buildSimpleQuoteProfitability,
  getAuctionCostQuoteRaw,
} from '../../src/discovery/external-take/profitability-policy';
import { EXTERNAL_TAKE_REJECTION_REASONS } from '../../src/take/external-take/policy';
import {
  BoundExternalTakeRouteEvaluation,
  ExternalTakeQuoteEvaluation,
} from '../../src/take/types';

type ProfitabilityPolicyParams = Parameters<
  typeof applyDiscoveryApprovalProfitabilityPolicy
>[0];

const raw = (value: number): BigNumber => BigNumber.from(value);

function takePolicy(
  overrides: Record<string, unknown> = {}
): ProfitabilityPolicyParams['takePolicy'] {
  return { enabled: true, ...overrides } as ProfitabilityPolicyParams['takePolicy'];
}

function target(
  takeOverrides: Record<string, unknown> = {}
): ProfitabilityPolicyParams['target'] {
  return {
    source: 'discovered',
    poolAddress: '0x1111111111111111111111111111111111111111',
    name: 'profitability policy pool',
    dryRun: false,
    take: {
      liquiditySource: LiquiditySource.LIFI,
      marketPriceFactor: 0.99,
      ...takeOverrides,
    },
    candidates: [],
  } as ProfitabilityPolicyParams['target'];
}

function gasPolicy(
  overrides: Partial<ProfitabilityPolicyParams['gasPolicy']> = {}
): ProfitabilityPolicyParams['gasPolicy'] {
  return {
    approved: true,
    gasCostNative: 0,
    gasCostQuote: 0,
    gasPriceGwei: 1,
    gasPriceRaw: ethers.utils.parseUnits('1', 'gwei'),
    ...overrides,
  };
}

function calldataQuoteEvaluation(
  overrides: Partial<ExternalTakeQuoteEvaluation> = {}
): BoundExternalTakeRouteEvaluation {
  return {
    isTakeable: true,
    externalTakePath: 'calldata_aggregator',
    selectedLiquiditySource: LiquiditySource.LIFI,
    providerId: 'lifi',
    calldataQuote: {} as any,
    quoteAmount: 125,
    quoteAmountRaw: raw(125),
    collateralAmount: 1,
    routeExecutionFloorRaw: raw(105),
    ...overrides,
  } as BoundExternalTakeRouteEvaluation;
}

function directDexQuoteEvaluation(
  overrides: Partial<ExternalTakeQuoteEvaluation> = {}
): BoundExternalTakeRouteEvaluation {
  return {
    isTakeable: true,
    externalTakePath: 'direct_dex',
    selectedLiquiditySource: LiquiditySource.UNISWAPV3,
    selectedFeeTier: 3000,
    quoteAmount: 125,
    quoteAmountRaw: raw(125),
    collateralAmount: 1,
    routeExecutionFloorRaw: raw(105),
    ...overrides,
  } as BoundExternalTakeRouteEvaluation;
}

function applyPolicy(overrides: Partial<ProfitabilityPolicyParams> = {}): {
  result: ExternalTakeApprovalResult;
  stats: Pick<ProfitabilityPolicyParams['stats'], 'profitFloorRejects'>;
  bindExecutionRoute: sinon.SinonStub;
} {
  const quoteEvaluation =
    overrides.quoteEvaluation ?? calldataQuoteEvaluation();
  const stats = overrides.stats ?? { profitFloorRejects: 0 };
  const bindExecutionRoute =
    (overrides.bindExecutionRoute as sinon.SinonStub | undefined) ??
    sinon.stub().callsFake((evaluation: ExternalTakeQuoteEvaluation) => ({
      approved: true,
      quoteEvaluation: evaluation as BoundExternalTakeRouteEvaluation,
    }));

  const result = applyDiscoveryApprovalProfitabilityPolicy({
    quoteEvaluation,
    selectedLiquiditySource:
      overrides.selectedLiquiditySource ??
      quoteEvaluation.selectedLiquiditySource,
    target: target(),
    takePolicy: takePolicy(),
    gasPolicy: gasPolicy(),
    auctionCostQuoteRaw: raw(100),
    routeGasLimit: raw(900000),
    minExpectedProfitQuoteRaw: raw(10),
    gasCostQuoteRaw: raw(5),
    quoteAmountRaw: quoteEvaluation.quoteAmountRaw,
    price: 100,
    approvalMode: 'strict_hybrid',
    countStats: true,
    stats,
    bindExecutionRoute,
    ...overrides,
  });

  return { result, stats, bindExecutionRoute };
}

describe('Discovery external take profitability policy', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('ceil-converts auction cost from WAD into quote-token raw units', () => {
    const cost = getAuctionCostQuoteRaw({
      price: ethers.utils.parseEther('1.23456789'),
      collateral: ethers.utils.parseEther('2'),
      quoteTokenDecimals: 6,
    });

    expect(cost.eq(BigNumber.from(2469136))).to.equal(true);
  });

  it('does not build simple profitability without a raw quote amount', () => {
    expect(
      buildSimpleQuoteProfitability({
        quoteEvaluation: { isTakeable: true },
        auctionCostQuoteRaw: raw(100),
        routeGasLimit: raw(900000),
      })
    ).to.equal(undefined);
  });

  it('defaults simple route gas cost to zero and clamps shortfall/net profit', () => {
    const profitability = buildSimpleQuoteProfitability({
      quoteEvaluation: {
        isTakeable: true,
        quoteAmountRaw: raw(90),
        routeProfitability: {
          auctionRepayRequirementQuoteRaw: raw(95),
        },
      },
      auctionCostQuoteRaw: raw(100),
      routeGasLimit: raw(900000),
    });

    expect(profitability?.auctionRepayRequirementQuoteRaw?.eq(raw(95))).to.equal(
      true
    );
    expect(profitability?.routeExecutionCostQuoteRaw?.eq(0)).to.equal(true);
    expect(profitability?.expectedNetProfitQuoteRaw?.eq(0)).to.equal(true);
    expect(profitability?.expectedShortfallQuoteRaw?.eq(raw(10))).to.equal(true);
  });

  it('records simple route gas cost and telemetry for profitable quotes', () => {
    const gasPriceWei = ethers.utils.parseUnits('1', 'gwei');
    const profitability = buildSimpleQuoteProfitability({
      quoteEvaluation: {
        isTakeable: true,
        quoteAmountRaw: raw(130),
      },
      auctionCostQuoteRaw: raw(100),
      routeGasLimit: raw(900000),
      gasCostQuoteRaw: raw(5),
      gasPriceRaw: gasPriceWei,
      gasPriceGwei: 1,
      gasPriceAgeMs: 25,
      gasPriceFreshnessTtlMs: 5000,
      l2GasCostBufferBasisPoints: 13000,
    });

    expect(profitability?.auctionRepayRequirementQuoteRaw?.eq(raw(100))).to.equal(
      true
    );
    expect(profitability?.routeExecutionCostQuoteRaw?.eq(raw(5))).to.equal(true);
    expect(profitability?.expectedNetProfitQuoteRaw?.eq(raw(25))).to.equal(true);
    expect(profitability?.expectedShortfallQuoteRaw?.eq(0)).to.equal(true);
    expect(profitability?.gasPriceWei?.eq(gasPriceWei)).to.equal(true);
    expect(profitability?.gasPriceGwei).to.equal(1);
    expect(profitability?.gasPriceAgeMs).to.equal(25);
    expect(profitability?.gasPriceFreshnessTtlMs).to.equal(5000);
    expect(profitability?.l2GasCostBufferBasisPoints).to.equal(13000);
    expect(profitability?.gasPolicyEvaluatedAt).to.be.a('number');
  });

  it('approves without binding when no raw route policy or profit floor is configured', () => {
    const quoteEvaluation = calldataQuoteEvaluation();
    const bindExecutionRoute = sinon.stub().throws(new Error('should not bind'));
    const { result, stats } = applyPolicy({
      quoteEvaluation,
      quoteAmountRaw: undefined,
      auctionCostQuoteRaw: undefined,
      gasCostQuoteRaw: undefined,
      minExpectedProfitQuoteRaw: raw(0),
      takePolicy: takePolicy(),
      bindExecutionRoute:
        bindExecutionRoute as unknown as ProfitabilityPolicyParams['bindExecutionRoute'],
    });

    expect(result.approved).to.equal(true);
    if (result.approved) {
      expect(result.quoteEvaluation).to.equal(quoteEvaluation);
    }
    expect(bindExecutionRoute.called).to.equal(false);
    expect(stats.profitFloorRejects).to.equal(0);
  });

  it('rejects minProfitNative when quote-normalized raw floor is unavailable', () => {
    const { result, stats, bindExecutionRoute } = applyPolicy({
      quoteAmountRaw: undefined,
      auctionCostQuoteRaw: undefined,
      gasCostQuoteRaw: undefined,
      takePolicy: takePolicy({ minProfitNative: '1000000000000000' }),
    });

    expect(result).to.deep.include({
      approved: false,
      reason: 'quote-normalized minProfitNative floor is not available',
      rejectCategory: 'profitFloor',
    });
    expect(stats.profitFloorRejects).to.equal(1);
    expect(bindExecutionRoute.called).to.equal(false);
  });

  it('rejects quote-normalized expected profit below the configured floor', () => {
    const { result, stats, bindExecutionRoute } = applyPolicy({
      quoteEvaluation: calldataQuoteEvaluation({
        quoteAmount: 104,
        collateralAmount: 1,
      }),
      quoteAmountRaw: undefined,
      auctionCostQuoteRaw: undefined,
      gasCostQuoteRaw: undefined,
      takePolicy: takePolicy({ minExpectedProfitQuote: 10 }),
      gasPolicy: gasPolicy({ gasCostQuote: 1 }),
      countStats: false,
    });

    expect(result).to.deep.include({
      approved: false,
      reason: 'expected take profit 3.000000 below minExpectedProfitQuote 10',
      rejectCategory: 'profitFloor',
    });
    expect(stats.profitFloorRejects).to.equal(0);
    expect(bindExecutionRoute.called).to.equal(false);
  });

  it('approves quote-normalized expected profit when it clears the configured floor', () => {
    const quoteEvaluation = calldataQuoteEvaluation({
      quoteAmount: 111,
      collateralAmount: 1,
    });
    const bindExecutionRoute = sinon.stub().throws(new Error('should not bind'));
    const { result, stats } = applyPolicy({
      quoteEvaluation,
      quoteAmountRaw: undefined,
      auctionCostQuoteRaw: undefined,
      gasCostQuoteRaw: undefined,
      takePolicy: takePolicy({ minExpectedProfitQuote: 10 }),
      gasPolicy: gasPolicy({ gasCostQuote: 1 }),
      bindExecutionRoute:
        bindExecutionRoute as unknown as ProfitabilityPolicyParams['bindExecutionRoute'],
    });

    expect(result.approved).to.equal(true);
    if (result.approved) {
      expect(result.quoteEvaluation).to.equal(quoteEvaluation);
    }
    expect(bindExecutionRoute.called).to.equal(false);
    expect(stats.profitFloorRejects).to.equal(0);
  });

  it('rejects quote-normalized expected profit when decimal quote context is missing', () => {
    const { result, stats, bindExecutionRoute } = applyPolicy({
      quoteEvaluation: calldataQuoteEvaluation({
        quoteAmount: undefined,
        collateralAmount: undefined,
      }),
      quoteAmountRaw: undefined,
      auctionCostQuoteRaw: undefined,
      gasCostQuoteRaw: undefined,
      takePolicy: takePolicy({ minExpectedProfitQuote: 1 }),
      gasPolicy: gasPolicy({ gasCostQuote: 0 }),
    });

    expect(result).to.deep.include({
      approved: false,
      reason: 'expected take profit 0.000000 below minExpectedProfitQuote 1',
      rejectCategory: 'profitFloor',
    });
    expect(stats.profitFloorRejects).to.equal(1);
    expect(bindExecutionRoute.called).to.equal(false);
  });

  it('rejects raw aggregator approval when hybrid fallback lacks gas quote cost', () => {
    const { result, stats, bindExecutionRoute } = applyPolicy({
      approvalMode: HYBRID_GAS_QUOTE_FALLBACK_KIND,
      gasCostQuoteRaw: undefined,
    });

    expect(result).to.deep.include({
      approved: false,
      reason: 'route profitability context missing raw policy inputs',
      rejectCategory: 'profitFloor',
    });
    expect(stats.profitFloorRejects).to.equal(1);
    expect(bindExecutionRoute.called).to.equal(false);
  });

  it('rejects raw aggregator quotes below the route-derived profit floor', () => {
    const { result, stats, bindExecutionRoute } = applyPolicy({
      quoteEvaluation: calldataQuoteEvaluation({
        quoteAmountRaw: raw(112),
      }),
      quoteAmountRaw: raw(112),
    });

    expect(result).to.deep.include({
      approved: false,
      reason: EXTERNAL_TAKE_REJECTION_REASONS.routeQuoteBelowRequiredOutputFloor,
      rejectCategory: 'profitFloor',
    });
    expect(stats.profitFloorRejects).to.equal(1);
    expect(bindExecutionRoute.called).to.equal(false);
  });

  it('binds raw aggregator approvals with merged route profitability floors', () => {
    const { result, stats, bindExecutionRoute } = applyPolicy();

    expect(result.approved).to.equal(true);
    expect(stats.profitFloorRejects).to.equal(0);
    expect(bindExecutionRoute.calledOnce).to.equal(true);
    const approvedEvaluation = bindExecutionRoute.firstCall
      .args[0] as ExternalTakeQuoteEvaluation;
    expect(approvedEvaluation.profitMinOutRaw?.eq(raw(115))).to.equal(true);
    expect(approvedEvaluation.routeExecutionFloorRaw?.eq(raw(115))).to.equal(
      true
    );
    expect(approvedEvaluation.approvedMinOutRaw?.eq(raw(115))).to.equal(true);
    expect(
      approvedEvaluation.routeProfitability?.routeExecutionCostQuoteRaw?.eq(
        raw(5)
      )
    ).to.equal(true);
    expect(approvedEvaluation.routeProfitability?.gasPriceGwei).to.equal(1);
  });

  it('keeps explicit aggregator route min-out above the derived profit floor', () => {
    const { result, bindExecutionRoute } = applyPolicy({
      quoteEvaluation: calldataQuoteEvaluation({
        routeMinOutRaw: raw(120),
        routeExecutionFloorRaw: raw(140),
      }),
    });

    expect(result.approved).to.equal(true);
    const approvedEvaluation = bindExecutionRoute.firstCall
      .args[0] as ExternalTakeQuoteEvaluation;
    expect(approvedEvaluation.routeMinOutRaw?.eq(raw(120))).to.equal(true);
    expect(approvedEvaluation.approvedMinOutRaw?.eq(raw(120))).to.equal(true);
  });

  it('does not reuse stale profit min-out as an aggregator route slippage floor', () => {
    const { result, bindExecutionRoute } = applyPolicy({
      quoteEvaluation: calldataQuoteEvaluation({
        profitMinOutRaw: raw(140),
        routeExecutionFloorRaw: raw(140),
      }),
    });

    expect(result.approved).to.equal(true);
    const approvedEvaluation = bindExecutionRoute.firstCall
      .args[0] as ExternalTakeQuoteEvaluation;
    expect(approvedEvaluation.routeMinOutRaw).to.equal(undefined);
    expect(approvedEvaluation.profitMinOutRaw?.eq(raw(115))).to.equal(true);
    expect(approvedEvaluation.approvedMinOutRaw?.eq(raw(115))).to.equal(true);
  });

  it('rejects direct DEX quotes after refreshing route profitability floors', () => {
    const { result, stats, bindExecutionRoute } = applyPolicy({
      quoteEvaluation: directDexQuoteEvaluation({
        quoteAmountRaw: raw(112),
      }),
      selectedLiquiditySource: LiquiditySource.UNISWAPV3,
      selectedDirectDexLiquiditySource: LiquiditySource.UNISWAPV3,
      quoteAmountRaw: raw(112),
    });

    expect(result).to.deep.include({
      approved: false,
      reason: EXTERNAL_TAKE_REJECTION_REASONS.routeQuoteBelowRequiredOutputFloor,
      rejectCategory: 'profitFloor',
    });
    expect(stats.profitFloorRejects).to.equal(1);
    expect(bindExecutionRoute.called).to.equal(false);
  });

  it('binds direct DEX hybrid fallback approvals with zero execution cost when gas quote is unavailable', () => {
    const { result, bindExecutionRoute } = applyPolicy({
      quoteEvaluation: directDexQuoteEvaluation({
        quoteAmountRaw: raw(112),
      }),
      selectedLiquiditySource: LiquiditySource.UNISWAPV3,
      selectedDirectDexLiquiditySource: LiquiditySource.UNISWAPV3,
      approvalMode: HYBRID_GAS_QUOTE_FALLBACK_KIND,
      gasCostQuoteRaw: undefined,
      minExpectedProfitQuoteRaw: raw(1),
      quoteAmountRaw: raw(112),
    });

    expect(result.approved).to.equal(true);
    expect(bindExecutionRoute.calledOnce).to.equal(true);
    const approvedEvaluation = bindExecutionRoute.firstCall
      .args[0] as ExternalTakeQuoteEvaluation;
    expect(
      approvedEvaluation.routeProfitability?.routeExecutionCostQuoteRaw?.eq(0)
    ).to.equal(true);
    expect(approvedEvaluation.approvedMinOutRaw?.eq(raw(102))).to.equal(true);
  });

  it('rejects direct DEX quotes that lose the takeable flag even without a route reason', () => {
    const { result, stats, bindExecutionRoute } = applyPolicy({
      quoteEvaluation: directDexQuoteEvaluation({
        isTakeable: false,
        quoteAmountRaw: undefined,
      }),
      selectedLiquiditySource: LiquiditySource.UNISWAPV3,
      selectedDirectDexLiquiditySource: LiquiditySource.UNISWAPV3,
      quoteAmountRaw: raw(130),
      gasCostQuoteRaw: raw(0),
      minExpectedProfitQuoteRaw: raw(0),
    });

    expect(result).to.deep.include({
      approved: false,
      reason: EXTERNAL_TAKE_REJECTION_REASONS.routeQuoteBelowRequiredOutputFloor,
      rejectCategory: 'profitFloor',
    });
    expect(stats.profitFloorRejects).to.equal(1);
    expect(bindExecutionRoute.called).to.equal(false);
  });

  it('allows explicitly subsidized direct DEX quotes that repay and clear the market floor', () => {
    const { result, bindExecutionRoute } = applyPolicy({
      quoteEvaluation: directDexQuoteEvaluation({
        quoteAmountRaw: raw(103),
      }),
      selectedLiquiditySource: LiquiditySource.UNISWAPV3,
      selectedDirectDexLiquiditySource: LiquiditySource.UNISWAPV3,
      target: target({ allowSubsidy: true }),
      quoteAmountRaw: raw(103),
    });

    expect(result.approved).to.equal(true);
    expect(bindExecutionRoute.calledOnce).to.equal(true);
    const approvedEvaluation = bindExecutionRoute.firstCall
      .args[0] as ExternalTakeQuoteEvaluation;
    expect(approvedEvaluation.approvedMinOutRaw?.eq(raw(100))).to.equal(true);
    expect(
      approvedEvaluation.routeProfitability?.expectedSubsidyQuoteRaw?.eq(
        raw(12)
      )
    ).to.equal(true);
    expect(approvedEvaluation.routeProfitability?.subsidyAllowed).to.equal(
      true
    );
  });
});
