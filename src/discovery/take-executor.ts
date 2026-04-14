import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber, ethers } from 'ethers';
import { LiquiditySource, getAutoDiscoverTakePolicy } from '../config';
import { ResolvedTakeTarget } from './targets';
import { logger } from '../logging';
import {
  createDiscoveryTransportsForConfig,
  evaluateGasPolicy,
  logDiscoveryDecision,
  resolveWrappedNativeAddress,
} from './gas-policy';
import {
  DiscoveryExecutionConfig,
  DiscoveryRpcCache,
} from './types';
import { DiscoveryReadTransports } from '../read-transports';
import * as takeModule from '../take';
import * as takeFactoryModule from '../take/factory';
import { ExternalTakeAdapter, processTakeCandidates } from '../take/engine';
import { TakeWriteTransport } from '../take/write-transport';
import { createFactoryQuoteProviderRuntimeCache } from '../take/factory';
import { decimaledToWei } from '../utils';

const EXTERNAL_TAKE_GAS_LIMIT = BigNumber.from(900000);
const ARB_TAKE_GAS_LIMIT = BigNumber.from(450000);
const WAD = ethers.constants.WeiPerEther;

function getQuoteTokenScaleFromDecimals(
  quoteTokenDecimals: number
): BigNumber | undefined {
  if (quoteTokenDecimals > 18) {
    return undefined;
  }

  return BigNumber.from(10).pow(18 - quoteTokenDecimals);
}

function getAuctionCostQuoteRaw(params: {
  price: BigNumber;
  collateral: BigNumber;
  quoteTokenDecimals: number;
}): BigNumber | undefined {
  const scale = getQuoteTokenScaleFromDecimals(params.quoteTokenDecimals);
  if (!scale) {
    return undefined;
  }

  const quoteDueWad = params.collateral.mul(params.price).add(WAD.sub(1)).div(WAD);
  return quoteDueWad.add(scale.sub(1)).div(scale);
}

function formatSignedQuoteAmount(params: {
  rawAmount: BigNumber;
  quoteTokenDecimals: number;
  negative?: boolean;
}): string {
  const formatted = ethers.utils.formatUnits(
    params.rawAmount,
    params.quoteTokenDecimals
  );
  return params.negative ? `-${formatted}` : formatted;
}

interface DiscoveredTakeTargetStats {
  candidateCount: number;
  approvedTakeDecisions: number;
  approvedArbTakeDecisions: number;
  evaluationSkips: number;
  revalidationSkips: number;
  gasPolicyRejects: number;
  profitFloorRejects: number;
  arbProfitUnavailableRejects: number;
  executedExternalTakes: number;
  executedArbTakes: number;
}

export interface HandleDiscoveredTakeTargetParams {
  pool: FungiblePool;
  signer: Signer;
  takeWriteTransport?: TakeWriteTransport;
  target: ResolvedTakeTarget;
  config: DiscoveryExecutionConfig;
  transports?: DiscoveryReadTransports;
  rpcCache?: DiscoveryRpcCache;
}

function logDiscoveredTakeTargetSummary(params: {
  pool: FungiblePool;
  target: ResolvedTakeTarget;
  stats: DiscoveredTakeTargetStats;
}): void {
  logger.info(
    `Discovered take target summary: pool=${params.pool.poolAddress} name="${params.target.name}" source=${params.target.take.liquiditySource ?? 'none'} dryRun=${params.target.dryRun} candidates=${params.stats.candidateCount} approvedTakeDecisions=${params.stats.approvedTakeDecisions} approvedArbTakeDecisions=${params.stats.approvedArbTakeDecisions} evaluationSkips=${params.stats.evaluationSkips} revalidationSkips=${params.stats.revalidationSkips} gasPolicyRejects=${params.stats.gasPolicyRejects} profitFloorRejects=${params.stats.profitFloorRejects} arbProfitUnavailableRejects=${params.stats.arbProfitUnavailableRejects} executedExternalTakes=${params.stats.executedExternalTakes} executedArbTakes=${params.stats.executedArbTakes}`
  );
}

export async function handleDiscoveredTakeTarget(
  params: HandleDiscoveredTakeTargetParams
): Promise<void> {
  const transports =
    params.transports ??
    createDiscoveryTransportsForConfig(params.config, params.signer);
  const stats: DiscoveredTakeTargetStats = {
    candidateCount: params.target.candidates.length,
    approvedTakeDecisions: 0,
    approvedArbTakeDecisions: 0,
    evaluationSkips: 0,
    revalidationSkips: 0,
    gasPolicyRejects: 0,
    profitFloorRejects: 0,
    arbProfitUnavailableRejects: 0,
    executedExternalTakes: 0,
    executedArbTakes: 0,
  };
  const rpcCache =
    params.rpcCache ??
    (params.signer.provider
      ? {
          chainId:
          typeof params.signer.getChainId === 'function'
            ? await params.signer.getChainId()
            : undefined,
          gasPrice: await transports.readRpc.getGasPrice(),
          gasPriceFetchedAt: Date.now(),
          gasQuoteConversions: new Map(),
          factoryQuoteProviders: createFactoryQuoteProviderRuntimeCache(),
        }
      : undefined);
  const takePolicy = getAutoDiscoverTakePolicy(params.config.autoDiscover);
  const externalTakeAdapter: ExternalTakeAdapter<any, any> =
    params.target.take.liquiditySource === LiquiditySource.ONEINCH
      ? {
          kind: 'oneinch',
          evaluateExternalTake: async ({
            pool,
            signer,
            poolConfig,
            price,
            collateral,
          }) =>
            takeModule.getOneInchTakeQuoteEvaluation(
              pool,
              price,
              collateral,
              poolConfig,
              { delayBetweenActions: params.config.delayBetweenActions },
              signer,
              params.config.oneInchRouters,
              params.config.connectorTokens
            ),
          executeExternalTake: async ({
            pool,
            signer,
            poolConfig,
            liquidation,
            config,
          }) =>
            takeModule.takeLiquidation({
              pool,
              signer,
              poolConfig,
              liquidation,
              config,
            }),
        }
      : params.target.take.liquiditySource !== undefined
        ? {
            kind: 'factory',
            evaluateExternalTake: async ({
              pool,
              signer,
              poolConfig,
              auctionPrice,
              collateral,
            }) =>
              takeFactoryModule.getFactoryTakeQuoteEvaluation(
                pool,
                auctionPrice,
                collateral,
                poolConfig,
                {
                  universalRouterOverrides:
                    params.config.universalRouterOverrides,
                  sushiswapRouterOverrides:
                    params.config.sushiswapRouterOverrides,
                  curveRouterOverrides: params.config.curveRouterOverrides,
                  tokenAddresses: params.config.tokenAddresses,
                },
                signer,
                rpcCache?.factoryQuoteProviders
              ),
            executeExternalTake: async ({
              pool,
              signer,
              poolConfig,
              liquidation,
              config,
            }) =>
              takeFactoryModule.takeLiquidationFactory({
                pool,
                signer,
                poolConfig,
                liquidation,
                config,
              }),
          }
        : takeModule.createNoExternalTakeAdapter();

  const externalExecutionConfig =
    params.target.take.liquiditySource === LiquiditySource.ONEINCH
      ? {
          dryRun: params.target.dryRun,
          delayBetweenActions: params.config.delayBetweenActions,
          connectorTokens: params.config.connectorTokens,
          oneInchRouters: params.config.oneInchRouters,
          keeperTaker: params.config.keeperTaker,
          takeWriteTransport: params.takeWriteTransport,
        }
      : {
          dryRun: params.target.dryRun,
          keeperTakerFactory: params.config.keeperTakerFactory,
          universalRouterOverrides: params.config.universalRouterOverrides,
          sushiswapRouterOverrides: params.config.sushiswapRouterOverrides,
          curveRouterOverrides: params.config.curveRouterOverrides,
          tokenAddresses: params.config.tokenAddresses,
          takeWriteTransport: params.takeWriteTransport,
        };

  try {
    await processTakeCandidates({
      pool: params.pool,
      signer: params.signer,
      poolConfig: params.target,
      candidates: params.target.candidates.map(({ borrower }) => ({ borrower })),
      subgraph: transports.subgraph,
      externalTakeAdapter,
      externalExecutionConfig: externalExecutionConfig as any,
      dryRun: params.target.dryRun,
      delayBetweenActions: params.config.delayBetweenActions,
      revalidateBeforeExecution: true,
      approveExternalTake: async ({
        price,
        auctionPrice,
        collateral,
        quoteEvaluation,
      }) => {
        const wrappedNativeAddress = resolveWrappedNativeAddress(
          params.config,
          params.target.take.liquiditySource
        );
        const nativeToQuoteConversion =
          wrappedNativeAddress &&
          wrappedNativeAddress.toLowerCase() ===
            params.pool.collateralAddress.toLowerCase() &&
          quoteEvaluation.quoteAmountRaw
            ? {
                amountInNative: collateral,
                amountOutQuoteRaw: quoteEvaluation.quoteAmountRaw,
              }
            : undefined;

        const gasPolicy = await evaluateGasPolicy({
          signer: params.signer,
          config: params.config,
          transports,
          policy: takePolicy,
          gasLimit: EXTERNAL_TAKE_GAS_LIMIT,
          quoteTokenAddress: params.pool.quoteAddress,
          preferredLiquiditySource: params.target.take.liquiditySource,
          useProfitFloor: true,
          nativeToQuoteConversion,
          gasPrice: rpcCache?.gasPrice,
          chainId: rpcCache?.chainId,
          rpcCache,
        });
        if (!gasPolicy.approved) {
          stats.gasPolicyRejects += 1;
          return {
            approved: false,
            reason: gasPolicy.reason,
          };
        }

        const minExpectedProfitQuote = takePolicy?.minExpectedProfitQuote;
        if (minExpectedProfitQuote !== undefined) {
          const quoteAmountRaw = quoteEvaluation.quoteAmountRaw;
          const gasCostQuoteRaw = gasPolicy.gasCostQuoteRaw;
          const quoteTokenDecimals = gasPolicy.quoteTokenDecimals;
          const auctionCostQuoteRaw =
            quoteTokenDecimals !== undefined
              ? getAuctionCostQuoteRaw({
                  price: auctionPrice,
                  collateral,
                  quoteTokenDecimals,
                })
              : undefined;

          if (
            quoteAmountRaw &&
            gasCostQuoteRaw &&
            quoteTokenDecimals !== undefined &&
            auctionCostQuoteRaw
          ) {
            const breakEvenQuoteAmountRaw = auctionCostQuoteRaw.add(gasCostQuoteRaw);
            const minExpectedProfitQuoteRaw = decimaledToWei(
              minExpectedProfitQuote,
              quoteTokenDecimals
            );
            const requiredQuoteAmountRaw = breakEvenQuoteAmountRaw.add(
              minExpectedProfitQuoteRaw
            );
            if (quoteAmountRaw.lt(requiredQuoteAmountRaw)) {
              const expectedProfitRaw = quoteAmountRaw.gte(breakEvenQuoteAmountRaw)
                ? quoteAmountRaw.sub(breakEvenQuoteAmountRaw)
                : breakEvenQuoteAmountRaw.sub(quoteAmountRaw);
              stats.profitFloorRejects += 1;
              return {
                approved: false,
                reason: `expected take profit ${formatSignedQuoteAmount({
                  rawAmount: expectedProfitRaw,
                  quoteTokenDecimals,
                  negative: quoteAmountRaw.lt(breakEvenQuoteAmountRaw),
                })} below minExpectedProfitQuote ${minExpectedProfitQuote}`,
              };
            }
          } else {
            const auctionCostQuote = price * (quoteEvaluation.collateralAmount ?? 0);
            const expectedProfit =
              (quoteEvaluation.quoteAmount ?? 0) -
              auctionCostQuote -
              gasPolicy.gasCostQuote;
            if (expectedProfit < minExpectedProfitQuote) {
              stats.profitFloorRejects += 1;
              return {
                approved: false,
                reason: `expected take profit ${expectedProfit.toFixed(6)} below minExpectedProfitQuote ${minExpectedProfitQuote}`,
              };
            }
          }
        }

        return { approved: true };
      },
      approveArbTake: async () => {
        if (takePolicy?.minExpectedProfitQuote !== undefined) {
          stats.arbProfitUnavailableRejects += 1;
          return {
            approved: false,
            reason: 'quote-normalized profit is not available',
          };
        }

        const gasPolicy = await evaluateGasPolicy({
          signer: params.signer,
          config: params.config,
          transports,
          policy: takePolicy,
          gasLimit: ARB_TAKE_GAS_LIMIT,
          quoteTokenAddress: params.pool.quoteAddress,
          preferredLiquiditySource: params.target.take.liquiditySource,
          useProfitFloor: false,
          gasPrice: rpcCache?.gasPrice,
          chainId: rpcCache?.chainId,
          rpcCache,
        });
        if (!gasPolicy.approved) {
          stats.gasPolicyRejects += 1;
          return {
            approved: false,
            reason: gasPolicy.reason,
          };
        }

        return { approved: true };
      },
      onFound: (decision) => {
        if (decision.approvedTake) {
          stats.approvedTakeDecisions += 1;
        }
        if (decision.approvedArbTake) {
          stats.approvedArbTakeDecisions += 1;
        }
      },
      onSkip: ({ candidate, stage, reason }) => {
        if (stage === 'revalidation') {
          stats.revalidationSkips += 1;
        } else {
          stats.evaluationSkips += 1;
        }
        if (stage === 'revalidation') {
          logDiscoveryDecision(
            params.config,
            `Skipping discovered take execution for ${params.pool.poolAddress}/${candidate.borrower} because ${reason}`
          );
          return;
        }

        logDiscoveryDecision(
          params.config,
          `Skipping discovered take candidate ${params.pool.poolAddress}/${candidate.borrower}: ${reason}`
        );
      },
      onExecuted: ({ executedTake, executedArbTake }) => {
        if (executedTake) {
          stats.executedExternalTakes += 1;
        }
        if (executedArbTake) {
          stats.executedArbTakes += 1;
        }
      },
    });
  } finally {
    logDiscoveredTakeTargetSummary({
      pool: params.pool,
      target: params.target,
      stats,
    });
  }
}
