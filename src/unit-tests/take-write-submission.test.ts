import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, ethers } from 'ethers';
import { LiquiditySource } from '../config';
import * as erc20 from '../erc20';
import * as oneInch from '../dex/one-inch';
import { NonceTracker } from '../nonce';
import { takeLiquidation } from '../take';
import { takeLiquidationFactory } from '../take/factory';
import { DexRouter } from '../dex/router';
import { executeUniswapV3FactoryTake } from '../take/factory/uniswap';
import { executeCurveFactoryTake } from '../take/factory/curve';
import { CurveQuoteProvider } from '../dex/providers/curve-quote-provider';
import { CurvePoolType } from '../config';
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
      getAddress: sinon
        .stub()
        .resolves('0x00000000000000000000000000000000000000aa'),
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

    sinon.stub(AjnaKeeperTaker__factory, 'connect').returns(keeperTaker as any);
    sinon
      .stub(DexRouter.prototype, 'getSwapDataFromOneInch')
      .resolves({ data: '0xdeadbeef' } as any);
    sinon
      .stub(DexRouter.prototype, 'getRouter')
      .returns('0x00000000000000000000000000000000000000cc');
    sinon.stub(oneInch, 'convertSwapApiResponseToDetails').returns({
      aggregationExecutor: '0x00000000000000000000000000000000000000ce',
      swapDescription: {
        srcToken: '0x0000000000000000000000000000000000000002',
        dstToken: '0x0000000000000000000000000000000000000003',
        srcReceiver: '0x0000000000000000000000000000000000000000',
        dstReceiver: '0x00000000000000000000000000000000000000bb',
        amount: ethers.utils.parseEther('1'),
        minReturnAmount: BigNumber.from(1),
        flags: BigNumber.from(0),
      },
      opaqueData: '0x1234',
    } as any);
    sinon.stub(shared, 'getQuoteAmountDueRaw').resolves(BigNumber.from(10));
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
        externalTakeQuoteEvaluation: {
          isTakeable: true,
          quoteAmountRaw: BigNumber.from(11),
        },
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
      (
        AjnaKeeperTaker__factory.connect as sinon.SinonStub
      ).calledOnceWithExactly(
        '0x00000000000000000000000000000000000000dd',
        readSigner
      )
    ).to.be.true;
    expect(queueTransactionStub.calledOnce).to.be.true;
    expect(takeWriteTransport.submitTransaction.calledOnce).to.be.true;
  });

  it('raises the legacy 1inch minReturnAmount to the approved execution floor', async () => {
    const readSigner = {
      getChainId: sinon.stub().resolves(1),
    };
    const writeSigner = {
      getAddress: sinon
        .stub()
        .resolves('0x00000000000000000000000000000000000000aa'),
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

    sinon.stub(AjnaKeeperTaker__factory, 'connect').returns(keeperTaker as any);
    sinon
      .stub(DexRouter.prototype, 'getSwapDataFromOneInch')
      .resolves({ data: '0xdeadbeef' } as any);
    sinon
      .stub(DexRouter.prototype, 'getRouter')
      .returns('0x00000000000000000000000000000000000000cc');
    sinon.stub(oneInch, 'convertSwapApiResponseToDetails').returns({
      aggregationExecutor: '0x00000000000000000000000000000000000000ce',
      swapDescription: {
        srcToken: '0x0000000000000000000000000000000000000002',
        dstToken: '0x0000000000000000000000000000000000000003',
        srcReceiver: '0x0000000000000000000000000000000000000000',
        dstReceiver: '0x00000000000000000000000000000000000000bb',
        amount: ethers.utils.parseEther('1'),
        minReturnAmount: BigNumber.from(900),
        flags: BigNumber.from(0),
      },
      opaqueData: '0x1234',
    } as any);
    sinon.stub(shared, 'getQuoteAmountDueRaw').resolves(BigNumber.from(950));
    sinon.stub(erc20, 'getDecimalsErc20').resolves(18);
    sinon
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
        externalTakeQuoteEvaluation: {
          isTakeable: true,
          quoteAmountRaw: BigNumber.from(1000),
          approvedMinOutRaw: BigNumber.from(1100),
        },
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

    const encodedDetails = populateTransactionStub.firstCall.args[6];
    const decoded = ethers.utils.defaultAbiCoder.decode(
      [
        '(address,(address,address,address,address,uint256,uint256,uint256),bytes)',
      ],
      encodedDetails
    );
    expect(decoded[0][1][5].toString()).to.equal('1100');
  });

  it('uses the configured take write transport for Curve factory take submission without reselecting the pool', async () => {
    const clock = sinon.useFakeTimers();
    const readSigner = {};
    const writeSigner = {
      getAddress: sinon
        .stub()
        .resolves('0x00000000000000000000000000000000000000ef'),
      getTransactionCount: sinon.stub().resolves(0),
      provider: {
        getBlock: sinon.stub().resolves({ timestamp: 123 }),
      },
    };
    const takeWriteTransport = {
      mode: 'private_rpc',
      signer: writeSigner,
      submitTransaction: sinon.stub().resolves({
        txHash: '0xcurvehash',
        wait: sinon.stub().resolves({ transactionHash: '0xcurvehash' }),
      }),
    };
    const estimateGasStub = sinon.stub().resolves(BigNumber.from(120_000));
    const populateTransactionStub = sinon.stub().resolves({
      to: '0x0000000000000000000000000000000000000013',
      data: '0x9876',
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
      expect(signer).to.equal(readSigner);
      return 456;
    });
    const queueTransactionStub = sinon
      .stub(NonceTracker, 'queueTransaction')
      .callsFake(async (signer, txFunction) => {
        expect(signer).to.equal(writeSigner);
        return await txFunction(3);
      });
    const initializeStub = sinon.stub(
      CurveQuoteProvider.prototype,
      'initialize'
    );
    const resolvePoolSelectionStub = sinon.stub(
      CurveQuoteProvider.prototype,
      'resolvePoolSelection'
    );

    const curveTakePromise = executeCurveFactoryTake({
      pool: {
        name: 'Factory Curve Pool',
        poolAddress: '0x0000000000000000000000000000000000000011',
        collateralAddress: '0x00000000000000000000000000000000000000c1',
        quoteAddress: '0x00000000000000000000000000000000000000c2',
      } as any,
      poolConfig: {
        name: 'Factory Curve Pool',
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
        approvedMinOutRaw: BigNumber.from(10),
        selectedLiquiditySource: LiquiditySource.CURVE,
        curvePool: {
          address: '0x00000000000000000000000000000000000000c3',
          poolType: CurvePoolType.STABLE,
          tokenInIndex: 1,
          tokenOutIndex: 0,
        },
      },
      config: {
        keeperTakerFactory: '0x0000000000000000000000000000000000000013',
        curveRouterOverrides: {
          poolConfigs: {
            'mismatched-key': {
              address: '0x00000000000000000000000000000000000000ff',
              poolType: CurvePoolType.CRYPTO,
            },
          },
          wethAddress: '0x00000000000000000000000000000000000000aa',
        },
        tokenAddresses: {},
        takeWriteTransport: takeWriteTransport as any,
      },
    });
    await clock.tickAsync(2000);
    await curveTakePromise;
    clock.restore();

    expect(initializeStub.called).to.be.false;
    expect(resolvePoolSelectionStub.called).to.be.false;
    expect(queueTransactionStub.calledOnce).to.be.true;
    expect(takeWriteTransport.submitTransaction.calledOnce).to.be.true;
    const takeArgs = populateTransactionStub.firstCall.args;
    expect(takeArgs[4]).to.equal(Number(LiquiditySource.CURVE));
    expect(takeArgs[5].toLowerCase()).to.equal(
      '0x00000000000000000000000000000000000000c3'
    );
    const decoded = ethers.utils.defaultAbiCoder.decode(
      ['address', 'uint8', 'uint8', 'uint8', 'uint256', 'uint256'],
      takeArgs[6]
    );
    expect(decoded[0].toLowerCase()).to.equal(
      '0x00000000000000000000000000000000000000c3'
    );
    expect(decoded[1]).to.equal(0);
    expect(decoded[2]).to.equal(1);
    expect(decoded[3]).to.equal(0);
  });

  it('refuses factory execution when an approved quote is missing route-binding fields', async () => {
    const connectStub = sinon.stub(AjnaKeeperTakerFactory__factory, 'connect');
    const basePool = {
      name: 'Factory Take Pool',
      poolAddress: '0x0000000000000000000000000000000000000011',
      collateralAddress: '0x0000000000000000000000000000000000000012',
      quoteAddress: '0x0000000000000000000000000000000000000013',
    } as any;
    const basePoolConfig = {
      name: 'Factory Take Pool',
      take: {
        liquiditySource: LiquiditySource.UNISWAPV3,
        marketPriceFactor: 0.95,
      },
    };
    const baseLiquidation = {
      borrower: '0xBorrower',
      hpbIndex: 0,
      collateral: ethers.utils.parseEther('1'),
      auctionPrice: ethers.utils.parseEther('1'),
      isTakeable: true,
      isArbTakeable: false,
    };

    const cases = [
      {
        label: 'selected liquidity source',
        quoteEvaluation: {
          isTakeable: true,
          quoteAmountRaw: BigNumber.from(11),
          approvedMinOutRaw: BigNumber.from(10),
          selectedFeeTier: 3000,
        },
      },
      {
        label: 'approved min-out',
        quoteEvaluation: {
          isTakeable: true,
          quoteAmountRaw: BigNumber.from(11),
          selectedLiquiditySource: LiquiditySource.UNISWAPV3,
          selectedFeeTier: 3000,
        },
      },
      {
        label: 'selected fee tier',
        quoteEvaluation: {
          isTakeable: true,
          quoteAmountRaw: BigNumber.from(11),
          approvedMinOutRaw: BigNumber.from(10),
          selectedLiquiditySource: LiquiditySource.UNISWAPV3,
        },
      },
    ];

    for (const { label, quoteEvaluation } of cases) {
      const result = await takeLiquidationFactory({
        pool: basePool,
        poolConfig: basePoolConfig,
        signer: {} as any,
        liquidation: {
          ...baseLiquidation,
          externalTakeQuoteEvaluation: quoteEvaluation,
        },
        config: {
          dryRun: false,
          keeperTakerFactory: '0x0000000000000000000000000000000000000014',
        },
      });
      expect(result, label).to.equal(false);
    }

    expect(connectStub.called).to.be.false;
  });

  it('validates factory dry-run quotes before reporting a would-take action', async () => {
    const connectStub = sinon.stub(AjnaKeeperTakerFactory__factory, 'connect');

    const result = await takeLiquidationFactory({
      pool: {
        name: 'Factory Take Pool',
        poolAddress: '0x0000000000000000000000000000000000000011',
        collateralAddress: '0x0000000000000000000000000000000000000012',
        quoteAddress: '0x0000000000000000000000000000000000000013',
      } as any,
      poolConfig: {
        name: 'Factory Take Pool',
        take: {
          liquiditySource: LiquiditySource.UNISWAPV3,
          marketPriceFactor: 0.95,
        },
      },
      signer: {} as any,
      liquidation: {
        borrower: '0xBorrower',
        hpbIndex: 0,
        collateral: ethers.utils.parseEther('1'),
        auctionPrice: ethers.utils.parseEther('1'),
        isTakeable: true,
        isArbTakeable: false,
        externalTakeQuoteEvaluation: {
          isTakeable: true,
          quoteAmountRaw: BigNumber.from(11),
          selectedLiquiditySource: LiquiditySource.UNISWAPV3,
          selectedFeeTier: 3000,
        },
      },
      config: {
        dryRun: true,
      },
    });

    expect(result).to.equal(false);
    expect(connectStub.called).to.be.false;
  });

  it('uses the configured take write transport for Uniswap factory take submission', async () => {
    const readSigner = {};
    const writeSigner = {
      getAddress: sinon
        .stub()
        .resolves('0x00000000000000000000000000000000000000ee'),
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
      expect(signer).to.equal(readSigner);
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
        approvedMinOutRaw: BigNumber.from(10),
        selectedLiquiditySource: LiquiditySource.UNISWAPV3,
        selectedFeeTier: 3000,
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
      (
        AjnaKeeperTakerFactory__factory.connect as sinon.SinonStub
      ).calledOnceWithExactly(
        '0x0000000000000000000000000000000000000013',
        readSigner
      )
    ).to.be.true;
    expect(queueTransactionStub.calledOnce).to.be.true;
    expect(takeWriteTransport.submitTransaction.calledOnce).to.be.true;
  });
});
