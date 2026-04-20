#!/usr/bin/env ts-node

import fs from 'fs';
import path from 'path';
import { AjnaSDK, FungiblePool } from '@ajna-finance/sdk';
import { Wallet, ethers } from 'ethers';
import { handleKicks } from '../src/kick';
import { handleTakes } from '../src/take';
import subgraphModule, {
  GetLiquidationResponse,
  GetLoanResponse,
} from '../src/subgraph';
import {
  LiquiditySource,
  PriceOriginSource,
  configureAjna,
} from '../src/config';
import { getBalanceOfErc20 } from '../src/erc20';

type FixtureSummary = {
  rpcUrl: string;
  pool: {
    address: string;
  };
  borrower: {
    owner: string;
    neutralPrice: string;
    thresholdPrice: string;
  };
  liquidationCheck: {
    keeperKickEligibleByCurrentCode: boolean;
  };
  uniswapV3ExternalTake?: {
    routerConfig: {
      universalRouterAddress: string;
      permit2Address: string;
      poolFactoryAddress: string;
      quoterV2Address: string;
      wethAddress: string;
      defaultFeeTier: number;
      defaultSlippage: number;
    };
    deployment: {
      keeperTakerFactory: string;
      uniswapV3Taker: string;
    };
  };
};

type HarnessReport = {
  summaryPath: string;
  rpcUrl: string;
  borrower: string;
  derivedKickReferencePrice: number;
  keeperKickEligibleBefore: boolean;
  keeperQuoteBalanceBefore: string;
  keeperQuoteBalanceAfter: string;
  kickExecuted: boolean;
  liquidationStatusAfterKick?: {
    collateral: string;
    debtToCover?: string;
    price: string;
  };
  takeExecuted: boolean;
  liquidationStatusAfterTake?: {
    collateral: string;
    debtToCover?: string;
    price: string;
  } | null;
  collateralReducedByTake: boolean;
  takeWarpCount: number;
  takeWarpSecondsPerStep: number;
  takeAttempts: number;
};

// This harness targets a Base fork by design — the addresses below are
// Ajna's Base mainnet deployment. If Ajna redeploys on Base, these need to
// be updated alongside the fixture script's BASE_AJNA_ERC20_POOL_FACTORY.
// The `erc20PoolFactory` value must match
// scripts/create-liquidatable-ajna-fixture.ts::BASE_AJNA_ERC20_POOL_FACTORY.
const BASE_AJNA_CONFIG = {
  erc20PoolFactory: '0x214f62B5836D83f3D6c4f71F174209097B1A779C',
  erc721PoolFactory: '0xeefEC5d1Cc4bde97279d01D88eFf9e0fEe981769',
  poolUtils: '0x97fa9b0909C238D170C1ab3B5c728A3a45BBEcBa',
  positionManager: '0x59710a4149A27585f1841b5783ac704a08274e64',
  ajnaToken: '0xf0f326af3b1Ed943ab95C29470730CC8Cf66ae47',
  grantFund: '',
  burnWrapper: '',
  lenderHelper: '',
};

// Sentinel URL for the subgraph in harness mode. The subgraph calls that
// matter (getLoans, getLiquidations) are monkey-patched to read directly
// from the pool contract. If something bypasses the override and hits the
// network, the `.invalid` TLD (IANA-reserved, RFC 6761) guarantees DNS
// failure so we see a loud error rather than a silent real-subgraph call.
const FIXTURE_SUBGRAPH_SENTINEL_URL = 'http://fixture-subgraph.override.invalid';

function overrideGetLoans(
  fn: typeof subgraphModule.getLoans
): () => void {
  const originalGetLoans = subgraphModule.getLoans;
  subgraphModule.getLoans = fn;
  return () => {
    subgraphModule.getLoans = originalGetLoans;
  };
}

function overrideGetLiquidations(
  fn: typeof subgraphModule.getLiquidations
): () => void {
  const originalGetLiquidations = subgraphModule.getLiquidations;
  subgraphModule.getLiquidations = fn;
  return () => {
    subgraphModule.getLiquidations = originalGetLiquidations;
  };
}

function makeGetLoansFromFixture(
  pool: FungiblePool,
  borrower: string
): typeof subgraphModule.getLoans {
  return async (): Promise<GetLoanResponse> => {
    const loan = await pool.getLoan(borrower);
    if ((loan as any).isKicked) {
      return { loans: [] };
    }
    return {
      loans: [
        {
          borrower,
          thresholdPrice: Number(loan.thresholdPrice.toString()) / 1e18,
        },
      ],
    };
  };
}

function makeGetLiquidationsFromFixture(
  pool: FungiblePool,
  borrower: string
): typeof subgraphModule.getLiquidations {
  return async (
    _subgraphUrl: string,
    _poolAddress: string,
    minCollateral: number
  ): Promise<GetLiquidationResponse> => {
    const { hpb, hpbIndex } = await pool.getPrices();
    try {
      const liquidation = await pool.getLiquidation(borrower);
      const status = await liquidation.getStatus();
      const collateral = Number(status.collateral.toString()) / 1e18;
      return {
        pool: {
          hpb: Number(hpb.toString()) / 1e18,
          hpbIndex,
          liquidationAuctions: collateral > minCollateral ? [{ borrower }] : [],
        },
      };
    } catch (error) {
      // Same discipline as `tryGetLiquidationStatus`: benign "no auction"
      // collapses to an empty list, but real RPC failures surface. If this
      // ever silently returned [] for an RPC timeout, the harness would
      // report "no liquidation to take" and pass the test incorrectly.
      if (!isBenignNoLiquidationError(error)) {
        throw error;
      }
      return {
        pool: {
          hpb: Number(hpb.toString()) / 1e18,
          hpbIndex,
          liquidationAuctions: [],
        },
      };
    }
  };
}

function usage() {
  return `Usage: ts-node scripts/run-fixture-keeper-harness.ts --summary /path/to/fixture-summary.json [--dry-run] [--auto-warp-to-take] [--take-warp-seconds N] [--max-take-warps N]\n\nRequired env:\n- AJNA_AGENT_KEEPER_KEY\n\nOptional env:\n- AJNA_AGENT_HARNESS_OUTPUT_PATH\n`;
}

// Defaults calibrated against the verified 1-day/3-day local-fixture
// profile described in AUTONOMOUS_AGENT_LIQUIDATION_GUIDE.md. 86400s (1
// day) per warp × 3 warps gives a ~3-day window, long enough for the
// auction to cross the take-price threshold on a standard Ajna pool
// without overshooting so far that the fixture's neutral-price
// snapshot becomes stale.
const DEFAULT_TAKE_WARP_SECONDS = 86_400;
const DEFAULT_MAX_TAKE_WARPS = 3;

function parseArgs(argv: string[]) {
  let summaryPath: string | undefined;
  let dryRun = false;
  let autoWarpToTake = false;
  let takeWarpSeconds = DEFAULT_TAKE_WARP_SECONDS;
  let maxTakeWarps = DEFAULT_MAX_TAKE_WARPS;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--summary') {
      summaryPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--auto-warp-to-take') {
      autoWarpToTake = true;
      continue;
    }
    if (arg === '--take-warp-seconds') {
      takeWarpSeconds = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--max-take-warps') {
      maxTakeWarps = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--help') {
      process.stdout.write(usage());
      process.exit(0);
    }
  }

  if (!summaryPath) {
    throw new Error('Missing --summary /path/to/fixture-summary.json');
  }
  if (!Number.isFinite(takeWarpSeconds) || takeWarpSeconds < 0) {
    throw new Error('--take-warp-seconds must be a non-negative number');
  }
  if (!Number.isFinite(maxTakeWarps) || maxTakeWarps < 0) {
    throw new Error('--max-take-warps must be a non-negative number');
  }

  return {
    summaryPath: path.resolve(summaryPath),
    dryRun,
    autoWarpToTake,
    takeWarpSeconds,
    maxTakeWarps,
  };
}

async function getLiquidationStatus(pool: FungiblePool, borrower: string) {
  const liquidation = await pool.getLiquidation(borrower);
  const status = await liquidation.getStatus();
  const maybeDebtToCover = (status as any).debtToCover;
  return {
    collateral: status.collateral.toString(),
    debtToCover:
      maybeDebtToCover !== undefined ? maybeDebtToCover.toString() : undefined,
    price: status.price.toString(),
  };
}

/**
 * Heuristic: does this error mean "no liquidation auction exists for this
 * borrower right now" (legitimate state to observe) versus a real RPC /
 * chain failure (should be surfaced, not swallowed)?
 *
 * The Ajna SDK's `pool.getLiquidation(...)` throws when no auction row is
 * found. Ethers provider errors (`CALL_EXCEPTION`, `SERVER_ERROR`,
 * `NETWORK_ERROR`, `TIMEOUT`) indicate real problems that silently
 * swallowing would hide. We treat anything lacking one of those ethers
 * error codes as the benign "no auction" case and return undefined.
 */
function isBenignNoLiquidationError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return true;
  const code = (error as { code?: string }).code;
  if (typeof code === 'string') {
    const hardFailureCodes = new Set([
      'CALL_EXCEPTION',
      'SERVER_ERROR',
      'NETWORK_ERROR',
      'TIMEOUT',
    ]);
    if (hardFailureCodes.has(code)) return false;
  }
  return true;
}

async function tryGetLiquidationStatus(
  pool: FungiblePool,
  borrower: string,
  context: string
): Promise<Awaited<ReturnType<typeof getLiquidationStatus>> | undefined> {
  try {
    return await getLiquidationStatus(pool, borrower);
  } catch (error) {
    if (isBenignNoLiquidationError(error)) return undefined;
    process.stderr.write(
      `[harness] ${context}: getLiquidationStatus failed with a non-benign error; ` +
        `surfacing the raw error. Underlying: ${
          error instanceof Error ? error.message : String(error)
        }\n`
    );
    throw error;
  }
}

async function main() {
  const { summaryPath, dryRun, autoWarpToTake, takeWarpSeconds, maxTakeWarps } = parseArgs(process.argv.slice(2));
  const keeperKey = process.env.AJNA_AGENT_KEEPER_KEY;
  if (!keeperKey) {
    throw new Error('Missing AJNA_AGENT_KEEPER_KEY');
  }

  const summary = JSON.parse(
    fs.readFileSync(summaryPath, 'utf8')
  ) as FixtureSummary;
  if (!summary.uniswapV3ExternalTake) {
    throw new Error(
      'Fixture summary does not include uniswapV3ExternalTake. Run the fixture with --with-uniswap-v3-external-take first.'
    );
  }

  configureAjna(BASE_AJNA_CONFIG as any);
  const provider = new ethers.providers.JsonRpcProvider(summary.rpcUrl);
  const keeper = new Wallet(keeperKey, provider);
  const ajna = new AjnaSDK(provider);
  const pool = (await ajna.fungiblePoolFactory.getPoolByAddress(
    summary.pool.address
  )) as FungiblePool;

  const derivedKickReferencePrice = Math.max(
    Number(ethers.utils.formatUnits(summary.borrower.neutralPrice, 18)) * 0.9,
    0.000001
  );

  const poolConfig = {
    name: 'Local Fixture Pool',
    address: summary.pool.address,
    price: {
      source: PriceOriginSource.FIXED,
      value: derivedKickReferencePrice,
    },
    kick: {
      minDebt: 0.001,
      priceFactor: 0.99,
    },
    take: {
      minCollateral: 0.01,
      liquiditySource: LiquiditySource.UNISWAPV3,
      marketPriceFactor: 0.98,
    },
  } as const;

  const undoLoans = overrideGetLoans(
    makeGetLoansFromFixture(pool, summary.borrower.owner)
  );
  const undoLiquidations = overrideGetLiquidations(
    makeGetLiquidationsFromFixture(pool, summary.borrower.owner)
  );

  try {
    const keeperQuoteBalanceBefore = await getBalanceOfErc20(
      keeper,
      pool.quoteAddress
    );

    const liquidationStatusBeforeKick = await tryGetLiquidationStatus(
      pool,
      summary.borrower.owner,
      'pre-kick status read'
    );

    await handleKicks({
      pool,
      poolConfig,
      signer: keeper,
      config: {
        dryRun,
        delayBetweenActions: 0,
        coinGeckoApiKey: '',
        subgraphUrl: FIXTURE_SUBGRAPH_SENTINEL_URL,
        tokenAddresses: {
          weth: summary.uniswapV3ExternalTake.routerConfig.wethAddress,
        },
        ethRpcUrl: summary.rpcUrl,
      },
      chainId: 8453,
    });

    const liquidationStatusAfterKick = await tryGetLiquidationStatus(
      pool,
      summary.borrower.owner,
      'post-kick status read'
    );

    const collateralBeforeTake = liquidationStatusAfterKick?.collateral;

    let takeWarpCount = 0;
    let takeAttempts = 0;
    let liquidationStatusAfterTake: HarnessReport['liquidationStatusAfterTake'] = liquidationStatusAfterKick ?? null;
    let collateralReducedByTake = false;

    while (true) {
      takeAttempts += 1;
      await handleTakes({
        signer: keeper,
        pool,
        poolConfig,
        config: {
          dryRun,
          delayBetweenActions: 0,
          subgraphUrl: FIXTURE_SUBGRAPH_SENTINEL_URL,
          keeperTakerFactory:
            summary.uniswapV3ExternalTake.deployment.keeperTakerFactory,
          takerContracts: {
            UniswapV3: summary.uniswapV3ExternalTake.deployment.uniswapV3Taker,
          },
          universalRouterOverrides:
            summary.uniswapV3ExternalTake.routerConfig,
        },
      });

      // Callers downstream distinguish `null` ("no auction right now")
      // from a defined status, so normalize the benign-undefined case
      // from `tryGetLiquidationStatus` back to `null`. Non-benign errors
      // propagate and halt the harness loudly.
      const postTakeStatus = await tryGetLiquidationStatus(
        pool,
        summary.borrower.owner,
        'post-take status read'
      );
      liquidationStatusAfterTake = postTakeStatus ?? null;

      collateralReducedByTake =
        collateralBeforeTake !== undefined && liquidationStatusAfterTake !== null
          ? ethers.BigNumber.from(liquidationStatusAfterTake.collateral).lt(
              ethers.BigNumber.from(collateralBeforeTake)
            )
          : collateralBeforeTake !== undefined && liquidationStatusAfterTake === null;

      if (collateralReducedByTake || !autoWarpToTake || takeWarpCount >= maxTakeWarps) {
        break;
      }
      if (liquidationStatusAfterTake === null) {
        break;
      }
      await provider.send('evm_increaseTime', [takeWarpSeconds]);
      await provider.send('evm_mine', []);
      takeWarpCount += 1;
    }

    const keeperQuoteBalanceAfter = await getBalanceOfErc20(keeper, pool.quoteAddress);

    const report: HarnessReport = {
      summaryPath,
      rpcUrl: summary.rpcUrl,
      borrower: summary.borrower.owner,
      derivedKickReferencePrice,
      keeperKickEligibleBefore:
        summary.liquidationCheck.keeperKickEligibleByCurrentCode,
      keeperQuoteBalanceBefore: keeperQuoteBalanceBefore.toString(),
      keeperQuoteBalanceAfter: keeperQuoteBalanceAfter.toString(),
      kickExecuted:
        liquidationStatusBeforeKick?.collateral !== '0' &&
        liquidationStatusBeforeKick !== undefined
          ? false
          : liquidationStatusAfterKick !== undefined &&
            liquidationStatusAfterKick.collateral !== '0',
      liquidationStatusAfterKick,
      takeExecuted: collateralReducedByTake,
      liquidationStatusAfterTake,
      collateralReducedByTake,
      takeWarpCount,
      takeWarpSecondsPerStep: takeWarpSeconds,
      takeAttempts,
    };

    const outputPath = process.env.AJNA_AGENT_HARNESS_OUTPUT_PATH;
    if (outputPath) {
      fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    }

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    undoLiquidations();
    undoLoans();
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
});
