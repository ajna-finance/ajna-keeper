// Packet 2B resolved-policy boundary check (packet-2b.md): production
// runtime modules outside src/config/route-policy.ts must not import the raw
// path/default-source/provider-list resolution helpers or inspect raw
// take-policy fields for execution decisions; they consume
// ResolvedExternalTakePolicy. This is deliberately the simplest
// import-statement and member-read text scan that works — the repo has no
// linter, and a bespoke AST framework for four banned imports is exactly the
// kind of heavy mechanism the roadmap avoids. If the repo later adopts a
// linter, migrate this rule to no-restricted-imports/no-restricted-syntax
// and delete this test.
//
// The scan targets policy interpretation only. It must NOT reject provider
// API payload parsing or provider labels (e.g. LI.FI response checks such as
// quote.type === 'lifi', tool-name validation, dex.lifi config field names,
// log labels, fixture payloads, provider ids, or diagnostics).
import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.join(__dirname, '..', '..');

const SCAN_DIRS = [
  path.join(REPO_ROOT, 'src', 'discovery'),
  path.join(REPO_ROOT, 'src', 'take'),
  path.join(REPO_ROOT, 'src', 'dex'),
];
const SCAN_FILES = [
  path.join(REPO_ROOT, 'scripts', 'deploy-factory-system.ts'),
];

// Raw policy-resolution helpers privatized into resolveExternalTakePolicy.
const BANNED_IMPORT_NAMES = [
  'resolveExternalTakePaths',
  'resolveDefaultFactoryLiquiditySource',
  'resolveFactoryRouteSelectionSources',
];

// Raw take-policy fields whose interpretation belongs to the resolver.
// Member READS of these in runtime modules are banned; the fields may still
// appear in type/interface declarations and resolver input pass-through.
const BANNED_MEMBER_READS = [
  'allowedExternalTakePaths',
  'allowedCalldataAggregatorProviders',
  'defaultFactoryLiquiditySource',
];

// Legacy `lifi` may not be interpreted as an external-take path/kind/
// deployment sentinel outside config/env/no-spend input parsing. Provider
// ids, provider payload literals, labels, and dex.lifi config keys are fine.
const LIFI_PATH_ALIAS_PATTERNS: { re: RegExp; what: string }[] = [
  { re: /externalTakePath\s*[!=]==?\s*'lifi'/, what: "externalTakePath compared to 'lifi'" },
  { re: /externalTakePath:\s*'lifi'/, what: "externalTakePath: 'lifi'" },
  { re: /\bdeploymentType\s*[!=]==?\s*'lifi'/, what: "deploymentType compared to 'lifi'" },
  { re: /\bdeploymentType:\s*'lifi'/, what: "deploymentType: 'lifi'" },
  { re: /\bpath\s*[!=]==?\s*'lifi'/, what: "path compared to 'lifi'" },
  { re: /\bpath:\s*'lifi'/, what: "path: 'lifi'" },
  { re: /\bkind\s*[!=]==?\s*'lifi'/, what: "kind compared to 'lifi'" },
  { re: /\bkind:\s*'lifi'/, what: "kind: 'lifi'" },
];

function collectTypeScriptFiles(target: string, out: string[]): string[] {
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    if (target.endsWith('.ts')) {
      out.push(target);
    }
    return out;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const fullPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      collectTypeScriptFiles(fullPath, out);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(fullPath);
    }
  }
  return out;
}

function scanTargets(): string[] {
  const files: string[] = [];
  for (const dir of SCAN_DIRS) {
    collectTypeScriptFiles(dir, files);
  }
  for (const file of SCAN_FILES) {
    if (fs.existsSync(file)) {
      files.push(file);
    }
  }
  return files;
}

function relative(file: string): string {
  return path.relative(REPO_ROOT, file);
}

describe('resolved external-take policy boundary (Packet 2B)', () => {
  const files = scanTargets();

  it('scans a non-empty production surface', () => {
    expect(files.length).to.be.greaterThan(20);
  });

  it('does not import raw policy-resolution helpers', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      const importRe = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g;
      let match: RegExpExecArray | null;
      while ((match = importRe.exec(content)) !== null) {
        for (const banned of BANNED_IMPORT_NAMES) {
          // Match the exact imported binding, not substrings of longer names
          // (resolveExternalTakePolicy must stay importable).
          const names = match[1]
            .split(',')
            .map(part => part.trim().split(/\s+as\s+/)[0].trim());
          if (names.indexOf(banned) >= 0) {
            offenders.push(`${relative(file)}: imports ${banned}`);
          }
        }
      }
    }
    expect(offenders, offenders.join('\n')).to.deep.equal([]);
  });

  it('does not member-read raw take-policy fields for execution decisions', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        for (const field of BANNED_MEMBER_READS) {
          // Property READ shapes: `x.field`, `x?.field`. Reads off the
          // resolver's output object are the sanctioned pattern, so any
          // receiver identifier containing "resolved" is allowed.
          const readRe = new RegExp(
            String.raw`([A-Za-z_$][\w$]*)\??\.${field}\b`
          );
          const match = readRe.exec(line);
          if (match && !/resolved/i.test(match[1])) {
            offenders.push(
              `${relative(file)}:${index + 1}: reads raw ${field} (${line.trim()})`
            );
          }
        }
      });
    }
    expect(offenders, offenders.join('\n')).to.deep.equal([]);
  });

  it("does not interpret legacy 'lifi' as an external-take path alias", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        for (const pattern of LIFI_PATH_ALIAS_PATTERNS) {
          if (pattern.re.test(line)) {
            offenders.push(
              `${relative(file)}:${index + 1}: ${pattern.what} (${line.trim()})`
            );
          }
        }
      });
    }
    expect(offenders, offenders.join('\n')).to.deep.equal([]);
  });
});
