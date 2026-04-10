import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber, ethers } from 'ethers';
import { getAutoDiscoverSettlementPolicy } from '../config-types';
import { ResolvedSettlementTarget } from '../discovery-targets';
import { logger } from '../logging';
import {
  createDiscoveryTransportsForConfig,
  evaluateGasPolicy,
  logDiscoveryDecision,
} from './gas-policy';
import {
  DiscoveryExecutionConfig,
  DiscoveryRpcCache,
} from './types';
import { DiscoveryReadTransports } from '../read-transports';
import { AuctionToSettle, SettlementHandler } from '../settlement';

const SETTLEMENT_GAS_LIMIT = BigNumber.from(800000);

interface DiscoveredSettlementTargetStats {
  candidateCount: number;
  needsSettlementSkips: number;
  incentiveSkips: number;
  gasPolicyRejects: number;
  approvedCandidates: number;
  executionAttempted: boolean;
}

export interface HandleDiscoveredSettlementTargetParams {
  pool: FungiblePool;
  signer: Signer;
  target: ResolvedSettlementTarget;
  config: DiscoveryExecutionConfig;
  transports?: DiscoveryReadTransports;
  rpcCache?: DiscoveryRpcCache;
}

function hydrateSettlementAuction(
  candidate: ResolvedSettlementTarget['candidates'][number]
): AuctionToSettle {
  return {
    borrower: candidate.borrower,
    kickTime: candidate.kickTime,
    debtRemaining: ethers.utils.parseEther(candidate.debtRemaining || '0'),
    collateralRemaining: ethers.utils.parseEther(
      candidate.collateralRemaining || '0'
    ),
  };
}

function logDiscoveredSettlementTargetSummary(params: {
  pool: FungiblePool;
  target: ResolvedSettlementTarget;
  stats: DiscoveredSettlementTargetStats;
}): void {
  logger.info(
    `Discovered settlement target summary: pool=${params.pool.poolAddress} name="${params.target.name}" dryRun=${params.target.dryRun} candidates=${params.stats.candidateCount} needsSettlementSkips=${params.stats.needsSettlementSkips} incentiveSkips=${params.stats.incentiveSkips} gasPolicyRejects=${params.stats.gasPolicyRejects} approvedCandidates=${params.stats.approvedCandidates} executionAttempted=${params.stats.executionAttempted}`
  );
}

export async function handleDiscoveredSettlementTarget(
  params: HandleDiscoveredSettlementTargetParams
): Promise<void> {
  const transports =
    params.transports ??
    createDiscoveryTransportsForConfig(params.config, params.signer);
  const stats: DiscoveredSettlementTargetStats = {
    candidateCount: params.target.candidates.length,
    needsSettlementSkips: 0,
    incentiveSkips: 0,
    gasPolicyRejects: 0,
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
    (params.signer.provider
      ? {
          gasPrice: await transports.readRpc.getGasPrice(),
        }
      : undefined);
  const approvedAuctions: AuctionToSettle[] = [];
  const settlementPolicy = getAutoDiscoverSettlementPolicy(
    params.config.autoDiscover
  );

  try {
    for (const candidate of params.target.candidates) {
      const needsSettlement = await handler.needsSettlement(candidate.borrower);
      if (!needsSettlement.needs) {
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

      const gasPolicy = await evaluateGasPolicy({
        signer: params.signer,
        config: params.config,
        transports,
        policy: settlementPolicy,
        gasLimit: SETTLEMENT_GAS_LIMIT,
        quoteTokenAddress: params.pool.quoteAddress,
        useProfitFloor: false,
        gasPrice: rpcCache?.gasPrice,
      });
      if (!gasPolicy.approved) {
        stats.gasPolicyRejects += 1;
        logDiscoveryDecision(
          params.config,
          `Skipping discovered settlement candidate ${params.pool.poolAddress}/${candidate.borrower}: ${gasPolicy.reason}`
        );
        continue;
      }

      approvedAuctions.push(hydrateSettlementAuction(candidate));
    }

    stats.approvedCandidates = approvedAuctions.length;
    if (approvedAuctions.length === 0) {
      return;
    }

    stats.executionAttempted = true;
    await handler.handleCandidateAuctions(approvedAuctions);
  } finally {
    logDiscoveredSettlementTargetSummary({
      pool: params.pool,
      target: params.target,
      stats,
    });
  }
}
