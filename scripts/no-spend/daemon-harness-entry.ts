#!/usr/bin/env ts-node
//
// Harness-only persistent-daemon entrypoint for no-spend AGGREGATOR coverage.
//
// Why this exists: the production entry (src/index.ts) never installs the
// calldata-aggregator quote injector and never sets the harness env flag, so a
// daemon spawned from it can only exercise the direct_dex (real Uniswap) take
// path. To let the REAL long-lived keeper drive the LI.FI / Sushi / 1inch
// calldata-aggregator path no-spend, the daemon must be started from a harness
// entry that installs the env-gated injector first. This file is that seam:
// production code is untouched and stays inert (the flag is only ever set here).
//
// It mirrors the in-process injector that fixture-keeper-harness-cli.ts installs,
// but for the spawned daemon: set flag -> install the injector -> start the
// keeper loops. The MockLifiSwapTarget is funded (and the per-take payout sized)
// by the caller runDaemonAggregator, which holds the quote-rich fixture keeper
// and passes the payout via AJNA_AGENT_HARNESS_AGGREGATOR_PAYOUT_RAW.
//
// Fork-validated: the real daemon took an auction via the LI.FI calldata path
// against the mock target, exit 0 (see docs/multi-pool-enumeration-scenario.md).

import fs from 'fs';
import yargs from 'yargs/yargs';
import { BigNumber, utils } from 'ethers';

import { readConfigFile, resolveCalldataAggregatorProviderForSource } from '../../src/config';
import type { LiquiditySource } from '../../src/config';
import { startKeeperFromConfig } from '../../src/run';
import { installProcessSafetyHandlers } from '../../src/process-safety';
import {
  AGGREGATOR_QUOTE_INJECTION_ENV_FLAG,
  installAggregatorQuoteInjector,
  type AggregatorQuoteInjector,
} from '../../src/take/aggregator-calldata/quote-injection';
import type { ApprovedCalldataAggregatorQuote } from '../../src/take/aggregator-calldata/types';
import { logger, setLoggerConfig } from '../../src/logging';

const MOCK_SWAP_IFACE = new utils.Interface([
  'function mockSwap(address tokenIn, address tokenOut, address recipient, uint256 amountIn, uint256 amountOut)',
]);
const MOCK_SWAP_SELECTOR = MOCK_SWAP_IFACE.getSighash('mockSwap');

interface AggregatorTakerDeployment {
  key: string;
  source: number;
  takerAddress: string;
  targetAddress: string;
}

interface FixtureSummaryLike {
  quoteToken: { deployedAddress: string };
  collateralToken: { deployedAddress: string };
  uniswapV3ExternalTake?: {
    deployment?: { aggregatorTakers?: AggregatorTakerDeployment[] };
  };
}

interface InjectorSpec {
  providerId: ApprovedCalldataAggregatorQuote['providerId'];
  targetAddress: string;
  quoteAmountRaw: BigNumber;
}

function buildInjector(
  summary: FixtureSummaryLike,
  payoutRaw: BigNumber
): AggregatorQuoteInjector {
  // Only the taker->target mapping comes from the (shared) summary deployment;
  // the src/dst tokens are read PER-POOL from the pool object at injection time,
  // so one shared mock target can serve a multipool set where each pool has its
  // own quote token.
  const takers =
    summary.uniswapV3ExternalTake?.deployment?.aggregatorTakers ?? [];

  const specsByTaker = new Map<string, InjectorSpec>();
  for (const taker of takers) {
    const providerId = resolveCalldataAggregatorProviderForSource(
      taker.source as LiquiditySource
    );
    if (!providerId) continue; // not a calldata-aggregator source; skip
    specsByTaker.set(taker.takerAddress.toLowerCase(), {
      providerId,
      targetAddress: taker.targetAddress,
      // The mock pays out a fixed quote amount; it MUST exceed the on-chain
      // amount-due for the take to settle profitably (validated on fork).
      quoteAmountRaw: payoutRaw,
    });
  }

  return ({ pool, takerAddress, chainId, collateralInTokenDecimals }) => {
    const spec = specsByTaker.get(takerAddress.toLowerCase());
    if (!spec) {
      throw new Error(`No mock aggregator quote spec for taker ${takerAddress}`);
    }
    const srcToken = pool.collateralAddress;
    const dstToken = pool.quoteAddress;
    const callData = MOCK_SWAP_IFACE.encodeFunctionData('mockSwap', [
      srcToken,
      dstToken,
      takerAddress,
      collateralInTokenDecimals,
      spec.quoteAmountRaw,
    ]);
    return {
      providerId: spec.providerId,
      quotedAtMs: Date.now(),
      chainId,
      srcToken,
      dstToken,
      dstReceiver: takerAddress,
      amountInTokenUnits: collateralInTokenDecimals,
      quoteAmountRaw: spec.quoteAmountRaw,
      routeMinOutRaw: spec.quoteAmountRaw,
      transactionTarget: spec.targetAddress,
      approvalSpender: spec.targetAddress,
      callData,
      selector: MOCK_SWAP_SELECTOR,
      txValue: '0',
      routeSummary: {
        providerId: spec.providerId,
        tool: 'mock-aggregator',
        feeCosts: [],
      },
    };
  };
}

async function main(): Promise<void> {
  const argv = yargs(process.argv.slice(2))
    .options({
      config: { type: 'string', demandOption: true },
      'fixture-summary': { type: 'string', demandOption: true },
    })
    .parseSync();

  // Set the env flag BEFORE installing the injector (installAggregatorQuoteInjector
  // throws otherwise). Only ever set here — production never reaches this file.
  process.env[AGGREGATOR_QUOTE_INJECTION_ENV_FLAG] = '1';

  const config = await readConfigFile(argv.config);
  setLoggerConfig(config);
  const fixtureSummary = JSON.parse(
    fs.readFileSync(argv['fixture-summary'], 'utf8')
  ) as FixtureSummaryLike;

  // The mock target is funded with quote token (and the per-take payout sized) by
  // the caller (runDaemonAggregator), which holds the quote-rich fixture keeper —
  // this entry's keystore wallet has no quote. The payout MUST exceed the on-chain
  // amount-due, so it is required here rather than guessed.
  const payoutEnv = process.env.AJNA_AGENT_HARNESS_AGGREGATOR_PAYOUT_RAW;
  if (!payoutEnv) {
    throw new Error(
      'Harness daemon entry requires AJNA_AGENT_HARNESS_AGGREGATOR_PAYOUT_RAW (the mock quote-token payout per take)'
    );
  }
  const payoutRaw = BigNumber.from(payoutEnv);

  installAggregatorQuoteInjector(buildInjector(fixtureSummary, payoutRaw));
  logger.info(
    'Harness daemon entry: aggregator quote injector installed; starting keeper.'
  );
  await startKeeperFromConfig(config);
}

installProcessSafetyHandlers();
main().catch((error) => {
  logger.error('Fatal harness daemon error; exiting.', error);
  process.exit(1);
});
