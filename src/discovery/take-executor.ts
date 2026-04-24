import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber, ethers } from 'ethers';
import {
  ExternalTakePathKind,
  LiquiditySource,
  LiquiditySourceMap,
  TakeWriteTransportMode,
  getAutoDiscoverTakePolicy,
} from '../config';
import { ResolvedTakeTarget } from './targets';
import { logger } from '../logging';
import {
  createDiscoveryTransportsForConfig,
  evaluateGasPolicy,
  getDiscoveryGasPriceFreshnessTtlMs,
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
import { ExternalTakeQuoteEvaluation } from '../take/types';
import { TakeWriteTransport } from '../take/write-transport';
import { FactoryRouteProfitabilityContext } from '../take/factory';
import {
  applyFactoryRouteProfitabilityPolicy,
  maxBigNumber,
} from '../take/factory/shared';
import { decimaledToWei } from '../utils';
import { getDecimalsErc20 } from '../erc20';
import { createDiscoveryRpcCache } from './rpc-cache';

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
  if (allowedLiquiditySources?.length) {
    return Array.from(new Set(allowedLiquiditySources)).filter(
      isDynamicFactorySource
    );
  }

  return isDynamicFactorySource(defaultLiquiditySource)
    ? [defaultLiquiditySource]
    : [];
}

function getExternalTakePaths(params: {
  defaultLiquiditySource: LiquiditySource | undefined;
  allowedExternalTakePaths?: ExternalTakePathKind[];
}): ExternalTakePathKind[] {
  if (params.allowedExternalTakePaths?.length) {
    return Array.from(new Set(params.allowedExternalTakePaths));
  }
  if (params.defaultLiquiditySource === LiquiditySource.ONEINCH) {
    return ['oneinch'];
  }
  if (isDynamicFactorySource(params.defaultLiquiditySource)) {
    return ['factory'];
  }
  return [];
}

function getDefaultFactoryLiquiditySource(params: {
  defaultLiquiditySource: LiquiditySource | undefined;
  configuredDefaultFactoryLiquiditySource?: LiquiditySource;
}): LiquiditySource | undefined {
  if (isDynamicFactorySource(params.defaultLiquiditySource)) {
    return params.defaultLiquiditySource;
  }
  return isDynamicFactorySource(params.configuredDefaultFactoryLiquiditySource)
    ? params.configuredDefaultFactoryLiquiditySource
    : undefined;
}

function withTakeLiquiditySource<T extends ResolvedTakeTarget>(
  target: T,
  liquiditySource: LiquiditySource
): T {
  return {
    ...target,
    take: {
      ...target.take,
      liquiditySource,
    },
  };
}

function rankExternalTakeQuote(
  evaluation: ExternalTakeQuoteEvaluation
): BigNumber | undefined {
  return (
    evaluation.routeProfitability?.expectedNetProfitQuoteRaw ??
    evaluation.quoteAmountRaw
  );
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

  const quoteDueWad = params.collateral
    .mul(params.price)
    .add(WAD.sub(1))
    .div(WAD);
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

function hasFreshFactoryRouteGasPolicy(params: {
  quoteEvaluation: {
    routeProfitability?: {
      gasPolicyEvaluatedAt?: number;
    };
  };
  chainId?: number;
  takePolicy?: ReturnType<typeof getAutoDiscoverTakePolicy>;
  now?: number;
}): boolean {
  const evaluatedAt =
    params.quoteEvaluation.routeProfitability?.gasPolicyEvaluatedAt;
  if (evaluatedAt === undefined) {
    return false;
  }

  return (
    (params.now ?? Date.now()) - evaluatedAt <=
    getDiscoveryGasPriceFreshnessTtlMs(params.takePolicy, params.chainId)
  );
}

async function refreshDiscoveryGasPriceIfStale(params: {
  rpcCache?: DiscoveryRpcCache;
  transports: DiscoveryReadTransports;
  maxAgeMs?: number;
}): Promise<void> {
  const rpcCache = params.rpcCache;
  if (!rpcCache) {
    return;
  }

  const fetchedAt = rpcCache.gasPriceFetchedAt;
  const hasFreshGasPrice =
    rpcCache.gasPrice !== undefined &&
    fetchedAt !== undefined &&
    Date.now() - fetchedAt <=
      (params.maxAgeMs ??
        getDiscoveryGasPriceFreshnessTtlMs(undefined, rpcCache.chainId));
  if (hasFreshGasPrice) {
    return;
  }

  rpcCache.gasPrice = await params.transports.readRpc.getGasPrice();
  rpcCache.gasPriceFetchedAt = Date.now();
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

  if (!requiresRouteGasRanking && !requiresQuoteProfitability) {
    return undefined;
  }

  await refreshDiscoveryGasPriceIfStale({
    rpcCache: params.rpcCache,
    transports: params.transports,
    maxAgeMs: getDiscoveryGasPriceFreshnessTtlMs(
      params.takePolicy,
      params.rpcCache?.chainId
    ),
  });

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
  const routeExecutionCostQuoteRawBySource: LiquiditySourceMap<BigNumber> = {};
  const nativeProfitFloorQuoteRawBySource: LiquiditySourceMap<BigNumber> = {};
  const routeRejectionReasonsBySource: LiquiditySourceMap<string> = {};
  const gasPolicyEvaluatedAt = Date.now();

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
      if (requiresRouteGasRanking) {
        logger.warn(
          `Rejecting route source ${LiquiditySource[source] ?? source} because quote-denominated gas conversion failed: ${gasPolicy.reason ?? 'route gas policy rejected source'}`
        );
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
    gasPolicyEvaluatedAt,
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
  onCandidateInactive?: (candidate: {
    poolAddress: string;
    borrower: string;
  }) => void;
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

function isInactiveAuctionSkipReason(reason: string): boolean {
  return reason.includes('auction no longer has collateral onchain');
}

function isPrivateOrRelayTakeWriteTransport(
  transport: TakeWriteTransport | undefined
): boolean {
  return (
    transport?.mode === TakeWriteTransportMode.PRIVATE_RPC ||
    transport?.mode === TakeWriteTransportMode.RELAY
  );
}

function enforceExternalTakeTransportPolicy(params: {
  target: ResolvedTakeTarget;
  takeWriteTransport?: TakeWriteTransport;
  takePolicy: ReturnType<typeof getAutoDiscoverTakePolicy>;
}): boolean {
  if (
    params.target.dryRun ||
    params.target.take.marketPriceFactor === undefined
  ) {
    return true;
  }

  const policy =
    params.takePolicy?.externalTakeTransportPolicy ?? 'allow_public';
  if (policy === 'allow_public') {
    return true;
  }

  const hasPrivateOrRelay = isPrivateOrRelayTakeWriteTransport(
    params.takeWriteTransport
  );
  if (hasPrivateOrRelay) {
    return true;
  }

  const message = `Discovered external take target ${params.target.poolAddress} is using public RPC write fallback while externalTakeTransportPolicy=${policy}`;
  if (policy === 'require_private_or_relay') {
    logger.warn(`${message}; skipping target`);
    return false;
  }

  logger.warn(
    `${message}; continuing because policy only prefers private/relay`
  );
  return true;
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
    (await createDiscoveryRpcCache({
      signer: params.signer,
      readRpc: transports.readRpc,
      includeFactoryQuoteProviders: true,
    }));
  const takePolicy = getAutoDiscoverTakePolicy(params.config.autoDiscover);
  if (
    !enforceExternalTakeTransportPolicy({
      target: params.target,
      takeWriteTransport: params.takeWriteTransport,
      takePolicy,
    })
  ) {
    logDiscoveredTakeTargetSummary({
      pool: params.pool,
      target: params.target,
      stats,
    });
    return;
  }
  const approveExternalTakeForDiscovery = async ({
    price,
    auctionPrice,
    collateral,
    quoteEvaluation,
    countStats = true,
  }: {
    price: number;
    auctionPrice: BigNumber;
    collateral: BigNumber;
    quoteEvaluation: ExternalTakeQuoteEvaluation;
    countStats?: boolean;
  }): Promise<{ approved: boolean; reason?: string }> => {
    let selectedLiquiditySource = quoteEvaluation.selectedLiquiditySource;
    if (selectedLiquiditySource === undefined) {
      const configuredLiquiditySource = params.target.take.liquiditySource;
      if (
        configuredLiquiditySource !== LiquiditySource.ONEINCH &&
        isDynamicFactorySource(configuredLiquiditySource)
      ) {
        return {
          approved: false,
          reason: 'factory route approval missing selected liquidity source',
        };
      }
      selectedLiquiditySource = configuredLiquiditySource;
    }
    const selectedFactoryLiquiditySource =
      selectedLiquiditySource !== undefined &&
      isDynamicFactorySource(selectedLiquiditySource)
        ? selectedLiquiditySource
        : undefined;
    if (
      selectedLiquiditySource !== undefined &&
      hasFreshFactoryRouteGasPolicy({
        quoteEvaluation,
        chainId: rpcCache?.chainId,
        takePolicy,
      })
    ) {
      return { approved: true };
    }

    await refreshDiscoveryGasPriceIfStale({
      rpcCache,
      transports,
      maxAgeMs: getDiscoveryGasPriceFreshnessTtlMs(
        takePolicy,
        rpcCache?.chainId
      ),
    });

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
      if (countStats) {
        stats.gasPolicyRejects += 1;
      }
      return {
        approved: false,
        reason: gasPolicy.reason,
      };
    }

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
    if (quoteAmountRaw && gasCostQuoteRaw && auctionCostQuoteRaw) {
      const breakEvenQuoteAmountRaw = auctionCostQuoteRaw.add(gasCostQuoteRaw);
      quoteEvaluation.routeProfitability = {
        ...quoteEvaluation.routeProfitability,
        auctionRepayRequirementQuoteRaw:
          quoteEvaluation.routeProfitability?.auctionRepayRequirementQuoteRaw ??
          auctionCostQuoteRaw,
        routeExecutionCostQuoteRaw: gasCostQuoteRaw,
        expectedNetProfitQuoteRaw: quoteAmountRaw.gte(breakEvenQuoteAmountRaw)
          ? quoteAmountRaw.sub(breakEvenQuoteAmountRaw)
          : ZERO,
        gasPolicyEvaluatedAt: Date.now(),
      };
    }

    const minExpectedProfitQuote = takePolicy?.minExpectedProfitQuote;
    const hasQuoteProfitFloor =
      minExpectedProfitQuote !== undefined ||
      takePolicy?.minProfitNative !== undefined;
    if (hasQuoteProfitFloor) {
      const minExpectedProfitQuoteRaw =
        quoteTokenDecimals !== undefined && minExpectedProfitQuote !== undefined
          ? decimaledToWei(minExpectedProfitQuote, quoteTokenDecimals)
          : ZERO;
      const canApplyFactoryProfitability =
        selectedFactoryLiquiditySource !== undefined &&
        quoteAmountRaw !== undefined &&
        gasCostQuoteRaw !== undefined &&
        quoteTokenDecimals !== undefined;

      if (canApplyFactoryProfitability) {
        const refreshedEvaluation = applyFactoryRouteProfitabilityPolicy({
          evaluation: quoteEvaluation,
          liquiditySource: selectedFactoryLiquiditySource,
          context: {
            routeExecutionCostQuoteRawBySource: {
              [selectedFactoryLiquiditySource]: gasCostQuoteRaw,
            },
            nativeProfitFloorQuoteRawBySource: {
              [selectedFactoryLiquiditySource]:
                gasPolicy.minProfitNativeQuoteRaw ?? ZERO,
            },
            configuredProfitFloorQuoteRaw: minExpectedProfitQuoteRaw,
            gasPolicyEvaluatedAt: Date.now(),
          },
        });
        Object.assign(quoteEvaluation, refreshedEvaluation);
        if (!refreshedEvaluation.isTakeable) {
          if (countStats) {
            stats.profitFloorRejects += 1;
          }
          return {
            approved: false,
            reason:
              refreshedEvaluation.reason ??
              'route quote below required output floor',
          };
        }
      } else {
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
          quoteEvaluation.approvedMinOutRaw = quoteEvaluation.approvedMinOutRaw
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
            surplusOverFloorQuoteRaw: quoteAmountRaw.gte(requiredQuoteAmountRaw)
              ? quoteAmountRaw.sub(requiredQuoteAmountRaw)
              : ZERO,
            gasPolicyEvaluatedAt: Date.now(),
          };
          if (quoteAmountRaw.lt(requiredQuoteAmountRaw)) {
            const expectedProfitRaw = quoteAmountRaw.gte(
              breakEvenQuoteAmountRaw
            )
              ? quoteAmountRaw.sub(breakEvenQuoteAmountRaw)
              : breakEvenQuoteAmountRaw.sub(quoteAmountRaw);
            if (countStats) {
              stats.profitFloorRejects += 1;
            }
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
            if (countStats) {
              stats.profitFloorRejects += 1;
            }
            return {
              approved: false,
              reason: 'quote-normalized minProfitNative floor is not available',
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
            if (countStats) {
              stats.profitFloorRejects += 1;
            }
            return {
              approved: false,
              reason: `expected take profit ${expectedProfit.toFixed(6)} below minExpectedProfitQuote ${minExpectedProfitQuote}`,
            };
          }
        }
      }
    }

    return { approved: true };
  };
  const externalTakePaths = getExternalTakePaths({
    defaultLiquiditySource: params.target.take.liquiditySource,
    allowedExternalTakePaths: takePolicy?.allowedExternalTakePaths,
  });
  const defaultFactoryLiquiditySource = getDefaultFactoryLiquiditySource({
    defaultLiquiditySource: params.target.take.liquiditySource,
    configuredDefaultFactoryLiquiditySource:
      takePolicy?.defaultFactoryLiquiditySource,
  });
  const factoryQuoteConfig = {
    universalRouterOverrides: params.config.universalRouterOverrides,
    sushiswapRouterOverrides: params.config.sushiswapRouterOverrides,
    curveRouterOverrides: params.config.curveRouterOverrides,
    tokenAddresses: params.config.tokenAddresses,
  };
  const quoteFactoryPath = async ({
    pool,
    signer,
    poolConfig,
    auctionPrice,
    collateral,
  }: {
    pool: FungiblePool;
    signer: Signer;
    poolConfig: ResolvedTakeTarget;
    auctionPrice: BigNumber;
    collateral: BigNumber;
  }): Promise<ExternalTakeQuoteEvaluation> => {
    if (defaultFactoryLiquiditySource === undefined) {
      return {
        isTakeable: false,
        externalTakePath: 'factory',
        reason: 'factory external take path is not configured',
      };
    }
    const factoryPoolConfig = withTakeLiquiditySource(
      poolConfig,
      defaultFactoryLiquiditySource
    );
    const routeProfitabilityContext =
      await buildFactoryRouteProfitabilityContext({
        pool,
        signer,
        config: params.config as DiscoveryExecutionConfig,
        transports,
        rpcCache,
        defaultLiquiditySource: defaultFactoryLiquiditySource,
        takePolicy,
      });

    const evaluation = await takeFactoryModule.getFactoryTakeQuoteEvaluation(
      pool,
      auctionPrice,
      collateral,
      factoryPoolConfig,
      factoryQuoteConfig,
      signer,
      rpcCache?.factoryQuoteProviders,
      {
        allowedLiquiditySources: takePolicy?.allowedLiquiditySources,
        routeQuoteBudgetPerCandidate:
          takePolicy?.takeRouteQuoteBudgetPerCandidate,
        routeProfitabilityContext,
      }
    );
    return {
      ...evaluation,
      externalTakePath: 'factory',
      quotedAuctionPriceWad: evaluation.quotedAuctionPriceWad ?? auctionPrice,
      quotedCollateralWad: evaluation.quotedCollateralWad ?? collateral,
    };
  };
  const quoteOneInchPath = async ({
    pool,
    signer,
    poolConfig,
    price,
    auctionPrice,
    collateral,
  }: {
    pool: FungiblePool;
    signer: Signer;
    poolConfig: ResolvedTakeTarget;
    price: number;
    auctionPrice: BigNumber;
    collateral: BigNumber;
  }): Promise<ExternalTakeQuoteEvaluation> => {
    const evaluation = await takeModule.getOneInchPathQuoteEvaluation(
      pool,
      price,
      collateral,
      poolConfig,
      { delayBetweenActions: params.config.delayBetweenActions },
      signer,
      params.config.oneInchRouters,
      params.config.connectorTokens
    );
    return {
      ...evaluation,
      externalTakePath: 'oneinch',
      selectedLiquiditySource:
        evaluation.selectedLiquiditySource ?? LiquiditySource.ONEINCH,
      quotedAuctionPriceWad: auctionPrice,
      quotedCollateralWad: collateral,
    };
  };
  const externalTakeAdapter: ExternalTakeAdapter<any, any> =
    takePolicy?.allowedExternalTakePaths !== undefined
      ? {
          kind: 'hybrid',
          evaluateExternalTake: async ({
            pool,
            signer,
            poolConfig,
            price,
            auctionPrice,
            collateral,
          }) => {
            const approvedEvaluations: ExternalTakeQuoteEvaluation[] = [];
            const rejectedReasons: string[] = [];

            for (const path of externalTakePaths) {
              const evaluation =
                path === 'oneinch'
                  ? await quoteOneInchPath({
                      pool,
                      signer,
                      poolConfig,
                      price,
                      auctionPrice,
                      collateral,
                    })
                  : await quoteFactoryPath({
                      pool,
                      signer,
                      poolConfig,
                      auctionPrice,
                      collateral,
                    });
              if (!evaluation.isTakeable) {
                rejectedReasons.push(
                  `${path}=${evaluation.reason ?? 'not takeable'}`
                );
                continue;
              }

              const approval = await approveExternalTakeForDiscovery({
                price,
                auctionPrice,
                collateral,
                quoteEvaluation: evaluation,
                countStats: false,
              });
              if (!approval.approved) {
                rejectedReasons.push(
                  `${path}=${approval.reason ?? 'policy rejected path'}`
                );
                continue;
              }
              approvedEvaluations.push(evaluation);
            }

            const selected = approvedEvaluations.sort((left, right) => {
              const leftRank = rankExternalTakeQuote(left);
              const rightRank = rankExternalTakeQuote(right);
              if (!leftRank && !rightRank) {
                return 0;
              }
              if (!leftRank) {
                return 1;
              }
              if (!rightRank) {
                return -1;
              }
              return leftRank.eq(rightRank)
                ? 0
                : leftRank.gt(rightRank)
                  ? -1
                  : 1;
            })[0];
            if (selected) {
              logger.debug(
                `Hybrid external take selected path=${selected.externalTakePath} source=${selected.selectedLiquiditySource ?? 'n/a'} expectedNetProfitRaw=${selected.routeProfitability?.expectedNetProfitQuoteRaw?.toString() ?? 'n/a'} for pool ${pool.name}`
              );
              return selected;
            }

            return {
              isTakeable: false,
              reason: rejectedReasons.length
                ? `no viable external take path: ${rejectedReasons.join('; ')}`
                : 'no external take paths configured',
            };
          },
          executeExternalTake: async ({
            pool,
            signer,
            poolConfig,
            liquidation,
            config,
          }) => {
            const selectedPath =
              liquidation.externalTakeQuoteEvaluation?.externalTakePath;
            if (
              selectedPath === 'oneinch' ||
              liquidation.externalTakeQuoteEvaluation
                ?.selectedLiquiditySource === LiquiditySource.ONEINCH
            ) {
              return takeModule.takeLiquidation({
                pool,
                signer,
                poolConfig,
                liquidation,
                config,
              });
            }

            const selectedFactorySource =
              liquidation.externalTakeQuoteEvaluation?.selectedLiquiditySource;
            const factoryPoolConfig =
              selectedFactorySource !== undefined &&
              isDynamicFactorySource(selectedFactorySource)
                ? withTakeLiquiditySource(poolConfig, selectedFactorySource)
                : poolConfig;
            return takeFactoryModule.takeLiquidationFactory({
              pool,
              signer,
              poolConfig: factoryPoolConfig,
              liquidation,
              config,
            });
          },
        }
      : params.target.take.liquiditySource === LiquiditySource.ONEINCH
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
                quoteFactoryPath({
                  pool,
                  signer,
                  poolConfig,
                  auctionPrice,
                  collateral,
                }),
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

  const externalExecutionConfig = {
    dryRun: params.target.dryRun,
    delayBetweenActions: params.config.delayBetweenActions,
    connectorTokens: params.config.connectorTokens,
    oneInchRouters: params.config.oneInchRouters,
    keeperTaker: params.config.keeperTaker,
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
      candidates: params.target.candidates.map(({ borrower }) => ({
        borrower,
      })),
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
      }) =>
        approveExternalTakeForDiscovery({
          price,
          auctionPrice,
          collateral,
          quoteEvaluation,
        }),
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

        await refreshDiscoveryGasPriceIfStale({
          rpcCache,
          transports,
          maxAgeMs: getDiscoveryGasPriceFreshnessTtlMs(
            takePolicy,
            rpcCache?.chainId
          ),
        });

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
        if (isInactiveAuctionSkipReason(reason)) {
          params.onCandidateInactive?.({
            poolAddress: params.target.poolAddress,
            borrower: candidate.borrower,
          });
        }
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
