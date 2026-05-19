import { expect } from 'chai';
import {
  parseOptions,
  requireUniswapRouteShape,
  resolveUniswapV3SeedFeeTiers,
  type UniswapV3FeeTierQuoteCheck,
  type UniswapV3RouterConfig,
} from '../../scripts/create-liquidatable-ajna-fixture';

const ROUTER_CONFIG: UniswapV3RouterConfig = {
  universalRouterAddress: '0x0000000000000000000000000000000000000001',
  permit2Address: '0x0000000000000000000000000000000000000002',
  poolFactoryAddress: '0x0000000000000000000000000000000000000003',
  quoterV2Address: '0x0000000000000000000000000000000000000004',
  wethAddress: '0x0000000000000000000000000000000000000005',
  positionManagerAddress: '0x0000000000000000000000000000000000000006',
  defaultFeeTier: 3000,
  candidateFeeTiers: [3000, 500, 10000],
  defaultSlippage: 1,
};

function quoteCheck(params: {
  pair: 'collateral_quote' | 'weth_quote';
  feeTier: number;
  quoteSuccess: boolean;
}): UniswapV3FeeTierQuoteCheck {
  return {
    pair: params.pair,
    tokenIn: '0x0000000000000000000000000000000000000010',
    tokenOut: '0x0000000000000000000000000000000000000020',
    amountInRaw: '1000000000000000000',
    feeTier: params.feeTier,
    poolExists: true,
    quoteSuccess: params.quoteSuccess,
    amountOutRaw: params.quoteSuccess ? '1000000' : undefined,
    reason: params.quoteSuccess ? undefined : 'quote reverted',
  };
}

describe('create-liquidatable-ajna-fixture helpers', () => {
  const envSnapshot = { ...process.env };

  beforeEach(() => {
    process.env = { ...envSnapshot };
    delete process.env.AJNA_AGENT_ENABLE_UNISWAP_V3_EXTERNAL_TAKE;
    delete process.env.AJNA_AGENT_UNISWAP_LIQUIDITY_MODE;
    delete process.env.AJNA_AGENT_UNISWAP_FEE_TIER_TEST_MODE;
    delete process.env.AJNA_AGENT_UNISWAP_EXPECTED_EXECUTION_FEE_TIER;
  });

  after(() => {
    process.env = envSnapshot;
  });

  it('parses explicit strict-hybrid and fallback-regression liquidity modes', () => {
    const strictOptions = parseOptions([
      '--with-uniswap-v3-external-take',
      '--uniswap-liquidity-mode',
      'strict_hybrid',
    ]);
    const fallbackOptions = parseOptions([
      '--with-uniswap-v3-external-take',
      '--uniswap-liquidity-mode',
      'fallback_regression',
    ]);

    expect(strictOptions.withUniswapV3ExternalTake).to.equal(true);
    expect(strictOptions.uniswapV3LiquidityMode).to.equal('strict_hybrid');
    expect(fallbackOptions.uniswapV3LiquidityMode).to.equal(
      'fallback_regression'
    );
  });

  it('keeps best-tier selection reserved until per-tier liquidity profiles exist', () => {
    expect(() =>
      resolveUniswapV3SeedFeeTiers({
        routerConfig: ROUTER_CONFIG,
        feeTierTestMode: 'best_tier_selection',
      })
    ).to.throw('best_tier_selection is reserved');
  });

  it('selects explicit fee tiers for default-only and single-non-default fixture coverage', () => {
    expect(
      resolveUniswapV3SeedFeeTiers({
        routerConfig: ROUTER_CONFIG,
        feeTierTestMode: 'default_only',
      })
    ).to.deep.equal([3000]);

    expect(
      resolveUniswapV3SeedFeeTiers({
        routerConfig: ROUTER_CONFIG,
        feeTierTestMode: 'single_non_default',
        expectedExecutionFeeTier: 500,
      })
    ).to.deep.equal([500]);
  });

  it('rejects ambiguous single-non-default fee-tier fixtures', () => {
    expect(() =>
      resolveUniswapV3SeedFeeTiers({
        routerConfig: {
          ...ROUTER_CONFIG,
          candidateFeeTiers: [3000],
        },
        feeTierTestMode: 'single_non_default',
      })
    ).to.throw('requires at least one configured non-default fee tier');

    expect(() =>
      resolveUniswapV3SeedFeeTiers({
        routerConfig: ROUTER_CONFIG,
        feeTierTestMode: 'single_non_default',
        expectedExecutionFeeTier: 3000,
      })
    ).to.throw('must not equal the default fee tier');
  });

  it('requires collateral/quote and WETH/quote quotes for strict-hybrid final-kick handoff', () => {
    const summary = requireUniswapRouteShape({
      liquidityMode: 'strict_hybrid',
      feeTierTestMode: 'all_configured',
      seededCollateralQuoteFeeTiers: [500],
      collateralQuoteFeeTierChecks: [
        quoteCheck({
          pair: 'collateral_quote',
          feeTier: 500,
          quoteSuccess: true,
        }),
      ],
      wethQuoteFeeTierChecks: [
        quoteCheck({ pair: 'weth_quote', feeTier: 500, quoteSuccess: true }),
      ],
    });

    expect(summary).to.deep.include({
      status: 'passed',
      liquidityMode: 'strict_hybrid',
      strictHybridGasQuoteReady: true,
      fallbackRegressionGasQuoteOmitted: false,
    });

    expect(() =>
      requireUniswapRouteShape({
        liquidityMode: 'strict_hybrid',
        feeTierTestMode: 'all_configured',
        seededCollateralQuoteFeeTiers: [500],
        collateralQuoteFeeTierChecks: [
          quoteCheck({
            pair: 'collateral_quote',
            feeTier: 500,
            quoteSuccess: true,
          }),
        ],
        wethQuoteFeeTierChecks: [
          quoteCheck({ pair: 'weth_quote', feeTier: 500, quoteSuccess: false }),
        ],
      })
    ).to.throw('strict_hybrid Uniswap route-shape verification failed');
  });

  it('requires WETH/quote to remain unquoted for fallback-regression handoff', () => {
    const summary = requireUniswapRouteShape({
      liquidityMode: 'fallback_regression',
      feeTierTestMode: 'all_configured',
      seededCollateralQuoteFeeTiers: [500],
      collateralQuoteFeeTierChecks: [
        quoteCheck({
          pair: 'collateral_quote',
          feeTier: 500,
          quoteSuccess: true,
        }),
      ],
      wethQuoteFeeTierChecks: [
        quoteCheck({ pair: 'weth_quote', feeTier: 500, quoteSuccess: false }),
      ],
    });

    expect(summary).to.deep.include({
      status: 'passed',
      liquidityMode: 'fallback_regression',
      strictHybridGasQuoteReady: false,
      fallbackRegressionGasQuoteOmitted: true,
    });

    expect(() =>
      requireUniswapRouteShape({
        liquidityMode: 'fallback_regression',
        feeTierTestMode: 'all_configured',
        seededCollateralQuoteFeeTiers: [500],
        collateralQuoteFeeTierChecks: [
          quoteCheck({
            pair: 'collateral_quote',
            feeTier: 500,
            quoteSuccess: true,
          }),
        ],
        wethQuoteFeeTierChecks: [
          quoteCheck({ pair: 'weth_quote', feeTier: 500, quoteSuccess: true }),
        ],
      })
    ).to.throw('fallback_regression Uniswap route-shape verification failed');
  });

  it('fails route-shape verification when the expected execution tier does not quote', () => {
    expect(() =>
      requireUniswapRouteShape({
        liquidityMode: 'strict_hybrid',
        feeTierTestMode: 'single_non_default',
        seededCollateralQuoteFeeTiers: [500],
        expectedExecutionFeeTier: 500,
        collateralQuoteFeeTierChecks: [
          quoteCheck({
            pair: 'collateral_quote',
            feeTier: 500,
            quoteSuccess: false,
          }),
        ],
        wethQuoteFeeTierChecks: [
          quoteCheck({ pair: 'weth_quote', feeTier: 500, quoteSuccess: true }),
        ],
      })
    ).to.throw('expected collateral/quote fee tier 500 did not quote');
  });
});
