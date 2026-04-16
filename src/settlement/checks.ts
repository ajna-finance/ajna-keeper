import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { weiToDecimaled } from '../utils';
import {
  AuctionToSettle,
  SettlementIncentiveResult,
  SettlementNeedResult,
} from './model';
import { SettlementActionConfig } from './types';

function formatSettlementCheckError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error !== null && 'message' in error
        ? String((error as { message?: unknown }).message ?? error)
        : String(error);
  return message.slice(0, 100);
}

function isRetryableSettlementCheckError(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : '';
  if (
    code === 'NETWORK_ERROR' ||
    code === 'SERVER_ERROR' ||
    code === 'TIMEOUT' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN'
  ) {
    return true;
  }

  const message = formatSettlementCheckError(error).toLowerCase();
  return (
    message.includes('network error') ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('econnreset') ||
    message.includes('econnrefused') ||
    message.includes('enotfound') ||
    message.includes('eai_again') ||
    message.includes('429') ||
    message.includes('rate limit') ||
    message.includes('socket hang up') ||
    message.includes('bad gateway') ||
    message.includes('service unavailable') ||
    message.includes('gateway timeout')
  );
}

export function isAuctionOldEnough(
  auction: AuctionToSettle,
  poolConfig: SettlementActionConfig
): boolean {
  const minAge = poolConfig.settlement.minAuctionAge || 3600;
  const ageSeconds = (Date.now() - auction.kickTime) / 1000;
  return ageSeconds >= minAge;
}

export async function needsSettlement(params: {
  pool: FungiblePool;
  signer: Signer;
  borrower: string;
  maxBucketDepth?: number;
}): Promise<SettlementNeedResult> {
  try {
    const auctionInfo = await params.pool.contract.auctionInfo(params.borrower);
    const kickTime = auctionInfo.kickTime_;

    if (kickTime.eq(0)) {
      return { needs: false, reason: 'No active auction (kickTime = 0)' };
    }

    const liquidationStatus = await params.pool
      .getLiquidation(params.borrower)
      .getStatus();
    const collateralAmount = liquidationStatus.collateral;
    const debt = liquidationStatus.debtToCover ?? auctionInfo.debtToCollateral_;

    const details = {
      debtRemaining: debt,
      collateralRemaining: collateralAmount,
      auctionPrice: liquidationStatus.price,
      kickTime: kickTime.toNumber(),
    };

    if (debt.eq(0)) {
      return {
        needs: false,
        reason: 'No debt remaining - auction fully covered',
        details,
      };
    }

    if (collateralAmount.gt(0)) {
      return {
        needs: false,
        reason: `Still has ${weiToDecimaled(collateralAmount)} collateral to auction`,
        details,
      };
    }

    if (collateralAmount.eq(0) && debt.gt(0)) {
      try {
        const poolWithSigner = params.pool.contract.connect(params.signer);
        await poolWithSigner.callStatic.settle(
          params.borrower,
          params.maxBucketDepth ?? 50
        );

        return {
          needs: true,
          reason: `Bad debt detected: ${weiToDecimaled(debt)} debt with 0 collateral`,
          details,
        };
      } catch (settleError) {
        const retryable = isRetryableSettlementCheckError(settleError);
        return {
          needs: false,
          retryable,
          reason: retryable
            ? `Retryable settlement check failure: ${formatSettlementCheckError(settleError)}`
            : `Settlement call would fail: ${formatSettlementCheckError(settleError)}`,
          details,
        };
      }
    }

    return {
      needs: false,
      reason: 'Unexpected state',
      details,
    };
  } catch (error) {
    const retryable = isRetryableSettlementCheckError(error);
    return {
      needs: false,
      retryable,
      reason: retryable
        ? `Retryable settlement check failure: ${formatSettlementCheckError(error)}`
        : `Error checking settlement: ${formatSettlementCheckError(error)}`,
    };
  }
}

export async function checkBotIncentive(params: {
  pool: FungiblePool;
  signer: Signer;
  borrower: string;
}): Promise<SettlementIncentiveResult> {
  try {
    const botAddress = await params.signer.getAddress();
    const auctionInfo = await params.pool.contract.auctionInfo(params.borrower);
    const kicker = auctionInfo.kicker_;
    const isKicker = kicker.toLowerCase() === botAddress.toLowerCase();

    if (isKicker) {
      try {
        const kickerInfo = await params.pool.contract.kickerInfo(botAddress);
        const claimable = kickerInfo.claimable_;
        return {
          hasIncentive: true,
          reason: `Bot is kicker with ${weiToDecimaled(claimable)} claimable bond`,
        };
      } catch {
        return {
          hasIncentive: true,
          reason: 'Bot is kicker (could not check claimable amount)',
        };
      }
    }

    return {
      hasIncentive: false,
      reason: `Not the kicker (kicker: ${kicker.slice(0, 8)})`,
    };
  } catch (error) {
    return {
      hasIncentive: false,
      reason: `Error checking incentive: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
