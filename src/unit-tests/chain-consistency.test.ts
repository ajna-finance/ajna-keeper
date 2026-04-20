import { expect } from 'chai';
import sinon from 'sinon';
import { assertSubgraphChainConsistency } from '../run';
import type { SubgraphReader } from '../read-transports';

function makeFakeProvider(
  getBlockImpl: (n: number) => Promise<{ timestamp: number } | null>
): any {
  return { getBlock: sinon.stub().callsFake(getBlockImpl) };
}

function makeFakeSubgraph(
  meta: Awaited<ReturnType<SubgraphReader['getSubgraphMeta']>> | Error
): any {
  if (meta instanceof Error) {
    return { getSubgraphMeta: sinon.stub().rejects(meta) };
  }
  return { getSubgraphMeta: sinon.stub().resolves(meta) };
}

describe('assertSubgraphChainConsistency', () => {
  it('passes when subgraph and RPC agree on block timestamp', async () => {
    const subgraph = makeFakeSubgraph({
      block: { number: 1_000_000, timestamp: 1_700_000_000 },
      deployment: 'QmFake',
      hasIndexingErrors: false,
    });
    const provider = makeFakeProvider(async (n) => {
      if (n !== 1_000_000) return null;
      return { timestamp: 1_700_000_000 };
    });

    await assertSubgraphChainConsistency({
      subgraph,
      provider,
      chainId: 8453,
    });
  });

  it('tolerates small timestamp skew within the threshold', async () => {
    const subgraph = makeFakeSubgraph({
      block: { number: 1_000_000, timestamp: 1_700_000_000 },
      deployment: 'QmFake',
      hasIndexingErrors: false,
    });
    const provider = makeFakeProvider(async () => ({
      timestamp: 1_700_000_030, // 30s drift — within 60s tolerance
    }));

    await assertSubgraphChainConsistency({
      subgraph,
      provider,
      chainId: 8453,
    });
  });

  it('throws with chain-mismatch error when timestamps diverge', async () => {
    // Subgraph reports block 1,000,000 at Feb 2024. RPC returns a block
    // with Jan 2026 timestamp — different chain entirely.
    const subgraph = makeFakeSubgraph({
      block: { number: 1_000_000, timestamp: 1_707_000_000 },
      deployment: 'QmEthMainnet',
      hasIndexingErrors: false,
    });
    const provider = makeFakeProvider(async () => ({
      timestamp: 1_770_000_000,
    }));

    try {
      await assertSubgraphChainConsistency({
        subgraph,
        provider,
        chainId: 8453,
      });
      throw new Error('expected throw');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      expect(msg).to.include('chain-consistency mismatch');
      expect(msg).to.include('QmEthMainnet');
      expect(msg).to.include('chainId=8453');
    }
  });

  it('throws when the RPC cannot find the subgraph-reported block', async () => {
    const subgraph = makeFakeSubgraph({
      block: { number: 99_999_999, timestamp: 1_700_000_000 },
      deployment: 'QmFake',
      hasIndexingErrors: false,
    });
    const provider = makeFakeProvider(async () => null);

    try {
      await assertSubgraphChainConsistency({
        subgraph,
        provider,
        chainId: 8453,
      });
      throw new Error('expected throw');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      expect(msg).to.include('99999999');
      expect(msg).to.include('different chain');
    }
  });

  it('throws with actionable error when subgraph _meta query fails', async () => {
    const subgraph = makeFakeSubgraph(new Error('subgraph unreachable'));
    const provider = makeFakeProvider(async () => null);

    try {
      await assertSubgraphChainConsistency({
        subgraph,
        provider,
        chainId: 8453,
      });
      throw new Error('expected throw');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      expect(msg).to.include('could not fetch _meta');
      expect(msg).to.include('subgraph unreachable');
    }
  });

  it('throws with actionable error when RPC getBlock fails transiently', async () => {
    const subgraph = makeFakeSubgraph({
      block: { number: 1_000_000, timestamp: 1_700_000_000 },
      deployment: 'QmFake',
      hasIndexingErrors: false,
    });
    const provider: any = {
      getBlock: sinon.stub().rejects(new Error('RPC 500 internal error')),
    };

    try {
      await assertSubgraphChainConsistency({
        subgraph,
        provider,
        chainId: 8453,
      });
      throw new Error('expected throw');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      expect(msg).to.include('RPC rejected getBlock');
      expect(msg).to.include('Verify ethRpcUrl');
      expect(msg).to.include('RPC 500 internal error');
    }
  });

  it('throws when the subgraph has no indexed blocks yet (meta.block is null)', async () => {
    const subgraph: any = {
      getSubgraphMeta: sinon.stub().resolves({
        block: null,
        deployment: 'QmFreshDeployment',
        hasIndexingErrors: false,
      }),
    };
    const provider = makeFakeProvider(async () => null);

    try {
      await assertSubgraphChainConsistency({
        subgraph,
        provider,
        chainId: 8453,
      });
      throw new Error('expected throw');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      expect(msg).to.include('no indexed blocks yet');
      expect(msg).to.include('QmFreshDeployment');
    }
  });

  it('passes but warns when subgraph reports indexing errors', async () => {
    const subgraph = makeFakeSubgraph({
      block: { number: 1_000_000, timestamp: 1_700_000_000 },
      deployment: 'QmFake',
      hasIndexingErrors: true,
    });
    const provider = makeFakeProvider(async () => ({
      timestamp: 1_700_000_000,
    }));

    // Should not throw; the warning goes through logger.
    await assertSubgraphChainConsistency({
      subgraph,
      provider,
      chainId: 8453,
    });
  });
});
