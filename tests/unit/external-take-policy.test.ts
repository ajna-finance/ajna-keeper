import { expect } from 'chai';
import { BigNumber, ethers } from 'ethers';
import {
  EXTERNAL_TAKE_REJECTION_REASONS,
  applyExternalTakeRoutePolicy,
  mergeRoutePolicyIntoEvaluation,
} from '../../src/take/external-take/policy';

const raw = (value: number): BigNumber => BigNumber.from(value);
const usdc = (value: string): BigNumber => ethers.utils.parseUnits(value, 18);

describe('External take route policy', () => {
  it('approves profitable non-subsidized routes and carries the profit floor into min-out', () => {
    const policy = applyExternalTakeRoutePolicy({
      configuredMarketPriceFactor: 0.99,
      allowSubsidy: false,
      quoteAmountRaw: raw(125),
      quoteDueRaw: raw(100),
      marketFactorFloorQuoteRaw: raw(102),
      routeExecutionCostQuoteRaw: raw(5),
      configuredProfitFloorQuoteRaw: raw(10),
    });

    expect(policy.isEconomicallyExecutable).to.equal(true);
    expect(policy.requiredNonSubsidizedOutputRaw.eq(raw(115))).to.equal(true);
    expect(policy.approvedMinOutRaw.eq(raw(115))).to.equal(true);
    expect(policy.expectedNetProfitQuoteRaw.eq(raw(20))).to.equal(true);
    expect(policy.expectedShortfallQuoteRaw.eq(0)).to.equal(true);
    expect(policy.expectedSubsidyQuoteRaw.eq(0)).to.equal(true);
  });

  it('rejects non-subsidized routes below the gas/profit-adjusted output floor', () => {
    const policy = applyExternalTakeRoutePolicy({
      configuredMarketPriceFactor: 0.99,
      allowSubsidy: false,
      quoteAmountRaw: raw(112),
      quoteDueRaw: raw(100),
      marketFactorFloorQuoteRaw: raw(102),
      routeExecutionCostQuoteRaw: raw(5),
      configuredProfitFloorQuoteRaw: raw(10),
    });

    expect(policy.isEconomicallyExecutable).to.equal(false);
    expect(policy.rejectionReason).to.equal(
      EXTERNAL_TAKE_REJECTION_REASONS.routeQuoteBelowRequiredOutputFloor
    );
    expect(policy.approvedMinOutRaw.eq(raw(115))).to.equal(true);
  });

  it('reports break-even shortfall separately from clamped net profit', () => {
    const policy = applyExternalTakeRoutePolicy({
      configuredMarketPriceFactor: 0.99,
      allowSubsidy: true,
      quoteAmountRaw: raw(103),
      quoteDueRaw: raw(100),
      marketFactorFloorQuoteRaw: raw(102),
      routeExecutionCostQuoteRaw: raw(5),
      configuredProfitFloorQuoteRaw: raw(10),
    });

    expect(policy.isEconomicallyExecutable).to.equal(true);
    expect(policy.expectedNetProfitQuoteRaw.eq(0)).to.equal(true);
    expect(policy.expectedShortfallQuoteRaw.eq(raw(2))).to.equal(true);
    expect(policy.expectedSubsidyQuoteRaw.eq(raw(12))).to.equal(true);
  });

  it('allows explicitly subsidized routes that repay the auction', () => {
    const policy = applyExternalTakeRoutePolicy({
      configuredMarketPriceFactor: 0.99,
      allowSubsidy: true,
      quoteAmountRaw: raw(112),
      quoteDueRaw: raw(100),
      marketFactorFloorQuoteRaw: raw(102),
      routeExecutionCostQuoteRaw: raw(5),
      configuredProfitFloorQuoteRaw: raw(10),
    });

    expect(policy.isEconomicallyExecutable).to.equal(true);
    expect(policy.approvedMinOutRaw.eq(raw(100))).to.equal(true);
    expect(policy.expectedSubsidyQuoteRaw.eq(raw(3))).to.equal(true);
    expect(policy.effectiveMarketPriceFactor).to.equal(0.99);
  });

  it('rejects subsidized routes that cannot repay the auction', () => {
    const policy = applyExternalTakeRoutePolicy({
      configuredMarketPriceFactor: 0.99,
      allowSubsidy: true,
      quoteAmountRaw: raw(99),
      quoteDueRaw: raw(100),
      marketFactorFloorQuoteRaw: raw(102),
    });

    expect(policy.isEconomicallyExecutable).to.equal(false);
    expect(policy.rejectionReason).to.equal(
      EXTERNAL_TAKE_REJECTION_REASONS.routeQuoteBelowRepaymentFloor
    );
  });

  it('rejects subsidized routes below the configured market threshold even when repayment clears', () => {
    const policy = applyExternalTakeRoutePolicy({
      configuredMarketPriceFactor: 0.99,
      allowSubsidy: true,
      quoteAmountRaw: raw(101),
      quoteDueRaw: raw(100),
      marketFactorFloorQuoteRaw: raw(102),
    });

    expect(policy.isEconomicallyExecutable).to.equal(false);
    expect(policy.rejectionReason).to.equal(
      EXTERNAL_TAKE_REJECTION_REASONS.auctionPriceAboveThreshold
    );
  });

  it('keeps route min-out when it is stricter than the policy floor', () => {
    const policy = applyExternalTakeRoutePolicy({
      configuredMarketPriceFactor: 0.99,
      allowSubsidy: true,
      quoteAmountRaw: raw(130),
      quoteDueRaw: raw(100),
      marketFactorFloorQuoteRaw: raw(102),
      routeMinOutRaw: raw(120),
    });

    expect(policy.approvedMinOutRaw.eq(raw(120))).to.equal(true);
    expect(policy.routeMinOutRaw?.eq(raw(120))).to.equal(true);
  });

  it('derives the break-even factor and clamps the effective non-subsidized factor', () => {
    const policy = applyExternalTakeRoutePolicy({
      configuredMarketPriceFactor: 0.99,
      allowSubsidy: false,
      quoteAmountRaw: raw(125),
      quoteDueRaw: raw(100),
      marketFactorFloorQuoteRaw: raw(102),
      routeExecutionCostQuoteRaw: raw(5),
      configuredProfitFloorQuoteRaw: raw(10),
    });

    expect(policy.routeBreakEvenMarketPriceFactor).to.be.closeTo(
      0.869565,
      1e-7
    );
    expect(policy.effectiveMarketPriceFactor).to.be.closeTo(0.869565, 1e-7);
  });

  it('merges policy min-out and profitability telemetry into quote evaluations', () => {
    const policy = applyExternalTakeRoutePolicy({
      configuredMarketPriceFactor: 0.99,
      allowSubsidy: false,
      quoteAmountRaw: raw(130),
      quoteDueRaw: raw(100),
      marketFactorFloorQuoteRaw: raw(102),
      routeExecutionCostQuoteRaw: raw(5),
      configuredProfitFloorQuoteRaw: raw(10),
      nativeProfitFloorQuoteRaw: raw(7),
      slippageRiskBufferQuoteRaw: raw(3),
      routeMinOutRaw: raw(120),
    });

    const merged = mergeRoutePolicyIntoEvaluation({
      evaluation: {
        isTakeable: true,
        marketPrice: 200,
        takeablePrice: 198,
        routeProfitability: {
          gasPolicyEvaluatedAt: 123,
          configuredMarketPriceFactor: 0.5,
        },
      },
      policy,
      auctionRepayRequirementQuoteRaw: raw(100),
      configuredMarketPriceFactor: 0.99,
      marketFactorFloorQuoteRaw: raw(102),
      routeProfitabilityExtras: {
        routeGasLimit: raw(900000),
        gasPriceGwei: 1.5,
      },
    });

    expect(merged.routeMinOutRaw?.eq(raw(120))).to.equal(true);
    expect(merged.profitMinOutRaw?.eq(raw(118))).to.equal(true);
    expect(merged.approvedMinOutRaw?.eq(raw(120))).to.equal(true);
    expect(merged.takeablePrice).to.be.closeTo(169.4914, 0.0001);
    expect(
      merged.routeProfitability?.auctionRepayRequirementQuoteRaw?.eq(raw(100))
    ).to.equal(true);
    expect(
      merged.routeProfitability?.routeExecutionCostQuoteRaw?.eq(raw(5))
    ).to.equal(true);
    expect(
      merged.routeProfitability?.configuredProfitFloorQuoteRaw?.eq(raw(10))
    ).to.equal(true);
    expect(
      merged.routeProfitability?.nativeProfitFloorQuoteRaw?.eq(raw(7))
    ).to.equal(true);
    expect(
      merged.routeProfitability?.slippageRiskBufferQuoteRaw?.eq(raw(3))
    ).to.equal(true);
    expect(merged.routeProfitability?.configuredMarketPriceFactor).to.equal(
      0.99
    );
    expect(
      merged.routeProfitability?.marketFactorFloorQuoteRaw?.eq(raw(102))
    ).to.equal(true);
    expect(
      merged.routeProfitability?.requiredProfitFloorQuoteRaw?.eq(raw(10))
    ).to.equal(true);
    expect(
      merged.routeProfitability?.requiredNonSubsidizedOutputRaw?.eq(raw(118))
    ).to.equal(true);
    expect(
      merged.routeProfitability?.requiredOutputFloorQuoteRaw?.eq(raw(118))
    ).to.equal(true);
    expect(
      merged.routeProfitability?.expectedNetProfitQuoteRaw?.eq(raw(22))
    ).to.equal(true);
    expect(
      merged.routeProfitability?.expectedShortfallQuoteRaw?.eq(raw(0))
    ).to.equal(true);
    expect(
      merged.routeProfitability?.surplusOverFloorQuoteRaw?.eq(raw(12))
    ).to.equal(true);
    expect(merged.routeProfitability?.subsidyAllowed).to.equal(false);
    expect(
      merged.routeProfitability?.expectedSubsidyQuoteRaw?.eq(raw(0))
    ).to.equal(true);
    expect(merged.routeProfitability?.gasPolicyEvaluatedAt).to.equal(123);
    expect(merged.routeProfitability?.routeGasLimit?.eq(raw(900000))).to.equal(
      true
    );
    expect(merged.routeProfitability?.gasPriceGwei).to.equal(1.5);
  });

  it('rejects the real CADC first BucketTake point below repayment and market threshold', () => {
    const quoteDue = usdc('5.023934827627184068');
    const marketFactorFloor = quoteDue.mul(100).add(98).div(99);
    const policy = applyExternalTakeRoutePolicy({
      configuredMarketPriceFactor: 0.99,
      allowSubsidy: false,
      quoteAmountRaw: usdc('4.954684377911498'),
      quoteDueRaw: quoteDue,
      marketFactorFloorQuoteRaw: marketFactorFloor,
    });

    expect(policy.isEconomicallyExecutable).to.equal(false);
    expect(policy.rejectionReason).to.equal(
      EXTERNAL_TAKE_REJECTION_REASONS.routeQuoteBelowRepaymentFloor
    );
  });

  it('still rejects the real CADC first BucketTake point if the event bond change is naively credited', () => {
    const quoteDue = usdc('5.023934827627184068');
    const marketFactorFloor = quoteDue.mul(100).add(98).div(99);
    const observedMarketOutput = usdc('4.954684377911498');
    const reportedBondChange = usdc('0.023662955939816372');
    const policy = applyExternalTakeRoutePolicy({
      configuredMarketPriceFactor: 0.99,
      allowSubsidy: false,
      quoteAmountRaw: observedMarketOutput.add(reportedBondChange),
      quoteDueRaw: quoteDue,
      marketFactorFloorQuoteRaw: marketFactorFloor,
    });

    expect(policy.isEconomicallyExecutable).to.equal(false);
    expect(policy.rejectionReason).to.equal(
      EXTERNAL_TAKE_REJECTION_REASONS.routeQuoteBelowRepaymentFloor
    );
  });

  it('approves the real CADC second BucketTake point before gas/profit floors', () => {
    const quoteDue = usdc('3.090554648181740026');
    const quoteAmount = usdc('3.1439176014062675');
    const marketFactorFloor = quoteDue.mul(100).add(98).div(99);
    const policy = applyExternalTakeRoutePolicy({
      configuredMarketPriceFactor: 0.99,
      allowSubsidy: false,
      quoteAmountRaw: quoteAmount,
      quoteDueRaw: quoteDue,
      marketFactorFloorQuoteRaw: marketFactorFloor,
    });

    expect(policy.isEconomicallyExecutable).to.equal(true);
    expect(
      policy.expectedNetProfitQuoteRaw.eq(quoteAmount.sub(quoteDue))
    ).to.equal(true);
  });

  it('rejects the real CADC second BucketTake point when profit or gas floors consume the spread', () => {
    const quoteDue = usdc('3.090554648181740026');
    const quoteAmount = usdc('3.1439176014062675');
    const marketFactorFloor = quoteDue.mul(100).add(98).div(99);
    const profitFloorPolicy = applyExternalTakeRoutePolicy({
      configuredMarketPriceFactor: 0.99,
      allowSubsidy: false,
      quoteAmountRaw: quoteAmount,
      quoteDueRaw: quoteDue,
      marketFactorFloorQuoteRaw: marketFactorFloor,
      configuredProfitFloorQuoteRaw: usdc('0.06'),
    });
    const gasFloorPolicy = applyExternalTakeRoutePolicy({
      configuredMarketPriceFactor: 0.99,
      allowSubsidy: false,
      quoteAmountRaw: quoteAmount,
      quoteDueRaw: quoteDue,
      marketFactorFloorQuoteRaw: marketFactorFloor,
      routeExecutionCostQuoteRaw: usdc('0.054'),
    });

    expect(profitFloorPolicy.isEconomicallyExecutable).to.equal(false);
    expect(gasFloorPolicy.isEconomicallyExecutable).to.equal(false);
    expect(profitFloorPolicy.rejectionReason).to.equal(
      EXTERNAL_TAKE_REJECTION_REASONS.routeQuoteBelowRequiredOutputFloor
    );
    expect(gasFloorPolicy.rejectionReason).to.equal(
      EXTERNAL_TAKE_REJECTION_REASONS.routeQuoteBelowRequiredOutputFloor
    );
  });
});
