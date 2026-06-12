import type { FungiblePool, Signer } from '@ajna-finance/sdk';
import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, ethers } from 'ethers';
import { LiquiditySource } from '../../../src/config';
import * as erc20 from '../../../src/erc20';
import {
  handleDiscoveredTakeTarget,
  type DiscoveryExecutionConfig,
  type DiscoveryRpcCache,
} from '../../../src/discovery/handlers';
import type { ApprovedLifiQuote } from '../../../src/dex/lifi';
import type { ResolvedTakeTarget } from '../../../src/discovery/targets';
import type { HandleDiscoveredTakeTargetParams } from '../../../src/discovery/take-executor';
import type { DiscoveryReadTransports } from '../../../src/read-transports';
import * as lifiExecutionModule from '../../../src/take/lifi/execution';
import { normalizeApprovedLifiQuote } from '../../../src/take/lifi/quote-service';
import type { ApprovedCalldataAggregatorQuote } from '../../../src/take/aggregator-calldata/types';
import * as takeFactoryModule from '../../../src/take/factory';
import type { ExternalTakeQuoteEvaluation } from '../../../src/take/types';
import type { TakeWriteTransport } from '../../../src/take/write-transport';
import { createDiscoveryTransports } from '../../helpers/discovery';

type TestDiscoveredTakePool = {
  name: string;
  poolAddress: string;
  quoteAddress: string;
  collateralAddress: string;
  getLiquidation: sinon.SinonStub;
};

type TestDiscoveredTakeSigner = {
  provider: {
    getGasPrice: sinon.SinonStub;
  };
  getChainId: sinon.SinonStub;
};

type TestDiscoveredTakeParams = {
  pool: TestDiscoveredTakePool;
  signer: TestDiscoveredTakeSigner;
  target: ResolvedTakeTarget;
  config: DiscoveryExecutionConfig;
  transports: DiscoveryReadTransports;
  rpcCache?: DiscoveryRpcCache;
  takeWriteTransport?: TakeWriteTransport;
  onCandidateInactive?: HandleDiscoveredTakeTargetParams['onCandidateInactive'];
};

function mockFungiblePool(pool: TestDiscoveredTakePool): FungiblePool {
  return pool as unknown as FungiblePool;
}

function mockSigner(signer: TestDiscoveredTakeSigner): Signer {
  return signer as unknown as Signer;
}

export function makeDiscoveredTakeParams(
  params: TestDiscoveredTakeParams
): HandleDiscoveredTakeTargetParams {
  return {
    ...params,
    pool: mockFungiblePool(params.pool),
    signer: mockSigner(params.signer),
  };
}

export function getDiscoveredTakeSummary(
  loggerInfoStub: sinon.SinonStub
): string {
  const isSummaryMessage = (message: unknown): message is string =>
    typeof message === 'string' &&
    message.includes('Discovered take target summary:');
  const summaryLog = loggerInfoStub
    .getCalls()
    .map((call) => call.args[0] as unknown)
    .find(isSummaryMessage);
  if (summaryLog === undefined) {
    expect.fail('Expected a discovered take target summary log');
  }
  return summaryLog;
}

export function makeTestApprovedLifiQuote(
  overrides: Partial<ApprovedLifiQuote> = {}
): ApprovedLifiQuote {
  return {
    raw: {} as any,
    quoteAmountRaw: ethers.utils.parseUnits('125', 6),
    routeMinOutRaw: ethers.utils.parseUnits('120', 6),
    amountInTokenUnits: ethers.utils.parseEther('1'),
    srcToken: '0x3333333333333333333333333333333333333333',
    dstToken: '0x2222222222222222222222222222222222222222',
    dstReceiver: '0x4444444444444444444444444444444444444444',
    approvalSpender: '0x5555555555555555555555555555555555555555',
    transactionTarget: '0x6666666666666666666666666666666666666666',
    transactionRequest: {
      to: '0x6666666666666666666666666666666666666666',
      data: '0xabcdef12',
      value: '0',
      from: '0x4444444444444444444444444444444444444444',
      chainId: 8453,
    },
    tool: 'uniswap',
    topLevelTool: 'lifi',
    feeCosts: [],
    selector: '0xabcdef12',
    quotedAtMs: Date.now(),
    ...overrides,
  };
}

export function makeTestCalldataAggregatorQuote(
  overrides: Partial<ApprovedLifiQuote> = {},
  chainId = 8453
): ApprovedCalldataAggregatorQuote {
  return normalizeApprovedLifiQuote(
    makeTestApprovedLifiQuote(overrides),
    chainId
  );
}

export function createHybridGasFallbackFactoryQuote(
  overrides: Partial<ExternalTakeQuoteEvaluation> = {}
): ExternalTakeQuoteEvaluation {
  return {
    isTakeable: true,
    externalTakePath: 'factory',
    selectedLiquiditySource: LiquiditySource.UNISWAPV3,
    selectedFeeTier: 500,
    quoteAmount: 125,
    quoteAmountRaw: ethers.utils.parseUnits('125', 6),
    collateralAmount: 1,
    marketPrice: 125,
    takeablePrice: 123.75,
    approvedMinOutRaw: ethers.utils.parseUnits('100', 6),
    quotedAuctionPriceWad: ethers.utils.parseEther('100'),
    quotedCollateralWad: ethers.utils.parseEther('1'),
    ...overrides,
  };
}

export function createNativeToQuoteGasConversionReject(
  overrides: Partial<ExternalTakeQuoteEvaluation> = {}
): ExternalTakeQuoteEvaluation {
  return {
    isTakeable: false,
    externalTakePath: 'factory',
    selectedLiquiditySource: LiquiditySource.UNISWAPV3,
    reason: 'failed to quote gas cost into quote token',
    routeProfitability: {
      gasPolicyRejectCode: 'native_to_quote_conversion_unavailable',
      gasQuoteAttempts: [
        {
          source: LiquiditySource.UNISWAPV3,
          tokenIn: '0x4200000000000000000000000000000000000006',
          tokenOut: '0x2222222222222222222222222222222222222222',
          amountIn: '900000000000000',
          feeTiers: [3000, 100, 500, 10000],
          success: false,
          reason: 'no factory pool at configured fee tiers',
        },
      ],
    },
    ...overrides,
  };
}

export async function runLifiHybridGasFallbackScenario(
  options: {
    factoryEvaluations?: ExternalTakeQuoteEvaluation[];
  } = {}
) {
  sinon.stub(erc20, 'getDecimalsErc20').resolves(6);
  const takeLiquidationLifiStub = sinon
    .stub(lifiExecutionModule, 'takeLiquidationLifi')
    .resolves(true);
  const takeLiquidationFactoryStub = sinon
    .stub(takeFactoryModule, 'takeLiquidationFactory')
    .resolves(true);
  const lifiQuoteStub = sinon
    .stub(lifiExecutionModule, 'getLifiPathQuoteEvaluation')
    .resolves({
      isTakeable: false,
      externalTakePath: 'calldata_aggregator',
      selectedLiquiditySource: LiquiditySource.LIFI,
      reason: 'LI.FI unavailable',
    });
  const factoryEvaluations = options.factoryEvaluations ?? [
    createNativeToQuoteGasConversionReject(),
    createHybridGasFallbackFactoryQuote(),
  ];
  let factoryCallIndex = 0;
  const factoryQuoteStub = sinon
    .stub(takeFactoryModule, 'getFactoryTakeQuoteEvaluation')
    .callsFake(async () => {
      const evaluation =
        factoryEvaluations[
          Math.min(factoryCallIndex, factoryEvaluations.length - 1)
        ];
      factoryCallIndex += 1;
      return evaluation;
    });
  const gasPrice = ethers.utils.parseUnits('1', 'gwei');
  const wethAddress = '0x4200000000000000000000000000000000000006';
  const pool = {
    name: 'LI.FI Hybrid Gas Fallback Pool',
    poolAddress: '0x7777777777777777777777777777777777777792',
    quoteAddress: wethAddress,
    collateralAddress: '0x3333333333333333333333333333333333333333',
    getLiquidation: sinon.stub().returns({
      getStatus: sinon.stub().resolves({
        collateral: ethers.utils.parseEther('1'),
        price: ethers.utils.parseEther('100'),
      }),
    }),
  };

  await handleDiscoveredTakeTarget(
    makeDiscoveredTakeParams({
      pool,
      signer: {
        provider: {
          getGasPrice: sinon.stub().resolves(gasPrice),
        },
        getChainId: sinon.stub().resolves(1),
      },
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
            borrower: '0xBorrowerHybridLifiGasFallback',
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
            allowedExternalTakePaths: ['lifi', 'factory'],
            externalTakeRouteSelectionMode: 'maximize_profit',
            defaultFactoryLiquiditySource: LiquiditySource.UNISWAPV3,
            hybridGasQuoteFailureFallbackMode: 'factory_first',
            maxGasCostNative: 1,
          },
        },
        tokenAddresses: {
          weth: wethAddress,
        },
      },
      transports: createDiscoveryTransports(gasPrice),
      rpcCache: {
        chainId: 1,
        gasPrice,
        gasPriceFetchedAt: Date.now(),
        factoryQuoteProviders:
          takeFactoryModule.createFactoryQuoteProviderRuntimeCache(),
      },
    })
  );

  return {
    factoryQuoteStub,
    lifiQuoteStub,
    takeLiquidationLifiStub,
    takeLiquidationFactoryStub,
  };
}

export function createHybridLifiFallbackScenario(
  options: {
    lifiExpectedNetProfitRaw?: BigNumber;
    factoryExpectedNetProfitRaw?: BigNumber;
    refreshedCollateral?: BigNumber;
    refreshedAuctionPrice?: BigNumber;
  } = {}
) {
  const wethAddress = '0x4200000000000000000000000000000000000006';
  const gasPrice = ethers.utils.parseUnits('1', 'gwei');
  const gasPolicyEvaluatedAt = Date.now();
  const refreshedCollateral =
    options.refreshedCollateral ?? ethers.utils.parseEther('1');
  const refreshedAuctionPrice =
    options.refreshedAuctionPrice ?? ethers.utils.parseEther('100');
  sinon.stub(erc20, 'getDecimalsErc20').resolves(18);

  const lifiQuoteStub = sinon
    .stub(lifiExecutionModule, 'getLifiPathQuoteEvaluation')
    .resolves({
      isTakeable: true,
      externalTakePath: 'calldata_aggregator',
      selectedLiquiditySource: LiquiditySource.LIFI,
      quoteAmount: 130,
      quoteAmountRaw: ethers.utils.parseEther('130'),
      routeMinOutRaw: ethers.utils.parseEther('128'),
      collateralAmount: 1,
      marketPrice: 130,
      takeablePrice: 128.7,
      approvedMinOutRaw: ethers.utils.parseEther('100'),
      quotedAuctionPriceWad: ethers.utils.parseEther('100'),
      quotedCollateralWad: ethers.utils.parseEther('1'),
      calldataQuote: makeTestCalldataAggregatorQuote({
        quoteAmountRaw: ethers.utils.parseEther('130'),
        routeMinOutRaw: ethers.utils.parseEther('128'),
      }),
      routeProfitability: {
        expectedNetProfitQuoteRaw:
          options.lifiExpectedNetProfitRaw ?? ethers.utils.parseEther('29'),
        expectedSubsidyQuoteRaw: BigNumber.from(0),
        subsidyAllowed: false,
        gasPriceWei: gasPrice,
        gasPolicyEvaluatedAt,
      },
    });
  const factoryQuoteStub = sinon
    .stub(takeFactoryModule, 'getFactoryTakeQuoteEvaluation')
    .resolves({
      isTakeable: true,
      externalTakePath: 'factory',
      selectedLiquiditySource: LiquiditySource.UNISWAPV3,
      selectedFeeTier: 500,
      quoteAmount: 120,
      quoteAmountRaw: ethers.utils.parseEther('120'),
      routeMinOutRaw: ethers.utils.parseEther('118'),
      collateralAmount: 1,
      marketPrice: 120,
      takeablePrice: 118.8,
      approvedMinOutRaw: ethers.utils.parseEther('100'),
      quotedAuctionPriceWad: ethers.utils.parseEther('100'),
      quotedCollateralWad: ethers.utils.parseEther('1'),
      routeProfitability: {
        expectedNetProfitQuoteRaw:
          options.factoryExpectedNetProfitRaw ?? ethers.utils.parseEther('19'),
        expectedSubsidyQuoteRaw: BigNumber.from(0),
        subsidyAllowed: false,
        gasPriceWei: gasPrice,
        gasPolicyEvaluatedAt,
      },
    });
  const takeLiquidationFactoryStub = sinon
    .stub(takeFactoryModule, 'takeLiquidationFactory')
    .resolves(true);

  const pool = {
    name: 'Hybrid LI.FI Fallback Pool',
    poolAddress: '0x7777777777777777777777777777777777786',
    quoteAddress: wethAddress,
    collateralAddress: '0x3333333333333333333333333333333333333333',
    getLiquidation: sinon.stub().returns({
      getStatus: sinon.stub().resolves({
        collateral: refreshedCollateral,
        price: refreshedAuctionPrice,
      }),
    }),
  };

  return {
    lifiQuoteStub,
    factoryQuoteStub,
    takeLiquidationFactoryStub,
    params: makeDiscoveredTakeParams({
      pool,
      signer: {
        provider: {
          getGasPrice: sinon.stub().resolves(gasPrice),
        },
        getChainId: sinon.stub().resolves(8453),
      },
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
            borrower: '0xBorrowerHybridLifiFallback',
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
            allowedExternalTakePaths: ['lifi', 'factory'],
            externalTakeRouteSelectionMode: 'maximize_profit',
            defaultFactoryLiquiditySource: LiquiditySource.UNISWAPV3,
            dexGasOverrides: {
              [LiquiditySource.LIFI]: '900000',
              [LiquiditySource.UNISWAPV3]: '900000',
            },
          },
        },
        tokenAddresses: {
          weth: wethAddress,
        },
        lifi: {
          mode: 'production',
          allowExchanges: ['uniswap'],
          callTargetAllowlist: {},
          approvalSpenderAllowlist: {},
          selectorAllowlist: {},
        },
        lifiTaker: '0x4444444444444444444444444444444444444444',
      },
      transports: createDiscoveryTransports(gasPrice),
      rpcCache: {
        chainId: 8453,
        gasPrice,
        gasPriceFetchedAt: Date.now(),
        factoryQuoteProviders:
          takeFactoryModule.createFactoryQuoteProviderRuntimeCache(),
      },
    }),
  };
}
