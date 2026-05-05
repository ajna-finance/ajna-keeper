import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber, constants } from 'ethers';
import { EnabledKickSettings, PoolConfig, PriceOriginSource } from './config';
import {
  getAllowanceOfErc20,
  getBalanceOfErc20,
  getDecimalsErc20,
  convertWadToTokenDecimals,
} from './erc20';
import { logger } from './logging';
import { getPrice } from './pricing';
import {
  decimaledToWei,
  RequireFields,
  tokenChangeDecimals,
  weiToDecimaled,
} from './utils';
import { poolKick, poolQuoteApprove } from './transactions';
import {
  resolveSubgraphConfig,
  SubgraphConfigInput,
  WithSubgraph,
} from './read-transports';
import { invalidateIdleBondCache } from './rewards/collect-bond';

interface KickConfigBase {
  dryRun?: boolean;
  coinGeckoApiKey?: string;
  tokenAddresses?: { [tokenSymbol: string]: string };
  ethRpcUrl?: string;
}

type KickConfig = WithSubgraph<KickConfigBase>;
type KickConfigInput = SubgraphConfigInput<KickConfigBase>;

interface HandleKickParams {
  pool: FungiblePool;
  poolConfig: RequireFields<PoolConfig, 'kick'>;
  signer: Signer;
  config: KickConfigInput;
  chainId?: number;
}

const LIQUIDATION_BOND_MARGIN: number = 0.01; // How much extra margin to allow for liquidationBond. Expressed as a ratio (0 - 1).

const ZERO_ALLOWANCE_CACHE_CYCLES = 10;
const zeroAllowanceCache = new Map<string, number>();

function allowanceCacheKey(poolAddress: string, signerAddress: string): string {
  return `${poolAddress.toLowerCase()}:${signerAddress.toLowerCase()}`;
}

function consumeZeroAllowanceCache(key: string): boolean {
  const remaining = zeroAllowanceCache.get(key);
  if (remaining === undefined || remaining <= 0) {
    zeroAllowanceCache.delete(key);
    return false;
  }
  const next = remaining - 1;
  if (next <= 0) {
    zeroAllowanceCache.delete(key);
  } else {
    zeroAllowanceCache.set(key, next);
  }
  return true;
}

function invalidateZeroAllowanceCache(
  poolAddress: string,
  signerAddress: string
): void {
  zeroAllowanceCache.delete(allowanceCacheKey(poolAddress, signerAddress));
}

export function clearZeroAllowanceCache(): void {
  zeroAllowanceCache.clear();
}

export async function handleKicks({
  pool,
  poolConfig,
  signer,
  config,
  chainId,
}: HandleKickParams) {
  const resolvedConfig = resolveSubgraphConfig(config);
  for await (const loanToKick of getLoansToKick({
    pool,
    poolConfig,
    config: resolvedConfig,
    chainId,
  })) {
    await kick({ signer, pool, loanToKick, config: resolvedConfig });
  }
  await clearAllowances({ pool, signer });
}

interface LoanToKick {
  borrower: string;
  liquidationBond: BigNumber;
  estimatedRemainingBond: BigNumber;
  limitPrice: number;
}

interface GetLoansToKickParams
  extends Pick<HandleKickParams, 'pool' | 'poolConfig' | 'chainId'> {
  config: SubgraphConfigInput<
    Pick<KickConfigBase, 'coinGeckoApiKey' | 'tokenAddresses' | 'ethRpcUrl'>
  >;
}

function assertEnabledKickSettings(
  poolConfig: RequireFields<PoolConfig, 'kick'>
): asserts poolConfig is PoolConfig & { kick: EnabledKickSettings } {
  if (poolConfig.kick.enabled !== true) {
    throw new Error(
      `Kick settings for pool ${poolConfig.name ?? poolConfig.address} require enabled: true to run`
    );
  }
  if (
    poolConfig.kick.minDebt === undefined ||
    poolConfig.kick.priceFactor === undefined
  ) {
    throw new Error(
      `Kick settings for pool ${poolConfig.name ?? poolConfig.address} require minDebt and priceFactor when enabled`
    );
  }
}

export async function* getLoansToKick({
  pool,
  config,
  poolConfig,
  chainId,
}: GetLoansToKickParams): AsyncGenerator<LoanToKick> {
  assertEnabledKickSettings(poolConfig);
  const resolvedConfig = resolveSubgraphConfig(config);
  const { loans } = await resolvedConfig.subgraph.getLoans(pool.poolAddress);
  const loanMap = await pool.getLoans(loans.map(({ borrower }) => borrower));
  const borrowersSortedByBond = Array.from(loanMap.keys()).sort(
    (borrowerA, borrowerB) => {
      const bondA = weiToDecimaled(loanMap.get(borrowerA)!.liquidationBond);
      const bondB = weiToDecimaled(loanMap.get(borrowerB)!.liquidationBond);
      return bondB - bondA;
    }
  );
  const getSumEstimatedBond = (borrowers: string[]) =>
    borrowers.reduce<BigNumber>(
      (sum, borrower) => sum.add(loanMap.get(borrower)!.liquidationBond),
      constants.Zero
    );
  // Fixed and CoinGecko kick references are pool-wide for the duration of a kick pass.
  const staticLimitPrice =
    poolConfig.price.source === PriceOriginSource.POOL
      ? undefined
      : await getPrice(
          poolConfig.price,
          resolvedConfig.coinGeckoApiKey,
          undefined,
          chainId,
          resolvedConfig.ethRpcUrl,
          resolvedConfig.tokenAddresses
        );
  let cachedPoolPrices: Awaited<ReturnType<typeof pool.getPrices>> | undefined;
  const getCachedPoolPrices = async () => {
    if (!cachedPoolPrices) {
      cachedPoolPrices = await pool.getPrices();
    }
    return cachedPoolPrices;
  };

  for (let i = 0; i < borrowersSortedByBond.length; i++) {
    const borrower = borrowersSortedByBond[i];
    const [poolPrices, loanDetails] = await Promise.all([
      getCachedPoolPrices(),
      pool.getLoan(borrower),
    ]);
    const { lup, hpb } = poolPrices;
    const { thresholdPrice, liquidationBond, debt, neutralPrice } = loanDetails;
    const estimatedRemainingBond = liquidationBond.add(
      getSumEstimatedBond(borrowersSortedByBond.slice(i + 1))
    );

    // If TP is lower than lup, the bond can not be kicked.
    if (thresholdPrice.lt(lup)) {
      logger.debug(
        `Not kicking loan since TP is lower LUP. borrower: ${borrower}, TP: ${weiToDecimaled(thresholdPrice)}, LUP: ${weiToDecimaled(lup)}`
      );
      continue;
    }

    // if loan debt is lower than configured fixed value (denominated in quote token), skip it
    if (weiToDecimaled(debt) < poolConfig.kick.minDebt) {
      logger.debug(
        `Not kicking loan since debt is too low. pool: ${pool.name}, borrower: ${borrower}, debt: ${weiToDecimaled(debt)}, minDebt: ${poolConfig.kick.minDebt}`
      );
      continue;
    }

    /*
    // Only kick loans with a neutralPrice above hpb to ensure they are profitalbe.
    if (neutralPrice.lt(hpb)) {
      logger.debug(
        `Not kicking loan since (NP < HPB). pool: ${pool.name}, borrower: ${borrower}, NP: ${neutralPrice}, hpb: ${hpb}`
      );
      continue;
    }
    */

    // Only kick loans with a neutralPrice above price (with some margin) to ensure they are profitable.
    const limitPrice =
      staticLimitPrice ??
      (await getPrice(
        poolConfig.price,
        resolvedConfig.coinGeckoApiKey,
        poolPrices,
        chainId,
        resolvedConfig.ethRpcUrl,
        resolvedConfig.tokenAddresses
      ));
    if (
      weiToDecimaled(neutralPrice) * poolConfig.kick.priceFactor <
      limitPrice
    ) {
      logger.debug(
        `Not kicking loan since (NP * Factor < Price). pool: ${pool.name}, borrower: ${borrower}, NP: ${weiToDecimaled(neutralPrice)}, Price: ${limitPrice}`
      );
      continue;
    }

    yield {
      borrower,
      liquidationBond,
      estimatedRemainingBond,
      limitPrice,
    };
    // A yielded candidate may be kicked before this generator resumes, which can
    // move pool prices. Reuse cached prices only across skipped borrowers.
    cachedPoolPrices = undefined;
  }
}

interface ApproveBalanceParams {
  pool: FungiblePool;
  signer: Signer;
  loanToKick: LoanToKick;
}

/**
 * Approves enough quoteToken to cover the bond of this kick and remaining kicks.
 * @returns True if there is enough balance to cover the next kick. False otherwise.
 */
export async function approveBalanceForLoanToKick({
  pool,
  signer,
  loanToKick,
}: ApproveBalanceParams): Promise<boolean> {
  const { liquidationBond, estimatedRemainingBond } = loanToKick;
  const [balanceNative, quoteDecimals] = await Promise.all([
    getBalanceOfErc20(signer, pool.quoteAddress),
    getDecimalsErc20(signer, pool.quoteAddress),
  ]);
  const balanceWad = tokenChangeDecimals(balanceNative, quoteDecimals);
  if (balanceWad.lt(liquidationBond)) {
    logger.debug(
      `Insufficient balance to approve bond. pool: ${pool.name}, borrower: ${loanToKick.borrower}, balance: ${weiToDecimaled(balanceWad)}, bond: ${weiToDecimaled(liquidationBond)}`
    );
    return false;
  }
  const allowance = await getAllowanceOfErc20(
    signer,
    pool.quoteAddress,
    pool.poolAddress
  );
  if (allowance.lt(liquidationBond)) {
    const amountToApprove = estimatedRemainingBond.lt(balanceWad)
      ? estimatedRemainingBond
      : liquidationBond;
    const margin = decimaledToWei(
      weiToDecimaled(amountToApprove) * LIQUIDATION_BOND_MARGIN
    );
    const amountWithMargin = amountToApprove.add(margin);
    // Get quote token details for human-readable logging
    const quoteDecimals = await getDecimalsErc20(signer, pool.quoteAddress);
    const amountInNativeDecimals = convertWadToTokenDecimals(
      amountWithMargin,
      quoteDecimals
    );
    const readableAmount = weiToDecimaled(
      amountInNativeDecimals,
      quoteDecimals
    );
    try {
      logger.debug(
        `Approving quote. pool: ${pool.name}, amount: ${amountWithMargin} WAD (${readableAmount} quote tokens)`
      );
      await poolQuoteApprove(pool, signer, amountWithMargin);
      const signerAddress = await signer.getAddress();
      invalidateZeroAllowanceCache(pool.poolAddress, signerAddress);
      logger.debug(
        `Approved quote. pool: ${pool.name}, amount: ${amountWithMargin} WAD (${readableAmount} quote tokens)`
      );
    } catch (error) {
      logger.error(
        `Failed to approve quote. pool: ${pool.name}, amount: ${amountWithMargin} WAD (${readableAmount} quote tokens)`,
        error
      );
      return false;
    }
  }
  return true;
}

interface KickParams extends Pick<HandleKickParams, 'pool' | 'signer'> {
  loanToKick: LoanToKick;
  config: Pick<KickConfigBase, 'dryRun'>;
}

export async function kick({ pool, signer, config, loanToKick }: KickParams) {
  const { dryRun } = config;
  const { borrower, liquidationBond, limitPrice } = loanToKick;

  if (dryRun) {
    logger.info(
      `DryRun - Would kick loan - pool: ${pool.name}, borrower: ${borrower}`
    );
    return;
  }

  try {
    const bondApproved = await approveBalanceForLoanToKick({
      signer,
      pool,
      loanToKick,
    });

    if (!bondApproved) {
      logger.info(
        `Failed to approve sufficient bond. Skipping kick of loan. pool: ${pool.name}, borrower: ${loanToKick.borrower}, bond: ${weiToDecimaled(liquidationBond)}`
      );
      return;
    }

    logger.debug(`Kicking loan - pool: ${pool.name}, borrower: ${borrower}`);
    const limitIndex =
      limitPrice > 0
        ? pool.getBucketByPrice(decimaledToWei(limitPrice)).index
        : undefined;
    await poolKick(pool, signer, borrower, limitIndex);
    logger.info(
      `Kick transaction confirmed. pool: ${pool.name}, borrower: ${borrower}`
    );
    const signerAddress = await signer.getAddress();
    invalidateIdleBondCache(pool.poolAddress, signerAddress);
  } catch (error) {
    logger.error(
      `Failed to kick loan. pool: ${pool.name}, borrower: ${borrower}.`,
      error
    );
  }
}

/**
 * Sets allowances for this pool to zero if it's current allowance is greater than zero.
 */
async function clearAllowances({
  pool,
  signer,
}: Pick<HandleKickParams, 'pool' | 'signer'>) {
  const signerAddress = await signer.getAddress();
  const cacheKey = allowanceCacheKey(pool.poolAddress, signerAddress);
  if (consumeZeroAllowanceCache(cacheKey)) {
    logger.debug(
      `Skipping allowance check (cached zero) for pool ${pool.name}`
    );
    return;
  }
  const allowance = await getAllowanceOfErc20(
    signer,
    pool.quoteAddress,
    pool.poolAddress
  );
  if (allowance.gt(constants.Zero)) {
    try {
      logger.debug(`Clearing allowance. pool: ${pool.name}`);
      await poolQuoteApprove(pool, signer, constants.Zero);
      zeroAllowanceCache.set(cacheKey, ZERO_ALLOWANCE_CACHE_CYCLES);
      logger.debug(`Cleared allowance. pool: ${pool.name}`);
    } catch (error) {
      logger.error(`Failed to clear allowance. pool: ${pool.name}`, error);
    }
    return;
  }
  zeroAllowanceCache.set(cacheKey, ZERO_ALLOWANCE_CACHE_CYCLES);
}
