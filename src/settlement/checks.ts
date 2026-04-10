import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { weiToDecimaled } from '../utils';
import {
  AuctionToSettle,
  SettlementIncentiveResult,
  SettlementNeedResult,
} from './model';
import { SettlementActionConfig } from './types';

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
    const debt = auctionInfo.debtToCollateral_;

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
        await poolWithSigner.callStatic.settle(params.borrower, 10);

        return {
          needs: true,
          reason: `Bad debt detected: ${weiToDecimaled(debt)} debt with 0 collateral`,
          details,
        };
      } catch (settleError) {
        return {
          needs: false,
          reason: `Settlement call would fail: ${
            settleError instanceof Error
              ? settleError.message.slice(0, 100)
              : String(settleError)
          }`,
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
    return {
      needs: false,
      reason: `Error checking settlement: ${
        error instanceof Error ? error.message : String(error)
      }`,
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
