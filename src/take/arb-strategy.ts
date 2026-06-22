import { FungiblePool, Signer } from '@ajna-finance/sdk';
import { BigNumber } from 'ethers';
import { SubgraphReader } from '../read-transports';
import { weiToDecimaled } from '../utils';
import { arbTakeLiquidation, checkIfArbTakeable } from './arb';
import { TakeWriteTransport } from './write-transport';
import { ArbTakeEvaluation, TakeActionConfig } from './types';

export interface ArbTakeStrategy<
  TPoolConfig extends TakeActionConfig = TakeActionConfig,
> {
  kind: 'arb';
  actionLabel?: string;
  logPrefix?: string;
  isEnabled: (poolConfig: TPoolConfig) => boolean;
  evaluateArbTake: (params: {
    pool: FungiblePool;
    signer: Signer;
    poolConfig: TPoolConfig;
    subgraph: SubgraphReader;
    price: number;
    auctionPrice: BigNumber;
    collateral: BigNumber;
  }) => Promise<ArbTakeEvaluation>;
  executeArbTake: (params: {
    pool: FungiblePool;
    signer: Signer;
    borrower: string;
    hpbIndex: number;
    dryRun: boolean;
    takeWriteTransport?: TakeWriteTransport;
  }) => Promise<boolean>;
}

export function isArbTakeStrategyEnabled(
  poolConfig: TakeActionConfig
): boolean {
  return (
    poolConfig.take.minCollateral !== undefined &&
    poolConfig.take.hpbPriceFactor !== undefined
  );
}

export function createArbTakeStrategy<
  TPoolConfig extends TakeActionConfig = TakeActionConfig,
>(params?: {
  actionLabel?: string;
  logPrefix?: string;
}): ArbTakeStrategy<TPoolConfig> {
  return {
    kind: 'arb',
    actionLabel: params?.actionLabel,
    logPrefix: params?.logPrefix,
    isEnabled: isArbTakeStrategyEnabled,
    evaluateArbTake: async ({
      pool,
      signer,
      poolConfig,
      subgraph,
      price,
      collateral,
    }) => {
      if (!isArbTakeStrategyEnabled(poolConfig)) {
        return {
          isArbTakeable: false,
          hpbIndex: 0,
          reason: 'arbTake settings are not configured',
        };
      }

      const prices = await pool.getPrices();
      const hpb = Number(weiToDecimaled(prices.hpb));
      // Guard hpb=0 (degenerate/empty pool) so minDeposit is never Infinity
      // (which would otherwise be stringified into the subgraph query). An arb
      // take needs a meaningful highest bucket to deposit into; without one,
      // skip explicitly rather than relying on the Infinity floor.
      if (!Number.isFinite(hpb) || hpb <= 0) {
        return {
          isArbTakeable: false,
          hpbIndex: 0,
          reason: 'pool has no highest meaningful bucket (hpb <= 0)',
        };
      }
      const minDeposit = poolConfig.take.minCollateral
        ? poolConfig.take.minCollateral / hpb
        : 0;

      return checkIfArbTakeable(
        pool,
        price,
        collateral,
        poolConfig,
        subgraph,
        minDeposit.toString(),
        signer
      );
    },
    executeArbTake: async ({
      pool,
      signer,
      borrower,
      hpbIndex,
      dryRun,
      takeWriteTransport,
    }) =>
      arbTakeLiquidation({
        pool,
        signer,
        liquidation: {
          borrower,
          hpbIndex,
        },
        config: {
          dryRun,
          takeWriteTransport,
        },
        actionLabel: params?.actionLabel,
        logPrefix: params?.logPrefix,
      }),
  };
}
