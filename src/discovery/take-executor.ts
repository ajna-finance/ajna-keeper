import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber, ethers } from 'ethers';
import { LiquiditySource, getAutoDiscoverTakePolicy } from '../config';
import { ResolvedTakeTarget } from './targets';
import { logger } from '../logging';
import {
  createDiscoveryTransportsForConfig,
  evaluateGasPolicy,
  logDiscoveryDecision,
} from './gas-policy';
import {
  DiscoveryExecutionConfig,
  DiscoveryExecutionTransportConfig,
  DiscoveryRpcCache,
} from './types';
import { DiscoveryReadTransports } from '../read-transports';
import * as takeModule from '../take';
import * as takeFactoryModule from '../take/factory';
import { ExternalTakeAdapter, processTakeCandidates } from '../take/engine';
import { TakeWriteTransport } from '../take/write-transport';
import {
  FactoryRouteProfitabilityContext,
  createFactoryQuoteProviderRuntimeCache,
} from '../take/factory';
import {
  applyFactoryRouteProfitabilityPolicy,
  maxBigNumber,
} from '../take/factory/shared';
import { decimaledToWei } from '../utils';
import { getDecimalsErc20 } from '../erc20';

// Conservative per-route execution limits used for profitability screening.
// Operators can override these with autoDiscover.take.dexGasOverrides.
const EXTERNAL_TAKE_GAS_LIMIT = BigNumber.from(900000);
const CURVE_EXTERNAL_TAKE_GAS_LIMIT = BigNumber.from(1_500_000);
const ARB_TAKE_GAS_LIMIT = BigNumber.from(450000);
const WAD = ethers.constants.WeiPerEther;
const ZERO = BigNumber.from(0);

function isDynamicFactorySource(
  source: LiquiditySource | undefined
): source is
  | LiquiditySource.UNISWAPV3
  | LiquiditySource.SUSHISWAP
  | LiquiditySource.CURVE {
  return (
    source === LiquiditySource.UNISWAPV3 ||
    source === LiquiditySource.SUSHISWAP ||
    source === LiquiditySource.CURVE
  );
}

function getFactoryRouteSelectionSources(
  defaultLiquiditySource: LiquiditySource | undefined,
  allowedLiquiditySources?: LiquiditySource[]
): LiquiditySource[] {
  if (!isDynamicFactorySource(defaultLiquiditySource)) {
    return [];
  }

  return Array.from(
    new Set([defaultLiquiditySource, ...(allowedLiquiditySources ?? [])])
  ).filter(isDynamicFactorySource);
}

function getExternalTakeGasLimit(
  policy: ReturnType<typeof getAutoDiscoverTakePolicy>,
  source: LiquiditySource
): BigNumber {
  const override = policy?.dexGasOverrides?.[source];
  if (override) {
    return BigNumber.from(override);
  }
  return source === LiquiditySource.CURVE
    ? CURVE_EXTERNAL_TAKE_GAS_LIMIT
    : EXTERNAL_TAKE_GAS_LIMIT;
}

function isSoftRouteGasConversionFailure(reason: string | undefined): boolean {
  return (
    reason === 'failed to quote gas cost into quote token' ||
    reason === 'no liquidity source available for gas cost conversion' ||
    reason === 'no wrapped native token configured for gas cost conversion'
  );
}

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

async function buildFactoryRouteProfitabilityContext(params: {
  pool: FungiblePool;
  signer: Signer;
  config: DiscoveryExecutionConfig;
  transports: DiscoveryReadTransports;
  rpcCache?: DiscoveryRpcCache;
  defaultLiquiditySource: LiquiditySource | undefined;
  takePolicy: ReturnType<typeof getAutoDiscoverTakePolicy>;
}): Promise<FactoryRouteProfitabilityContext | undefined> {
  const sources = getFactoryRouteSelectionSources(
    params.defaultLiquiditySource,
    params.takePolicy?.allowedLiquiditySources
  );
  const requiresRouteGasRanking = sources.length > 1;
  const requiresQuoteProfitability =
    params.takePolicy?.minExpectedProfitQuote !== undefined ||
    params.takePolicy?.minProfitNative !== undefined;
  const requiresHardQuoteGasPolicy =
    params.takePolicy?.maxGasCostQuote !== undefined ||
    requiresQuoteProfitability;

  if (!requiresRouteGasRanking && !requiresQuoteProfitability) {
    return undefined;
  }

  const quoteTokenDecimals = await getDecimalsErc20(
    params.signer,
    params.pool.quoteAddress
  );
  const configuredProfitFloorQuoteRaw =
    params.takePolicy?.minExpectedProfitQuote !== undefined
      ? decimaledToWei(
          params.takePolicy.minExpectedProfitQuote,
          quoteTokenDecimals
        )
      : ZERO;
  const routeExecutionCostQuoteRawBySource: Partial<
    Record<LiquiditySource, BigNumber>
  > = {};
  const nativeProfitFloorQuoteRawBySource: Partial<
    Record<LiquiditySource, BigNumber>
  > = {};
  const routeRejectionReasonsBySource: Partial<Record<LiquiditySource, string>> =
    {};

  for (const source of sources) {
    const gasPolicy = await evaluateGasPolicy({
      signer: params.signer,
      config: params.config,
      transports: params.transports,
      policy: {
        ...params.takePolicy,
        minExpectedProfitQuote:
          params.takePolicy?.minExpectedProfitQuote ??
          (requiresRouteGasRanking ? 0 : undefined),
      },
      gasLimit: getExternalTakeGasLimit(params.takePolicy, source),
      quoteTokenAddress: params.pool.quoteAddress,
      preferredLiquiditySource: source,
      useProfitFloor: true,
      gasPrice: params.rpcCache?.gasPrice,
      chainId: params.rpcCache?.chainId,
      rpcCache: params.rpcCache,
    });

    if (!gasPolicy.approved) {
      if (
        requiresRouteGasRanking &&
        !requiresHardQuoteGasPolicy &&
        isSoftRouteGasConversionFailure(gasPolicy.reason)
      ) {
        logger.debug(
          `Route gas conversion unavailable for ${LiquiditySource[source] ?? source}; ranking this source without quote-denominated gas cost: ${gasPolicy.reason}`
        );
        routeExecutionCostQuoteRawBySource[source] = ZERO;
        continue;
      }
      routeRejectionReasonsBySource[source] =
        gasPolicy.reason ?? 'route gas policy rejected source';
      continue;
    }

    routeExecutionCostQuoteRawBySource[source] =
      gasPolicy.gasCostQuoteRaw ?? ZERO;
    if (gasPolicy.minProfitNativeQuoteRaw) {
      nativeProfitFloorQuoteRawBySource[source] =
        gasPolicy.minProfitNativeQuoteRaw;
    }
  }

  return {
    routeExecutionCostQuoteRawBySource,
    nativeProfitFloorQuoteRawBySource,
    configuredProfitFloorQuoteRaw,
    routeRejectionReasonsBySource,
  };
}

interface DiscoveredTakeTargetStats {
  candidateCount: number;
  approvedTakeDecisions: number;
  approvedArbTakeDecisions: number;
  evaluationSkips: number;
  revalidationSkips: number;
  executionSkips: number;
  gasPolicyRejects: number;
  profitFloorRejects: number;
  arbProfitUnavailableRejects: number;
  executedExternalTakes: number;
  executedArbTakes: number;
}

interface HandleDiscoveredTakeTargetParamsBase {
  pool: FungiblePool;
  signer: Signer;
  takeWriteTransport?: TakeWriteTransport;
  target: ResolvedTakeTarget;
  rpcCache?: DiscoveryRpcCache;
}

export type HandleDiscoveredTakeTargetParams =
  | (HandleDiscoveredTakeTargetParamsBase & {
      config: DiscoveryExecutionTransportConfig;
      transports?: DiscoveryReadTransports;
    })
  | (HandleDiscoveredTakeTargetParamsBase & {
      config: DiscoveryExecutionConfig;
      transports: DiscoveryReadTransports;
    });

function hasDiscoveryTransportConfig(
  config: DiscoveryExecutionConfig | DiscoveryExecutionTransportConfig
): config is DiscoveryExecutionTransportConfig {
  return (
    'ethRpcUrl' in config &&
    typeof config.ethRpcUrl === 'string' &&
    'subgraphUrl' in config &&
    typeof config.subgraphUrl === 'string'
  );
}

function logDiscoveredTakeTargetSummary(params: {
  pool: FungiblePool;
  target: ResolvedTakeTarget;
  stats: DiscoveredTakeTargetStats;
}): void {
  logger.info(
    `Discovered take target summary: pool=${params.pool.poolAddress} name="${params.target.name}" source=${params.target.take.liquiditySource ?? 'none'} dryRun=${params.target.dryRun} candidates=${params.stats.candidateCount} approvedTakeDecisions=${params.stats.approvedTakeDecisions} approvedArbTakeDecisions=${params.stats.approvedArbTakeDecisions} evaluationSkips=${params.stats.evaluationSkips} revalidationSkips=${params.stats.revalidationSkips} executionSkips=${params.stats.executionSkips} gasPolicyRejects=${params.stats.gasPolicyRejects} profitFloorRejects=${params.stats.profitFloorRejects} arbProfitUnavailableRejects=${params.stats.arbProfitUnavailableRejects} executedExternalTakes=${params.stats.executedExternalTakes} executedArbTakes=${params.stats.executedArbTakes}`
  );
}

export async function handleDiscoveredTakeTarget(
  params: HandleDiscoveredTakeTargetParams
): Promise<void> {
  const transports = params.transports
    ? params.transports
    : hasDiscoveryTransportConfig(params.config)
      ? createDiscoveryTransportsForConfig(params.config, params.signer)
      : (() => {
          throw new Error(
            'Discovered take target requires transports when config omits read transport settings'
          );
        })();
  const stats: DiscoveredTakeTargetStats = {
    candidateCount: params.target.candidates.length,
    approvedTakeDecisions: 0,
    approvedArbTakeDecisions: 0,
    evaluationSkips: 0,
    revalidationSkips: 0,
    executionSkips: 0,
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
            }) => {
              const routeProfitabilityContext =
                await buildFactoryRouteProfitabilityContext({
                  pool,
                  signer,
                  config: params.config as DiscoveryExecutionConfig,
                  transports,
                  rpcCache,
                  defaultLiquiditySource: params.target.take.liquiditySource,
                  takePolicy,
                });

              return takeFactoryModule.getFactoryTakeQuoteEvaluation(
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
                rpcCache?.factoryQuoteProviders,
                {
                  allowedLiquiditySources: takePolicy?.allowedLiquiditySources,
                  routeQuoteBudgetPerCandidate:
                    takePolicy?.takeRouteQuoteBudgetPerCandidate,
                  routeProfitabilityContext,
                }
              );
            },
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
          runtimeCache: rpcCache?.factoryQuoteProviders,
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
      takeWriteTransport: params.takeWriteTransport,
      revalidateBeforeExecution: true,
      approveExternalTake: async ({
        price,
        auctionPrice,
        collateral,
        quoteEvaluation,
      }) => {
        let selectedLiquiditySource = quoteEvaluation.selectedLiquiditySource;
        if (selectedLiquiditySource === undefined) {
          const configuredLiquiditySource = params.target.take.liquiditySource;
          if (
            configuredLiquiditySource !== LiquiditySource.ONEINCH &&
            isDynamicFactorySource(configuredLiquiditySource)
          ) {
            return {
              approved: false,
              reason:
                'factory route approval missing selected liquidity source',
            };
          }
          selectedLiquiditySource = configuredLiquiditySource;
        }

        const gasPolicy = await evaluateGasPolicy({
          signer: params.signer,
          config: params.config,
          transports,
          policy: takePolicy,
          gasLimit:
            selectedLiquiditySource !== undefined
              ? getExternalTakeGasLimit(takePolicy, selectedLiquiditySource)
              : EXTERNAL_TAKE_GAS_LIMIT,
          quoteTokenAddress: params.pool.quoteAddress,
          preferredLiquiditySource: selectedLiquiditySource,
          useProfitFloor: true,
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
        const hasQuoteProfitFloor =
          minExpectedProfitQuote !== undefined ||
          takePolicy?.minProfitNative !== undefined;
        if (hasQuoteProfitFloor) {
          const quoteAmountRaw = quoteEvaluation.quoteAmountRaw;
          const gasCostQuoteRaw = gasPolicy.gasCostQuoteRaw;
          const quoteTokenDecimals = gasPolicy.quoteTokenDecimals;
          const minExpectedProfitQuoteRaw =
            quoteTokenDecimals !== undefined &&
            minExpectedProfitQuote !== undefined
              ? decimaledToWei(minExpectedProfitQuote, quoteTokenDecimals)
              : ZERO;
          const factoryLiquiditySource =
            selectedLiquiditySource !== undefined &&
            isDynamicFactorySource(selectedLiquiditySource)
              ? selectedLiquiditySource
              : undefined;
          const canApplyFactoryProfitability =
            factoryLiquiditySource !== undefined &&
            quoteAmountRaw !== undefined &&
            gasCostQuoteRaw !== undefined &&
            quoteTokenDecimals !== undefined;

          if (canApplyFactoryProfitability) {
            const refreshedEvaluation = applyFactoryRouteProfitabilityPolicy({
              evaluation: quoteEvaluation,
              liquiditySource: factoryLiquiditySource,
              context: {
                routeExecutionCostQuoteRawBySource: {
                  [factoryLiquiditySource]: gasCostQuoteRaw,
                },
                nativeProfitFloorQuoteRawBySource: {
                  [factoryLiquiditySource]:
                    gasPolicy.minProfitNativeQuoteRaw ?? ZERO,
                },
                configuredProfitFloorQuoteRaw: minExpectedProfitQuoteRaw,
              },
            });
            Object.assign(quoteEvaluation, refreshedEvaluation);
            if (!refreshedEvaluation.isTakeable) {
              stats.profitFloorRejects += 1;
              return {
                approved: false,
                reason:
                  refreshedEvaluation.reason ??
                  'route quote below required output floor',
              };
            }
          } else {
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
              const breakEvenQuoteAmountRaw =
                auctionCostQuoteRaw.add(gasCostQuoteRaw);
              const minProfitNativeQuoteRaw =
                gasPolicy.minProfitNativeQuoteRaw ?? ZERO;
              const requiredProfitFloorRaw = maxBigNumber(
                minExpectedProfitQuoteRaw,
                minProfitNativeQuoteRaw
              );
              const requiredQuoteAmountRaw = breakEvenQuoteAmountRaw.add(
                requiredProfitFloorRaw
              );
              quoteEvaluation.approvedMinOutRaw =
                quoteEvaluation.approvedMinOutRaw
                  ? maxBigNumber(
                      quoteEvaluation.approvedMinOutRaw,
                      requiredQuoteAmountRaw
                    )
                  : requiredQuoteAmountRaw;
              quoteEvaluation.routeProfitability = {
                ...quoteEvaluation.routeProfitability,
                routeExecutionCostQuoteRaw: gasCostQuoteRaw,
                configuredProfitFloorQuoteRaw: minExpectedProfitQuoteRaw,
                nativeProfitFloorQuoteRaw: minProfitNativeQuoteRaw,
                requiredProfitFloorQuoteRaw: requiredProfitFloorRaw,
                requiredOutputFloorQuoteRaw: requiredQuoteAmountRaw,
                expectedNetProfitQuoteRaw: quoteAmountRaw.gte(
                  breakEvenQuoteAmountRaw
                )
                  ? quoteAmountRaw.sub(breakEvenQuoteAmountRaw)
                  : ZERO,
                surplusOverFloorQuoteRaw: quoteAmountRaw.gte(
                  requiredQuoteAmountRaw
                )
                  ? quoteAmountRaw.sub(requiredQuoteAmountRaw)
                  : ZERO,
              };
              if (quoteAmountRaw.lt(requiredQuoteAmountRaw)) {
                const expectedProfitRaw = quoteAmountRaw.gte(
                  breakEvenQuoteAmountRaw
                )
                  ? quoteAmountRaw.sub(breakEvenQuoteAmountRaw)
                  : breakEvenQuoteAmountRaw.sub(quoteAmountRaw);
                stats.profitFloorRejects += 1;
                return {
                  approved: false,
                  reason: `expected take profit ${formatSignedQuoteAmount({
                    rawAmount: expectedProfitRaw,
                    quoteTokenDecimals,
                    negative: quoteAmountRaw.lt(breakEvenQuoteAmountRaw),
                  })} below required profit floor`,
                };
              }
            } else {
              if (takePolicy?.minProfitNative !== undefined) {
                stats.profitFloorRejects += 1;
                return {
                  approved: false,
                  reason:
                    'quote-normalized minProfitNative floor is not available',
                };
              }
              const auctionCostQuote =
                price * (quoteEvaluation.collateralAmount ?? 0);
              const expectedProfit =
                (quoteEvaluation.quoteAmount ?? 0) -
                auctionCostQuote -
                gasPolicy.gasCostQuote;
              if (
                minExpectedProfitQuote !== undefined &&
                expectedProfit < minExpectedProfitQuote
              ) {
                stats.profitFloorRejects += 1;
                return {
                  approved: false,
                  reason: `expected take profit ${expectedProfit.toFixed(6)} below minExpectedProfitQuote ${minExpectedProfitQuote}`,
                };
              }
            }
          }
        }

        return { approved: true };
      },
      approveArbTake: async () => {
        if (
          takePolicy?.minExpectedProfitQuote !== undefined ||
          takePolicy?.minProfitNative !== undefined
        ) {
          stats.arbProfitUnavailableRejects += 1;
          return {
            approved: false,
            reason:
              takePolicy?.minProfitNative !== undefined
                ? `arb-take blocked: minProfitNative=${takePolicy.minProfitNative} requires quote-normalized profit, which is not supported for arb-takes`
                : `arb-take blocked: minExpectedProfitQuote=${takePolicy?.minExpectedProfitQuote} requires quote-normalized profit, which is not supported for arb-takes`,
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
        } else if (stage === 'execution') {
          stats.executionSkips += 1;
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
