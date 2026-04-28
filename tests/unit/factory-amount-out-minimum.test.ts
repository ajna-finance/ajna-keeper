import { expect } from 'chai';
import { BigNumber, ethers } from 'ethers';
import { computeFactoryAmountOutMinimum } from '../../src/take/factory';
import { LiquiditySource } from '../../src/config';
import { ApprovedUniswapV3FactoryQuoteEvaluation } from '../../src/take/types';

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

    const quoteEvaluation: ApprovedUniswapV3FactoryQuoteEvaluation = {
      isTakeable: true,
      externalTakePath: 'factory',
      quoteAmountRaw: ethers.utils.parseEther('120'),
      approvedMinOutRaw: ethers.utils.parseEther('118.8'),
      selectedLiquiditySource: LiquiditySource.UNISWAPV3,
      selectedFeeTier: 3000,
    };

    const amountOutMinimum = await computeFactoryAmountOutMinimum({
      pool: pool as any,
      liquidation,
      quoteEvaluation,
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

    const quoteEvaluation: ApprovedUniswapV3FactoryQuoteEvaluation = {
      isTakeable: true,
      externalTakePath: 'factory',
      quoteAmountRaw: ethers.utils.parseEther('101'),
      approvedMinOutRaw: ethers.utils.parseEther('99'),
      selectedLiquiditySource: LiquiditySource.UNISWAPV3,
      selectedFeeTier: 3000,
    };

    let thrown: Error | undefined;
    try {
      await computeFactoryAmountOutMinimum({
        pool: pool as any,
        liquidation,
        quoteEvaluation,
      });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown?.message).to.equal(
      'Factory: approvedMinOutRaw below auction repayment floor'
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

    const quoteEvaluation: ApprovedUniswapV3FactoryQuoteEvaluation = {
      isTakeable: true,
      externalTakePath: 'factory',
      quoteAmountRaw: ethers.utils.parseEther('126'),
      approvedMinOutRaw: ethers.utils.parseEther('125'),
      selectedLiquiditySource: LiquiditySource.UNISWAPV3,
      selectedFeeTier: 3000,
    };

    const amountOutMinimum = await computeFactoryAmountOutMinimum({
      pool: pool as any,
      liquidation,
      quoteEvaluation,
    });

    expect(amountOutMinimum.eq(ethers.utils.parseEther('125'))).to.be.true;
  });

  it('derives the execution floor from split route/profit floors instead of stale approvedMinOutRaw', async () => {
    const pool = {
      contract: {
        quoteTokenScale: async () => BigNumber.from(1),
      },
    };

    const liquidation = {
      collateral: ethers.utils.parseEther('100'),
      auctionPrice: ethers.utils.parseEther('1'),
    };

    const quoteEvaluation: ApprovedUniswapV3FactoryQuoteEvaluation = {
      isTakeable: true,
      externalTakePath: 'factory',
      quoteAmountRaw: ethers.utils.parseEther('150'),
      routeMinOutRaw: ethers.utils.parseEther('125'),
      profitMinOutRaw: ethers.utils.parseEther('105'),
      approvedMinOutRaw: ethers.utils.parseEther('140'),
      selectedLiquiditySource: LiquiditySource.UNISWAPV3,
      selectedFeeTier: 3000,
    };

    const amountOutMinimum = await computeFactoryAmountOutMinimum({
      pool: pool as any,
      liquidation,
      quoteEvaluation,
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
        quoteEvaluation: quoteEvaluation as any,
      });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown?.message).to.equal(
      'Factory: approvedMinOutRaw missing from evaluation'
    );
  });
});
