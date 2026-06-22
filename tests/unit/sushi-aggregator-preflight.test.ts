import { expect } from 'chai';
import sinon from 'sinon';
import { ethers } from 'ethers';
import { KeeperConfig, LiquiditySource } from '../../src/config';
import {
  validateSushiAggregatorAllowlistPreflight,
  validateSushiAggregatorTakerRouterSupport,
} from '../../src/dex/sushi-aggregator/preflight';
import { baseRoutePreflightConfig } from './helpers/route-preflight-config';

describe('Sushi aggregator route preflight', () => {
  afterEach(() => {
    sinon.restore();
  });

  function sushiRouterProviderStub(configuredSources: number[]) {
    const routerIface = new ethers.utils.Interface([
      'function getConfiguredTakers() view returns (uint8[] memory sources, address[] memory takers)',
    ]);
    const provider = {
      _isProvider: true,
      resolveName: sinon.stub().callsFake(async (name: string) => name),
      call: sinon
        .stub()
        .callsFake(async () =>
          routerIface.encodeFunctionResult('getConfiguredTakers', [
            configuredSources,
            configuredSources.map(
              (_, index) => `0x${(index + 1).toString(16).padStart(40, '0')}`
            ),
          ])
        ),
    };
    return provider as any;
  }

  function sushiAggregatorConfig(): KeeperConfig {
    return {
      ...baseRoutePreflightConfig(),
      takers: {
        router: '0x1111111111111111111111111111111111111111',
        contracts: {
          SushiAggregator: '0x2222222222222222222222222222222222222222',
        },
      },
      dex: {
        sushiAggregator: {
          mode: 'production',
          callTargetAllowlist: {
            1: ['0x3333333333333333333333333333333333333333'],
          },
          approvalSpenderAllowlist: {
            1: ['0x4444444444444444444444444444444444444444'],
          },
          selectorAllowlist: {
            1: {
              '0x3333333333333333333333333333333333333333': ['0xabcdef12'],
            },
          },
        },
      },
    };
  }

  function sushiPreflightProviderStub(params?: {
    allowedTargets?: string[];
    allowedSpenders?: string[];
    allowedSelectors?: string[];
  }) {
    const config = sushiAggregatorConfig();
    const routerIface = new ethers.utils.Interface([
      'function getConfiguredTakers() view returns (uint8[] memory sources, address[] memory takers)',
    ]);
    const takerIface = new ethers.utils.Interface([
      'function getAllowedCallTargets() view returns (address[])',
      'function getAllowedApprovalSpenders() view returns (address[])',
      'function getAllowedCallSelectors(address target) view returns (bytes4[])',
    ]);
    const allowedTargets =
      params?.allowedTargets ??
      config.dex!.sushiAggregator!.callTargetAllowlist![1];
    const allowedSpenders =
      params?.allowedSpenders ??
      config.dex!.sushiAggregator!.approvalSpenderAllowlist![1];
    const allowedSelectors = params?.allowedSelectors ?? ['0xabcdef12'];

    return {
      config,
      provider: {
        _isProvider: true,
        resolveName: sinon.stub().callsFake(async (name: string) => name),
        // Allowlisted call targets / approval spenders are code-existence checked
        // by the preflight (mirrors LI.FI/1inch); return non-empty bytecode.
        getCode: sinon.stub().resolves('0x6000'),
        call: sinon.stub().callsFake(async (tx: { data: string }) => {
          const selector = tx.data.slice(0, 10);
          if (selector === routerIface.getSighash('getConfiguredTakers')) {
            return routerIface.encodeFunctionResult('getConfiguredTakers', [
              [LiquiditySource.SUSHI_AGGREGATOR],
              [config.takers!.contracts!.SushiAggregator],
            ]);
          }
          if (selector === takerIface.getSighash('getAllowedCallTargets')) {
            return takerIface.encodeFunctionResult('getAllowedCallTargets', [
              allowedTargets,
            ]);
          }
          if (
            selector === takerIface.getSighash('getAllowedApprovalSpenders')
          ) {
            return takerIface.encodeFunctionResult(
              'getAllowedApprovalSpenders',
              [allowedSpenders]
            );
          }
          if (selector === takerIface.getSighash('getAllowedCallSelectors')) {
            return takerIface.encodeFunctionResult('getAllowedCallSelectors', [
              allowedSelectors,
            ]);
          }
          throw new Error(`unexpected call ${selector}`);
        }),
      },
    };
  }

  it('accepts a TakerRouter with only the Sushi aggregator source configured', async () => {
    const errors: string[] = [];

    await validateSushiAggregatorTakerRouterSupport({
      config: {
        ...baseRoutePreflightConfig(),
        takers: {
          router: '0x1111111111111111111111111111111111111111',
          contracts: {},
        },
      },
      provider: sushiRouterProviderStub([LiquiditySource.SUSHI_AGGREGATOR]),
      errors,
    });

    expect(errors).to.deep.equal([]);
  });

  it('rejects a TakerRouter without the Sushi aggregator source configured', async () => {
    const errors: string[] = [];

    await validateSushiAggregatorTakerRouterSupport({
      config: {
        ...baseRoutePreflightConfig(),
        takers: {
          router: '0x1111111111111111111111111111111111111111',
          contracts: {},
        },
      },
      provider: sushiRouterProviderStub([LiquiditySource.UNISWAPV3]),
      errors,
    });

    expect(errors).to.have.length(1);
    expect(errors[0]).to.include('without source id 6');
  });

  it('labels Sushi aggregator allowlist preflight mismatches with the provider name', async () => {
    const { config, provider } = sushiPreflightProviderStub({
      allowedTargets: ['0x9999999999999999999999999999999999999999'],
    });
    const errors: string[] = [];

    await validateSushiAggregatorAllowlistPreflight({
      config,
      provider: provider as any,
      chainId: 1,
      takerAddress: config.takers!.contracts!.SushiAggregator,
      errors,
    });

    expect(errors.some((error) => error.includes('LI.FI taker'))).to.equal(
      false
    );
    expect(
      errors.some((error) =>
        error.includes('Sushi aggregator taker call target allowlist')
      )
    ).to.equal(true);
  });
});
