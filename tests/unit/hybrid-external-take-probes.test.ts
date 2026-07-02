import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, ethers } from 'ethers';
import { LiquiditySource } from '../../src/config';
import { handleDiscoveredTakeTarget } from '../../src/discovery/handlers';
import { evaluateHybridExternalTakeForDiscovery } from '../../src/discovery/external-take/hybrid';
import { ExternalTakeQuoteCircuitOutcome } from '../../src/discovery/external-take/provider';
import * as erc20 from '../../src/erc20';
import * as directDexModule from '../../src/take/direct-dex';
import * as lifiExecutionModule from '../../src/take/lifi/execution';
import * as lifiQuoteEvaluationModule from '../../src/take/lifi/quote-evaluation';
import * as oneInchAggregatorExecutionModule from '../../src/take/oneinch-aggregator/execution';
import * as oneInchAggregatorQuoteModule from '../../src/take/oneinch-aggregator/quote-evaluation';
import {
  createDeferred,
  createDiscoveryTransports,
} from '../helpers/discovery';
import { buildTakeableOneInchQuote } from './helpers/external-take-quotes';

describe('hybrid external take probes', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('records calldata provider timeout outcomes with provider identity', async () => {
    const recordedOutcomes: ExternalTakeQuoteCircuitOutcome[] = [];
    const lifiProvider = {
      path: 'calldata_aggregator',
      providerId: 'lifi',
      quote: async () => await new Promise(() => undefined),
      recordQuoteCircuitOutcome: (outcome: ExternalTakeQuoteCircuitOutcome) => {
        recordedOutcomes.push(outcome);
      },
      execute: async () => ({
        succeeded: false,
        preBroadcastFailed: true,
      }),
    };
    const providerRegistry = {
      listExternalTakeProbeProviders: () => [lifiProvider],
      selectExternalTakeProvider: ({
        selectedPath,
        providerId,
      }: {
        selectedPath: string;
        providerId?: string;
      }) => {
        if (selectedPath === 'calldata_aggregator' && providerId === 'lifi') {
          return lifiProvider;
        }
        throw new Error(
          `Unsupported external take route: ${selectedPath}` +
            (providerId ? `/${providerId}` : '')
        );
      },
    };

    const result = await evaluateHybridExternalTakeForDiscovery({
      pool: { name: 'Timeout Pool' } as any,
      signer: {} as any,
      poolConfig: { name: 'Timeout Pool', take: {} } as any,
      takePolicy: {},
      externalTakePaths: ['calldata_aggregator'],
      calldataAggregatorProviders: ['lifi'],
      routeSelectionMode: 'maximize_profit',
      hybridGasQuoteFallbackPolicy: {
        eligible: false,
        reason: 'fallback disabled',
      },
      probeTimeoutMs: 1,
      price: 1,
      auctionPrice: BigNumber.from(1),
      collateral: BigNumber.from(1),
      providerRegistry: providerRegistry as any,
      approveExternalTake: async () => {
        throw new Error('approval should not run for a timed-out quote');
      },
      stats: { gasPolicyRejects: 0, profitFloorRejects: 0 },
    });

    expect(result.takeable).to.equal(false);
    if (result.takeable) {
      throw new Error('expected timed-out probe to reject all paths');
    }
    expect(result.quoteEvaluation.reason).to.include(
      'calldata_aggregator/lifi=probe timed out after 1ms'
    );
    expect(recordedOutcomes).to.deep.equal(['failure']);
  });

  // P0-3 decision-matrix money-safety: when EVERY probed provider is rejected
  // (e.g. all below the profit floor), the hybrid must return takeable=false so
  // the keeper executes ZERO takes — never falling open to an unprofitable one.
  it('returns takeable=false (no take) when every provider quote is rejected', async () => {
    const rejectingProvider = (providerId: string) => ({
      path: 'calldata_aggregator' as const,
      providerId,
      quote: async () => ({
        isTakeable: false as const,
        externalTakePath: 'calldata_aggregator' as const,
        reason: 'route below required profit floor',
      }),
      recordQuoteCircuitOutcome: () => undefined,
      execute: async () => ({ succeeded: false, preBroadcastFailed: true }),
    });
    const lifi = rejectingProvider('lifi');
    const sushi = rejectingProvider('sushi_aggregator');
    const providerRegistry = {
      listExternalTakeProbeProviders: () => [lifi, sushi],
      selectExternalTakeProvider: ({
        providerId,
      }: {
        selectedPath: string;
        providerId?: string;
      }) => {
        if (providerId === 'lifi') return lifi;
        if (providerId === 'sushi_aggregator') return sushi;
        throw new Error(`Unsupported provider ${providerId}`);
      },
    };

    let approvalRan = false;
    const result = await evaluateHybridExternalTakeForDiscovery({
      pool: { name: 'All-Rejected Pool' } as any,
      signer: {} as any,
      poolConfig: { name: 'All-Rejected Pool', take: {} } as any,
      takePolicy: {},
      externalTakePaths: ['calldata_aggregator'],
      calldataAggregatorProviders: ['lifi', 'sushi_aggregator'],
      routeSelectionMode: 'maximize_profit',
      hybridGasQuoteFallbackPolicy: {
        eligible: false,
        reason: 'fallback disabled',
      },
      probeTimeoutMs: 1000,
      price: 1,
      auctionPrice: BigNumber.from(1),
      collateral: BigNumber.from(1),
      providerRegistry: providerRegistry as any,
      approveExternalTake: async () => {
        approvalRan = true;
        throw new Error('approval must not run for a rejected quote');
      },
      stats: { gasPolicyRejects: 0, profitFloorRejects: 0 },
    });

    expect(result.takeable).to.equal(false);
    // A rejected quote never reaches approval/execution.
    expect(approvalRan).to.equal(false);
  });

  it('does not let an abandoned 1inch probe overwrite circuit state after timeout', async () => {
    const clock = sinon.useFakeTimers();
    try {
      const oneInchDeferred = createDeferred<any>();
      sinon
        .stub(
          oneInchAggregatorQuoteModule,
          'getOneInchAggregatorPathQuoteEvaluation'
        )
        .returns(oneInchDeferred.promise);
      const takeLiquidationStub = sinon
        .stub(
          oneInchAggregatorExecutionModule,
          'takeLiquidationOneInchAggregator'
        )
        .resolves(true);
      const rpcCache: any = {
        chainId: 1,
        directDexQuoteProviders:
          directDexModule.createDirectDexQuoteProviderRuntimeCache(),
      };
      const transports = createDiscoveryTransports(
        ethers.utils.parseUnits('1', 'gwei')
      );
      const pool = {
        name: 'Hybrid Timeout Pool',
        poolAddress: '0x7777777777777777777777777777777777783',
        quoteAddress: '0x2222222222222222222222222222222222222222',
        collateralAddress: '0x3333333333333333333333333333333333333333',
        getLiquidation: sinon.stub().returns({
          getStatus: sinon.stub().resolves({
            collateral: ethers.utils.parseEther('1'),
            price: ethers.utils.parseEther('100'),
          }),
        }),
      };

      const handlePromise = handleDiscoveredTakeTarget({
        pool: pool as any,
        signer: {
          provider: {
            getGasPrice: sinon
              .stub()
              .resolves(ethers.utils.parseUnits('1', 'gwei')),
          },
          getChainId: sinon.stub().resolves(1),
        } as any,
        target: {
          source: 'discovered',
          poolAddress: pool.poolAddress,
          name: pool.name,
          dryRun: false,
          take: {
            liquiditySource: LiquiditySource.ONEINCH,
            marketPriceFactor: 0.99,
          },
          candidates: [
            {
              poolAddress: pool.poolAddress,
              borrower: '0xBorrowerHybridTimeout',
              kickTime: Date.now(),
              debtRemaining: '1',
              collateralRemaining: '1',
              neutralPrice: '1',
              debt: '1',
              collateral: '1',
              heuristicScore: 1,
            },
          ],
        },
        config: {
          autoDiscover: {
            enabled: true,
            take: {
              enabled: true,
              allowedExternalTakePaths: ['calldata_aggregator'],
              externalTakeRouteSelectionMode: 'direct_dex_first',
              externalTakeProbeTimeoutMs: 50,
              oneInchQuoteFailureThreshold: 2,
            },
          },
          subgraphUrl: 'http://example-subgraph',
        } as any,
        transports,
        rpcCache,
      });

      await clock.tickAsync(50);
      await handlePromise;
      expect(
        rpcCache.providerCircuits?.oneinch?.route_quote?.failures
      ).to.equal(1);
      expect(takeLiquidationStub.called).to.be.false;

      oneInchDeferred.resolve(
        buildTakeableOneInchQuote({
          isTakeable: true,
          externalTakePath: 'calldata_aggregator',
          selectedLiquiditySource: LiquiditySource.ONEINCH,
          quoteAmount: 125,
          quoteAmountRaw: ethers.utils.parseUnits('125', 6),
          collateralAmount: 1,
          marketPrice: 125,
          takeablePrice: 123.75,
          approvedMinOutRaw: ethers.utils.parseUnits('123', 6),
          quotedAuctionPriceWad: ethers.utils.parseEther('100'),
          quotedCollateralWad: ethers.utils.parseEther('1'),
        })
      );
      await clock.tickAsync(0);
      expect(
        rpcCache.providerCircuits?.oneinch?.route_quote?.failures
      ).to.equal(1);
      expect(transports.readRpc.getGasPrice.called).to.be.false;
    } finally {
      clock.restore();
    }
  });

  it('does not let an abandoned LI.FI probe overwrite circuit state after timeout', async () => {
    const clock = sinon.useFakeTimers();
    try {
      const lifiDeferred = createDeferred<any>();
      sinon
        .stub(lifiQuoteEvaluationModule, 'getLifiPathQuoteEvaluation')
        .returns(lifiDeferred.promise);
      const takeLiquidationLifiStub = sinon
        .stub(lifiExecutionModule, 'takeLiquidationLifi')
        .resolves(true);
      const rpcCache: any = {
        chainId: 8453,
      };
      const transports = createDiscoveryTransports(
        ethers.utils.parseUnits('1', 'gwei')
      );
      const pool = {
        name: 'Hybrid LI.FI Timeout Pool',
        poolAddress: '0x7777777777777777777777777777777777785',
        quoteAddress: '0x2222222222222222222222222222222222222222',
        collateralAddress: '0x3333333333333333333333333333333333333333',
        getLiquidation: sinon.stub().returns({
          getStatus: sinon.stub().resolves({
            collateral: ethers.utils.parseEther('1'),
            price: ethers.utils.parseEther('100'),
          }),
        }),
      };

      const handlePromise = handleDiscoveredTakeTarget({
        pool: pool as any,
        signer: {
          provider: {
            getGasPrice: sinon
              .stub()
              .resolves(ethers.utils.parseUnits('1', 'gwei')),
          },
          getChainId: sinon.stub().resolves(8453),
        } as any,
        target: {
          source: 'discovered',
          poolAddress: pool.poolAddress,
          name: pool.name,
          dryRun: false,
          take: {
            liquiditySource: LiquiditySource.LIFI,
            marketPriceFactor: 0.99,
          },
          candidates: [
            {
              poolAddress: pool.poolAddress,
              borrower: '0xBorrowerHybridLifiTimeout',
              kickTime: Date.now(),
              debtRemaining: '1',
              collateralRemaining: '1',
              neutralPrice: '1',
              debt: '1',
              collateral: '1',
              heuristicScore: 1,
            },
          ],
        },
        config: {
          autoDiscover: {
            enabled: true,
            take: {
              enabled: true,
              allowedExternalTakePaths: ['calldata_aggregator'],
              allowedCalldataAggregatorProviders: ['lifi'],
              externalTakeRouteSelectionMode: 'direct_dex_first',
              externalTakeProbeTimeoutMs: 50,
            },
          },
          lifi: {
            mode: 'production',
            allowExchanges: ['uniswap'],
            callTargetAllowlist: {},
            approvalSpenderAllowlist: {},
            selectorAllowlist: {},
            quoteFailureThreshold: 2,
          },
          lifiTaker: '0x4444444444444444444444444444444444444444',
          subgraphUrl: 'http://example-subgraph',
        } as any,
        transports,
        rpcCache,
      });

      await clock.tickAsync(50);
      await handlePromise;
      expect(rpcCache.providerCircuits?.lifi?.route_quote?.failures).to.equal(
        1
      );
      expect(takeLiquidationLifiStub.called).to.be.false;

      lifiDeferred.resolve({
        isTakeable: true,
        externalTakePath: 'calldata_aggregator',
        selectedLiquiditySource: LiquiditySource.LIFI,
        quoteAmount: 125,
        quoteAmountRaw: ethers.utils.parseUnits('125', 6),
        collateralAmount: 1,
        marketPrice: 125,
        takeablePrice: 123.75,
        approvedMinOutRaw: ethers.utils.parseUnits('123', 6),
        quotedAuctionPriceWad: ethers.utils.parseEther('100'),
        quotedCollateralWad: ethers.utils.parseEther('1'),
      });
      await clock.tickAsync(0);
      expect(rpcCache.providerCircuits?.lifi?.route_quote?.failures).to.equal(
        1
      );
    } finally {
      clock.restore();
    }
  });

  it('does not let an abandoned direct DEX first probe run approval after timeout', async () => {
    const clock = sinon.useFakeTimers();
    try {
      const directDexDeferred = createDeferred<any>();
      sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
      sinon
        .stub(directDexModule, 'getDirectDexTakeQuoteEvaluation')
        .returns(directDexDeferred.promise as any);
      sinon
        .stub(
          oneInchAggregatorQuoteModule,
          'getOneInchAggregatorPathQuoteEvaluation'
        )
        .resolves({
          isTakeable: false,
          reason: '1inch rejected',
        });
      sinon
        .stub(
          oneInchAggregatorExecutionModule,
          'takeLiquidationOneInchAggregator'
        )
        .resolves(true);
      sinon.stub(directDexModule, 'takeLiquidationDirectDex').resolves(true);

      const transports = createDiscoveryTransports(
        ethers.utils.parseUnits('1', 'gwei')
      );
      const pool = {
        name: 'Hybrid Direct DEX Timeout Pool',
        poolAddress: '0x7777777777777777777777777777777777784',
        quoteAddress: '0x2222222222222222222222222222222222222222',
        collateralAddress: '0x3333333333333333333333333333333333333333',
        getLiquidation: sinon.stub().returns({
          getStatus: sinon.stub().resolves({
            collateral: ethers.utils.parseEther('1'),
            price: ethers.utils.parseEther('100'),
          }),
        }),
      };

      const handlePromise = handleDiscoveredTakeTarget({
        pool: pool as any,
        signer: {
          provider: {
            getGasPrice: sinon
              .stub()
              .resolves(ethers.utils.parseUnits('1', 'gwei')),
          },
          getChainId: sinon.stub().resolves(1),
        } as any,
        target: {
          source: 'discovered',
          poolAddress: pool.poolAddress,
          name: pool.name,
          dryRun: false,
          take: {
            liquiditySource: LiquiditySource.ONEINCH,
            marketPriceFactor: 0.99,
          },
          candidates: [
            {
              poolAddress: pool.poolAddress,
              borrower: '0xBorrowerHybridDirectDexTimeout',
              kickTime: Date.now(),
              debtRemaining: '1',
              collateralRemaining: '1',
              neutralPrice: '1',
              debt: '1',
              collateral: '1',
              heuristicScore: 1,
            },
          ],
        },
        config: {
          autoDiscover: {
            enabled: true,
            take: {
              enabled: true,
              allowedExternalTakePaths: ['direct_dex', 'calldata_aggregator'],
              defaultDirectDexLiquiditySource: LiquiditySource.UNISWAPV3,
              externalTakeRouteSelectionMode: 'direct_dex_first',
              externalTakeProbeTimeoutMs: 50,
            },
          },
          subgraphUrl: 'http://example-subgraph',
        } as any,
        transports,
        rpcCache: {
          chainId: 1,
          directDexQuoteProviders:
            directDexModule.createDirectDexQuoteProviderRuntimeCache(),
        },
      });

      await clock.tickAsync(50);
      await handlePromise;
      expect(transports.readRpc.getGasPrice.called).to.be.false;

      directDexDeferred.resolve({
        isTakeable: true,
        externalTakePath: 'direct_dex',
        selectedLiquiditySource: LiquiditySource.UNISWAPV3,
        quoteAmount: 125,
        quoteAmountRaw: ethers.utils.parseUnits('125', 6),
        collateralAmount: 1,
        marketPrice: 125,
        takeablePrice: 123.75,
        approvedMinOutRaw: ethers.utils.parseUnits('123', 6),
        quotedAuctionPriceWad: ethers.utils.parseEther('100'),
        quotedCollateralWad: ethers.utils.parseEther('1'),
      });
      await clock.tickAsync(0);
      expect(transports.readRpc.getGasPrice.called).to.be.false;
    } finally {
      clock.restore();
    }
  });

  it('continues direct_dex_first probing when the first route is subsidized', async () => {
    const directDexProvider = {
      path: 'direct_dex' as const,
      quote: sinon.stub().resolves({
        isTakeable: true,
        externalTakePath: 'direct_dex',
        selectedLiquiditySource: LiquiditySource.UNISWAPV3,
        selectedFeeTier: 3000,
        quoteAmountRaw: ethers.utils.parseUnits('100', 6),
        routeExecutionFloorRaw: ethers.utils.parseUnits('100', 6),
        routeProfitability: {
          subsidyAllowed: true,
          expectedSubsidyQuoteRaw: ethers.utils.parseUnits('5', 6),
        },
      }),
      execute: async () => ({ succeeded: false, preBroadcastFailed: true }),
    };
    const oneInchProvider = {
      path: 'calldata_aggregator' as const,
      providerId: 'oneinch' as const,
      quote: sinon.stub().resolves({
        isTakeable: true,
        externalTakePath: 'calldata_aggregator',
        providerId: 'oneinch',
        selectedLiquiditySource: LiquiditySource.ONEINCH,
        quoteAmountRaw: ethers.utils.parseUnits('110', 6),
        routeExecutionFloorRaw: ethers.utils.parseUnits('105', 6),
        routeProfitability: {
          expectedNetProfitQuoteRaw: ethers.utils.parseUnits('3', 6),
        },
      }),
      execute: async () => ({ succeeded: false, preBroadcastFailed: true }),
    };
    const providerRegistry = {
      listExternalTakeProbeProviders: () => [
        directDexProvider,
        oneInchProvider,
      ],
      selectExternalTakeProvider: ({
        selectedPath,
        providerId,
      }: {
        selectedPath: string;
        providerId?: string;
      }) => {
        if (selectedPath === 'direct_dex') return directDexProvider;
        if (
          selectedPath === 'calldata_aggregator' &&
          providerId === 'oneinch'
        ) {
          return oneInchProvider;
        }
        throw new Error(`Unsupported provider ${selectedPath}/${providerId}`);
      },
    };

    const result = await evaluateHybridExternalTakeForDiscovery({
      pool: { name: 'Subsidized Direct First Pool' } as any,
      signer: {} as any,
      poolConfig: { name: 'Subsidized Direct First Pool', take: {} } as any,
      takePolicy: {},
      externalTakePaths: ['direct_dex', 'calldata_aggregator'],
      calldataAggregatorProviders: ['oneinch'],
      routeSelectionMode: 'direct_dex_first',
      hybridGasQuoteFallbackPolicy: {
        eligible: false,
        reason: 'fallback disabled',
      },
      probeTimeoutMs: 1000,
      price: 1,
      auctionPrice: BigNumber.from(1),
      collateral: BigNumber.from(1),
      providerRegistry: providerRegistry as any,
      approveExternalTake: async ({ quoteEvaluation }) => ({
        approved: true,
        quoteEvaluation: quoteEvaluation as any,
      }),
      stats: { gasPolicyRejects: 0, profitFloorRejects: 0 },
    });

    expect(result.takeable).to.equal(true);
    if (!result.takeable) throw new Error('expected hybrid route selection');
    expect(result.executionPlan.primary.evaluation.externalTakePath).to.equal(
      'calldata_aggregator'
    );
    expect(
      result.executionPlan.primary.evaluation.selectedLiquiditySource
    ).to.equal(LiquiditySource.ONEINCH);
    expect(result.executionPlan.fallbacks).to.have.length(0);
    expect(directDexProvider.quote.calledOnce).to.equal(true);
    expect(oneInchProvider.quote.calledOnce).to.equal(true);
  });
});
