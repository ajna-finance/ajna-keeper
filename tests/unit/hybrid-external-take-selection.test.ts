import { expect } from 'chai';
import { BigNumber, ethers } from 'ethers';
import { LiquiditySource } from '../../src/config';
import {
  resolveHybridExternalTakeExecutionSelection,
  selectBestExternalTakeQuoteEvaluation,
} from '../../src/discovery/external-take/selection';
import { ExternalTakeQuoteEvaluation } from '../../src/take/types';

function quoteEvaluation(
  params: Partial<ExternalTakeQuoteEvaluation>
): ExternalTakeQuoteEvaluation {
  return {
    isTakeable: true,
    quoteAmountRaw: BigNumber.from(125),
    ...params,
  } as ExternalTakeQuoteEvaluation;
}

describe('hybrid external take selection', () => {
  it('rejects disabled hybrid execution paths before dispatch', () => {
    const disabledPath = resolveHybridExternalTakeExecutionSelection({
      allowedExternalTakePaths: ['factory'],
      quoteEvaluation: quoteEvaluation({
        externalTakePath: 'oneinch',
        selectedLiquiditySource: LiquiditySource.ONEINCH,
        quoteAmount: 125,
        quoteAmountRaw: ethers.utils.parseUnits('125', 6),
        collateralAmount: 1,
        marketPrice: 125,
        takeablePrice: 123.75,
      }),
    });

    expect(disabledPath).to.deep.include({
      approved: false,
      reason: 'selected disabled path=oneinch',
    });

    const missingFactorySource = resolveHybridExternalTakeExecutionSelection({
      allowedExternalTakePaths: ['factory'],
      quoteEvaluation: quoteEvaluation({
        externalTakePath: 'factory',
        quoteAmount: 125,
        quoteAmountRaw: ethers.utils.parseUnits('125', 6),
        collateralAmount: 1,
        marketPrice: 125,
        takeablePrice: 123.75,
      }),
    });

    expect(missingFactorySource).to.deep.include({
      approved: false,
      reason: 'selected factory path without a concrete factory source',
    });

    const missingSelectedPath = resolveHybridExternalTakeExecutionSelection({
      allowedExternalTakePaths: ['oneinch', 'factory'],
      quoteEvaluation: quoteEvaluation({
        quoteAmount: 125,
        quoteAmountRaw: ethers.utils.parseUnits('125', 6),
        collateralAmount: 1,
        marketPrice: 125,
        takeablePrice: 123.75,
      }),
    });

    expect(missingSelectedPath).to.deep.include({
      approved: false,
      reason: 'hybrid external take selection missing selected path',
    });

    const lifiSourceOnly = resolveHybridExternalTakeExecutionSelection({
      allowedExternalTakePaths: ['lifi'],
      quoteEvaluation: quoteEvaluation({
        selectedLiquiditySource: LiquiditySource.LIFI,
        quoteAmount: 125,
        quoteAmountRaw: ethers.utils.parseUnits('125', 6),
        collateralAmount: 1,
        marketPrice: 125,
        takeablePrice: 123.75,
      }),
    });

    expect(lifiSourceOnly).to.deep.include({
      approved: true,
      effectiveSelectedPath: 'lifi',
    });

    const inconsistentLifiPath = resolveHybridExternalTakeExecutionSelection({
      allowedExternalTakePaths: ['factory', 'lifi'],
      quoteEvaluation: quoteEvaluation({
        externalTakePath: 'factory',
        selectedLiquiditySource: LiquiditySource.LIFI,
        quoteAmount: 125,
        quoteAmountRaw: ethers.utils.parseUnits('125', 6),
        collateralAmount: 1,
        marketPrice: 125,
        takeablePrice: 123.75,
      }),
    });

    expect(inconsistentLifiPath).to.deep.include({
      approved: false,
      reason: 'selected inconsistent path=factory source=LIFI',
    });
  });

  it('prefers non-subsidized hybrid external take quotes over higher-profit subsidized quotes', () => {
    const nonSubsidized = quoteEvaluation({
      externalTakePath: 'factory',
      selectedLiquiditySource: LiquiditySource.UNISWAPV3,
      quoteAmountRaw: BigNumber.from(125),
      routeProfitability: {
        expectedNetProfitQuoteRaw: BigNumber.from(20),
        expectedSubsidyQuoteRaw: BigNumber.from(0),
        subsidyAllowed: false,
      },
    });
    const subsidized = quoteEvaluation({
      externalTakePath: 'oneinch',
      selectedLiquiditySource: LiquiditySource.ONEINCH,
      quoteAmountRaw: BigNumber.from(140),
      routeProfitability: {
        expectedNetProfitQuoteRaw: BigNumber.from(35),
        expectedSubsidyQuoteRaw: BigNumber.from(5),
        subsidyAllowed: true,
      },
    });

    expect(
      selectBestExternalTakeQuoteEvaluation({
        evaluations: [subsidized, nonSubsidized],
        externalTakePaths: ['oneinch', 'factory', 'lifi'],
      })
    ).to.equal(nonSubsidized);
  });

  it('ranks LI.FI hybrid quotes by expected net profit with path-order tie break', () => {
    const oneInch = quoteEvaluation({
      externalTakePath: 'oneinch',
      selectedLiquiditySource: LiquiditySource.ONEINCH,
      quoteAmountRaw: BigNumber.from(130),
      routeProfitability: {
        expectedNetProfitQuoteRaw: BigNumber.from(10),
        expectedSubsidyQuoteRaw: BigNumber.from(0),
        subsidyAllowed: false,
      },
    });
    const lifi = quoteEvaluation({
      externalTakePath: 'lifi',
      selectedLiquiditySource: LiquiditySource.LIFI,
      quoteAmountRaw: BigNumber.from(135),
      routeProfitability: {
        expectedNetProfitQuoteRaw: BigNumber.from(15),
        expectedSubsidyQuoteRaw: BigNumber.from(0),
        subsidyAllowed: false,
      },
    });
    const factoryTie = quoteEvaluation({
      externalTakePath: 'factory',
      selectedLiquiditySource: LiquiditySource.UNISWAPV3,
      quoteAmountRaw: BigNumber.from(140),
      routeProfitability: {
        expectedNetProfitQuoteRaw: BigNumber.from(15),
        expectedSubsidyQuoteRaw: BigNumber.from(0),
        subsidyAllowed: false,
      },
    });

    expect(
      selectBestExternalTakeQuoteEvaluation({
        evaluations: [oneInch, lifi, factoryTie],
        externalTakePaths: ['oneinch', 'lifi', 'factory'],
      })
    ).to.equal(lifi);
  });

  it('chooses the smallest subsidy among subsidized hybrid external take quotes', () => {
    const smallerSubsidy = quoteEvaluation({
      externalTakePath: 'factory',
      selectedLiquiditySource: LiquiditySource.SUSHISWAP,
      quoteAmountRaw: BigNumber.from(130),
      routeProfitability: {
        expectedNetProfitQuoteRaw: BigNumber.from(15),
        expectedSubsidyQuoteRaw: BigNumber.from(2),
        subsidyAllowed: true,
      },
    });
    const largerSubsidy = quoteEvaluation({
      externalTakePath: 'oneinch',
      selectedLiquiditySource: LiquiditySource.ONEINCH,
      quoteAmountRaw: BigNumber.from(150),
      routeProfitability: {
        expectedNetProfitQuoteRaw: BigNumber.from(40),
        expectedSubsidyQuoteRaw: BigNumber.from(8),
        subsidyAllowed: true,
      },
    });

    expect(
      selectBestExternalTakeQuoteEvaluation({
        evaluations: [largerSubsidy, smallerSubsidy],
        externalTakePaths: ['oneinch', 'factory'],
      })
    ).to.equal(smallerSubsidy);
  });
});
