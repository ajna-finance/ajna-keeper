import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, ethers } from 'ethers';
import { LiquiditySource } from '../config';
import * as erc20 from '../erc20';
import * as oneInch from '../1inch';
import { NonceTracker } from '../nonce';
import { takeLiquidation } from '../take';
import { DexRouter } from '../dex-router';
import { executeUniswapV3FactoryTake } from '../take/factory/uniswap';
import * as shared from '../take/factory/shared';
import {
  AjnaKeeperTaker__factory,
  AjnaKeeperTakerFactory__factory,
} from '../../typechain-types';

describe('take write submission', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('uses the configured take write transport for legacy 1inch take submission', async () => {
    const readSigner = {
      getChainId: sinon.stub().resolves(1),
    };
    const writeSigner = {
      getAddress: sinon.stub().resolves('0x00000000000000000000000000000000000000aa'),
      getTransactionCount: sinon.stub().resolves(0),
    };
    const takeWriteTransport = {
      mode: 'private_rpc',
      signer: writeSigner,
      submitTransaction: sinon.stub().resolves({
        txHash: '0xhash',
        wait: sinon.stub().resolves({ transactionHash: '0xhash' }),
      }),
    };
    const estimateGasStub = sinon.stub().resolves(BigNumber.from(100_000));
    const populateTransactionStub = sinon.stub().resolves({
      to: '0x00000000000000000000000000000000000000dd',
      data: '0x1234',
    });
    const keeperTaker = {
      address: '0x00000000000000000000000000000000000000bb',
      estimateGas: {
        takeWithAtomicSwap: estimateGasStub,
      },
      populateTransaction: {
        takeWithAtomicSwap: populateTransactionStub,
      },
    };

    sinon
      .stub(AjnaKeeperTaker__factory, 'connect')
      .returns(keeperTaker as any);
    sinon
      .stub(DexRouter.prototype, 'getSwapDataFromOneInch')
      .resolves({ data: '0xdeadbeef' } as any);
    sinon
      .stub(DexRouter.prototype, 'getRouter')
      .returns('0x00000000000000000000000000000000000000cc');
    sinon.stub(oneInch, 'convertSwapApiResponseToDetailsBytes').returns('0x1234');
    sinon.stub(erc20, 'getDecimalsErc20').resolves(18);
    const queueTransactionStub = sinon
      .stub(NonceTracker, 'queueTransaction')
      .callsFake(async (signer, txFunction) => {
        expect(signer).to.equal(writeSigner);
        return await txFunction(7);
      });

    await takeLiquidation({
      pool: {
        name: 'Legacy Take Pool',
        poolAddress: '0x0000000000000000000000000000000000000001',
        collateralAddress: '0x0000000000000000000000000000000000000002',
        quoteAddress: '0x0000000000000000000000000000000000000003',
      } as any,
      poolConfig: {
        name: 'Legacy Take Pool',
        take: {
          liquiditySource: LiquiditySource.ONEINCH,
          marketPriceFactor: 0.95,
        },
      },
      signer: readSigner as any,
      liquidation: {
        borrower: '0xBorrower',
        hpbIndex: 0,
        collateral: ethers.utils.parseEther('1'),
        auctionPrice: ethers.utils.parseEther('1'),
        isTakeable: true,
        isArbTakeable: false,
      },
      config: {
        dryRun: false,
        delayBetweenActions: 0,
        connectorTokens: [],
        oneInchRouters: {
          1: '0x00000000000000000000000000000000000000cc',
        },
        keeperTaker: '0x00000000000000000000000000000000000000dd',
        takeWriteTransport: takeWriteTransport as any,
      },
    });

    expect(
      (AjnaKeeperTaker__factory.connect as sinon.SinonStub).calledOnceWithExactly(
        '0x00000000000000000000000000000000000000dd',
        writeSigner
      )
    ).to.be.true;
    expect(queueTransactionStub.calledOnce).to.be.true;
    expect(takeWriteTransport.submitTransaction.calledOnce).to.be.true;
  });

  it('uses the configured take write transport for Uniswap factory take submission', async () => {
    const readSigner = {};
    const writeSigner = {
      getAddress: sinon.stub().resolves('0x00000000000000000000000000000000000000ee'),
      getTransactionCount: sinon.stub().resolves(0),
      provider: {
        getBlock: sinon.stub().resolves({ timestamp: 123 }),
      },
    };
    const takeWriteTransport = {
      mode: 'private_rpc',
      signer: writeSigner,
      submitTransaction: sinon.stub().resolves({
        txHash: '0xfactoryhash',
        wait: sinon.stub().resolves({ transactionHash: '0xfactoryhash' }),
      }),
    };
    const estimateGasStub = sinon.stub().resolves(BigNumber.from(120_000));
    const populateTransactionStub = sinon.stub().resolves({
      to: '0x0000000000000000000000000000000000000013',
      data: '0x5678',
    });
    const factory = {
      estimateGas: {
        takeWithAtomicSwap: estimateGasStub,
      },
      populateTransaction: {
        takeWithAtomicSwap: populateTransactionStub,
      },
    };

    sinon
      .stub(AjnaKeeperTakerFactory__factory, 'connect')
      .returns(factory as any);
    sinon
      .stub(shared, 'computeFactoryAmountOutMinimum')
      .resolves(BigNumber.from(10));
    sinon.stub(shared, 'getSwapDeadline').callsFake(async (signer) => {
      expect(signer).to.equal(writeSigner);
      return 456;
    });
    const queueTransactionStub = sinon
      .stub(NonceTracker, 'queueTransaction')
      .callsFake(async (signer, txFunction) => {
        expect(signer).to.equal(writeSigner);
        return await txFunction(3);
      });

    await executeUniswapV3FactoryTake({
      pool: {
        name: 'Factory Take Pool',
        poolAddress: '0x0000000000000000000000000000000000000011',
        quoteAddress: '0x0000000000000000000000000000000000000012',
      } as any,
      poolConfig: {
        name: 'Factory Take Pool',
        take: {
          liquiditySource: LiquiditySource.UNISWAPV3,
          marketPriceFactor: 0.95,
        },
      },
      signer: readSigner as any,
      liquidation: {
        borrower: '0xBorrower',
        hpbIndex: 0,
        collateral: ethers.utils.parseEther('1'),
        auctionPrice: ethers.utils.parseEther('1'),
        isTakeable: true,
        isArbTakeable: false,
      },
      quoteEvaluation: {
        isTakeable: true,
        quoteAmountRaw: BigNumber.from(11),
      },
      config: {
        keeperTakerFactory: '0x0000000000000000000000000000000000000013',
        universalRouterOverrides: {
          universalRouterAddress: '0x0000000000000000000000000000000000000014',
          permit2Address: '0x0000000000000000000000000000000000000015',
          defaultFeeTier: 3000,
        },
        takeWriteTransport: takeWriteTransport as any,
      },
    });

    expect(
      (AjnaKeeperTakerFactory__factory.connect as sinon.SinonStub).calledOnceWithExactly(
        '0x0000000000000000000000000000000000000013',
        writeSigner
      )
    ).to.be.true;
    expect(queueTransactionStub.calledOnce).to.be.true;
    expect(takeWriteTransport.submitTransaction.calledOnce).to.be.true;
  });
});
