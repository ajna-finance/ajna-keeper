import { expect } from 'chai';
import { BigNumber, ethers } from 'ethers';
import { LiquiditySource } from '../config-types';
import { computeFactoryAmountOutMinimum } from '../take-factory';

describe('Factory amountOutMinimum', () => {
  it('uses the stricter of the slippage floor and profitability floor', async () => {
    const pool = {
      contract: {
        quoteTokenScale: async () => BigNumber.from(1),
      },
    };

    const liquidation = {
      collateral: ethers.utils.parseEther('100'),
      auctionPrice: ethers.utils.parseEther('1'),
    };

    const quoteEvaluation = {
      isTakeable: true,
      quoteAmountRaw: ethers.utils.parseEther('120'),
    };

    const amountOutMinimum = await computeFactoryAmountOutMinimum({
      pool: pool as any,
      liquidation,
      quoteEvaluation,
      liquiditySource: LiquiditySource.UNISWAPV3,
      config: {
        universalRouterOverrides: {
          defaultSlippage: 1.0,
        },
      },
      marketPriceFactor: 0.95,
    });

    expect(amountOutMinimum.eq(ethers.utils.parseEther('118.8'))).to.be.true;
  });

  it('never allows the minimum below quote due even when marketPriceFactor is above one', async () => {
    const pool = {
      contract: {
        quoteTokenScale: async () => BigNumber.from(1),
      },
    };

    const liquidation = {
      collateral: ethers.utils.parseEther('100'),
      auctionPrice: ethers.utils.parseEther('1'),
    };

    const quoteEvaluation = {
      isTakeable: true,
      quoteAmountRaw: ethers.utils.parseEther('101'),
    };

    const amountOutMinimum = await computeFactoryAmountOutMinimum({
      pool: pool as any,
      liquidation,
      quoteEvaluation,
      liquiditySource: LiquiditySource.SUSHISWAP,
      config: {
        sushiswapRouterOverrides: {
          defaultSlippage: 50.0,
        },
      },
      marketPriceFactor: 1.05,
    });

    expect(amountOutMinimum.eq(ethers.utils.parseEther('100'))).to.be.true;
  });
});
