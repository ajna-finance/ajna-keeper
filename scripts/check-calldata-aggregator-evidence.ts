// Calldata-aggregator evidence checker (SushiSwap aggregator roadmap,
// Packets 2A/3A). One of the roadmap's three sanctioned meta-tooling gates
// (with the Packet 0 hot-file checker and the Packet 2B boundary check).
//
// Validates a committed evidence artifact against the tooling-only schema in
// tools/external-take-evidence/evidence-schema.ts, then for route_shape
// artifacts additionally proves:
//   1. matrix:      rows cover the required 7-chain minimum fixture matrix
//   2. floor:       the objective successful-route floor is met
//   3. re-derive:   every recorded success row re-normalizes from its raw
//                   fixture to byte-identical normalized fields
//   4. fail-closed: at least one committed malformed/ambiguous fixture
//                   exists and the normalizer rejects every one of them
//
// The packet doc names a .mjs entrypoint; this repo's recorded Packet 0
// precedent translates command entrypoints to ts-node .ts scripts.
//
// Usage: npm run check-calldata-aggregator-evidence [-- --artifact <path>]
import * as fs from 'fs';
import * as path from 'path';
import {
  CompetitivenessArtifact,
  EVIDENCE_PROVIDERS,
  ProviderSuccessResult,
  RouteShapeArtifact,
  routeShapeSuccessFloorMet,
  validateEvidenceArtifact,
} from '../tools/external-take-evidence/evidence-schema';
import {
  SushiQuoteRequestContext,
  normalizeSushiV7Response,
} from '../tools/external-take-evidence/sushi-route-normalizer';

export const DEFAULT_ARTIFACT_PATH = path.join(
  __dirname,
  '..',
  'tools',
  'external-take-evidence',
  'fixtures',
  'sushi-route-shape.artifact.json'
);

export const REQUIRED_ROUTE_SHAPE_MATRIX_CHAIN_IDS: readonly number[] = [
  1, 8453, 42161, 10, 137, 43114, 43111,
];

export interface CheckViolation {
  rule: string;
  detail: string;
}

interface RawFixtureFile {
  fixtureKind?: string;
  capturedAt?: string;
  expectedNormalization?: string;
  request?: {
    chainId?: number;
    tokenIn?: string;
    tokenOut?: string;
    amountIn?: string;
    maxSlippage?: number;
    sender?: string;
    recipient?: string;
  };
  response?: unknown;
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return (
      '{' +
      keys
        .map(key => JSON.stringify(key) + ':' + stableStringify(record[key]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}

function loadJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function fixtureContext(
  fixture: RawFixtureFile,
  filePath: string
): SushiQuoteRequestContext | undefined {
  const request = fixture.request;
  if (
    !request ||
    typeof request.chainId !== 'number' ||
    typeof request.tokenIn !== 'string' ||
    typeof request.tokenOut !== 'string' ||
    typeof request.amountIn !== 'string' ||
    typeof request.maxSlippage !== 'number' ||
    typeof request.sender !== 'string' ||
    typeof fixture.capturedAt !== 'string'
  ) {
    return undefined;
  }
  return {
    chainId: request.chainId,
    tokenIn: request.tokenIn,
    tokenOut: request.tokenOut,
    amountIn: request.amountIn,
    maxSlippage: request.maxSlippage,
    sender: request.sender,
    ...(request.recipient ? { recipient: request.recipient } : {}),
    requestedAt: fixture.capturedAt,
  };
}

export function checkRouteShapeArtifact(
  artifact: RouteShapeArtifact,
  artifactDir: string
): CheckViolation[] {
  const violations: CheckViolation[] = [];

  for (const chainId of REQUIRED_ROUTE_SHAPE_MATRIX_CHAIN_IDS) {
    if (!artifact.rows.some(row => row.chainId === chainId)) {
      violations.push({
        rule: 'matrix',
        detail: `required matrix chain ${chainId} has no recorded row`,
      });
    }
  }

  const floor = routeShapeSuccessFloorMet(artifact);
  if (!floor.met) {
    violations.push({
      rule: 'floor',
      detail:
        `objective successful-route floor unmet (${floor.detail}); ` +
        'Packet 2B is blocked or must be scope-limited to the proven shape',
    });
  }

  for (const row of artifact.rows) {
    for (const result of row.providerResults) {
      const fixtureRelPath =
        result.outcome === 'success' || result.rawFixturePath
          ? result.rawFixturePath
          : undefined;
      if (!fixtureRelPath) {
        continue;
      }
      const fixturePath = path.join(artifactDir, fixtureRelPath);
      if (!fs.existsSync(fixturePath)) {
        violations.push({
          rule: 're-derive',
          detail: `${row.chainName}: referenced fixture ${fixtureRelPath} does not exist`,
        });
        continue;
      }
      if (result.outcome !== 'success') {
        continue;
      }
      const fixture = loadJson(fixturePath) as RawFixtureFile;
      const ctx = fixtureContext(fixture, fixturePath);
      if (!ctx) {
        violations.push({
          rule: 're-derive',
          detail: `${row.chainName}: fixture ${fixtureRelPath} is missing request context`,
        });
        continue;
      }
      const normalization = normalizeSushiV7Response(fixture.response, ctx);
      if (!normalization.ok) {
        violations.push({
          rule: 're-derive',
          detail:
            `${row.chainName}: recorded success no longer normalizes from ` +
            `${fixtureRelPath}: ${normalization.reason}`,
        });
        continue;
      }
      const recorded = stableStringify(
        (result as ProviderSuccessResult).normalized
      );
      const rederived = stableStringify(normalization.normalized);
      if (recorded !== rederived) {
        violations.push({
          rule: 're-derive',
          detail:
            `${row.chainName}: normalized fields drifted from the raw fixture ` +
            `${fixtureRelPath} (recorded vs re-derived mismatch)`,
        });
      }
    }
  }

  const rawDir = path.join(artifactDir, 'raw');
  const failClosedFixtures: string[] = [];
  if (fs.existsSync(rawDir)) {
    for (const fileName of fs.readdirSync(rawDir)) {
      if (!fileName.endsWith('.json')) {
        continue;
      }
      const fixture = loadJson(path.join(rawDir, fileName)) as RawFixtureFile;
      if (fixture.expectedNormalization === 'fail_closed') {
        failClosedFixtures.push(fileName);
        const ctx = fixtureContext(fixture, fileName);
        if (!ctx) {
          // Failure-shape captures (HTTP 4xx) still carry request context;
          // a fixture without one cannot prove anything.
          violations.push({
            rule: 'fail-closed',
            detail: `${fileName}: fail-closed fixture is missing request context`,
          });
          continue;
        }
        const normalization = normalizeSushiV7Response(fixture.response, ctx);
        if (normalization.ok) {
          violations.push({
            rule: 'fail-closed',
            detail:
              `${fileName}: fixture marked fail_closed but the normalizer ` +
              'accepted it',
          });
        }
      }
    }
  }
  if (failClosedFixtures.length === 0) {
    violations.push({
      rule: 'fail-closed',
      detail:
        'no committed malformed/ambiguous fail-closed fixture found under raw/',
    });
  }

  return violations;
}

// Packet 3A competitiveness rules: matrix coverage, one discriminated result
// per provider per row, and the coverage-based-proceed veto (incumbent
// failures justifying coverage must be reproducible unsupported_chain or
// no_route — never credentials, rate limits, transient errors, or malformed
// responses).
export function checkCompetitivenessArtifact(
  artifact: CompetitivenessArtifact
): CheckViolation[] {
  const violations: CheckViolation[] = [];
  for (const chainId of REQUIRED_ROUTE_SHAPE_MATRIX_CHAIN_IDS) {
    if (!artifact.rows.some(row => row.chainId === chainId)) {
      violations.push({
        rule: 'matrix',
        detail: `required matrix chain ${chainId} has no recorded row`,
      });
    }
  }
  for (const row of artifact.rows) {
    for (const provider of EVIDENCE_PROVIDERS) {
      const results = row.providerResults.filter(
        result => result.provider === provider
      );
      if (results.length !== 1) {
        violations.push({
          rule: 'providers',
          detail: `${row.chainName}: expected exactly one ${provider} result, found ${results.length}`,
        });
      }
    }
  }
  const decision = artifact.decision;
  if (decision.decision === 'proceed' && decision.scope) {
    for (const chainId of decision.scope.chains) {
      const row = artifact.rows.find(candidate => candidate.chainId === chainId);
      if (!row) {
        violations.push({
          rule: 'scope',
          detail: `proceed scope chain ${chainId} has no sample row`,
        });
        continue;
      }
      const sushiSuccess = row.providerResults.some(
        result => result.provider === 'sushi' && result.outcome === 'success'
      );
      if (!sushiSuccess) {
        violations.push({
          rule: 'scope',
          detail: `proceed scope chain ${chainId} has no successful Sushi route`,
        });
        continue;
      }
      const incumbentResults = row.providerResults.filter(
        result => result.provider !== 'sushi'
      );
      const incumbentSuccess = incumbentResults.some(
        result => result.outcome === 'success'
      );
      if (!incumbentSuccess) {
        // Coverage-based justification for this chain.
        for (const result of incumbentResults) {
          if (result.outcome !== 'failure') {
            continue;
          }
          const eligible =
            (result.classification === 'unsupported_chain' ||
              result.classification === 'no_route') &&
            result.reproducible === true;
          if (!eligible) {
            violations.push({
              rule: 'coverage-proceed',
              detail:
                `chain ${chainId}: coverage-based proceed needs reproducible ` +
                `unsupported_chain/no_route incumbents; ${result.provider} is ` +
                `${result.classification} (reproducible=${String(result.reproducible)})`,
            });
          }
        }
      } else if (!row.assessment) {
        violations.push({
          rule: 'scope',
          detail:
            `chain ${chainId}: proceed with a successful incumbent requires a ` +
            'recorded per-row comparison assessment',
        });
      }
    }
  }
  return violations;
}

function main(): void {
  const args = process.argv.slice(2);
  let artifactPath = DEFAULT_ARTIFACT_PATH;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--artifact') {
      const value = args[i + 1];
      if (!value) {
        console.error('FAIL [usage] --artifact requires a path argument');
        process.exit(1);
      }
      artifactPath = path.resolve(value);
      i++;
    }
  }

  if (!fs.existsSync(artifactPath)) {
    console.error(`FAIL [artifact] evidence artifact not found: ${artifactPath}`);
    process.exit(1);
  }

  let parsed: unknown;
  try {
    parsed = loadJson(artifactPath);
  } catch (error) {
    console.error(
      `FAIL [artifact] could not parse ${artifactPath}: ` +
        `${error instanceof Error ? error.message : error}`
    );
    process.exit(1);
  }

  const validation = validateEvidenceArtifact(parsed);
  if (!validation.ok) {
    for (const error of validation.errors) {
      console.error(`FAIL [schema] ${error}`);
    }
    console.error(
      `${validation.errors.length} schema violation(s) in ${artifactPath}`
    );
    process.exit(1);
  }

  const artifact = validation.artifact;
  console.log(`ok schema: ${artifact.artifactKind} artifact validates`);

  if (artifact.artifactKind === 'route_shape') {
    const violations = checkRouteShapeArtifact(
      artifact,
      path.dirname(artifactPath)
    );
    if (violations.length > 0) {
      for (const violation of violations) {
        console.error(`FAIL [${violation.rule}] ${violation.detail}`);
      }
      console.error(
        `${violations.length} evidence violation(s) in ${artifactPath}`
      );
      process.exit(1);
    }
    const successRows = artifact.rows.filter(row =>
      row.providerResults.some(result => result.outcome === 'success')
    );
    console.log(
      `ok matrix: ${artifact.rows.length} rows cover the required chains`
    );
    console.log(
      `ok floor: ${routeShapeSuccessFloorMet(artifact).detail} ` +
        `(${successRows.length} successful row(s))`
    );
    console.log('ok re-derive: recorded normalized fields match raw fixtures');
    console.log('ok fail-closed: committed fixtures are rejected as required');
  }

  if (artifact.artifactKind === 'competitiveness') {
    const violations = checkCompetitivenessArtifact(artifact);
    if (violations.length > 0) {
      for (const violation of violations) {
        console.error(`FAIL [${violation.rule}] ${violation.detail}`);
      }
      console.error(
        `${violations.length} evidence violation(s) in ${artifactPath}`
      );
      process.exit(1);
    }
    console.log(
      `ok matrix: ${artifact.rows.length} rows cover the required chains with all three providers`
    );
    console.log(
      `ok decision: ${artifact.decision.decision} (${artifact.decision.rationale.slice(0, 100)})`
    );
  }
}

if (require.main === module) {
  main();
}
