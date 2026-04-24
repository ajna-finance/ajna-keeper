import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber, ethers } from 'ethers';
import { getAutoDiscoverSettlementPolicy } from '../config';
import { ResolvedSettlementTarget } from './targets';
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
import { AuctionToSettle, SettlementHandler } from '../settlement';
import { createDiscoveryRpcCache } from './rpc-cache';

const SETTLEMENT_GAS_LIMIT = BigNumber.from(800000);

interface DiscoveredSettlementTargetStats {
  candidateCount: number;
  needsSettlementSkips: number;
  retryableNeedsSettlementFailures: number;
  incentiveSkips: number;
  gasPolicyRejects: number;
  invalidCandidateSkips: number;
  approvedCandidates: number;
  executionAttempted: boolean;
}

interface HandleDiscoveredSettlementTargetParamsBase {
  pool: FungiblePool;
  signer: Signer;
  target: ResolvedSettlementTarget;
  rpcCache?: DiscoveryRpcCache;
}

export type HandleDiscoveredSettlementTargetParams =
  | (HandleDiscoveredSettlementTargetParamsBase & {
      config: DiscoveryExecutionTransportConfig;
      transports?: DiscoveryReadTransports;
    })
  | (HandleDiscoveredSettlementTargetParamsBase & {
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

function hydrateSettlementAuction(
  candidate: ResolvedSettlementTarget['candidates'][number],
  onchainKickTimeSeconds?: number
): AuctionToSettle | undefined {
  try {
    return {
      borrower: candidate.borrower,
      kickTime:
        onchainKickTimeSeconds !== undefined
          ? onchainKickTimeSeconds * 1000
          : candidate.kickTime,
      debtRemaining: ethers.utils.parseEther(candidate.debtRemaining || '0'),
      collateralRemaining: ethers.utils.parseEther(
        candidate.collateralRemaining || '0'
      ),
    };
  } catch (error) {
    logger.warn(
      `Skipping discovered settlement candidate ${candidate.borrower} for ${candidate.poolAddress}: malformed numeric fields`,
      error
    );
    return undefined;
  }
}

function logDiscoveredSettlementTargetSummary(params: {
  pool: FungiblePool;
  target: ResolvedSettlementTarget;
  stats: DiscoveredSettlementTargetStats;
}): void {
  logger.info(
    `Discovered settlement target summary: pool=${params.pool.poolAddress} name="${params.target.name}" dryRun=${params.target.dryRun} candidates=${params.stats.candidateCount} needsSettlementSkips=${params.stats.needsSettlementSkips} retryableNeedsSettlementFailures=${params.stats.retryableNeedsSettlementFailures} incentiveSkips=${params.stats.incentiveSkips} gasPolicyRejects=${params.stats.gasPolicyRejects} invalidCandidateSkips=${params.stats.invalidCandidateSkips} approvedCandidates=${params.stats.approvedCandidates} executionAttempted=${params.stats.executionAttempted}`
  );
}

export async function handleDiscoveredSettlementTarget(
  params: HandleDiscoveredSettlementTargetParams
): Promise<void> {
  const transports = params.transports
    ? params.transports
    : hasDiscoveryTransportConfig(params.config)
      ? createDiscoveryTransportsForConfig(params.config, params.signer)
      : (() => {
          throw new Error(
            'Discovered settlement target requires transports when config omits read transport settings'
          );
        })();
  const stats: DiscoveredSettlementTargetStats = {
    candidateCount: params.target.candidates.length,
    needsSettlementSkips: 0,
    retryableNeedsSettlementFailures: 0,
    incentiveSkips: 0,
    gasPolicyRejects: 0,
    invalidCandidateSkips: 0,
    approvedCandidates: 0,
    executionAttempted: false,
  };
  const handler = new SettlementHandler(
    params.pool,
    params.signer,
    { settlement: params.target.settlement },
    {
      dryRun: params.target.dryRun,
      delayBetweenActions: params.config.delayBetweenActions,
      subgraph: transports.subgraph,
    }
  );
  const rpcCache =
    params.rpcCache ??
    (await createDiscoveryRpcCache({
      signer: params.signer,
      readRpc: transports.readRpc,
    }));
  const approvedAuctions: AuctionToSettle[] = [];
  const settlementPolicy = getAutoDiscoverSettlementPolicy(
    params.config.autoDiscover
  );

  try {
    const gasPolicy = await evaluateGasPolicy({
      signer: params.signer,
      config: params.config,
      transports,
      policy: settlementPolicy,
      gasLimit: SETTLEMENT_GAS_LIMIT,
      quoteTokenAddress: params.pool.quoteAddress,
      useProfitFloor: false,
      gasPrice: rpcCache?.gasPrice,
      chainId: rpcCache?.chainId,
      rpcCache,
    });
    if (!gasPolicy.approved) {
      stats.gasPolicyRejects = params.target.candidates.length;
      logDiscoveryDecision(
        params.config,
        `Skipping discovered settlement target ${params.pool.poolAddress}: ${gasPolicy.reason}`
      );
      return;
    }

    for (const candidate of params.target.candidates) {
      const needsSettlement = await handler.needsSettlement(candidate.borrower);
      if (!needsSettlement.needs) {
        if (needsSettlement.retryable) {
          stats.retryableNeedsSettlementFailures += 1;
          logger.warn(
            `Retryable discovered settlement check failure for ${params.pool.poolAddress}/${candidate.borrower}: ${needsSettlement.reason}`
          );
          continue;
        }
        stats.needsSettlementSkips += 1;
        logDiscoveryDecision(
          params.config,
          `Skipping discovered settlement candidate ${params.pool.poolAddress}/${candidate.borrower}: ${needsSettlement.reason}`
        );
        continue;
      }

      if (params.target.settlement.checkBotIncentive) {
        const incentiveCheck = await handler.checkBotIncentive(
          candidate.borrower
        );
        if (!incentiveCheck.hasIncentive) {
          stats.incentiveSkips += 1;
          logDiscoveryDecision(
            params.config,
            `Skipping discovered settlement candidate ${params.pool.poolAddress}/${candidate.borrower}: ${incentiveCheck.reason}`
          );
          continue;
        }
      }

      const hydratedAuction = hydrateSettlementAuction(
        candidate,
        needsSettlement.details?.kickTime
      );
      if (!hydratedAuction) {
        stats.invalidCandidateSkips += 1;
        continue;
      }

      approvedAuctions.push(hydratedAuction);
    }

    stats.approvedCandidates = approvedAuctions.length;
    if (approvedAuctions.length === 0) {
      return;
    }

    stats.executionAttempted = true;
    await handler.handleCandidateAuctions(approvedAuctions, {
      prevalidated: true,
    });
  } finally {
    logDiscoveredSettlementTargetSummary({
      pool: params.pool,
      target: params.target,
      stats,
    });
  }
}
