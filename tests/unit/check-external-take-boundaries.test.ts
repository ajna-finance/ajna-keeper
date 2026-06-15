import { expect } from 'chai';
import {
  evaluateExternalTakeBoundaries,
  parseBaseRef,
} from '../../scripts/check-external-take-boundaries';

describe('external-take boundary checker', () => {
  it('requires an explicit base ref argument shape', () => {
    expect(parseBaseRef([])).to.equal(undefined);
    expect(parseBaseRef(['--base'])).to.equal(undefined);
    expect(parseBaseRef(['--base', 'origin/main'])).to.equal('origin/main');
  });

  it('allows canonical Packet 5 route and provider names', () => {
    const violations = evaluateExternalTakeBoundaries([
      {
        file: 'src/config/external-take-descriptors.ts',
        content: `
          const route = { path: 'direct_dex' };
          const aggregator = { path: 'calldata_aggregator', providerId: 'oneinch' };
          const retained = config.dex.oneInch.routers[8453];
          const postAuction = PostAuctionDex.ONEINCH;
        `,
      },
    ]);
    expect(violations).to.deep.equal([]);
  });

  it('rejects retired standalone path aliases in production files', () => {
    const violations = evaluateExternalTakeBoundaries([
      {
        file: 'src/discovery/example.ts',
        content: `
          const legacyOneInch = { externalTakePath: 'oneinch' };
          const legacyLifi = { allowedExternalTakePaths: ['lifi'] };
          const legacyFactory = { path: 'factory' };
        `,
      },
    ]);
    expect(violations.map((violation) => violation.rule)).to.deep.equal([
      'retired-path-oneinch',
      'retired-path-lifi',
      'retired-path-factory',
    ]);
  });

  it('rejects retired factory naming in production files', () => {
    const violations = evaluateExternalTakeBoundaries([
      {
        file: 'src/take/direct-dex/index.ts',
        content: `
          const mode = 'factory_first';
          const source = take.defaultFactoryLiquiditySource;
          const factory = config.takers.factory;
          const address = summary.keeperTakerFactory;
          const fn = takeLiquidationFactory;
          type Input = FactoryPathQuoteInput;
          type Candidate = FactoryRouteCandidate;
          const adapter = createFactoryTakeAdapter();
          logger.info('Direct DEX: Executing route');
          appendNonZeroGroup(fields, 'approvedFactorySources', []);
        `,
      },
    ]);
    expect(violations.map((violation) => violation.rule)).to.deep.equal([
      'retired-direct DEX-first',
      'retired-default-factory-source',
      'retired-takers-factory',
      'retired-keeper-taker-factory',
      'retired-factory-symbol',
      'retired-factory-symbol',
      'retired-factory-symbol',
      'retired-factory-symbol',
      'retired-direct-dex-factory-log',
      'retired-factory-symbol',
    ]);
  });

  it('rejects retired direct DEX operator labels in scripts and examples', () => {
    const violations = evaluateExternalTakeBoundaries([
      {
        file: 'scripts/run-no-spend-validation.mjs',
        content: `
          requireInvariant(ok, 'external-take factory/taker deployed or reused');
          requireInvariant(ok, 'dry-run routeArtifact selected direct DEX path');
          requireInvariant(ok, 'execution records no direct DEX pre-broadcast or post-submission failures');
        `,
      },
      {
        file: 'examples/example-base-rollout-config.ts',
        content:
          '// SwapRouter02 for direct DEX external takes; allowedExternalTakePaths: [\'oneinch\', \'direct_dex\']',
      },
    ]);
    expect(violations.map((violation) => violation.rule)).to.deep.equal([
      'retired-direct-dex-operator-label',
      'retired-direct-dex-operator-label',
      'retired-direct-dex-operator-label',
      'retired-path-oneinch',
      'retired-direct-dex-operator-label',
    ]);
  });

  it('rejects retired direct DEX symbols in selected test helpers', () => {
    const violations = evaluateExternalTakeBoundaries([
      {
        file: 'tests/integration/helpers/direct-dex-route-harness.ts',
        content: `
          interface FactoryRouteExecutionFixture {}
          export function buildFactoryTakePoolConfig() {}
        `,
      },
    ]);
    expect(violations.map((violation) => violation.rule)).to.deep.equal([
      'retired-factory-symbol',
      'retired-factory-symbol',
    ]);
  });

  it('allows generated contract factories and pool factory address fields', () => {
    const violations = evaluateExternalTakeBoundaries([
      {
        file: 'src/take/direct-dex/uniswap.ts',
        content: `
          const router = TakerRouter__factory.connect(address, signer);
          const poolFactoryAddress = config.poolFactoryAddress;
        `,
      },
    ]);
    expect(violations).to.deep.equal([]);
  });

  it('rejects retired path aliases in root operator docs', () => {
    const violations = evaluateExternalTakeBoundaries([
      {
        file: 'README.md',
        content:
          "Use allowedExternalTakePaths: ['oneinch']. Use externalTakePath: 'factory' with direct DEX-first fallback.",
      },
    ]);
    expect(violations.map((violation) => violation.rule)).to.deep.equal([
      'retired-path-oneinch',
      'retired-path-factory',
      'retired-direct DEX-first',
    ]);
  });

  it('rejects retired factory authorization names and module paths', () => {
    const violations = evaluateExternalTakeBoundaries([
      {
        file: 'contracts/takers/UniswapV3KeeperTaker.sol',
        content:
          'function authorizedFactory() external view returns (address); modifier onlyOwnerOrFactory() { _; }',
      },
      {
        file: 'src/take/factory/shared.ts',
        content: "import { x } from './uniswap';",
      },
    ]);
    expect(violations.map((violation) => violation.rule)).to.deep.equal([
      'retired-factory-authorization',
      'retired-factory-module-path',
    ]);
  });

  it('rejects retired standalone 1inch contract, module, quote, and provider field surfaces', () => {
    const violations = evaluateExternalTakeBoundaries([
      {
        file: 'src/discovery/legacy-oneinch.ts',
        content: `
          import { AjnaKeeperTaker__factory } from '../../typechain-types';
          import { getOneInchTakeQuoteEvaluation } from '../take/one-inch-execution';
          const quoteOneInchPath = quoteOneInchPathForDiscovery;
          const provider = providerRegistry.oneInchProvider;
        `,
      },
    ]);
    expect(violations.map((violation) => violation.rule)).to.deep.equal([
      'retired-standalone-oneinch-contract',
      'retired-standalone-oneinch-module',
      'retired-standalone-oneinch-quotes',
      'retired-provider-registry-field',
    ]);
  });

  it('allows migration docs and config validation error strings', () => {
    const violations = evaluateExternalTakeBoundaries([
      {
        file: 'docs/calldata-aggregator-packet-5-oneinch-provider.md',
        content:
          "allowedExternalTakePaths: ['oneinch']; direct_dex_first; takers.router",
      },
      {
        file: 'src/config/validation.ts',
        content:
          "throw new Error('takers.factory is retired; use takers.router')",
      },
    ]);
    expect(violations).to.deep.equal([]);
  });
});
