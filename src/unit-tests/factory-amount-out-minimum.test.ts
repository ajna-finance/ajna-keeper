import { expect } from 'chai';
import { BigNumber, ethers } from 'ethers';
import { computeFactoryAmountOutMinimum } from '../take/factory';

describe('Factory amountOutMinimum', () => {
  it('uses the approved execution floor directly', async () => {
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
      approvedMinOutRaw: ethers.utils.parseEther('118.8'),
    };

    const amountOutMinimum = await computeFactoryAmountOutMinimum({
      pool: pool as any,
      liquidation,
      quoteEvaluation,
      marketPriceFactor: 0.95,
    });

    expect(amountOutMinimum.eq(ethers.utils.parseEther('118.8'))).to.be.true;
  });

  it('rejects an approved floor below quote due even when marketPriceFactor is above one', async () => {
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
      approvedMinOutRaw: ethers.utils.parseEther('99'),
    };

    let thrown: Error | undefined;
    try {
      await computeFactoryAmountOutMinimum({
        pool: pool as any,
        liquidation,
        quoteEvaluation,
        marketPriceFactor: 1.05,
      });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown?.message).to.equal(
      'Factory: approvedMinOutRaw below auction repayment/market-factor floor'
    );
  });

  it('preserves the approved route floor when it is stricter than repayment and market-factor floors', async () => {
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
      quoteAmountRaw: ethers.utils.parseEther('126'),
      approvedMinOutRaw: ethers.utils.parseEther('125'),
    };

    const amountOutMinimum = await computeFactoryAmountOutMinimum({
      pool: pool as any,
      liquidation,
      quoteEvaluation,
      marketPriceFactor: 0.99,
    });

    expect(amountOutMinimum.eq(ethers.utils.parseEther('125'))).to.be.true;
  });

  it('rejects a missing approved route floor', async () => {
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
      quoteAmountRaw: ethers.utils.parseEther('126'),
    };

    let thrown: Error | undefined;
    try {
      await computeFactoryAmountOutMinimum({
        pool: pool as any,
        liquidation,
        quoteEvaluation,
        marketPriceFactor: 0.99,
      });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown?.message).to.equal(
      'Factory: approvedMinOutRaw missing from evaluation'
    );
  });
});
