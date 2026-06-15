import { expect } from 'chai';
import { BigNumber, ethers } from 'ethers';
import { computeDirectDexAmountOutMinimum } from '../../src/take/direct-dex';
import { LiquiditySource } from '../../src/config';
import { ApprovedUniswapV3DirectDexQuoteEvaluation } from '../../src/take/types';

describe('Direct DEX amountOutMinimum', () => {
  it('preserves the legacy approved floor when split floor metadata is absent', async () => {
    const pool = {
      contract: {
        quoteTokenScale: async () => BigNumber.from(1),
      },
    };

    const liquidation = {
      collateral: ethers.utils.parseEther('100'),
      auctionPrice: ethers.utils.parseEther('1'),
    };

    const quoteEvaluation: ApprovedUniswapV3DirectDexQuoteEvaluation = {
      isTakeable: true,
      externalTakePath: 'direct_dex',
      quoteAmountRaw: ethers.utils.parseEther('120'),
      approvedMinOutRaw: ethers.utils.parseEther('118.8'),
      selectedLiquiditySource: LiquiditySource.UNISWAPV3,
      selectedFeeTier: 3000,
    };

    const amountOutMinimum = await computeDirectDexAmountOutMinimum({
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

    const quoteEvaluation: ApprovedUniswapV3DirectDexQuoteEvaluation = {
      isTakeable: true,
      externalTakePath: 'direct_dex',
      quoteAmountRaw: ethers.utils.parseEther('101'),
      approvedMinOutRaw: ethers.utils.parseEther('99'),
      selectedLiquiditySource: LiquiditySource.UNISWAPV3,
      selectedFeeTier: 3000,
    };

    let thrown: Error | undefined;
    try {
      await computeDirectDexAmountOutMinimum({
        pool: pool as any,
        liquidation,
        quoteEvaluation,
      });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown?.message).to.equal(
      'Direct DEX: approvedMinOutRaw below auction repayment floor'
    );
  });

  it('uses the route slippage floor when it is stricter than repayment', async () => {
    const pool = {
      contract: {
        quoteTokenScale: async () => BigNumber.from(1),
      },
    };

    const liquidation = {
      collateral: ethers.utils.parseEther('100'),
      auctionPrice: ethers.utils.parseEther('1'),
    };

    const quoteEvaluation: ApprovedUniswapV3DirectDexQuoteEvaluation = {
      isTakeable: true,
      externalTakePath: 'direct_dex',
      quoteAmountRaw: ethers.utils.parseEther('126'),
      routeMinOutRaw: ethers.utils.parseEther('125'),
      profitMinOutRaw: ethers.utils.parseEther('105'),
      approvedMinOutRaw: ethers.utils.parseEther('125'),
      selectedLiquiditySource: LiquiditySource.UNISWAPV3,
      selectedFeeTier: 3000,
    };

    const amountOutMinimum = await computeDirectDexAmountOutMinimum({
      pool: pool as any,
      liquidation,
      quoteEvaluation,
    });

    expect(amountOutMinimum.eq(ethers.utils.parseEther('125'))).to.be.true;
  });

  it('preserves a stricter profit floor in the router execution floor', async () => {
    const pool = {
      contract: {
        quoteTokenScale: async () => BigNumber.from(1),
      },
    };

    const liquidation = {
      collateral: ethers.utils.parseEther('100'),
      auctionPrice: ethers.utils.parseEther('1'),
    };

    const quoteEvaluation: ApprovedUniswapV3DirectDexQuoteEvaluation = {
      isTakeable: true,
      externalTakePath: 'direct_dex',
      quoteAmountRaw: ethers.utils.parseEther('150'),
      routeMinOutRaw: ethers.utils.parseEther('98'),
      profitMinOutRaw: ethers.utils.parseEther('130'),
      approvedMinOutRaw: ethers.utils.parseEther('140'),
      selectedLiquiditySource: LiquiditySource.UNISWAPV3,
      selectedFeeTier: 3000,
    };

    const amountOutMinimum = await computeDirectDexAmountOutMinimum({
      pool: pool as any,
      liquidation,
      quoteEvaluation,
    });

    expect(amountOutMinimum.eq(ethers.utils.parseEther('130'))).to.be.true;
  });

  it('uses the repayment floor for intentionally subsidized routes', async () => {
    const pool = {
      contract: {
        quoteTokenScale: async () => BigNumber.from(1),
      },
    };

    const liquidation = {
      collateral: ethers.utils.parseEther('100'),
      auctionPrice: ethers.utils.parseEther('1'),
    };

    const quoteEvaluation: ApprovedUniswapV3DirectDexQuoteEvaluation = {
      isTakeable: true,
      externalTakePath: 'direct_dex',
      quoteAmountRaw: ethers.utils.parseEther('101'),
      routeMinOutRaw: ethers.utils.parseEther('98'),
      profitMinOutRaw: ethers.utils.parseEther('100'),
      approvedMinOutRaw: ethers.utils.parseEther('100'),
      selectedLiquiditySource: LiquiditySource.UNISWAPV3,
      selectedFeeTier: 3000,
    };

    const amountOutMinimum = await computeDirectDexAmountOutMinimum({
      pool: pool as any,
      liquidation,
      quoteEvaluation,
    });

    expect(amountOutMinimum.eq(ethers.utils.parseEther('100'))).to.be.true;
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
      await computeDirectDexAmountOutMinimum({
        pool: pool as any,
        liquidation,
        quoteEvaluation: quoteEvaluation as any,
      });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown?.message).to.equal(
      'Direct DEX: approvedMinOutRaw missing from evaluation'
    );
  });
});
