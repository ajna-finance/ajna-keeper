import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, Signer, ethers } from 'ethers';
import { FungiblePool } from '@ajna-finance/sdk';
import { LiquiditySource } from '../../src/config';
import { DexRouter } from '../../src/dex/router';
import { getOneInchPathQuoteEvaluation } from '../../src/take/one-inch-execution';
import { TakeActionConfig } from '../../src/take/types';

const CHAIN_ID = 1;
const COLLATERAL_ADDRESS = '0x1111111111111111111111111111111111111111';
const QUOTE_ADDRESS = '0x2222222222222222222222222222222222222222';
const ROUTER_ADDRESS = '0x3333333333333333333333333333333333333333';

function makeTokenDecimalsCache(): Map<string, number> {
  return new Map([
    [`${CHAIN_ID}:${COLLATERAL_ADDRESS.toLowerCase()}`, 18],
    [`${CHAIN_ID}:${QUOTE_ADDRESS.toLowerCase()}`, 6],
  ]);
}

async function quoteWithSlippage(
  oneInchDefaultSlippage?: number
): Promise<BigNumber | undefined> {
  sinon.stub(DexRouter.prototype, 'getQuoteFromOneInch').resolves({
    success: true,
    dstAmount: ethers.utils.parseUnits('120', 6).toString(),
  });

  const pool = {
    name: '1inch Slippage Pool',
    poolAddress: '0x4444444444444444444444444444444444444444',
    collateralAddress: COLLATERAL_ADDRESS,
    quoteAddress: QUOTE_ADDRESS,
  } as unknown as FungiblePool;
  const signer = {
    getChainId: async () => CHAIN_ID,
    provider: {},
  } as unknown as Signer;
  const poolConfig: TakeActionConfig = {
    take: {
      liquiditySource: LiquiditySource.ONEINCH,
      marketPriceFactor: 0.99,
    },
  };

  const evaluation = await getOneInchPathQuoteEvaluation(
    pool,
    100,
    ethers.utils.parseEther('1'),
    poolConfig,
    {
      chainId: CHAIN_ID,
      oneInchDefaultSlippage,
      skipOneInchRateLimitDelay: true,
      tokenDecimalsCache: makeTokenDecimalsCache(),
    },
    signer,
    { [CHAIN_ID]: ROUTER_ADDRESS },
    undefined,
    ethers.utils.parseEther('100')
  );

  expect(evaluation.isTakeable).to.equal(true);
  return evaluation.routeMinOutRaw;
}

describe('1inch external take slippage', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('keeps the historical 1% min-out floor when oneInchDefaultSlippage is unset', async () => {
    const routeMinOutRaw = await quoteWithSlippage();

    expect(routeMinOutRaw?.eq(ethers.utils.parseUnits('118.8', 6))).to.equal(
      true
    );
  });

  it('uses oneInchDefaultSlippage for the 1inch route min-out floor', async () => {
    const routeMinOutRaw = await quoteWithSlippage(2.5);

    expect(routeMinOutRaw?.eq(ethers.utils.parseUnits('117', 6))).to.equal(
      true
    );
  });

  it('caches successful configured chain-id checks for the same signer/provider', async () => {
    const quoteStub = sinon
      .stub(DexRouter.prototype, 'getQuoteFromOneInch')
      .resolves({
        success: true,
        dstAmount: ethers.utils.parseUnits('120', 6).toString(),
      });
    const pool = {
      name: '1inch Chain Cache Pool',
      poolAddress: '0x4444444444444444444444444444444444444444',
      collateralAddress: COLLATERAL_ADDRESS,
      quoteAddress: QUOTE_ADDRESS,
    } as unknown as FungiblePool;
    const getChainId = sinon.stub().resolves(CHAIN_ID);
    const signer = {
      getChainId,
      provider: {},
    } as unknown as Signer;
    const poolConfig: TakeActionConfig = {
      take: {
        liquiditySource: LiquiditySource.ONEINCH,
        marketPriceFactor: 0.99,
      },
    };
    const config = {
      chainId: CHAIN_ID,
      skipOneInchRateLimitDelay: true,
      tokenDecimalsCache: makeTokenDecimalsCache(),
    };

    await getOneInchPathQuoteEvaluation(
      pool,
      100,
      ethers.utils.parseEther('1'),
      poolConfig,
      config,
      signer,
      { [CHAIN_ID]: ROUTER_ADDRESS },
      undefined,
      ethers.utils.parseEther('100')
    );
    await getOneInchPathQuoteEvaluation(
      pool,
      100,
      ethers.utils.parseEther('1'),
      poolConfig,
      config,
      signer,
      { [CHAIN_ID]: ROUTER_ADDRESS },
      undefined,
      ethers.utils.parseEther('100')
    );

    expect(getChainId.calledOnce).to.equal(true);
    expect(quoteStub.calledTwice).to.equal(true);
  });
});
