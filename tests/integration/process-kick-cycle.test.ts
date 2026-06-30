import './subgraph-mock';
import * as alchemyModule from '../../src/pricing/alchemy';
import { AjnaSDK, FungiblePool } from '@ajna-finance/sdk';
import { Wallet, constants } from 'ethers';
import { expect } from 'chai';
import { configureAjna, KeeperConfig, PriceOriginSource } from '../../src/config';
import { MAINNET_CONFIG } from './test-config';
import { getProvider, resetHardhat, increaseTime } from './test-utils';
import {
  createFundedQuoteWallet,
  depositQuoteToken,
  drawDebt,
} from './loan-helpers';
import {
  makeGetLoansFromSdk,
  overrideGetLoans,
  makeGetHighestMeaningfulBucket,
} from './subgraph-mock';
import { processKickCycle } from '../../src/run';
import { SubgraphReader } from '../../src/read-transports';
import { PoolMap, PoolHydrationCooldowns } from '../../src/discovery/targets';
import { PriceUnavailableError } from '../../src/pricing/price-guard';
import { decimaledToWei, weiToDecimaled } from '../../src/utils';
import { SECONDS_PER_YEAR } from '../../src/constants';
import { NonceTracker } from '../../src/nonce';

const POOL = MAINNET_CONFIG.SOL_WETH_POOL;
const BORROWER = POOL.collateralWhaleAddress;

// Restore getPoolPriceFromAlchemy after each test. The export is accessed via
// the module namespace at call time (CommonJS), so reassigning it stubs the
// price seam without a live Alchemy call — the same technique overrideGetLoans
// uses for the subgraph module.
type AlchemyFn = typeof alchemyModule.getPoolPriceFromAlchemy;
function stubAlchemyPrice(fn: AlchemyFn): () => void {
  const original = alchemyModule.getPoolPriceFromAlchemy;
  (alchemyModule as { getPoolPriceFromAlchemy: AlchemyFn }).getPoolPriceFromAlchemy =
    fn;
  return () => {
    (alchemyModule as { getPoolPriceFromAlchemy: AlchemyFn }).getPoolPriceFromAlchemy =
      original;
  };
}

async function setupUnkickedFixture(): Promise<{
  pool: FungiblePool;
  kicker: Wallet;
  np: number;
}> {
  configureAjna(MAINNET_CONFIG.AJNA_CONFIG);
  const pool: FungiblePool = await new AjnaSDK(
    getProvider()
  ).fungiblePoolFactory.getPoolByAddress(POOL.poolConfig.address);
  overrideGetLoans(makeGetLoansFromSdk(pool));

  await depositQuoteToken({
    pool,
    owner: POOL.quoteWhaleAddress,
    amount: 1,
    price: 0.07,
  });
  await drawDebt({
    pool,
    owner: BORROWER,
    amountToBorrow: 0.9,
    collateralToPledge: 14,
  });
  // Accrue interest so TP > LUP -> kickable, but DO NOT kick: the discovered
  // step is what should kick it.
  await increaseTime(SECONDS_PER_YEAR * 2);
  NonceTracker.clearNonces();

  const kicker = await createFundedQuoteWallet(
    decimaledToWei(2),
    POOL.quoteAddress
  );
  const loan = await pool.getLoan(BORROWER);
  return { pool, kicker, np: Number(weiToDecimaled(loan.neutralPrice)) };
}

// SubgraphReader stub: only getChainwideKickableLoans (the discovery source) and
// getHighestMeaningfulBucket (HMB, from the on-chain pool) are exercised by the
// discovered kick step; the rest is unused on this path.
function buildSubgraph(pool: FungiblePool): SubgraphReader {
  const hmb = makeGetHighestMeaningfulBucket(pool);
  return {
    getChainwideKickableLoans: async () => {
      const loan = await pool.getLoan(BORROWER);
      if (loan.isKicked) {
        return { loans: [] };
      }
      return {
        loans: [
          {
            id: `${pool.poolAddress}-${BORROWER}`,
            borrower: BORROWER,
            thresholdPrice: weiToDecimaled(loan.thresholdPrice),
            pool: { id: pool.poolAddress },
          },
        ],
      };
    },
    getHighestMeaningfulBucket: (poolAddress: string, minDeposit: string) =>
      hmb('', poolAddress, minDeposit),
  } as unknown as SubgraphReader;
}

// A KeeperConfig sufficient for processKickCycle's discovered path. Only the
// fields this path reads are meaningful (cast covers the unrelated rest).
function buildConfig(opts: {
  dryRun?: boolean;
  dryRunNewPools?: boolean;
  poolIsManual?: boolean;
}): KeeperConfig {
  return {
    network: {
      rpcUrl: 'http://127.0.0.1:8545',
      subgraph: { url: '' },
      tokenAddresses: {},
    },
    signer: { keystore: '' },
    runtime: { dryRun: opts.dryRun ?? false, logLevel: 'info', delayBetweenRuns: 1 },
    pricing: { coinGeckoApiKey: '' },
    discovery: {
      enabled: true,
      kick: { enabled: true, maxBondExposure: 1_000_000 },
      dryRunNewPools: opts.dryRunNewPools ?? false,
      defaults: {
        take: { minCollateral: 0.01, hpbPriceFactor: 0.99 },
        kick: { enabled: true, minDebt: 0, priceFactor: 0.99 },
      },
    },
    ajna: MAINNET_CONFIG.AJNA_CONFIG,
    manual: {
      // A manual pool entry WITHOUT a kick block: the manual loop skips it
      // (not kick-enabled), but the discovered step's manual-wins dedup still
      // excludes it.
      pools: opts.poolIsManual
        ? [
            {
              name: 'SOL/WETH (manual)',
              address: POOL.poolConfig.address,
              price: { source: PriceOriginSource.FIXED, value: 0.075 },
              take: { minCollateral: 0.01, hpbPriceFactor: 0.99 },
            },
          ]
        : [],
    },
  } as unknown as KeeperConfig;
}

async function runProcessKickCycle(
  pool: FungiblePool,
  kicker: Wallet,
  config: KeeperConfig
): Promise<void> {
  // Pre-seed the pool so ensurePoolLoaded short-circuits (no factory check).
  const poolMap: PoolMap = new Map();
  poolMap.set(pool.poolAddress, pool);
  poolMap.set(pool.poolAddress.toLowerCase(), pool);
  const hydrationCooldowns: PoolHydrationCooldowns = new Map();
  await processKickCycle({
    poolMap,
    config,
    signer: kicker,
    chainId: 1,
    subgraph: buildSubgraph(pool),
    ajna: new AjnaSDK(getProvider()),
    hydrationCooldowns,
  });
  NonceTracker.clearNonces();
}

async function kickTimeOf(pool: FungiblePool): Promise<boolean> {
  const { kickTime_ } = await pool.contract.auctionInfo(BORROWER);
  return kickTime_.gt(constants.Zero);
}

describe('processKickCycle discovered-step glue (fork)', function () {
  this.timeout(600000);
  let restoreAlchemy: (() => void) | undefined;

  beforeEach(async () => {
    await resetHardhat();
    NonceTracker.clearNonces();
  });
  afterEach(() => {
    restoreAlchemy?.();
    restoreAlchemy = undefined;
  });

  it('prices via Alchemy and kicks a discovered loan end-to-end (live)', async () => {
    const { pool, kicker, np } = await setupUnkickedFixture();
    restoreAlchemy = stubAlchemyPrice(async () => np * 0.25);

    await runProcessKickCycle(pool, kicker, buildConfig({ dryRun: false }));

    expect(await kickTimeOf(pool), 'loan should be kicked').to.be.true;
    const { locked } = await pool.kickerInfo(kicker.address);
    expect(locked.gt(constants.Zero), 'kicker bond posted').to.be.true;
  });

  it('dryRunNewPools gates the kick: same candidate is evaluated but not kicked', async () => {
    const { pool, kicker, np } = await setupUnkickedFixture();
    restoreAlchemy = stubAlchemyPrice(async () => np * 0.25);

    await runProcessKickCycle(
      pool,
      kicker,
      buildConfig({ dryRun: false, dryRunNewPools: true })
    );

    expect(await kickTimeOf(pool), 'loan should NOT be kicked under dry-run').to
      .be.false;
  });

  it('manual-wins dedup: a manually configured pool is not discovered-kicked', async () => {
    const { pool, kicker, np } = await setupUnkickedFixture();
    restoreAlchemy = stubAlchemyPrice(async () => np * 0.25);

    await runProcessKickCycle(
      pool,
      kicker,
      buildConfig({ dryRun: false, poolIsManual: true })
    );

    expect(await kickTimeOf(pool), 'manual pool should be skipped by discovery').to
      .be.false;
  });

  it('fails closed on an unavailable Alchemy price (no kick)', async () => {
    const { pool, kicker } = await setupUnkickedFixture();
    restoreAlchemy = stubAlchemyPrice(async () => {
      throw new PriceUnavailableError('test: price unavailable');
    });

    await runProcessKickCycle(pool, kicker, buildConfig({ dryRun: false }));

    expect(await kickTimeOf(pool), 'no kick without a usable price').to.be.false;
  });
});
