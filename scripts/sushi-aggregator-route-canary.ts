// Sushi aggregator route-shape canary (Packet 3B). Live, read-only, never
// broadcasts: fetches a real Sushi v7 quote for each scoped chain's
// keeper-relevant pair and runs it through the production fail-closed
// validator against the reviewed scoped allowlists. Any drift in the
// RouteProcessor target, selector, spender, head layout, value policy, or
// price-impact band fails the canary BEFORE live use.
//
// Usage: npm run sushi-aggregator-route-canary [-- --chain <id>]
import {
  SushiRouteCanarySummary,
  runSushiRouteCanary,
} from '../src/dex/sushi-aggregator/route-canary';

function printSummary(summary: SushiRouteCanarySummary): void {
  for (const check of summary.checks) {
    if (check.success) {
      console.log(
        `ok chain ${check.chainId} ${check.label}: target=${check.transactionTarget} ` +
          `selector=${check.selector} minOut=${check.routeMinOutRaw} ` +
          `expected=${check.quoteAmountRaw}`
      );
    } else {
      console.error(
        `FAIL [route-shape] chain ${check.chainId} ${check.label}: ${check.error}`
      );
    }
  }
  if (summary.failureCount > 0) {
    console.error(
      `${summary.failureCount} scoped chain(s) failed the Sushi aggregator route-shape canary`
    );
    return;
  }
  console.log(
    `ok canary: ${summary.chainIds.length}/${summary.chainIds.length} scoped chains validate fail-closed`
  );
}

async function main(): Promise<void> {
  const result = await runSushiRouteCanary({ argv: process.argv.slice(2) });
  printSummary(result.summary);
  process.exitCode = result.exitCode;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      `FAIL [canary] ${error instanceof Error ? error.message : error}`
    );
    process.exit(1);
  });
}
