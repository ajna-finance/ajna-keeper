import { expect } from 'chai';
import * as path from 'path';
import { pathToFileURL } from 'url';

// Negative control: every no-spend run proves the HAPPY case. This proves the
// orchestrator's execution invariants actually TRIP when the take does nothing
// — i.e. a take-did-nothing run cannot silently pass (no false-green). Imports
// the assertion via dynamic import (the .mjs is ESM and self-guards main()).
describe('no-spend orchestrator assertions trip on a failing execution (negative control)', () => {
  let assertExecutionReport: (report: unknown, options: unknown) => void;

  before(async () => {
    // ts-node (CommonJS target) rewrites `import()` to `require()`, which cannot
    // load the ESM .mjs. Wrap in `new Function` so a real dynamic import survives.
    const realImport = new Function('p', 'return import(p)') as (
      p: string
    ) => Promise<{ assertExecutionReport: typeof assertExecutionReport }>;
    const modUrl = pathToFileURL(
      path.join(__dirname, '../../scripts/run-no-spend-validation.mjs')
    ).href;
    const mod = await realImport(modUrl);
    assertExecutionReport = mod.assertExecutionReport;
  });

  it('throws when the take did not execute (takeExecuted=false)', () => {
    expect(() =>
      assertExecutionReport(
        { mode: 'discovery', takeExecuted: false, collateralReducedByTake: false },
        { mode: 'discovery' }
      )
    ).to.throw(/did not reduce auction collateral/i);
  });

  it('throws when collateral was not reduced (the swap was a no-op)', () => {
    expect(() =>
      assertExecutionReport(
        { mode: 'discovery', takeExecuted: true, collateralReducedByTake: false },
        { mode: 'discovery' }
      )
    ).to.throw(/did not reduce auction collateral/i);
  });

  it('throws on a harness mode mismatch', () => {
    expect(() =>
      assertExecutionReport({ mode: 'manual' }, { mode: 'discovery' })
    ).to.throw(/mode/i);
  });
});
