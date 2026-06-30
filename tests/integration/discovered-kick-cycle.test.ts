import './subgraph-mock';
import subgraphModule from '../../src/subgraph';
import { AjnaSDK, FungiblePool } from '@ajna-finance/sdk';
import { constants, Contract, Wallet } from 'ethers';
import { expect } from 'chai';
import { configureAjna } from '../../src/config';
import { MAINNET_CONFIG } from './test-config';
import {
  getProvider,
  resetHardhat,
  increaseTime,
  setBalance,
} from './test-utils';
import { depositQuoteToken, drawDebt } from './loan-helpers';
import {
  makeGetLoansFromSdk,
  overrideGetLoans,
  makeGetHighestMeaningfulBucket,
  overrideGetHighestMeaningfulBucket,
} from './subgraph-mock';
import { kick } from '../../src/kick';
import {
  runDiscoveredKickCycle,
  KickPoolHydration,
} from '../../src/kick-cycle';
import { decimaledToWei, weiToDecimaled } from '../../src/utils';
import { SECONDS_PER_YEAR } from '../../src/constants';
import { NonceTracker } from '../../src/nonce';

const POOL = MAINNET_CONFIG.SOL_WETH_POOL;
const WETH_ABI = ['function deposit() payable'];

async function createFundedQuoteWallet(
  amount: ReturnType<typeof decimaledToWei>
): Promise<Wallet> {
  const wallet = Wallet.createRandom().connect(getProvider());
  await setBalance(wallet.address, decimaledToWei(100).toHexString());
  const weth = new Contract(POOL.quoteAddress, WETH_ABI, wallet);
  await (await weth.deposit({ value: amount })).wait();
  return wallet;
}

// End-to-end discovered kick cycle on a mainnet fork: a real kickable loan is
// hydrated from real on-chain pool reads and kicked through the shared executor
// (eligibility + liveness + budget). The chain-wide query and the market price
// are stubbed (the price stub avoids the live Alchemy dependency); pool/loan
// hydration and the kick itself are real.
describe('runDiscoveredKickCycle on a fork', function () {
  this.timeout(600000);
  beforeEach(async () => {
    await resetHardhat();
    NonceTracker.clearNonces();
  });

  it('kicks a real kickable loan end-to-end through the shared executor', async () => {
    configureAjna(MAINNET_CONFIG.AJNA_CONFIG);
    const pool: FungiblePool = await new AjnaSDK(
      getProvider()
    ).fungiblePoolFactory.getPoolByAddress(POOL.poolConfig.address);
    overrideGetLoans(makeGetLoansFromSdk(pool));
    overrideGetHighestMeaningfulBucket(makeGetHighestMeaningfulBucket(pool));

    await depositQuoteToken({
      pool,
      owner: POOL.quoteWhaleAddress,
      amount: 1,
      price: 0.07,
    });
    await drawDebt({
      pool,
      owner: POOL.collateralWhaleAddress,
      amountToBorrow: 0.9,
      collateralToPledge: 14,
    });
    await increaseTime(SECONDS_PER_YEAR * 2); // accrue -> kickable
    NonceTracker.clearNonces();

    const borrower = POOL.collateralWhaleAddress;
    const loan = await pool.getLoan(borrower);
    const np = Number(weiToDecimaled(loan.neutralPrice));
    const prices = await pool.getPrices();
    const hpb = Number(weiToDecimaled(prices.hpb));
    // Liveness requires the HMB bucket price (== hpb here) to be <= NP.
    expect(np, 'NP should be >= HPB so the liveness gate can pass').to.be.gte(
      hpb
    );
    // A low market price clears the reward margin (NP*priceFactor >= market) and
    // the arb-room check (market < hmb*hpbPriceFactor).
    const marketPrice = np * 0.25;

    const kicker = await createFundedQuoteWallet(decimaledToWei(2));

    // Real per-pool hydration (getPrices / kickerInfo / HMB), matching run.ts.
    const hydratePool = async (
      poolAddress: string
    ): Promise<KickPoolHydration | undefined> => {
      const [p, kickerInfo] = await Promise.all([
        pool.getPrices(),
        pool.kickerInfo(await kicker.getAddress()),
      ]);
      const minDeposit = String(
        (POOL.poolConfig.take.minCollateral ?? 1e-8) / hpb
      );
      const { buckets } = await subgraphModule.getHighestMeaningfulBucket(
        '',
        poolAddress,
        minDeposit
      );
      const hmbPrice =
        buckets.length > 0
          ? Number(weiToDecimaled(pool.getBucketByIndex(buckets[0].bucketIndex).price))
          : undefined;
      return {
        poolAddress,
        lup: p.lup,
        hpb: p.hpb,
        hmbPrice,
        lockedBondQuote: weiToDecimaled(kickerInfo.locked),
      };
    };

    let kicked = 0;
    const report = await runDiscoveredKickCycle({
      subgraph: {
        getChainwideKickableLoans: async () => ({
          loans: [
            {
              id: `${pool.poolAddress}-${borrower}`,
              borrower,
              thresholdPrice: weiToDecimaled(loan.thresholdPrice),
              pool: { id: pool.poolAddress },
            },
          ],
        }),
      } as any,
      kickPolicy: { enabled: true, maxBondExposure: 100 },
      kickDefaults: { minDebt: 0, priceFactor: 0.9 },
      takeDefaults: {
        hpbPriceFactor: POOL.poolConfig.take.hpbPriceFactor ?? 0.99,
      },
      hydratePool,
      hydrateLoan: async () => {
        const l = await pool.getLoan(borrower);
        return {
          thresholdPrice: l.thresholdPrice,
          debt: l.debt,
          neutralPrice: l.neutralPrice,
          liquidationBond: l.liquidationBond,
          marketPrice,
        };
      },
      kickLoan: async (_pool, b, liquidationBond, marginPrice) => {
        await kick({
          pool,
          signer: kicker,
          loanToKick: {
            borrower: b,
            liquidationBond,
            estimatedRemainingBond: liquidationBond,
            limitPrice: marginPrice,
          },
          config: { dryRun: false },
        });
        kicked += 1;
      },
    });

    expect(report.candidatesConsidered).to.equal(1);
    expect(report.poolsConsidered).to.equal(1);
    expect(report.kicked, `cycle should kick; skips=${JSON.stringify(report.skippedByReason)}`).to.equal(
      1
    );
    expect(kicked).to.equal(1);

    NonceTracker.clearNonces();
    const kickedLoan = await pool.getLoan(borrower);
    expect(kickedLoan.isKicked, 'loan should now be in auction').to.be.true;
    const { locked } = await pool.kickerInfo(await kicker.getAddress());
    expect(locked.gt(constants.Zero), 'kicker bond locked').to.be.true;
  });
});
