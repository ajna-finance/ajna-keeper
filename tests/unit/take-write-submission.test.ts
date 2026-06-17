import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, ethers } from 'ethers';
import { LiquiditySource } from '../../src/config';
import * as erc20 from '../../src/erc20';
import * as oneInch from '../../src/dex/one-inch';
import { NonceConsumedTransactionError, NonceTracker } from '../../src/nonce';
import { takeLiquidationDirectDex } from '../../src/take/direct-dex';
import { executeUniswapV3DirectDexTake } from '../../src/take/direct-dex/uniswap';
import { executeCurveDirectDexTake } from '../../src/take/direct-dex/curve';
import { CurveQuoteProvider } from '../../src/dex/providers/curve-quote-provider';
import { CurvePoolType } from '../../src/config';
import * as shared from '../../src/take/direct-dex/route-selection';
import {
  BoundExternalTakeRouteEvaluation,
  ExternalTakeQuoteEvaluation,
} from '../../src/take/types';
import { TakerRouter__factory } from '../../typechain-types';
import { singleExternalTakeExecutionPlan } from '../helpers/external-take-plan';

function malformedBoundRoute(
  quoteEvaluation: ExternalTakeQuoteEvaluation
): BoundExternalTakeRouteEvaluation {
  return quoteEvaluation as unknown as BoundExternalTakeRouteEvaluation;
}

describe('take write submission', () => {
  afterEach(() => {
    sinon.restore();
  });

  async function runUniswapDirectDexSubmissionBoundaryScenario(params: {
    submitTransaction: sinon.SinonStub;
    onDirectDexExecutionFailure: sinon.SinonSpy;
  }) {
    const readSigner = {
      provider: {
        getBlock: sinon.stub().resolves({ timestamp: 123 }),
      },
    };
    const writeSigner = {
      getAddress: sinon
        .stub()
        .resolves('0x00000000000000000000000000000000000000ee'),
      getTransactionCount: sinon.stub().resolves(0),
    };
    const takeWriteTransport = {
      mode: 'private_rpc',
      signer: writeSigner,
      submitTransaction: params.submitTransaction,
    };
    const estimateGasStub = sinon.stub().resolves(BigNumber.from(120_000));
    const populateTransactionStub = sinon.stub().resolves({
      to: '0x0000000000000000000000000000000000000013',
      data: '0x5678',
    });
    sinon.stub(TakerRouter__factory, 'connect').returns({
      estimateGas: {
        takeWithAtomicSwap: estimateGasStub,
      },
      populateTransaction: {
        takeWithAtomicSwap: populateTransactionStub,
      },
    } as any);
    sinon
      .stub(shared, 'computeDirectDexAmountOutMinimum')
      .resolves(BigNumber.from(10));
    sinon.stub(NonceTracker, 'queueTransaction').callsFake(async (_, txFn) => {
      return await txFn(3);
    });

    let thrown: unknown;
    try {
      await executeUniswapV3DirectDexTake({
        pool: {
          name: 'Direct DEX Boundary Pool',
          poolAddress: '0x0000000000000000000000000000000000000011',
          quoteAddress: '0x0000000000000000000000000000000000000012',
          contract: {
            quoteTokenScale: sinon
              .stub()
              .resolves(ethers.utils.parseEther('1')),
          },
        } as any,
        poolConfig: {
          name: 'Direct DEX Boundary Pool',
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
          externalTakePath: 'direct_dex',
          quoteAmountRaw: BigNumber.from(11),
          approvedMinOutRaw: BigNumber.from(10),
          selectedLiquiditySource: LiquiditySource.UNISWAPV3,
          selectedFeeTier: 3000,
        },
        config: {
          keeperTakerRouter: '0x0000000000000000000000000000000000000013',
          uniswapV3RouterOverrides: {
            swapRouter02Address: '0x0000000000000000000000000000000000000014',
            poolFactoryAddress: '0x0000000000000000000000000000000000000015',
            wethAddress: '0x0000000000000000000000000000000000000016',
            quoterV2Address: '0x0000000000000000000000000000000000000017',
            defaultFeeTier: 3000,
          },
          takeWriteTransport: takeWriteTransport as any,
          onDirectDexExecutionFailure: params.onDirectDexExecutionFailure,
        },
      });
    } catch (error) {
      thrown = error;
    }

    return {
      thrown,
      estimateGasStub,
      populateTransactionStub,
    };
  }

  it('validates 1inch atomic swap details against the atomic take invariants', () => {
    const validDetails = {
      aggregationExecutor: '0x00000000000000000000000000000000000000ce',
      swapDescription: {
        srcToken: '0x0000000000000000000000000000000000000002',
        dstToken: '0x0000000000000000000000000000000000000003',
        srcReceiver: '0x00000000000000000000000000000000000000cc',
        dstReceiver: '0x00000000000000000000000000000000000000bb',
        amount: ethers.utils.parseEther('1'),
        minReturnAmount: BigNumber.from(1),
        flags: BigNumber.from(0),
      },
      opaqueData: '0x1234',
    } as any;
    const expected = {
      srcToken: '0x0000000000000000000000000000000000000002',
      dstToken: '0x0000000000000000000000000000000000000003',
      srcReceiver: '0x00000000000000000000000000000000000000cc',
      dstReceiver: '0x00000000000000000000000000000000000000bb',
      amount: ethers.utils.parseEther('1'),
    };

    expect(
      oneInch.validateOneInchSwapDetailsForAtomicTake(validDetails, expected)
    ).to.be.undefined;
    expect(
      oneInch.validateOneInchSwapDetailsForAtomicTake(
        {
          ...validDetails,
          swapDescription: {
            ...validDetails.swapDescription,
            srcReceiver: validDetails.aggregationExecutor,
          },
        },
        expected
      )
    ).to.be.undefined;
    expect(
      oneInch.validateOneInchSwapDetailsForAtomicTake(
        {
          ...validDetails,
          swapDescription: {
            ...validDetails.swapDescription,
            dstReceiver: '0x00000000000000000000000000000000000000cc',
          },
        },
        expected
      )
    ).to.include('dstReceiver');
    expect(
      oneInch.validateOneInchSwapDetailsForAtomicTake(
        {
          ...validDetails,
          swapDescription: {
            ...validDetails.swapDescription,
            amount: ethers.utils.parseEther('2'),
          },
        },
        expected
      )
    ).to.include('does not match requested collateral amount');
    expect(
      oneInch.validateOneInchSwapDetailsForAtomicTake(
        {
          ...validDetails,
          swapDescription: {
            ...validDetails.swapDescription,
            srcReceiver: '0x00000000000000000000000000000000000000dd',
          },
        },
        expected
      )
    ).to.include('srcReceiver');
    expect(
      oneInch.validateOneInchSwapDetailsForAtomicTake(
        {
          ...validDetails,
          swapDescription: {
            ...validDetails.swapDescription,
            minReturnAmount: BigNumber.from(0),
          },
        },
        expected
      )
    ).to.include('minReturnAmount must be greater than 0');
    expect(
      oneInch.validateOneInchSwapDetailsForAtomicTake(
        {
          ...validDetails,
          swapDescription: {
            ...validDetails.swapDescription,
            flags: BigNumber.from(1),
          },
        },
        expected
      )
    ).to.include('flags');
    expect(
      oneInch.validateOneInchSwapDetailsForAtomicTake(
        {
          ...validDetails,
          aggregationExecutor: '0x0000000000000000000000000000000000000000',
        },
        expected
      )
    ).to.include('aggregationExecutor cannot be the zero address');
    expect(
      oneInch.validateOneInchSwapDetailsForAtomicTake(
        {
          ...validDetails,
          swapDescription: {
            ...validDetails.swapDescription,
            flags: undefined,
          },
        } as any,
        expected
      )
    ).to.include('flags is invalid');
    expect(
      oneInch.validateOneInchSwapDetailsForAtomicTake(validDetails, {
        ...expected,
        aggregationExecutors: [validDetails.aggregationExecutor],
      })
    ).to.be.undefined;
    expect(
      oneInch.validateOneInchSwapDetailsForAtomicTake(validDetails, {
        ...expected,
        aggregationExecutors: ['0x00000000000000000000000000000000000000dd'],
      })
    ).to.include('is not in the configured allowlist');
    expect(
      oneInch.validateOneInchSwapDetailsForAtomicTake(validDetails, {
        ...expected,
        aggregationExecutors: [],
      })
    ).to.include('aggregationExecutor allowlist is empty');
    expect(
      oneInch.validateOneInchSwapDetailsForAtomicTake(
        {
          ...validDetails,
          swapDescription: {
            ...validDetails.swapDescription,
            flags: '0x0',
          },
        } as any,
        expected
      )
    ).to.be.undefined;
    expect(
      oneInch.validateOneInchSwapDetailsForAtomicTake(
        {
          ...validDetails,
          swapDescription: {
            ...validDetails.swapDescription,
            minReturnAmount: null,
          },
        } as any,
        expected
      )
    ).to.include('minReturnAmount is invalid');
    expect(
      oneInch.validateOneInchSwapDetailsForAtomicTake(
        {
          ...validDetails,
          aggregationExecutor: ' 0x00000000000000000000000000000000000000ce',
        } as any,
        expected
      )
    ).to.include('aggregationExecutor is not a valid address');
    expect(
      oneInch.validateOneInchSwapDetailsForAtomicTake(
        {
          ...validDetails,
          swapDescription: {
            ...validDetails.swapDescription,
            srcReceiver: '\u00000x00000000000000000000000000000000000000cc',
          },
        } as any,
        expected
      )
    ).to.include('srcReceiver is not a valid address');
  });

  it('keys direct DEX token decimal cache by chain id', async () => {
    const runtimeCache: shared.DirectDexQuoteProviderRuntimeCache = {
      chainId: 1,
    };
    const tokenAddress = '0x0000000000000000000000000000000000000002';
    const decimalsStub = sinon
      .stub(erc20, 'getDecimalsErc20')
      .onFirstCall()
      .resolves(6)
      .onSecondCall()
      .resolves(18);

    const firstDecimals = await shared.getCachedDirectDexTokenDecimals(
      {} as any,
      tokenAddress,
      runtimeCache
    );
    runtimeCache.chainId = 2;
    const secondDecimals = await shared.getCachedDirectDexTokenDecimals(
      {} as any,
      tokenAddress,
      runtimeCache
    );

    expect(firstDecimals).to.equal(6);
    expect(secondDecimals).to.equal(18);
    expect(decimalsStub.calledTwice).to.be.true;
  });

  it('uses the configured take write transport for Curve direct DEX take submission without reselecting the pool', async () => {
    // Deadline reads stay on the read signer; private/relay write transports
    // should only see transaction submission and nonce reads.
    const readSigner = {
      provider: {
        getBlock: sinon.stub().resolves({ timestamp: 123 }),
      },
    };
    const writeSigner = {
      getAddress: sinon
        .stub()
        .resolves('0x00000000000000000000000000000000000000ef'),
      getTransactionCount: sinon.stub().resolves(0),
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
    const routerContract = {
      estimateGas: {
        takeWithAtomicSwap: estimateGasStub,
      },
      populateTransaction: {
        takeWithAtomicSwap: populateTransactionStub,
      },
    };

    sinon
      .stub(TakerRouter__factory, 'connect')
      .returns(routerContract as any);
    const approvedExecutionFloor = BigNumber.from(10);
    sinon
      .stub(shared, 'computeDirectDexAmountOutMinimum')
      .resolves(approvedExecutionFloor);
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

    await executeCurveDirectDexTake({
      pool: {
        name: 'Direct DEX Curve Pool',
        poolAddress: '0x0000000000000000000000000000000000000011',
        collateralAddress: '0x00000000000000000000000000000000000000c1',
        quoteAddress: '0x00000000000000000000000000000000000000c2',
        contract: {
          quoteTokenScale: sinon
            .stub()
            .resolves(ethers.utils.parseEther('1')),
        },
      } as any,
      poolConfig: {
        name: 'Direct DEX Curve Pool',
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
        externalTakePath: 'direct_dex',
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
        keeperTakerRouter: '0x0000000000000000000000000000000000000013',
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
    expect(decoded[5].toNumber()).to.equal(1923);
    expect(
      (readSigner as any).provider.getBlock.calledOnceWithExactly('latest')
    ).to.be.true;
  });

  it('refuses direct DEX execution when an approved quote is missing route-binding fields', async () => {
    const connectStub = sinon.stub(TakerRouter__factory, 'connect');
    const basePool = {
      name: 'Direct DEX Take Pool',
      poolAddress: '0x0000000000000000000000000000000000000011',
      collateralAddress: '0x0000000000000000000000000000000000000012',
      quoteAddress: '0x0000000000000000000000000000000000000013',
    } as any;
    const basePoolConfig = {
      name: 'Direct DEX Take Pool',
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
      const result = await takeLiquidationDirectDex({
        pool: basePool,
        poolConfig: basePoolConfig,
        signer: {} as any,
        liquidation: {
          ...baseLiquidation,
          externalTakeExecutionPlan: singleExternalTakeExecutionPlan(
            malformedBoundRoute(quoteEvaluation)
          ),
        },
        config: {
          dryRun: false,
          keeperTakerRouter: '0x0000000000000000000000000000000000000014',
        },
      });
      expect(result, label).to.equal(false);
    }

    expect(connectStub.called).to.be.false;
  });

  it('validates direct DEX dry-run quotes before reporting a would-take action', async () => {
    const connectStub = sinon.stub(TakerRouter__factory, 'connect');

    const result = await takeLiquidationDirectDex({
      pool: {
        name: 'Direct DEX Take Pool',
        poolAddress: '0x0000000000000000000000000000000000000011',
        collateralAddress: '0x0000000000000000000000000000000000000012',
        quoteAddress: '0x0000000000000000000000000000000000000013',
      } as any,
      poolConfig: {
        name: 'Direct DEX Take Pool',
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
        externalTakeExecutionPlan: singleExternalTakeExecutionPlan(
          malformedBoundRoute({
            isTakeable: true,
            externalTakePath: 'direct_dex',
            quoteAmountRaw: BigNumber.from(11),
            selectedLiquiditySource: LiquiditySource.UNISWAPV3,
            selectedFeeTier: 3000,
          })
        ),
      },
      config: {
        dryRun: true,
      },
    });

    expect(result).to.equal(false);
    expect(connectStub.called).to.be.false;
  });

  it('uses the configured take write transport for Uniswap direct DEX take submission', async () => {
    const readSigner = {
      provider: {
        getBlock: sinon.stub().resolves({ timestamp: 123 }),
      },
    };
    const writeSigner = {
      getAddress: sinon
        .stub()
        .resolves('0x00000000000000000000000000000000000000ee'),
      getTransactionCount: sinon.stub().resolves(0),
    };
    const takeWriteTransport = {
      mode: 'private_rpc',
      signer: writeSigner,
      submitTransaction: sinon.stub().resolves({
        txHash: '0xd1ecde0000000000000000000000000000000000000000000000000000000000',
        wait: sinon.stub().resolves({ transactionHash: '0xd1ecde0000000000000000000000000000000000000000000000000000000000' }),
      }),
    };
    const estimateGasStub = sinon.stub().resolves(BigNumber.from(120_000));
    const populateTransactionStub = sinon.stub().resolves({
      to: '0x0000000000000000000000000000000000000013',
      data: '0x5678',
    });
    const routerContract = {
      estimateGas: {
        takeWithAtomicSwap: estimateGasStub,
      },
      populateTransaction: {
        takeWithAtomicSwap: populateTransactionStub,
      },
    };

    sinon
      .stub(TakerRouter__factory, 'connect')
      .returns(routerContract as any);
    const approvedExecutionFloor = BigNumber.from(10);
    sinon
      .stub(shared, 'computeDirectDexAmountOutMinimum')
      .resolves(approvedExecutionFloor);
    const queueTransactionStub = sinon
      .stub(NonceTracker, 'queueTransaction')
      .callsFake(async (signer, txFunction) => {
        expect(signer).to.equal(writeSigner);
        return await txFunction(3);
      });

    await executeUniswapV3DirectDexTake({
      pool: {
        name: 'Direct DEX Take Pool',
        poolAddress: '0x0000000000000000000000000000000000000011',
        quoteAddress: '0x0000000000000000000000000000000000000012',
        contract: {
          quoteTokenScale: sinon
            .stub()
            .resolves(ethers.utils.parseEther('1')),
        },
      } as any,
      poolConfig: {
        name: 'Direct DEX Take Pool',
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
        externalTakePath: 'direct_dex',
        quoteAmountRaw: BigNumber.from(11),
        approvedMinOutRaw: BigNumber.from(10),
        selectedLiquiditySource: LiquiditySource.UNISWAPV3,
        selectedFeeTier: 3000,
      },
      config: {
        keeperTakerRouter: '0x0000000000000000000000000000000000000013',
        uniswapV3RouterOverrides: {
          swapRouter02Address: '0x0000000000000000000000000000000000000014',
          poolFactoryAddress: '0x0000000000000000000000000000000000000015',
          wethAddress: '0x0000000000000000000000000000000000000016',
          quoterV2Address: '0x0000000000000000000000000000000000000017',
          defaultFeeTier: 3000,
        },
        takeWriteTransport: takeWriteTransport as any,
      },
    });

    expect(
      (
        TakerRouter__factory.connect as sinon.SinonStub
      ).calledOnceWithExactly(
        '0x0000000000000000000000000000000000000013',
        readSigner
      )
    ).to.be.true;
    expect(queueTransactionStub.calledOnce).to.be.true;
    expect(takeWriteTransport.submitTransaction.calledOnce).to.be.true;
    const takeArgs = populateTransactionStub.firstCall.args;
    expect(takeArgs[0]).to.equal('0x0000000000000000000000000000000000000011');
    expect(takeArgs[4]).to.equal(Number(LiquiditySource.UNISWAPV3));
    expect(takeArgs[5]).to.equal('0x0000000000000000000000000000000000000014');
    const decoded = ethers.utils.defaultAbiCoder.decode(
      ['(address,address,uint24,uint256,uint256)'],
      takeArgs[6]
    );
    expect(decoded[0][0]).to.equal(
      '0x0000000000000000000000000000000000000014'
    );
    expect(decoded[0][1]).to.equal(
      '0x0000000000000000000000000000000000000012'
    );
    expect(decoded[0][2]).to.equal(3000);
    expect(decoded[0][3].eq(approvedExecutionFloor)).to.be.true;
    expect(decoded[0][4].toNumber()).to.equal(1923);
    expect(
      (readSigner as any).provider.getBlock.calledOnceWithExactly('latest')
    ).to.be.true;
  });

  it('reports direct DEX transport rejection before acceptance as pre-broadcast', async () => {
    const submitTransaction = sinon
      .stub()
      .rejects(new Error('local send rejected'));
    const onDirectDexExecutionFailure = sinon.spy();

    const result = await runUniswapDirectDexSubmissionBoundaryScenario({
      submitTransaction,
      onDirectDexExecutionFailure,
    });

    expect(result.thrown).to.be.instanceOf(Error);
    expect((result.thrown as Error).message).to.equal('local send rejected');
    expect(result.estimateGasStub.calledOnce).to.equal(true);
    expect(result.populateTransactionStub.calledOnce).to.equal(true);
    expect(submitTransaction.calledOnce).to.equal(true);
    expect(onDirectDexExecutionFailure.calledOnce).to.equal(true);
    expect(onDirectDexExecutionFailure.firstCall.args[0]).to.deep.equal({
      preBroadcast: true,
      error: 'local send rejected',
    });
  });

  it('does not report accepted direct DEX submission wait failure as pre-broadcast', async () => {
    const submitTransaction = sinon.stub().resolves({
      txHash: '0xhash',
      wait: sinon.stub().rejects(new Error('receipt wait failed')),
    });
    const onDirectDexExecutionFailure = sinon.spy();

    const result = await runUniswapDirectDexSubmissionBoundaryScenario({
      submitTransaction,
      onDirectDexExecutionFailure,
    });

    expect(result.thrown).to.be.instanceOf(Error);
    expect((result.thrown as Error).message).to.equal('receipt wait failed');
    expect(submitTransaction.calledOnce).to.equal(true);
    expect(onDirectDexExecutionFailure.calledOnce).to.equal(true);
    expect(onDirectDexExecutionFailure.firstCall.args[0]).to.deep.equal({
      preBroadcast: false,
      error: 'receipt wait failed',
    });
  });

  it('does not report nonce-consumed direct DEX submission errors as pre-broadcast', async () => {
    const submitTransaction = sinon.stub().rejects(
      new NonceConsumedTransactionError('relay accepted direct DEX take', {
        txHash: '0xhash',
      })
    );
    const onDirectDexExecutionFailure = sinon.spy();

    const result = await runUniswapDirectDexSubmissionBoundaryScenario({
      submitTransaction,
      onDirectDexExecutionFailure,
    });

    expect((result.thrown as any).nonceConsumed).to.equal(true);
    expect(submitTransaction.calledOnce).to.equal(true);
    expect(onDirectDexExecutionFailure.calledOnce).to.equal(true);
    expect(onDirectDexExecutionFailure.firstCall.args[0]).to.deep.equal({
      preBroadcast: false,
      error: 'relay accepted direct DEX take',
    });
  });
});
