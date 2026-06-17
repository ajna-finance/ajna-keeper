import { expect } from 'chai';
import sinon from 'sinon';
import { ethers } from 'ethers';
import { LiquiditySource } from '../../src/config';
import { handleDiscoveredTakeTarget } from '../../src/discovery/handlers';
import * as erc20 from '../../src/erc20';
import { logger } from '../../src/logging';
import * as directDexModule from '../../src/take/direct-dex';
import * as oneInchAggregatorExecutionModule from '../../src/take/oneinch-aggregator/execution';
import * as oneInchAggregatorQuoteModule from '../../src/take/oneinch-aggregator/quote-evaluation';
import { createDiscoveryTransports } from '../helpers/discovery';

describe('discovery external take route binding', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('does not clear 1inch circuit failures for local policy quote rejects', async () => {
    sinon
      .stub(
        oneInchAggregatorExecutionModule,
        'takeLiquidationOneInchAggregator'
      )
      .resolves(true);
    const oneInchQuoteStub = sinon
      .stub(
        oneInchAggregatorQuoteModule,
        'getOneInchAggregatorPathQuoteEvaluation'
      )
      .resolves({
        isTakeable: false,
        externalTakePath: 'calldata_aggregator',
        selectedLiquiditySource: LiquiditySource.ONEINCH,
        reason: 'missing 1inch router for chain 8453',
      });
    const rpcCache = {
      chainId: 8453,
      gasPrice: ethers.utils.parseUnits('1', 'gwei'),
      gasPriceFetchedAt: Date.now(),
      providerCircuits: {
        oneinch: { route_quote: { failures: 1 } },
      },
    };
    const pool = {
      name: 'Local 1inch Reject Pool',
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

    await handleDiscoveredTakeTarget({
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
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.99,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerLocalReject',
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
          },
        },
        subgraphUrl: 'http://example-subgraph',
      } as any,
      transports: createDiscoveryTransports(
        ethers.utils.parseUnits('1', 'gwei')
      ),
      rpcCache,
    });

    expect(oneInchQuoteStub.calledOnce).to.be.true;
    expect(
      rpcCache.providerCircuits.oneinch.route_quote.failures
    ).to.equal(1);
  });

  it('refuses execution when a hybrid quote resolves to an inconsistent path and source', async () => {
    const debugStub = sinon.stub(logger, 'debug');
    const takeLiquidationStub = sinon
      .stub(
        oneInchAggregatorExecutionModule,
        'takeLiquidationOneInchAggregator'
      )
      .resolves(true);
    const takeLiquidationDirectDexStub = sinon
      .stub(directDexModule, 'takeLiquidationDirectDex')
      .resolves(true);
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    sinon.stub(directDexModule, 'getDirectDexTakeQuoteEvaluation').resolves({
      isTakeable: true,
      externalTakePath: 'direct_dex',
      selectedLiquiditySource: LiquiditySource.ONEINCH,
      quoteAmount: 125,
      quoteAmountRaw: ethers.utils.parseUnits('125', 6),
      collateralAmount: 1,
      marketPrice: 125,
      takeablePrice: 123.75,
      approvedMinOutRaw: ethers.utils.parseUnits('123', 6),
      quotedAuctionPriceWad: ethers.utils.parseEther('100'),
      quotedCollateralWad: ethers.utils.parseEther('1'),
      routeProfitability: {
        gasPolicyEvaluatedAt: Date.now(),
      },
    });

    const pool = {
      name: 'Hybrid Disabled Path Pool',
      poolAddress: '0x7777777777777777777777777777777777781',
      quoteAddress: '0x2222222222222222222222222222222222222222',
      collateralAddress: '0x3333333333333333333333333333333333333333',
      getLiquidation: sinon.stub().returns({
        getStatus: sinon.stub().resolves({
          collateral: ethers.utils.parseEther('1'),
          price: ethers.utils.parseEther('100'),
        }),
      }),
    };

    await handleDiscoveredTakeTarget({
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
          liquiditySource: LiquiditySource.UNISWAPV3,
          marketPriceFactor: 0.99,
        },
        candidates: [
          {
            poolAddress: pool.poolAddress,
            borrower: '0xBorrowerHybridDisabledPath',
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
            allowedExternalTakePaths: ['direct_dex'],
            defaultDirectDexLiquiditySource: LiquiditySource.UNISWAPV3,
          },
        },
        subgraphUrl: 'http://example-subgraph',
      } as any,
      transports: createDiscoveryTransports(
        ethers.utils.parseUnits('1', 'gwei')
      ),
      rpcCache: {
        chainId: 1,
        gasPrice: ethers.utils.parseUnits('1', 'gwei'),
        gasPriceFetchedAt: Date.now(),
        directDexQuoteProviders:
          directDexModule.createDirectDexQuoteProviderRuntimeCache(),
      },
    });

    expect(takeLiquidationStub.called).to.be.false;
    expect(takeLiquidationDirectDexStub.called).to.be.false;
    expect(
      debugStub
        .getCalls()
        .some((call) =>
          String(call.args[0]).includes(
            'selected inconsistent path=direct_dex source=ONEINCH'
          )
        )
    ).to.be.true;
  });

  it('refuses execution when a direct DEX hybrid quote has no selected direct DEX source', async () => {
    const debugStub = sinon.stub(logger, 'debug');
    const takeLiquidationDirectDexStub = sinon
      .stub(directDexModule, 'takeLiquidationDirectDex')
      .resolves(true);
    sinon
      .stub(
        oneInchAggregatorExecutionModule,
        'takeLiquidationOneInchAggregator'
      )
      .resolves(true);
    sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
    sinon.stub(directDexModule, 'getDirectDexTakeQuoteEvaluation').resolves({
      isTakeable: true,
      externalTakePath: 'direct_dex',
      quoteAmount: 125,
      quoteAmountRaw: ethers.utils.parseUnits('125', 6),
      collateralAmount: 1,
      marketPrice: 125,
      takeablePrice: 123.75,
      approvedMinOutRaw: ethers.utils.parseUnits('123', 6),
      quotedAuctionPriceWad: ethers.utils.parseEther('100'),
      quotedCollateralWad: ethers.utils.parseEther('1'),
      routeProfitability: {
        gasPolicyEvaluatedAt: Date.now(),
      },
    });

    const pool = {
      name: 'Hybrid Missing Source Pool',
      poolAddress: '0x7777777777777777777777777777777777782',
      quoteAddress: '0x2222222222222222222222222222222222222222',
      collateralAddress: '0x3333333333333333333333333333333333333333',
      getLiquidation: sinon.stub().returns({
        getStatus: sinon.stub().resolves({
          collateral: ethers.utils.parseEther('1'),
          price: ethers.utils.parseEther('100'),
        }),
      }),
    };

    await handleDiscoveredTakeTarget({
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
            borrower: '0xBorrowerHybridMissingSource',
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
            allowedExternalTakePaths: ['direct_dex'],
            defaultDirectDexLiquiditySource: LiquiditySource.UNISWAPV3,
          },
        },
        subgraphUrl: 'http://example-subgraph',
      } as any,
      transports: createDiscoveryTransports(
        ethers.utils.parseUnits('1', 'gwei')
      ),
      rpcCache: {
        chainId: 1,
        gasPrice: ethers.utils.parseUnits('1', 'gwei'),
        gasPriceFetchedAt: Date.now(),
        directDexQuoteProviders:
          directDexModule.createDirectDexQuoteProviderRuntimeCache(),
      },
    });

    expect(takeLiquidationDirectDexStub.called).to.be.false;
    expect(
      debugStub
        .getCalls()
        .some((call) =>
          String(call.args[0]).includes(
            'selected direct_dex path without a concrete direct DEX source'
          )
        )
    ).to.be.true;
  });
});
