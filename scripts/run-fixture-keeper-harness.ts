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
    } catch {
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

function parseArgs(argv: string[]) {
  let summaryPath: string | undefined;
  let dryRun = false;
  let autoWarpToTake = false;
  let takeWarpSeconds = 86400;
  let maxTakeWarps = 3;

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

    let liquidationStatusBeforeKick: HarnessReport['liquidationStatusAfterKick'] | undefined;
    try {
      liquidationStatusBeforeKick = await getLiquidationStatus(
        pool,
        summary.borrower.owner
      );
    } catch {
      liquidationStatusBeforeKick = undefined;
    }

    await handleKicks({
      pool,
      poolConfig,
      signer: keeper,
      config: {
        dryRun,
        delayBetweenActions: 0,
        coinGeckoApiKey: '',
        subgraphUrl: 'http://fixture-subgraph.override.invalid',
        tokenAddresses: {
          weth: summary.uniswapV3ExternalTake.routerConfig.wethAddress,
        },
        ethRpcUrl: summary.rpcUrl,
      },
      chainId: 8453,
    });

    let liquidationStatusAfterKick: HarnessReport['liquidationStatusAfterKick'];
    try {
      liquidationStatusAfterKick = await getLiquidationStatus(
        pool,
        summary.borrower.owner
      );
    } catch {
      liquidationStatusAfterKick = undefined;
    }

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
          subgraphUrl: 'http://fixture-subgraph.override.invalid',
          keeperTakerFactory:
            summary.uniswapV3ExternalTake.deployment.keeperTakerFactory,
          takerContracts: {
            UniswapV3: summary.uniswapV3ExternalTake.deployment.uniswapV3Taker,
          },
          universalRouterOverrides:
            summary.uniswapV3ExternalTake.routerConfig,
        },
      });

      try {
        liquidationStatusAfterTake = await getLiquidationStatus(
          pool,
          summary.borrower.owner
        );
      } catch {
        liquidationStatusAfterTake = null;
      }

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
