// Roadmap hot-file growth checker for calldata-aggregator feature packets.
//
// Compares the current tree (including uncommitted changes) against an
// EXPLICIT base ref and fails when a roadmap hot file grows. Packets touching
// hot files must run this against their declared base ref; overrides happen
// only through packet-closeout justification, never by editing the rules.
//
// Rules:
//   1. net-growth:     a hot file's final line count exceeds its base count
//   2. added-lines:    more than MAX_ADDED_LINES gross added lines in a hot
//                      file, even when net growth is zero or negative
//   3. total-line-cap: scripts/deploy-factory-system.ts at or above 1000 lines
//   4. base-ref:       missing or unresolvable --base ref is a failure
//
// Usage: npm run check-hot-file-growth -- --base <ref>
import { execFileSync } from 'child_process';
import * as fs from 'fs';

export const HOT_FILES: readonly string[] = [
  'src/config/validation.ts',
  'src/take/external-take/route.ts',
  'src/take/external-take/quote-approval.ts',
  'src/discovery/route-preflight.ts',
  'scripts/deploy-factory-system.ts',
];

export const MAX_ADDED_LINES = 10;

export const FINAL_LINE_CAPS: Readonly<Record<string, number>> = {
  'scripts/deploy-factory-system.ts': 1000,
};

export interface HotFileStat {
  file: string;
  addedLines: number;
  removedLines: number;
  baseLineCount: number;
  finalLineCount: number;
}

export interface Violation {
  file: string;
  rule: 'net-growth' | 'added-lines' | 'total-line-cap';
  detail: string;
}

export function evaluateHotFileGrowth(stats: HotFileStat[]): Violation[] {
  const violations: Violation[] = [];
  for (const stat of stats) {
    if (stat.finalLineCount > stat.baseLineCount) {
      violations.push({
        file: stat.file,
        rule: 'net-growth',
        detail:
          `grew from ${stat.baseLineCount} to ${stat.finalLineCount} lines ` +
          `(+${stat.addedLines}/-${stat.removedLines})`,
      });
    }
    if (stat.addedLines > MAX_ADDED_LINES) {
      violations.push({
        file: stat.file,
        rule: 'added-lines',
        detail:
          `${stat.addedLines} added lines exceeds the ${MAX_ADDED_LINES}-line ` +
          `hot-file addition cap (final ${stat.finalLineCount} lines)`,
      });
    }
    const cap = FINAL_LINE_CAPS[stat.file];
    if (cap !== undefined && stat.finalLineCount >= cap) {
      violations.push({
        file: stat.file,
        rule: 'total-line-cap',
        detail: `${stat.finalLineCount} lines reaches the ${cap}-line cap`,
      });
    }
  }
  return violations;
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' });
}

function countLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  const newlineCount = content.split('\n').length - 1;
  return content.endsWith('\n') ? newlineCount : newlineCount + 1;
}

function baseFileLineCount(baseRef: string, file: string): number {
  try {
    return countLines(git(['show', `${baseRef}:${file}`]));
  } catch {
    return 0; // file does not exist at the base ref
  }
}

function currentFileLineCount(file: string): number {
  try {
    return countLines(fs.readFileSync(file, 'utf8'));
  } catch {
    return 0; // file deleted or not present in this repo layout
  }
}

export function collectHotFileStats(baseRef: string): HotFileStat[] {
  const numstat = git(['diff', '--numstat', baseRef, '--', ...HOT_FILES]);
  const diffByFile = new Map<string, { added: number; removed: number }>();
  for (const line of numstat.split('\n')) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
    if (!match) {
      continue;
    }
    diffByFile.set(match[3], {
      added: match[1] === '-' ? 0 : parseInt(match[1], 10),
      removed: match[2] === '-' ? 0 : parseInt(match[2], 10),
    });
  }

  return HOT_FILES.map((file) => {
    const diff = diffByFile.get(file) ?? { added: 0, removed: 0 };
    return {
      file,
      addedLines: diff.added,
      removedLines: diff.removed,
      baseLineCount: baseFileLineCount(baseRef, file),
      finalLineCount: currentFileLineCount(file),
    };
  });
}

function parseBaseRef(argv: string[]): string | undefined {
  const flagIndex = argv.indexOf('--base');
  if (flagIndex === -1 || flagIndex + 1 >= argv.length) {
    return undefined;
  }
  const value = argv[flagIndex + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

function main(): void {
  const baseRef = parseBaseRef(process.argv.slice(2));
  if (!baseRef) {
    console.error(
      'check-hot-file-growth: an explicit --base <ref> is required ' +
        '(declare the exact packet base ref; see packet-0)'
    );
    process.exit(2);
  }

  try {
    git(['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`]);
  } catch {
    console.error(
      `check-hot-file-growth: base ref "${baseRef}" does not resolve to a commit`
    );
    process.exit(2);
  }

  const stats = collectHotFileStats(baseRef);
  const violations = evaluateHotFileGrowth(stats);

  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(
        `FAIL [${violation.rule}] ${violation.file}: ${violation.detail}`
      );
    }
    console.error(
      `${violations.length} hot-file violation(s) against base ${baseRef}. ` +
        'Move the logic into a focused helper/provider-neutral module, or ' +
        'record a packet-closeout exception (file, added lines, reason).'
    );
    process.exit(1);
  }

  for (const stat of stats) {
    console.log(
      `ok ${stat.file}: ${stat.finalLineCount} lines ` +
        `(+${stat.addedLines}/-${stat.removedLines} vs ${baseRef})`
    );
  }
}

if (require.main === module) {
  main();
}
