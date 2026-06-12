// Verifies every `// sig: 0x........` annotation on a custom error declaration
// in contracts/ (mocks excluded) matches the actual keccak-derived selector.
// These comments exist for off-chain revert decoding and have historically
// rotted (seven were wrong before the 2026-06 audit); this test makes the
// convention self-enforcing.
import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { utils } from 'ethers';

interface AnnotatedError {
  file: string;
  name: string;
  params: string;
  annotatedSelector: string;
}

function listSolidityFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'mocks') continue; // test doubles are exempt
      out.push(...listSolidityFiles(full));
    } else if (entry.name.endsWith('.sol')) {
      out.push(full);
    }
  }
  return out;
}

function canonicalSignature(name: string, params: string): string {
  const types = params
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    // Parameters may be declared with names ("address spender"); the
    // signature uses only the type token.
    .map((p) => p.split(/\s+/)[0]);
  return `${name}(${types.join(',')})`;
}

function collectAnnotatedErrors(file: string, source: string): AnnotatedError[] {
  const found: AnnotatedError[] = [];

  // Style A: trailing annotation on the declaration line:
  //   error SwapFailed();         // sig: 0x81ceff30
  const trailing =
    /error\s+(\w+)\s*\(([^)]*)\)\s*;[^\n]*?\/\/\s*sig:\s*(0x[0-9a-fA-F]{8})/g;
  let m: RegExpExecArray | null;
  while ((m = trailing.exec(source)) !== null) {
    found.push({
      file,
      name: m[1],
      params: m[2],
      annotatedSelector: m[3].toLowerCase(),
    });
  }

  // Style B: annotation alone on a preceding line (optionally followed by
  // natspec). Anchored to line start so a trailing annotation on the previous
  // declaration's line cannot mis-pair with the NEXT declaration:
  //   // sig: 0xf54a7ed9
  //   /// @notice ...
  //   error UnsupportedLiquiditySource();
  const preceding =
    /(?:^|\n)[ \t]*\/\/\s*sig:\s*(0x[0-9a-fA-F]{8})[ \t]*\n(?:[ \t]*\/\/\/[^\n]*\n)*[ \t]*error\s+(\w+)\s*\(([^)]*)\)\s*;/g;
  while ((m = preceding.exec(source)) !== null) {
    found.push({
      file,
      name: m[2],
      params: m[3],
      annotatedSelector: m[1].toLowerCase(),
    });
  }

  return found;
}

describe('contract error selector annotations', () => {
  const contractsDir = path.join(__dirname, '..', '..', 'contracts');
  const annotated: AnnotatedError[] = [];
  for (const file of listSolidityFiles(contractsDir)) {
    annotated.push(
      ...collectAnnotatedErrors(
        path.relative(contractsDir, file),
        fs.readFileSync(file, 'utf8')
      )
    );
  }

  it('finds the annotated error declarations', () => {
    // Guard against the patterns silently rotting to zero matches: the
    // contracts currently carry at least this many `// sig:` annotations.
    expect(annotated.length).to.be.greaterThanOrEqual(8);
  });

  it('every annotated selector matches the keccak-derived selector', () => {
    const mismatches: string[] = [];
    for (const entry of annotated) {
      const signature = canonicalSignature(entry.name, entry.params);
      const actual = utils.id(signature).slice(0, 10).toLowerCase();
      if (actual !== entry.annotatedSelector) {
        mismatches.push(
          `${entry.file}: ${signature} is ${actual}, annotated ${entry.annotatedSelector}`
        );
      }
    }
    expect(mismatches, mismatches.join('; ')).to.deep.equal([]);
  });
});
