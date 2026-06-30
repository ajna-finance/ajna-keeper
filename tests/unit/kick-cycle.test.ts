import { expect } from 'chai';
import sinon from 'sinon';
import { ethers } from 'ethers';
import {
  runDiscoveredKickCycle,
  DiscoveredKickCycleParams,
  KickPoolHydration,
  KickLoanHydration,
} from '../../src/kick/cycle';

const wad = (v: string) => ethers.utils.parseEther(v);

// A pool + loan whose hydrated facts clear every gate (matches the
// kick-candidate base): eligible, live (hmb<=NP, market<hmb*factor), bond fits.
const poolHydration = (
  poolAddress: string,
  overrides: Partial<KickPoolHydration> = {}
): KickPoolHydration => ({
  poolAddress,
  lup: wad('1'),
  hpb: wad('1'),
  hmbPrice: 1,
  lockedBondQuote: 0,
  ...overrides,
});

const loanHydration = (
  overrides: Partial<KickLoanHydration> = {}
): KickLoanHydration => ({
  thresholdPrice: wad('5'),
  debt: wad('10'),
  neutralPrice: wad('2'),
  liquidationBond: wad('1'),
  marketPrice: 0.5,
  ...overrides,
});

function makeParams(
  loans: { borrower: string; pool: string }[],
  overrides: Partial<DiscoveredKickCycleParams> = {}
): { params: DiscoveredKickCycleParams; kickLoan: sinon.SinonStub } {
  const kickLoan = sinon.stub().resolves();
  const params: DiscoveredKickCycleParams = {
    subgraph: {
      getChainwideKickableLoans: sinon.stub().resolves({
        loans: loans.map((l, i) => ({
          id: `loan-${i}`,
          borrower: l.borrower,
          thresholdPrice: 5,
          pool: { id: l.pool },
        })),
      }),
    } as any,
    kickPolicy: { enabled: true, maxBondExposure: 100 },
    kickDefaults: { minDebt: 1, priceFactor: 0.9 },
    takeDefaults: { hpbPriceFactor: 0.9 },
    hydratePool: async (poolAddress) => poolHydration(poolAddress),
    hydrateLoan: async () => loanHydration(),
    kickLoan,
    ...overrides,
  };
  return { params, kickLoan };
}

describe('runDiscoveredKickCycle', () => {
  afterEach(() => sinon.restore());

  it('kicks every eligible+live candidate and reports the totals', async () => {
    const { params, kickLoan } = makeParams([
      { borrower: '0xa', pool: '0xpool1' },
      { borrower: '0xb', pool: '0xpool1' },
    ]);
    const report = await runDiscoveredKickCycle(params);
    expect(report.kicked).to.equal(2);
    expect(report.candidatesConsidered).to.equal(2);
    expect(report.poolsConsidered).to.equal(1);
    expect(kickLoan.callCount).to.equal(2);
  });

  it('groups kickable loans across multiple pools', async () => {
    const { params } = makeParams([
      { borrower: '0xa', pool: '0xpool1' },
      { borrower: '0xb', pool: '0xpool2' },
    ]);
    const report = await runDiscoveredKickCycle(params);
    expect(report.poolsConsidered).to.equal(2);
    expect(report.kicked).to.equal(2);
  });

  it('skips a pool that cannot be hydrated', async () => {
    const { params, kickLoan } = makeParams(
      [
        { borrower: '0xa', pool: '0xpool1' },
        { borrower: '0xb', pool: '0xpool2' },
      ],
      {
        hydratePool: async (poolAddress) =>
          poolAddress === '0xpool2' ? undefined : poolHydration(poolAddress),
      }
    );
    const report = await runDiscoveredKickCycle(params);
    expect(report.poolsSkipped).to.equal(1);
    expect(report.poolsConsidered).to.equal(1);
    expect(report.kicked).to.equal(1);
    expect(kickLoan.callCount).to.equal(1);
  });

  it('records a typed skip reason when a loan cannot be priced', async () => {
    const { params } = makeParams([{ borrower: '0xa', pool: '0xpool1' }], {
      hydrateLoan: async () => undefined,
    });
    const report = await runDiscoveredKickCycle(params);
    expect(report.kicked).to.equal(0);
    expect(report.skippedByReason['price-unavailable']).to.equal(1);
  });

  it('records the gate skip reason from the executor', async () => {
    const { params } = makeParams([{ borrower: '0xa', pool: '0xpool1' }], {
      // collateralized: TP <= LUP
      hydrateLoan: async () => loanHydration({ thresholdPrice: wad('0.5') }),
    });
    const report = await runDiscoveredKickCycle(params);
    expect(report.kicked).to.equal(0);
    expect(report.skippedByReason['collateralized']).to.equal(1);
  });

  it('respects maxPoolsPerRun', async () => {
    const { params, kickLoan } = makeParams(
      [
        { borrower: '0xa', pool: '0xpool1' },
        { borrower: '0xb', pool: '0xpool2' },
        { borrower: '0xc', pool: '0xpool3' },
      ],
      { kickPolicy: { enabled: true, maxBondExposure: 100, maxPoolsPerRun: 2 } }
    );
    const report = await runDiscoveredKickCycle(params);
    expect(report.kicked).to.equal(2);
    expect(kickLoan.callCount).to.equal(2);
  });

  it('enforces the per-pool bond budget across loans in a pool', async () => {
    const { params, kickLoan } = makeParams(
      [
        { borrower: '0xa', pool: '0xpool1' },
        { borrower: '0xb', pool: '0xpool1' },
      ],
      { kickPolicy: { enabled: true, maxBondExposure: 1 } }
    );
    const report = await runDiscoveredKickCycle(params);
    // bond 1 each; cap 1 -> first reserves, second exceeds.
    expect(report.kicked).to.equal(1);
    expect(report.skippedByReason['bond-budget-exceeded']).to.equal(1);
    expect(kickLoan.callCount).to.equal(1);
  });
});
