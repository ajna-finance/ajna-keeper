import { expect } from 'chai';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  FINAL_LINE_CAPS,
  HOT_FILES,
  HotFileStat,
  MAX_ADDED_LINES,
  evaluateHotFileGrowth,
} from '../../scripts/check-hot-file-growth';

function stat(overrides: Partial<HotFileStat>): HotFileStat {
  return {
    file: 'src/config/validation.ts',
    addedLines: 0,
    removedLines: 0,
    baseLineCount: 100,
    finalLineCount: 100,
    ...overrides,
  };
}

describe('hot-file growth evaluation', () => {
  it('passes an unchanged hot file', () => {
    expect(evaluateHotFileGrowth([stat({})])).to.deep.equal([]);
  });

  it('fails any net line-count growth', () => {
    const violations = evaluateHotFileGrowth([
      stat({ addedLines: 1, finalLineCount: 101 }),
    ]);
    expect(violations).to.have.length(1);
    expect(violations[0].rule).to.equal('net-growth');
    expect(violations[0].detail).to.contain('100');
    expect(violations[0].detail).to.contain('101');
  });

  it('allows net shrinkage with small additions', () => {
    const violations = evaluateHotFileGrowth([
      stat({ addedLines: 5, removedLines: 30, finalLineCount: 75 }),
    ]);
    expect(violations).to.deep.equal([]);
  });

  it('fails gross additions above the cap even at net-zero growth', () => {
    const violations = evaluateHotFileGrowth([
      stat({
        addedLines: MAX_ADDED_LINES + 1,
        removedLines: MAX_ADDED_LINES + 1,
        finalLineCount: 100,
      }),
    ]);
    expect(violations).to.have.length(1);
    expect(violations[0].rule).to.equal('added-lines');
  });

  it('fails the deploy script at its total-line cap', () => {
    const file = 'scripts/deploy-factory-system.ts';
    const cap = FINAL_LINE_CAPS[file];
    const violations = evaluateHotFileGrowth([
      stat({
        file,
        baseLineCount: cap + 5, // already over at base: shrinking but capped
        finalLineCount: cap,
        removedLines: 5,
      }),
    ]);
    expect(violations.map((v) => v.rule)).to.deep.equal(['total-line-cap']);
  });

  it('passes the deploy script just below the cap', () => {
    const file = 'scripts/deploy-factory-system.ts';
    const cap = FINAL_LINE_CAPS[file];
    const violations = evaluateHotFileGrowth([
      stat({ file, baseLineCount: cap - 1, finalLineCount: cap - 1 }),
    ]);
    expect(violations).to.deep.equal([]);
  });

  it('reports each violated rule independently for one file', () => {
    const violations = evaluateHotFileGrowth([
      stat({
        addedLines: 25,
        removedLines: 0,
        baseLineCount: 100,
        finalLineCount: 125,
      }),
    ]);
    expect(violations.map((v) => v.rule).sort()).to.deep.equal([
      'added-lines',
      'net-growth',
    ]);
  });
});

describe('hot-file growth checker CLI', function () {
  // Subprocess + temp-repo tests; generous timeout for slow machines.
  this.timeout(60000);

  const repoRoot = path.join(__dirname, '..', '..');
  const tsNodeBin = path.join(repoRoot, 'node_modules', 'ts-node', 'dist', 'bin.js');
  const scriptPath = path.join(repoRoot, 'scripts', 'check-hot-file-growth.ts');

  function run(
    cwd: string,
    args: string[]
  ): { status: number; output: string } {
    try {
      const stdout = execFileSync(process.execPath, [tsNodeBin, scriptPath, ...args], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          TS_NODE_PROJECT: path.join(repoRoot, 'tsconfig.json'),
        },
      });
      return { status: 0, output: stdout };
    } catch (error: any) {
      return {
        status: error.status ?? 1,
        output: `${error.stdout ?? ''}${error.stderr ?? ''}`,
      };
    }
  }

  function setupTempRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-file-checker-'));
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'test']);
    for (const file of HOT_FILES) {
      fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), 'line\n'.repeat(50));
    }
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);
    return dir;
  }

  it('passes on an unchanged tree against the declared base ref', () => {
    const dir = setupTempRepo();
    const result = run(dir, ['--base', 'HEAD']);
    expect(result.status, result.output).to.equal(0);
    expect(result.output).to.contain('ok src/config/validation.ts');
  });

  it('fails when a hot file grows, identifying file, lines, and rule', () => {
    const dir = setupTempRepo();
    const target = path.join(dir, 'src/config/validation.ts');
    fs.appendFileSync(target, 'added\n');
    const result = run(dir, ['--base', 'HEAD']);
    expect(result.status).to.equal(1);
    expect(result.output).to.contain('net-growth');
    expect(result.output).to.contain('src/config/validation.ts');
    expect(result.output).to.contain('51');
  });

  it('fails when run without the required base ref', () => {
    const dir = setupTempRepo();
    const result = run(dir, []);
    expect(result.status).to.equal(2);
    expect(result.output).to.contain('--base');
  });

  it('fails when run with an unresolvable base ref', () => {
    const dir = setupTempRepo();
    const result = run(dir, ['--base', 'no-such-ref']);
    expect(result.status).to.equal(2);
    expect(result.output).to.contain('no-such-ref');
  });
});
