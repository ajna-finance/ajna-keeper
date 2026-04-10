import { expect } from 'chai';
import sinon from 'sinon';
import { ethers } from 'ethers';
import * as erc20 from '../erc20';
import subgraph from '../subgraph';
import { LiquiditySource } from '../config-types';
import { arbTakeLiquidation, checkIfArbTakeable } from '../arb-take';
import * as transactions from '../transactions';

describe('shared arbTake helpers', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('returns the expected arbTake evaluation', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(18);
    sinon.stub(subgraph, 'getHighestMeaningfulBucket').resolves({
      buckets: [{ bucketIndex: 321 }],
    } as any);

    const pool = {
      name: 'Test Pool',
      poolAddress: '0x1111111111111111111111111111111111111111',
      collateralAddress: '0x2222222222222222222222222222222222222222',
      getBucketByIndex: sinon.stub().withArgs(321).returns({
        price: ethers.utils.parseEther('10'),
      }),
    };

    const poolConfig = {
      name: 'Test Pool',
      take: {
        minCollateral: 1,
        hpbPriceFactor: 0.9,
        liquiditySource: LiquiditySource.UNISWAPV3,
      },
    };

    const args = [
      pool as any,
      8,
      ethers.utils.parseEther('2'),
      poolConfig as any,
      'http://test-subgraph',
      undefined,
      '0.1',
      {} as any,
    ] as const;

    const result = await checkIfArbTakeable(...args);

    expect(result.isArbTakeable).to.be.true;
    expect(result.hpbIndex).to.equal(321);
    expect(result.maxArbTakePrice).to.equal(9);
  });

  it('supports custom labels without changing arbTake execution', async () => {
    const liquidationSdk = { kind: 'liquidation-sdk' };
    const liquidationArbTakeStub = sinon
      .stub(transactions, 'liquidationArbTake')
      .resolves();

    const pool = {
      name: 'Execution Pool',
      poolAddress: '0x3333333333333333333333333333333333333333',
      getLiquidation: sinon.stub().withArgs('0xBorrower').returns(liquidationSdk),
    };

    const liquidation = {
      borrower: '0xBorrower',
      hpbIndex: 77,
      collateral: ethers.utils.parseEther('1'),
      auctionPrice: ethers.utils.parseEther('1'),
      isTakeable: false,
      isArbTakeable: true,
    };

    await arbTakeLiquidation({
      pool: pool as any,
      signer: {} as any,
      liquidation,
      config: { dryRun: false },
    });

    await arbTakeLiquidation({
      pool: pool as any,
      signer: {} as any,
      liquidation,
      config: { dryRun: false },
      actionLabel: 'Factory ArbTake',
      logPrefix: 'Factory: ',
    });

    expect(liquidationArbTakeStub.callCount).to.equal(2);
    expect(liquidationArbTakeStub.firstCall.args).to.deep.equal([
      liquidationSdk,
      {},
      77,
    ]);
    expect(liquidationArbTakeStub.secondCall.args).to.deep.equal([
      liquidationSdk,
      {},
      77,
    ]);
  });
});
