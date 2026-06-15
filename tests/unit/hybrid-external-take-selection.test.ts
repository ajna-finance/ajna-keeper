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
      resolvedExternalTakePaths: ['direct_dex'],
      quoteEvaluation: quoteEvaluation({
        externalTakePath: 'calldata_aggregator',
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
      reason: 'selected disabled path=calldata_aggregator',
    });

    const missingFactorySource = resolveHybridExternalTakeExecutionSelection({
      resolvedExternalTakePaths: ['direct_dex'],
      quoteEvaluation: quoteEvaluation({
        externalTakePath: 'direct_dex',
        quoteAmount: 125,
        quoteAmountRaw: ethers.utils.parseUnits('125', 6),
        collateralAmount: 1,
        marketPrice: 125,
        takeablePrice: 123.75,
      }),
    });

    expect(missingFactorySource).to.deep.include({
      approved: false,
      reason: 'selected direct_dex path without a concrete direct DEX source',
    });

    const missingSelectedPath = resolveHybridExternalTakeExecutionSelection({
      resolvedExternalTakePaths: ['calldata_aggregator', 'direct_dex'],
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
      resolvedExternalTakePaths: ['calldata_aggregator'],
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
      effectiveSelectedPath: 'calldata_aggregator',
    });

    const inconsistentLifiPath = resolveHybridExternalTakeExecutionSelection({
      resolvedExternalTakePaths: ['direct_dex', 'calldata_aggregator'],
      quoteEvaluation: quoteEvaluation({
        externalTakePath: 'direct_dex',
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
      reason: 'selected inconsistent path=direct_dex source=LIFI',
    });
  });

  it('prefers non-subsidized hybrid external take quotes over higher-profit subsidized quotes', () => {
    const nonSubsidized = quoteEvaluation({
      externalTakePath: 'direct_dex',
      selectedLiquiditySource: LiquiditySource.UNISWAPV3,
      quoteAmountRaw: BigNumber.from(125),
      routeProfitability: {
        expectedNetProfitQuoteRaw: BigNumber.from(20),
        expectedSubsidyQuoteRaw: BigNumber.from(0),
        subsidyAllowed: false,
      },
    });
    const subsidized = quoteEvaluation({
      externalTakePath: 'calldata_aggregator',
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
        externalTakePaths: ['calldata_aggregator', 'direct_dex'],
      })
    ).to.equal(nonSubsidized);
  });

  it('ranks LI.FI hybrid quotes by expected net profit with path-order tie break', () => {
    const oneInch = quoteEvaluation({
      externalTakePath: 'calldata_aggregator',
      selectedLiquiditySource: LiquiditySource.ONEINCH,
      quoteAmountRaw: BigNumber.from(130),
      routeProfitability: {
        expectedNetProfitQuoteRaw: BigNumber.from(10),
        expectedSubsidyQuoteRaw: BigNumber.from(0),
        subsidyAllowed: false,
      },
    });
    const lifi = quoteEvaluation({
      externalTakePath: 'calldata_aggregator',
      selectedLiquiditySource: LiquiditySource.LIFI,
      quoteAmountRaw: BigNumber.from(135),
      routeProfitability: {
        expectedNetProfitQuoteRaw: BigNumber.from(15),
        expectedSubsidyQuoteRaw: BigNumber.from(0),
        subsidyAllowed: false,
      },
    });
    const factoryTie = quoteEvaluation({
      externalTakePath: 'direct_dex',
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
        externalTakePaths: ['calldata_aggregator', 'direct_dex'],
      })
    ).to.equal(lifi);
  });

  it('chooses the smallest subsidy among subsidized hybrid external take quotes', () => {
    const smallerSubsidy = quoteEvaluation({
      externalTakePath: 'direct_dex',
      selectedLiquiditySource: LiquiditySource.SUSHISWAP,
      quoteAmountRaw: BigNumber.from(130),
      routeProfitability: {
        expectedNetProfitQuoteRaw: BigNumber.from(15),
        expectedSubsidyQuoteRaw: BigNumber.from(2),
        subsidyAllowed: true,
      },
    });
    const largerSubsidy = quoteEvaluation({
      externalTakePath: 'calldata_aggregator',
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
        externalTakePaths: ['calldata_aggregator', 'direct_dex'],
      })
    ).to.equal(smallerSubsidy);
  });
});
