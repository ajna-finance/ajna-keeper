import { BigNumber } from 'ethers';
import { FungiblePool } from '@ajna-finance/sdk';
import { ApprovedCalldataAggregatorQuote } from './types';

/**
 * Test-only quote-injection seam for the no-spend harness.
 *
 * The probe (`evaluateCalldataAggregatorPathQuote`) and execution
 * (`prepareCalldataAggregatorExecution`) paths both converge on a normalized
 * `ApprovedCalldataAggregatorQuote`, and both compute the live, debt-clamped
 * `collateralInTokenDecimals` (the on-chain callback collateral) + the resolved
 * `takerAddress` before requesting a provider quote. When this injector is
 * installed, those two paths call it INSTEAD of the live LI.FI/Sushi/1inch
 * quote fetch+validate+normalize — so the REAL evaluate -> approve -> rank ->
 * execute pipeline and the REAL on-chain taker run against a deployed
 * MockLifiSwapTarget with zero live-API egress.
 *
 * Production inertness: the seam is double-gated. `getAggregatorQuoteInjector`
 * returns undefined unless `AJNA_AGENT_HARNESS_AGGREGATOR_QUOTE_MOCK=1`, and
 * `installAggregatorQuoteInjector` throws unless that flag is set. The keeper
 * never sets the flag, so in any production config the override is unreachable
 * and the live quote path is always taken.
 */

export const AGGREGATOR_QUOTE_INJECTION_ENV_FLAG =
  'AJNA_AGENT_HARNESS_AGGREGATOR_QUOTE_MOCK';

export interface AggregatorQuoteInjectionParams {
  pool: FungiblePool;
  /** The resolved on-chain taker contract that will execute the calldata-take. */
  takerAddress: string;
  chainId: number;
  /** The live debt-clamped callback collateral (token decimals) to swap. */
  collateralInTokenDecimals: BigNumber;
}

export type AggregatorQuoteInjector = (
  params: AggregatorQuoteInjectionParams
) => ApprovedCalldataAggregatorQuote;

let injector: AggregatorQuoteInjector | undefined;

function injectionEnabled(): boolean {
  return process.env[AGGREGATOR_QUOTE_INJECTION_ENV_FLAG] === '1';
}

export function installAggregatorQuoteInjector(
  fn: AggregatorQuoteInjector
): void {
  if (!injectionEnabled()) {
    throw new Error(
      `Aggregator quote injection requires ${AGGREGATOR_QUOTE_INJECTION_ENV_FLAG}=1; ` +
        'refusing to install a test quote override in a production config.'
    );
  }
  injector = fn;
}

export function clearAggregatorQuoteInjector(): void {
  injector = undefined;
}

/**
 * Returns the installed injector, or undefined when the seam is disabled. Always
 * undefined unless the env flag is set, so production code paths are unaffected.
 */
export function getAggregatorQuoteInjector(): AggregatorQuoteInjector | undefined {
  if (!injectionEnabled()) {
    return undefined;
  }
  return injector;
}
