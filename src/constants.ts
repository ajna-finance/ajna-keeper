import { BigNumber, ethers } from 'ethers';

export const MAX_FENWICK_INDEX = 7388;
export const MAX_UINT_256 = BigNumber.from(
  '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
);
export const MAX_UINT24_FEE_TIER = 16_777_215;

export const SECONDS_PER_YEAR = 3.154e7;
export const SECONDS_PER_DAY = 86400;

export const WAD = ethers.constants.WeiPerEther;
export const ZERO_BN = BigNumber.from(0);
export const BASIS_POINTS_DENOMINATOR = 10_000;
export const BASIS_POINTS_DENOMINATOR_BN = BigNumber.from(
  BASIS_POINTS_DENOMINATOR
);
export const MARKET_FACTOR_SCALE = 1_000_000;

export const DEFAULT_HOT_AUCTION_CANDIDATE_TTL_MS = 10 * 60_000;
export const DEFAULT_MAX_HOT_AUCTION_CANDIDATES = 1000;
