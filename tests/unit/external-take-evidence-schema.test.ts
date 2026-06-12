// Packet 2A evidence schema tests (tooling-only checker behavior).
//
// Validates the committed route_shape artifact, proves the route_shape
// boundary rejections (LI.FI/1inch provider results, proceed/defer decision
// blocks), and proves the competitiveness wrapper Packet 3A must reuse
// accepts the same SampleRow/ProviderResult components without conversion.
import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import {
  CompetitivenessArtifact,
  RouteShapeArtifact,
  routeShapeSuccessFloorMet,
  validateCompetitivenessArtifact,
  validateEvidenceArtifact,
  validateRouteShapeArtifact,
} from '../../tools/external-take-evidence/evidence-schema';

const ARTIFACT_PATH = path.join(
  __dirname,
  '..',
  '..',
  'tools',
  'external-take-evidence',
  'fixtures',
  'sushi-route-shape.artifact.json'
);

function loadCommittedArtifact(): RouteShapeArtifact {
  return JSON.parse(fs.readFileSync(ARTIFACT_PATH, 'utf8'));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

describe('external-take evidence schema (Packet 2A)', () => {
  it('validates the committed route_shape artifact', () => {
    const result = validateEvidenceArtifact(loadCommittedArtifact());
    expect(result.ok, JSON.stringify(result)).to.equal(true);
  });

  it('records the hand-rolled validation mechanism decision', () => {
    const artifact = loadCommittedArtifact();
    expect(artifact.validationMechanism).to.equal('hand-rolled');
  });

  it('rejects LI.FI provider results in a route_shape artifact', () => {
    const artifact = clone(loadCommittedArtifact());
    (artifact.rows[0].providerResults[0] as { provider: string }).provider =
      'lifi';
    const result = validateRouteShapeArtifact(artifact);
    expect(result.ok).to.equal(false);
    if (!result.ok) {
      expect(
        result.errors.some(error =>
          error.includes('only sushi provider results')
        ),
        result.errors.join('\n')
      ).to.equal(true);
    }
  });

  it('rejects 1inch provider results in a route_shape artifact', () => {
    const artifact = clone(loadCommittedArtifact());
    (artifact.rows[0].providerResults[0] as { provider: string }).provider =
      'oneinch';
    const result = validateRouteShapeArtifact(artifact);
    expect(result.ok).to.equal(false);
  });

  it('rejects proceed/defer decision blocks in a route_shape artifact', () => {
    const artifact = clone(loadCommittedArtifact()) as unknown as Record<
      string,
      unknown
    >;
    artifact.decision = { decision: 'proceed', rationale: 'smuggled' };
    const result = validateRouteShapeArtifact(artifact);
    expect(result.ok).to.equal(false);
    if (!result.ok) {
      expect(
        result.errors.some(error => error.includes('artifact.decision'))
      ).to.equal(true);
    }
  });

  it('rejects unknown failure classifications', () => {
    const artifact = clone(loadCommittedArtifact());
    artifact.rows[0].providerResults = [
      {
        provider: 'sushi',
        outcome: 'failure',
        classification: 'mystery' as never,
        evidenceSummary: 'bad classification',
      },
    ];
    const result = validateRouteShapeArtifact(artifact);
    expect(result.ok).to.equal(false);
  });

  it('rejects unknown artifact kinds', () => {
    const result = validateEvidenceArtifact({ artifactKind: 'vibes' });
    expect(result.ok).to.equal(false);
  });

  it('rejects success results without normalized execution fields', () => {
    const artifact = clone(loadCommittedArtifact());
    delete (
      artifact.rows[0].providerResults[0] as unknown as Record<string, unknown>
    ).normalized;
    const result = validateRouteShapeArtifact(artifact);
    expect(result.ok).to.equal(false);
  });

  it('accepts a competitiveness artifact reusing route_shape rows plus incumbents', () => {
    const routeShape = loadCommittedArtifact();
    const reusedRow = clone(routeShape.rows[0]);
    reusedRow.providerResults.push(
      {
        provider: 'lifi',
        outcome: 'failure',
        classification: 'no_route',
        evidenceSummary: 'incumbent returned no route for the pair',
      },
      {
        provider: 'oneinch',
        outcome: 'failure',
        classification: 'missing_credentials',
        evidenceSummary: 'incumbent credentials rejected (HTTP 401)',
      }
    );
    const artifact: CompetitivenessArtifact = {
      artifactKind: 'competitiveness',
      schemaVersion: 1,
      packet: '3A',
      generatedAt: new Date(0).toISOString(),
      validationMechanism: 'hand-rolled',
      rows: [reusedRow],
      decision: {
        decision: 'defer',
        rationale: 'wrapper shape test only; Packet 3A owns the real decision',
      },
    };
    const result = validateCompetitivenessArtifact(artifact);
    expect(result.ok, JSON.stringify(result)).to.equal(true);
  });

  it('rejects a competitiveness artifact without a decision block', () => {
    const routeShape = loadCommittedArtifact();
    const artifact = {
      artifactKind: 'competitiveness',
      schemaVersion: 1,
      packet: '3A',
      generatedAt: new Date(0).toISOString(),
      validationMechanism: 'hand-rolled',
      rows: [clone(routeShape.rows[0])],
    };
    const result = validateCompetitivenessArtifact(artifact);
    expect(result.ok).to.equal(false);
  });

  it('rejects a competitiveness decision outside proceed/defer', () => {
    const routeShape = loadCommittedArtifact();
    const artifact = {
      artifactKind: 'competitiveness',
      schemaVersion: 1,
      packet: '3A',
      generatedAt: new Date(0).toISOString(),
      validationMechanism: 'hand-rolled',
      rows: [clone(routeShape.rows[0])],
      decision: { decision: 'maybe', rationale: 'indecisive' },
    };
    const result = validateCompetitivenessArtifact(artifact);
    expect(result.ok).to.equal(false);
  });

  describe('objective successful-route floor', () => {
    it('is met by the committed artifact', () => {
      const floor = routeShapeSuccessFloorMet(loadCommittedArtifact());
      expect(floor.met, floor.detail).to.equal(true);
    });

    it('is met by two successful distinct chains even with unproven shapes', () => {
      const artifact = clone(loadCommittedArtifact());
      artifact.rows = artifact.rows.slice(0, 2);
      expect(artifact.rows[0].chainId).to.not.equal(artifact.rows[1].chainId);
      const floor = routeShapeSuccessFloorMet(artifact);
      expect(floor.met, floor.detail).to.equal(true);
    });

    it('is unmet with one successful chain and an unproven observed shape', () => {
      const artifact = clone(loadCommittedArtifact());
      artifact.rows = artifact.rows.slice(0, 1);
      expect(
        artifact.observedResponseShapes.some(shape => !shape.proven),
        'committed artifact should record the unproven Polygon shape'
      ).to.equal(true);
      const floor = routeShapeSuccessFloorMet(artifact);
      expect(floor.met).to.equal(false);
    });

    it('is met with one successful chain when every observed shape is proven', () => {
      const artifact = clone(loadCommittedArtifact());
      artifact.rows = artifact.rows.slice(0, 1);
      artifact.observedResponseShapes = artifact.observedResponseShapes.filter(
        shape => shape.proven
      );
      const floor = routeShapeSuccessFloorMet(artifact);
      expect(floor.met, floor.detail).to.equal(true);
    });
  });
});
