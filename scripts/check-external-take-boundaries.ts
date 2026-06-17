// Static boundary checker for calldata-aggregator Packet 5.
//
// This intentionally scans text instead of building a compiler plugin. The
// Packet 5 migration is mostly naming/dispatch boundary cleanup, and a small
// explicit denylist gives the PR an executable "retired terms are gone from
// production surfaces" gate.
//
// Usage: npm run check-external-take-boundaries -- --base <ref>
import * as fs from 'fs';
import * as path from 'path';

export interface BoundaryFile {
  readonly file: string;
  readonly content: string;
}

export interface BoundaryViolation {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly detail: string;
  readonly text: string;
}

type BoundaryRule = {
  readonly id: string;
  readonly detail: string;
  readonly re: RegExp;
  readonly allow?: (params: {
    file: string;
    line: string;
    lineNumber: number;
  }) => boolean;
};

const SCAN_ROOTS = ['src', 'scripts', 'contracts', 'docs', 'examples'];
const SCAN_FILES = [
  'README.md',
  'production_setup_guide.md',
  'package.json',
  'hardhat.config.ts',
  'tests/integration/helpers/direct-dex-route-harness.ts',
  'tests/integration/production-route-selection.test.ts',
  'tests/unit/take-direct-dex.test.ts',
  'tests/unit/direct-dex-quote-provider-cache.test.ts',
  'tests/unit/direct-dex-route-selection.test.ts',
  'tests/unit/direct-dex-amount-out-minimum.test.ts',
  'tests/unit/discovery-handlers.test.ts',
  'tests/unit/lifi-discovery-handlers.test.ts',
  'tests/unit/take-write-submission.test.ts',
];
const SCAN_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.sol',
  '.md',
  '.json',
]);
const IGNORED_PATHS: readonly RegExp[] = [
  /^docs\/calldata-aggregator-/,
  /^scripts\/check-external-take-boundaries\.ts$/,
  /^scripts\/create-liquidatable-ajna-fixture-cli\.ts$/,
  /^tests\/unit\/check-external-take-boundaries\.test\.ts$/,
];

function isIgnoredPath(file: string): boolean {
  const normalized = file.split(path.sep).join('/');
  return IGNORED_PATHS.some((ignored) => ignored.test(normalized));
}

function isMigrationErrorLine(line: string): boolean {
  return /\b(retired|legacy|invalid|migration|must configure|use direct_dex|use takers\.router|fail(?:s|ed)? validation|reject(?:s|ed)?)\b/i.test(
    line
  );
}

function allowRetiredNameInValidationError(params: {
  file: string;
  line: string;
}): boolean {
  return (
    /^src\/config\//.test(params.file.split(path.sep).join('/')) &&
    isMigrationErrorLine(params.line)
  );
}

function allowFactoryLogOutsideDirectDexRuntime(params: {
  file: string;
  line: string;
}): boolean {
  if (allowRetiredNameInValidationError(params)) {
    return true;
  }
  const normalized = params.file.split(path.sep).join('/');
  return !(
    normalized.startsWith('src/take/direct-dex/') ||
    normalized === 'src/take/manual-context.ts' ||
    normalized === 'docs/fixtures/live-base-liquidation-fixture.md' ||
    normalized === 'README.md' ||
    normalized === 'production_setup_guide.md'
  );
}

function allowLegitimateFactoryTerm(params: {
  file: string;
  line: string;
}): boolean {
  if (allowRetiredNameInValidationError(params)) {
    return true;
  }
  return /\b(?:[A-Za-z0-9]+__factory|poolFactoryAddress|erc20PoolFactory|erc721PoolFactory|fungiblePoolFactory|getFactoryContract)\b/.test(
    params.line
  );
}

export const BOUNDARY_RULES: readonly BoundaryRule[] = [
  {
    id: 'retired-path-oneinch',
    detail:
      "standalone external-take path 'oneinch' is retired; use providerId 'oneinch' under calldata_aggregator",
    re: /\b(?:allowedExternalTakePaths|externalTakePath|deploymentType|path|kind)\b[^,\]\n;}]*(?:'oneinch'|"oneinch")/,
    allow: allowRetiredNameInValidationError,
  },
  {
    id: 'retired-path-lifi',
    detail:
      "top-level external-take path alias 'lifi' is retired; use calldata_aggregator plus providerId 'lifi'",
    re: /\b(?:allowedExternalTakePaths|externalTakePath|deploymentType|path|kind)\b[^,\]\n;}]*(?:'lifi'|"lifi")/,
    allow: allowRetiredNameInValidationError,
  },
  {
    id: 'retired-path-factory',
    detail:
      "external-take path 'factory' is retired; use direct_dex for direct DEX routes",
    re: /\b(?:allowedExternalTakePaths|externalTakePath|deploymentType|path|kind)\b[^,\]\n;}]*(?:'factory'|"factory")/,
    allow: allowRetiredNameInValidationError,
  },
  {
    id: 'retired-factory-first',
    detail: 'factory_first is retired; use direct_dex_first',
    re: /\bfactory[_-]first\b/,
    allow: allowRetiredNameInValidationError,
  },
  {
    id: 'retired-default-factory-source',
    detail:
      'defaultFactoryLiquiditySource is retired; use defaultDirectDexLiquiditySource',
    re: /\bdefaultFactoryLiquiditySource\b/,
    allow: allowRetiredNameInValidationError,
  },
  {
    id: 'retired-takers-factory',
    detail: 'takers.factory is retired; use takers.router',
    re: /\btakers\.factory\b/,
    allow: allowRetiredNameInValidationError,
  },
  {
    id: 'retired-takers-oneinch',
    detail:
      'takers.oneInch is retired for external takes; use takers.router plus OneInchAggregator',
    re: /\btakers\.oneInch\b/,
    allow: allowRetiredNameInValidationError,
  },
  {
    id: 'retired-keeper-taker-factory',
    detail: 'keeperTakerFactory is retired; use router terminology',
    re: /\bkeeperTakerFactory\b/,
    allow: allowRetiredNameInValidationError,
  },
  {
    id: 'retired-factory-authorization',
    detail:
      'factory authorization ABI names are retired; use authorizedRouter/onlyOwnerOrRouter',
    re: /\b(?:authorizedFactory|_authorizedFactory|onlyOwnerOrFactory)\b/,
    allow: allowRetiredNameInValidationError,
  },
  {
    id: 'retired-factory-module',
    detail:
      'src/take/factory production module path is retired; use src/take/direct-dex',
    re: /\bsrc\/take\/factory\b|['"][^'"]*take\/factory[^'"]*['"]/,
    allow: allowRetiredNameInValidationError,
  },
  {
    id: 'retired-factory-symbol',
    detail:
      'factory-named direct DEX symbols are retired; use direct DEX names',
    re: /\b(?:takeLiquidationFactory|Factory[A-Z][A-Za-z0-9_]*|(?!defaultFactoryLiquiditySource\b)[a-z][A-Za-z0-9_]*Factory[A-Z][A-Za-z0-9_]*|approvedFactorySources|executedFactorySources|dryRunFactorySources|factoryFailures)\b/,
    allow: allowLegitimateFactoryTerm,
  },
  {
    id: 'retired-direct-dex-factory-log',
    detail: 'direct DEX runtime logs should not use the retired Factory prefix',
    re: /\bFactory:\s/,
    allow: allowFactoryLogOutsideDirectDexRuntime,
  },
  {
    id: 'retired-direct-dex-operator-label',
    detail:
      'direct DEX operator-facing labels should not describe the route as factory-backed',
    re: /\b(?:external-take factory\/taker|keeper taker factory address|selected factory path|factory pre-broadcast|factory post-submission|factory external takes?)\b/i,
    allow: allowRetiredNameInValidationError,
  },
  {
    id: 'retired-standalone-oneinch-contract',
    detail:
      'standalone AjnaKeeperTaker production contract is retired; use OneInchAggregatorKeeperTaker via TakerRouter',
    re: /\bAjnaKeeperTaker__factory\b|\bnew AjnaKeeperTaker\b|\bcontracts\/AjnaKeeperTaker\.sol\b/,
    allow: allowRetiredNameInValidationError,
  },
  {
    id: 'retired-standalone-oneinch-module',
    detail:
      'standalone 1inch take modules are retired; use oneinch-aggregator modules',
    re: /\bone-inch-(?:adapter|execution|types)\b/,
    allow: allowRetiredNameInValidationError,
  },
  {
    id: 'retired-standalone-oneinch-quotes',
    detail:
      'standalone 1inch quote functions are retired; use oneinch-aggregator quote evaluation',
    re: /\b(?:quoteOneInchPath|quoteKeeperTakerOneInchTake|quoteOneInchPathForDiscovery|quoteKeeperTakerOneInchTakeForDiscovery)\b/,
    allow: allowRetiredNameInValidationError,
  },
  {
    id: 'retired-provider-registry-field',
    detail:
      'public per-provider registry fields are retired; use selectExternalTakeProvider',
    re: /\b(?:registry|providerRegistry)\.(?:oneInchProvider|oneInchAggregatorProvider|lifiProvider|sushiAggregatorProvider|factoryProvider)\b/,
    allow: allowRetiredNameInValidationError,
  },
];

export function evaluateExternalTakeBoundaries(
  files: readonly BoundaryFile[]
): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  for (const file of files) {
    if (isIgnoredPath(file.file)) {
      continue;
    }
    const normalizedFile = file.file.split(path.sep).join('/');
    if (normalizedFile.startsWith('src/take/factory/')) {
      violations.push({
        file: file.file,
        line: 1,
        rule: 'retired-factory-module-path',
        detail:
          'src/take/factory production module path is retired; use src/take/direct-dex',
        text: normalizedFile,
      });
    }
    const lines = file.content.split('\n');
    lines.forEach((line, index) => {
      for (const rule of BOUNDARY_RULES) {
        if (!rule.re.test(line)) {
          continue;
        }
        const lineNumber = index + 1;
        if (rule.allow?.({ file: normalizedFile, line, lineNumber }) === true) {
          continue;
        }
        violations.push({
          file: file.file,
          line: lineNumber,
          rule: rule.id,
          detail: rule.detail,
          text: line.trim(),
        });
      }
    });
  }
  return violations;
}

export function parseBaseRef(argv: readonly string[]): string | undefined {
  const flagIndex = argv.indexOf('--base');
  if (flagIndex === -1 || flagIndex + 1 >= argv.length) {
    return undefined;
  }
  const value = argv[flagIndex + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

function shouldScanFile(file: string): boolean {
  return SCAN_EXTENSIONS.has(path.extname(file));
}

function collectFiles(root: string, out: string[]): void {
  if (!fs.existsSync(root)) {
    return;
  }
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    if (shouldScanFile(root)) {
      out.push(root);
    }
    return;
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      collectFiles(fullPath, out);
    } else if (entry.isFile() && shouldScanFile(fullPath)) {
      out.push(fullPath);
    }
  }
}

export function collectBoundaryFiles(repoRoot = process.cwd()): BoundaryFile[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    collectFiles(path.join(repoRoot, root), files);
  }
  for (const file of SCAN_FILES) {
    const fullPath = path.join(repoRoot, file);
    if (fs.existsSync(fullPath) && shouldScanFile(fullPath)) {
      files.push(fullPath);
    }
  }
  return files.map((file) => ({
    file: path.relative(repoRoot, file).split(path.sep).join('/'),
    content: fs.readFileSync(file, 'utf8'),
  }));
}

function main(): void {
  const baseRef = parseBaseRef(process.argv.slice(2));
  if (!baseRef) {
    console.error(
      'check-external-take-boundaries: an explicit --base <ref> is required'
    );
    process.exit(2);
  }
  const violations = evaluateExternalTakeBoundaries(collectBoundaryFiles());
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(
        `FAIL [${violation.rule}] ${violation.file}:${violation.line}: ` +
          `${violation.detail} (${violation.text})`
      );
    }
    console.error(
      `${violations.length} external-take boundary violation(s) against base ${baseRef}`
    );
    process.exit(1);
  }
  console.log(`external-take boundary check passed against ${baseRef}`);
}

if (require.main === module) {
  main();
}
