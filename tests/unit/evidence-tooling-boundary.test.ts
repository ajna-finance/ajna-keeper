// Packet 2A boundary check: production src/** must not import the
// tooling-only evidence checker, its evidence-only types, or recorded
// route-shape artifacts. The evidence
// tooling lives in tools/external-take-evidence/ and is reachable only from
// tests/ and scripts/ entrypoints.
import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

const SRC_DIR = path.join(__dirname, '..', '..', 'src');

function collectTypeScriptFiles(dir: string, out: string[]): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTypeScriptFiles(fullPath, out);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(fullPath);
    }
  }
  return out;
}

describe('evidence tooling boundary (Packet 2A)', () => {
  it('production src/** never references the evidence tooling or artifacts', () => {
    const files = collectTypeScriptFiles(SRC_DIR, []);
    expect(files.length).to.be.greaterThan(0);
    const offenders: string[] = [];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      if (content.includes('external-take-evidence')) {
        offenders.push(`${file}: references external-take-evidence`);
      }
      const importRe = /(?:from\s+['"]|require\(\s*['"])([^'"]+)['"]/g;
      let match: RegExpExecArray | null;
      while ((match = importRe.exec(content)) !== null) {
        const importPath = match[1];
        if (
          importPath.includes('tools/') ||
          importPath.includes('route-shape.artifact')
        ) {
          offenders.push(`${file}: imports ${importPath}`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).to.deep.equal([]);
  });
});
