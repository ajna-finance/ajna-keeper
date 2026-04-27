import { expect } from 'chai';
import { BigNumber } from 'ethers';
import {
  EXTERNAL_TAKE_REJECTION_REASONS,
  applyExternalTakeRoutePolicy,
} from '../take/external-take-policy';

const raw = (value: number): BigNumber => BigNumber.from(value);

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
});
