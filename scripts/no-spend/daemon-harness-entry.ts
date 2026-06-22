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
// but for the spawned daemon: set flag -> fund the shared MockLifiSwapTarget ->
// install the injector -> start the keeper loops.
//
// DRAFT: tsc-checked, but the payout sizing + target funding need a funded-fork
// run to validate end-to-end (see docs/multi-pool-enumeration-scenario.md).

import fs from 'fs';
import yargs from 'yargs/yargs';
import { BigNumber, Contract, utils } from 'ethers';

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
import { getProviderAndSigner } from '../../src/utils';
import { logger, setLoggerConfig } from '../../src/logging';

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
];
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
  const collateralAddress = summary.collateralToken.deployedAddress;
  const quoteAddress = summary.quoteToken.deployedAddress;
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

  return ({ takerAddress, chainId, collateralInTokenDecimals }) => {
    const spec = specsByTaker.get(takerAddress.toLowerCase());
    if (!spec) {
      throw new Error(`No mock aggregator quote spec for taker ${takerAddress}`);
    }
    const callData = MOCK_SWAP_IFACE.encodeFunctionData('mockSwap', [
      collateralAddress,
      quoteAddress,
      takerAddress,
      collateralInTokenDecimals,
      spec.quoteAmountRaw,
    ]);
    return {
      providerId: spec.providerId,
      quotedAtMs: Date.now(),
      chainId,
      srcToken: collateralAddress,
      dstToken: quoteAddress,
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

  const { signer } = await getProviderAndSigner(
    config.signer.keystore,
    config.network.rpcUrl
  );

  // Fund the shared MockLifiSwapTarget(s) so each calldata-take can be paid out
  // in quote token. (One target is shared across aggregator takers.)
  const quote = new Contract(
    fixtureSummary.quoteToken.deployedAddress,
    ERC20_ABI,
    signer
  );
  const keeperQuoteBalance: BigNumber = await quote.balanceOf(
    await signer.getAddress()
  );
  const payoutBudget = keeperQuoteBalance.mul(9).div(10);
  const targets = Array.from(
    new Set(
      (
        fixtureSummary.uniswapV3ExternalTake?.deployment?.aggregatorTakers ?? []
      ).map((t) => t.targetAddress)
    )
  );
  for (const target of targets) {
    await (await quote.transfer(target, payoutBudget.div(targets.length))).wait();
  }

  // Payout per take: a fraction of the funded budget. MUST exceed the on-chain
  // amount-due (fork-validate); override via env for tuning.
  const payoutRaw = process.env.AJNA_AGENT_HARNESS_AGGREGATOR_PAYOUT_RAW
    ? BigNumber.from(process.env.AJNA_AGENT_HARNESS_AGGREGATOR_PAYOUT_RAW)
    : payoutBudget.div(100);

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
