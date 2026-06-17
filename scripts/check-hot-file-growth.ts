// Roadmap hot-file growth checker (calldata-aggregator follow-up packets).
//
// Compares the current tree (including uncommitted changes) against an
// EXPLICIT base ref and fails when a roadmap hot file grows. Packets touching
// hot files must run this against their declared base ref; overrides happen
// only through packet-closeout justification, never by editing the rules.
//
// Rules (enforced directly by this checker):
//   1. net-growth:     a hot file's final line count exceeds its base count
//   2. added-lines:    more than MAX_ADDED_LINES gross added lines in a hot
//                      file, even when net growth is zero or negative
//   3. total-line-cap: selected hot files at or above their hard line caps
//   4. base-ref:       missing or unresolvable --base ref is a failure
//   5. compatibility-import:
//                      repo code imports a compatibility-only hot module instead
//                      of the domain module that owns the logic
//
// Usage: npm run check-hot-file-growth -- --base <ref>
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';

export const HOT_FILES: readonly string[] = [
  'src/config/validation.ts',
  'scripts/deploy-factory-system.ts',
  'scripts/run-fixture-keeper-harness.ts',
  'scripts/create-liquidatable-ajna-fixture.ts',
];

export const MAX_ADDED_LINES = 10;

export const FINAL_LINE_CAPS: Readonly<Record<string, number>> = {
  'scripts/deploy-factory-system.ts': 1000,
};

export const OWNERSHIP_FILE_LINE_CAPS: Readonly<Record<string, number>> = {
  'src/config/validation-rules.ts': 1000,
  'src/config/auto-discover-validation.ts': 1000,
  'src/discovery/route-preflight-validation.ts': 1000,
  'src/take/direct-dex/route-amounts.ts': 1000,
  'src/take/direct-dex/route-profitability.ts': 1000,
  'src/take/direct-dex/route-types.ts': 500,
  'src/take/external-take/route-binding.ts': 1000,
  'src/take/external-take/quote-approval-rules.ts': 1000,
  'scripts/deploy-factory-system-cli.ts': 1000,
  'scripts/fixture-keeper-harness-cli.ts': 1000,
  'scripts/no-spend/harness-report.ts': 1000,
};

export interface CompatibilityOnlyHotModule {
  file: string;
  replacement: string;
  replacementByImport?: Readonly<Record<string, string>>;
}

interface ModuleSpecifierRef {
  moduleSpecifier: string;
  line: number;
  importedNames?: readonly string[];
}

export const COMPATIBILITY_ONLY_HOT_MODULES: readonly CompatibilityOnlyHotModule[] =
  [
    {
      file: 'src/config/validation.ts',
      replacement:
        'src/config/validation-rules.ts or src/config/auto-discover-validation.ts',
      replacementByImport: {
        validateAutoDiscoverConfig: 'src/config/auto-discover-validation.ts',
      },
    },
  ];

export interface HotFileStat {
  file: string;
  addedLines: number;
  removedLines: number;
  baseLineCount: number;
  finalLineCount: number;
}

export interface Violation {
  file: string;
  rule:
    | 'net-growth'
    | 'added-lines'
    | 'total-line-cap'
    | 'ownership-line-cap'
    | 'compatibility-import';
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

export function evaluateOwnershipFileLineCaps(
  caps: Readonly<Record<string, number>> = OWNERSHIP_FILE_LINE_CAPS
): Violation[] {
  const violations: Violation[] = [];
  for (const [file, cap] of Object.entries(caps)) {
    const lineCount = currentFileLineCount(file);
    if (lineCount >= cap) {
      violations.push({
        file,
        rule: 'ownership-line-cap',
        detail: `${lineCount} lines reaches the ${cap}-line ownership cap`,
      });
    }
  }
  return violations;
}

function git(
  args: string[],
  options: { stderr?: 'pipe' | 'ignore' } = {}
): string {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', options.stderr ?? 'pipe'],
  });
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
    return countLines(git(['show', `${baseRef}:${file}`], { stderr: 'ignore' }));
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

function stripKnownExtension(file: string): string {
  return file.replace(/\.(?:cjs|mjs|jsx|js|tsx|ts)$/, '');
}

function resolveRelativeModulePath(
  importerFile: string,
  moduleSpecifier: string
): string | undefined {
  if (!moduleSpecifier.startsWith('.')) {
    return undefined;
  }
  return stripKnownExtension(
    path
      .normalize(path.join(path.dirname(importerFile), moduleSpecifier))
      .replace(/\\/g, '/')
  );
}

function listRepoCodeFiles(): string[] {
  return git(['ls-files', '--cached', '--others', '--exclude-standard'])
    .split('\n')
    .filter((file) => /\.(?:cjs|mjs|jsx|js|tsx|ts)$/.test(file));
}

function stringLiteralText(node: ts.Node | undefined): string | undefined {
  if (
    node &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
  ) {
    return node.text;
  }
  return undefined;
}

function collectNamedSpecifiers(
  node: ts.ImportDeclaration | ts.ExportDeclaration
): string[] | undefined {
  if (ts.isImportDeclaration(node)) {
    const namedBindings = node.importClause?.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) {
      return undefined;
    }
    return namedBindings.elements.map((element) => element.name.text);
  }

  const exportClause = node.exportClause;
  if (!exportClause || !ts.isNamedExports(exportClause)) {
    return undefined;
  }
  return exportClause.elements.map((element) => element.name.text);
}

function collectModuleSpecifiers(
  file: string,
  content: string
): ModuleSpecifierRef[] {
  const sourceFile = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true
  );
  const specifiers: ModuleSpecifierRef[] = [];

  const recordSpecifier = (
    node: ts.Node | undefined,
    importedNames?: readonly string[]
  ): void => {
    const moduleSpecifier = stringLiteralText(node);
    if (moduleSpecifier === undefined || node === undefined) {
      return;
    }
    const position = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile)
    );
    specifiers.push({
      moduleSpecifier,
      line: position.line + 1,
      importedNames,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      recordSpecifier(node.moduleSpecifier, collectNamedSpecifiers(node));
    } else if (ts.isCallExpression(node)) {
      const firstArgument = node.arguments[0];
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')
      ) {
        recordSpecifier(firstArgument);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specifiers;
}

function resolveCompatibilityReplacement(
  compatibilityModule: CompatibilityOnlyHotModule,
  specifier: ModuleSpecifierRef
): string {
  const mappedReplacements = new Set<string>();
  for (const importedName of specifier.importedNames ?? []) {
    const replacement = compatibilityModule.replacementByImport?.[importedName];
    if (replacement === undefined) {
      return compatibilityModule.replacement;
    }
    mappedReplacements.add(replacement);
  }
  if (mappedReplacements.size === 1) {
    return Array.from(mappedReplacements)[0];
  }
  return compatibilityModule.replacement;
}

export function collectCompatibilityImportViolations(): Violation[] {
  const compatibilityByPath = new Map(
    COMPATIBILITY_ONLY_HOT_MODULES.map((entry) => [
      stripKnownExtension(entry.file),
      entry,
    ])
  );
  const violations: Violation[] = [];

  for (const file of listRepoCodeFiles()) {
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const importerPath = stripKnownExtension(file);
    for (const specifier of collectModuleSpecifiers(file, content)) {
      const resolvedPath = resolveRelativeModulePath(
        file,
        specifier.moduleSpecifier
      );
      const compatibilityModule =
        resolvedPath && compatibilityByPath.get(resolvedPath);
      if (!compatibilityModule || resolvedPath === importerPath) {
        continue;
      }
      violations.push({
        file,
        rule: 'compatibility-import',
        detail:
          `line ${specifier.line} imports compatibility shim ` +
          `${compatibilityModule.file}; import ` +
          `${resolveCompatibilityReplacement(
            compatibilityModule,
            specifier
          )} directly inside the repo`,
      });
    }
  }

  return violations;
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
  const violations = [
    ...evaluateHotFileGrowth(stats),
    ...evaluateOwnershipFileLineCaps(),
    ...collectCompatibilityImportViolations(),
  ];

  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(
        `FAIL [${violation.rule}] ${violation.file}: ${violation.detail}`
      );
    }
    console.error(
      `${violations.length} hot-file violation(s) against base ${baseRef}. ` +
        'Move logic into a focused helper/provider-neutral module and import ' +
        'compatibility shims only from outside repo code; this gate does not ' +
        'accept inline exceptions.'
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
