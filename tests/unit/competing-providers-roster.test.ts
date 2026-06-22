import { expect } from 'chai';
import { LiquiditySource } from '../../src/config';
import type {
  BoundExternalTakeRouteEvaluation,
  TakeDecision,
} from '../../src/take/types';
import {
  createExternalTakeExecutionCandidate,
  createExternalTakeExecutionPlan,
} from '../../src/take/external-take/execution-plan';
import {
  serializeDecisionEvent,
  buildRouteArtifact,
} from '../../scripts/no-spend/harness-report';

// Minimal evaluation: the roster derivation only reads selectedLiquiditySource.
function evaluation(
  source: LiquiditySource
): BoundExternalTakeRouteEvaluation {
  return {
    isTakeable: true,
    externalTakePath:
      source === LiquiditySource.UNISWAPV3 ? 'direct_dex' : 'calldata_aggregator',
    selectedLiquiditySource: source,
  } as unknown as BoundExternalTakeRouteEvaluation;
}

// An approved decision whose execution plan ranks `primary` first followed by
// `fallbacks` — mirroring the hybrid engine: winner = primary, runner-up
// aggregators + the direct-DEX gas-quote fallback = fallbacks.
function approvedDecision(
  primary: LiquiditySource,
  fallbacks: LiquiditySource[]
): TakeDecision {
  return {
    approvedTake: true,
    approvedArbTake: false,
    borrower: '0xborrower',
    collateral: undefined as never,
    auctionPrice: undefined as never,
    hpbIndex: 0,
    externalTakeExecutionPlan: createExternalTakeExecutionPlan({
      primaryEvaluation: evaluation(primary),
      fallbacks: fallbacks.map((source) =>
        createExternalTakeExecutionCandidate({ evaluation: evaluation(source) })
      ),
    }),
  } as unknown as TakeDecision;
}

const minimalArtifactParams = (
  routeDecisionEvents: ReturnType<typeof serializeDecisionEvent>[]
) => ({
  summary: { uniswapV3ExternalTake: undefined } as never,
  mode: 'discovery' as const,
  discoveryStats: [],
  routeDecisionEvents,
});

describe('competing-providers roster', () => {
  it('serializes the full ranked candidate roster (winner first) for an approved decision', () => {
    const decision = approvedDecision(LiquiditySource.LIFI, [
      LiquiditySource.SUSHI_AGGREGATOR,
      LiquiditySource.ONEINCH,
      LiquiditySource.UNISWAPV3,
    ]);
    const event = serializeDecisionEvent('attempt', decision);
    expect(event.candidateProviders).to.deep.equal([
      'LIFI',
      'SUSHI_AGGREGATOR',
      'ONEINCH',
      'UNISWAPV3',
    ]);
  });

  it('omits candidateProviders for a non-approved decision', () => {
    const decision = {
      approvedTake: false,
      approvedArbTake: false,
      borrower: '0xborrower',
    } as unknown as TakeDecision;
    const event = serializeDecisionEvent('attempt', decision);
    expect(event.candidateProviders).to.equal(undefined);
  });

  it('dedupes repeated sources across primary and fallbacks', () => {
    // A direct-DEX primary with a UNISWAPV3 gas-quote fallback collapses to one.
    const decision = approvedDecision(LiquiditySource.UNISWAPV3, [
      LiquiditySource.UNISWAPV3,
    ]);
    const event = serializeDecisionEvent('attempt', decision);
    expect(event.candidateProviders).to.deep.equal(['UNISWAPV3']);
  });

  it('unions candidateProviders across decision events in the route artifact', () => {
    const attempt = serializeDecisionEvent(
      'attempt',
      approvedDecision(LiquiditySource.SUSHI_AGGREGATOR, [
        LiquiditySource.LIFI,
        LiquiditySource.ONEINCH,
        LiquiditySource.UNISWAPV3,
      ])
    );
    const executed = serializeDecisionEvent(
      'executed',
      approvedDecision(LiquiditySource.SUSHI_AGGREGATOR, [
        LiquiditySource.LIFI,
        LiquiditySource.ONEINCH,
        LiquiditySource.UNISWAPV3,
      ])
    );
    const artifact = buildRouteArtifact(
      minimalArtifactParams([attempt, executed])
    );
    expect(artifact.competingProviders).to.have.members([
      'LIFI',
      'SUSHI_AGGREGATOR',
      'ONEINCH',
      'UNISWAPV3',
    ]);
    // All three aggregators present — the falsifiable competition claim holds.
    for (const competitor of ['LIFI', 'SUSHI_AGGREGATOR', 'ONEINCH']) {
      expect(artifact.competingProviders).to.include(competitor);
    }
  });

  it('excludes absent competitors — a single-provider regression is falsifiable', () => {
    // If route selection regressed to probing only the winner, the runner-up
    // aggregators never become ranked candidates and must not appear here.
    const event = serializeDecisionEvent(
      'attempt',
      approvedDecision(LiquiditySource.LIFI, [LiquiditySource.UNISWAPV3])
    );
    const artifact = buildRouteArtifact(minimalArtifactParams([event]));
    expect(artifact.competingProviders).to.deep.equal(['LIFI', 'UNISWAPV3']);
    expect(artifact.competingProviders).to.not.include('SUSHI_AGGREGATOR');
    expect(artifact.competingProviders).to.not.include('ONEINCH');
  });

  it('omits competingProviders entirely when no approved decision was recorded', () => {
    const event = serializeDecisionEvent('attempt', {
      approvedTake: false,
      approvedArbTake: false,
      borrower: '0xborrower',
    } as unknown as TakeDecision);
    const artifact = buildRouteArtifact(minimalArtifactParams([event]));
    expect(artifact.competingProviders).to.equal(undefined);
  });
});
