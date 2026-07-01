import * as fs from 'fs';
import * as path from 'path';

interface CoverageSnapshot {
  readonly file: string;
  readonly branchPercent?: number;
  readonly uncoveredBranches?: number;
}

interface CoverageTarget {
  readonly id: string;
  readonly tier: string;
  readonly sourceFiles: readonly string[];
  readonly testFiles: readonly string[];
  readonly workType: string;
  readonly coverageSnapshot?: readonly CoverageSnapshot[];
  readonly safetyInvariant: string;
}

interface CoverageManifest {
  readonly version: number;
  readonly coverageSource: string;
  readonly targets: readonly CoverageTarget[];
}

interface BranchMetrics {
  readonly hit: number;
  readonly total: number;
}

const repoRoot = process.cwd();
const manifestPath = path.join(repoRoot, 'coverage-hardening-targets.json');
const lcovPath = path.resolve(repoRoot, process.argv[2] ?? 'coverage/lcov.info');

function normalizeRepoPath(filePath: string): string {
  const normalized = filePath.split(path.sep).join('/');
  const normalizedRepoRoot = repoRoot.split(path.sep).join('/');
  if (normalized.startsWith(`${normalizedRepoRoot}/`)) {
    return normalized.slice(normalizedRepoRoot.length + 1);
  }
  const srcIndex = normalized.indexOf('/src/');
  if (srcIndex >= 0) {
    return normalized.slice(srcIndex + 1);
  }
  return normalized.replace(/^\.\//, '');
}

function parseLcov(raw: string): Map<string, BranchMetrics> {
  const files = new Map<string, BranchMetrics>();
  let currentFile: string | undefined;
  let currentTotal = 0;
  let currentHit = 0;

  function flush(): void {
    if (currentFile !== undefined) {
      files.set(currentFile, {
        hit: currentHit,
        total: currentTotal,
      });
    }
    currentFile = undefined;
    currentTotal = 0;
    currentHit = 0;
  }

  for (const line of raw.split('\n')) {
    if (line.startsWith('SF:')) {
      flush();
      currentFile = normalizeRepoPath(line.slice('SF:'.length));
    } else if (line.startsWith('BRF:')) {
      currentTotal = Number(line.slice('BRF:'.length));
    } else if (line.startsWith('BRH:')) {
      currentHit = Number(line.slice('BRH:'.length));
    } else if (line === 'end_of_record') {
      flush();
    }
  }
  flush();
  return files;
}

function loadManifest(): CoverageManifest {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as CoverageManifest;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

function formatMetrics(
  file: string,
  liveMetrics: Map<string, BranchMetrics>,
  snapshots: readonly CoverageSnapshot[]
): string {
  const live = liveMetrics.get(file);
  if (live !== undefined && live.total > 0) {
    const percent = ((live.hit / live.total) * 100).toFixed(1);
    return `${file} ${percent}% / ${live.total - live.hit}`;
  }

  const snapshot = snapshots.find((entry) => entry.file === file);
  if (snapshot?.branchPercent !== undefined) {
    const uncovered =
      snapshot.uncoveredBranches !== undefined
        ? ` / ${snapshot.uncoveredBranches}`
        : '';
    return `${file} ${snapshot.branchPercent.toFixed(1)}%${uncovered} snapshot`;
  }
  if (snapshot?.uncoveredBranches !== undefined) {
    return `${file} ${snapshot.uncoveredBranches} uncovered snapshot`;
  }
  return `${file} no branch snapshot`;
}

function main(): void {
  const manifest = loadManifest();
  const liveMetrics = fs.existsSync(lcovPath)
    ? parseLcov(fs.readFileSync(lcovPath, 'utf8'))
    : new Map<string, BranchMetrics>();

  if (liveMetrics.size === 0) {
    console.error(
      `No lcov branch data found at ${path.relative(repoRoot, lcovPath)}. ` +
        'Run npm run coverage first for live metrics.'
    );
  }

  console.log(`Coverage hardening targets v${manifest.version}`);
  console.log(`Source: ${manifest.coverageSource}`);
  console.log('');
  console.log(
    '| Tier | Target | Branch status | Test files | Work | Safety invariant |'
  );
  console.log('|---|---|---|---|---|---|');

  for (const target of manifest.targets) {
    const snapshots = target.coverageSnapshot ?? [];
    const branchStatus = target.sourceFiles
      .map((file) => formatMetrics(file, liveMetrics, snapshots))
      .join('<br>');
    console.log(
      [
        target.tier,
        target.id,
        branchStatus,
        target.testFiles.join('<br>'),
        target.workType,
        target.safetyInvariant,
      ]
        .map(escapeCell)
        .join(' | ')
        .replace(/^/, '| ')
        .replace(/$/, ' |')
    );
  }
}

main();
