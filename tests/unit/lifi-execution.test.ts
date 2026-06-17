import { AGGREGATOR_SWAP_DETAILS_TUPLE_ABI } from '../../src/take/aggregator-calldata/execution';
import { expect } from 'chai';
import sinon from 'sinon';
import axios from 'axios';
import { ethers } from 'ethers';
import { LiquiditySource, TakeWriteTransportMode } from '../../src/config';
import { getLifiPathQuoteEvaluation } from '../../src/take/lifi/quote-evaluation';
import {
  getLifiTakerAddress,
  takeLiquidationLifi,
} from '../../src/take/lifi/execution';
import { TakerRouter__factory } from '../../typechain-types/factories/contracts/factories';
import { logger } from '../../src/logging';
import { NonceConsumedTransactionError, NonceTracker } from '../../src/nonce';
import {
  runLifiSubmissionBoundaryScenario,
  stubLifiQuoteResponse,
} from './helpers/lifi-execution-scenarios';
import { malformedSingleExternalTakeExecutionPlan } from '../helpers/external-take-plan';

describe('LI.FI execution', () => {
  const LIFI_DETAILS_ABI =
    AGGREGATOR_SWAP_DETAILS_TUPLE_ABI;

  afterEach(() => {
    NonceTracker.clearNonces();
    sinon.restore();
  });

  it('uses only canonical takers.contracts.Lifi for LI.FI taker lookup', () => {
    const canonicalAndAliasContracts: Record<string, string> = {
      Lifi: '0x1111111111111111111111111111111111111111',
      LIFI: '0x2222222222222222222222222222222222222222',
      lifi: '0x3333333333333333333333333333333333333333',
    };
    const aliasOnlyContracts: Record<string, string> = {
      LIFI: '0x2222222222222222222222222222222222222222',
      lifi: '0x3333333333333333333333333333333333333333',
    };

    expect(getLifiTakerAddress(canonicalAndAliasContracts)).to.equal(
      '0x1111111111111111111111111111111111111111'
    );
    expect(getLifiTakerAddress(aliasOnlyContracts)).to.equal(undefined);
  });

  it('reports policy rejection as a pre-broadcast failure for hybrid fallback', async () => {
    const onLifiExecutionFailure = sinon.spy();
    const succeeded = await takeLiquidationLifi({
      pool: {
        name: 'LI.FI Reject Pool',
        poolAddress: '0x1111111111111111111111111111111111111111',
      } as any,
      signer: {} as any,
      poolConfig: {
        take: {
          liquiditySource: LiquiditySource.LIFI,
        },
      } as any,
      liquidation: {
        borrower: '0x2222222222222222222222222222222222222222',
        auctionPrice: ethers.utils.parseEther('100'),
        collateral: ethers.utils.parseEther('1'),
        externalTakeExecutionPlan: malformedSingleExternalTakeExecutionPlan({
          isTakeable: false,
          externalTakePath: 'calldata_aggregator',
          providerId: 'lifi',
          selectedLiquiditySource: LiquiditySource.LIFI,
          reason: 'LI.FI fresh quote min output below execution floor',
        }),
      } as any,
      config: {
        onLifiExecutionFailure,
      } as any,
    });

    expect(succeeded).to.equal(false);
    expect(onLifiExecutionFailure.calledOnce).to.equal(true);
    expect(onLifiExecutionFailure.firstCall.args[0]).to.deep.equal({
      preBroadcast: true,
      error:
        'LI.FI quote no longer satisfies execution policy for LI.FI Reject Pool/0x2222222222222222222222222222222222222222: LI.FI fresh quote min output below execution floor',
    });
  });

  it('rejects LI.FI quote evaluation before the API when collateral rounds to zero token units', async () => {
    const chainId = 8453;
    const collateral = '0x1111111111111111111111111111111111111111';
    const quoteToken = '0x2222222222222222222222222222222222222222';
    const axiosGet = sinon.stub(axios, 'get');

    const result = await getLifiPathQuoteEvaluation(
      {
        name: 'Dust LI.FI Pool',
        collateralAddress: collateral,
        quoteAddress: quoteToken,
      } as any,
      100,
      ethers.BigNumber.from(1),
      {
        take: {
          marketPriceFactor: 0.99,
        },
      } as any,
      {
        chainId,
        lifiTaker: '0x3333333333333333333333333333333333333333',
        lifi: {
          mode: 'production',
          allowExchanges: ['uniswap'],
          callTargetAllowlist: {
            [chainId]: ['0x4444444444444444444444444444444444444444'],
          },
          approvalSpenderAllowlist: {
            [chainId]: ['0x5555555555555555555555555555555555555555'],
          },
          selectorAllowlist: {
            [chainId]: {
              '0x4444444444444444444444444444444444444444': ['0xabcdef12'],
            },
          },
        },
        tokenDecimalsCache: new Map([[`${chainId}:${collateral}`, 6]]),
      },
      {
        getChainId: sinon.stub().resolves(chainId),
      } as any
    );

    expect(result).to.deep.include({
      isTakeable: false,
      externalTakePath: 'calldata_aggregator',
      selectedLiquiditySource: LiquiditySource.LIFI,
      reason: 'LI.FI collateral rounds to zero in token decimals',
    });
    expect(axiosGet.called).to.equal(false);
  });

  it('uses LI.FI route min-out rather than optimistic output for quote approval', async () => {
    const chainId = 8453;
    const collateral = '0x1111111111111111111111111111111111111111';
    const quoteToken = '0x2222222222222222222222222222222222222222';
    const lifiTaker = '0x3333333333333333333333333333333333333333';
    const target = '0x4444444444444444444444444444444444444444';
    const spender = '0x5555555555555555555555555555555555555555';
    const selector = '0xabcdef12';
    const fromAmount = ethers.utils.parseEther('1');
    const routeMinOutRaw = ethers.utils.parseUnits('99', 6);
    const quoteAmountRaw = ethers.utils.parseUnits('101', 6);

    stubLifiQuoteResponse({
      chainId,
      collateral,
      quoteToken,
      lifiTaker,
      target,
      spender,
      selector,
      fromAmount,
      routeMinOutRaw,
      quoteAmountRaw,
    });

    const result = await getLifiPathQuoteEvaluation(
      {
        name: 'Min Out LI.FI Pool',
        collateralAddress: collateral,
        quoteAddress: quoteToken,
        contract: {
          quoteTokenScale: sinon
            .stub()
            .resolves(ethers.BigNumber.from('1000000000000')),
        },
      } as any,
      100,
      fromAmount,
      {
        take: {
          marketPriceFactor: 1,
        },
      } as any,
      {
        chainId,
        lifiTaker,
        lifi: {
          mode: 'production',
          allowExchanges: ['uniswap'],
          callTargetAllowlist: { [chainId]: [target] },
          approvalSpenderAllowlist: { [chainId]: [spender] },
          selectorAllowlist: { [chainId]: { [target]: [selector] } },
        },
        tokenDecimalsCache: new Map([
          [`${chainId}:${collateral}`, 18],
          [`${chainId}:${quoteToken}`, 6],
        ]),
      },
      {
        getChainId: sinon.stub().resolves(chainId),
      } as any,
      ethers.utils.parseEther('100')
    );

    expect(result.isTakeable).to.equal(false);
    expect(result.reason).to.equal('route quote below repayment floor');
    expect(result.quoteAmountRaw?.eq(routeMinOutRaw)).to.equal(true);
    expect(result.routeMinOutRaw?.eq(routeMinOutRaw)).to.equal(true);
    expect(result.calldataQuote?.quoteAmountRaw.eq(quoteAmountRaw)).to.equal(
      true
    );
    expect(
      result.routeProfitability?.expectedShortfallQuoteRaw?.eq(
        ethers.utils.parseUnits('1', 6)
      )
    ).to.equal(true);
  });

  it('logs accepted LI.FI wrapper quote telemetry before route approval', async () => {
    const chainId = 8453;
    const collateral = '0x1111111111111111111111111111111111111111';
    const quoteToken = '0x2222222222222222222222222222222222222222';
    const lifiTaker = '0x3333333333333333333333333333333333333333';
    const target = '0x4444444444444444444444444444444444444444';
    const spender = '0x5555555555555555555555555555555555555555';
    const selector = '0xabcdef12';
    const fromAmount = ethers.utils.parseEther('1');
    const routeMinOutRaw = ethers.utils.parseUnits('101', 6);
    const quoteAmountRaw = ethers.utils.parseUnits('102', 6);
    const loggerInfo = sinon.stub(logger, 'info');

    stubLifiQuoteResponse({
      chainId,
      collateral,
      quoteToken,
      lifiTaker,
      target,
      spender,
      selector,
      fromAmount,
      routeMinOutRaw,
      quoteAmountRaw,
      topLevelType: 'lifi',
      topLevelTool: 'lifi',
      includedSwapTool: 'sushiswap',
    });

    const result = await getLifiPathQuoteEvaluation(
      {
        name: 'Telemetry LI.FI Pool',
        collateralAddress: collateral,
        quoteAddress: quoteToken,
        contract: {
          quoteTokenScale: sinon
            .stub()
            .resolves(ethers.BigNumber.from('1000000000000')),
        },
      } as any,
      100,
      fromAmount,
      {
        take: {
          marketPriceFactor: 1,
        },
      } as any,
      {
        chainId,
        lifiTaker,
        lifi: {
          mode: 'production',
          allowExchanges: ['sushiswap'],
          callTargetAllowlist: { [chainId]: [target] },
          approvalSpenderAllowlist: { [chainId]: [spender] },
          selectorAllowlist: { [chainId]: { [target]: [selector] } },
        },
        tokenDecimalsCache: new Map([
          [`${chainId}:${collateral}`, 18],
          [`${chainId}:${quoteToken}`, 6],
        ]),
      },
      {
        getChainId: sinon.stub().resolves(chainId),
      } as any,
      ethers.utils.parseEther('100')
    );

    expect(result.isTakeable).to.equal(true);
    const message = String(loggerInfo.firstCall?.args[0] ?? '');
    expect(message).to.include('lifiMode=production');
    expect(message).to.include('topLevelType=lifi');
    expect(message).to.include('topLevelTool=lifi');
    expect(message).to.include('effectiveTool=sushiswap');
    expect(message).to.include(
      `expectedOutputRaw=${quoteAmountRaw.toString()}`
    );
    expect(message).to.include(`routeMinOutRaw=${routeMinOutRaw.toString()}`);
    expect(message).to.include(
      `approvedMinOutRaw=${routeMinOutRaw.toString()}`
    );
    expect(message).to.include(`target=${target}`);
    expect(message).to.include(`transactionTarget=${target}`);
    expect(message).to.include(`approvalSpender=${spender}`);
    expect(message).to.include(`selector=${selector}`);
    expect(message).to.include('rejectionReason=none');
  });

  it('rejects approved LI.FI quote context that no longer matches current liquidation', async () => {
    const onLifiExecutionFailure = sinon.spy();
    const axiosGet = sinon.stub(axios, 'get');
    const quoteAmountRaw = ethers.utils.parseUnits('2000', 6);
    const routeMinOutRaw = ethers.utils.parseUnits('1900', 6);

    const succeeded = await takeLiquidationLifi({
      pool: {
        name: 'Stale Context LI.FI Pool',
        poolAddress: '0x1111111111111111111111111111111111111111',
      } as any,
      signer: {} as any,
      poolConfig: {
        take: {
          liquiditySource: LiquiditySource.LIFI,
        },
      } as any,
      liquidation: {
        borrower: '0x2222222222222222222222222222222222222222',
        auctionPrice: ethers.utils.parseEther('100'),
        collateral: ethers.utils.parseEther('2'),
        externalTakeExecutionPlan: malformedSingleExternalTakeExecutionPlan({
          isTakeable: true,
          externalTakePath: 'calldata_aggregator',
          selectedLiquiditySource: LiquiditySource.LIFI,
          quoteAmountRaw,
          routeMinOutRaw,
          approvedMinOutRaw: routeMinOutRaw,
          quotedAuctionPriceWad: ethers.utils.parseEther('100'),
          quotedCollateralWad: ethers.utils.parseEther('1'),
          calldataQuote: {
            providerId: 'lifi',
            quoteAmountRaw,
            routeMinOutRaw,
          },
        }),
      } as any,
      config: {
        onLifiExecutionFailure,
      } as any,
    });

    expect(succeeded).to.equal(false);
    expect(axiosGet.called).to.equal(false);
    expect(onLifiExecutionFailure.calledOnce).to.equal(true);
    expect(onLifiExecutionFailure.firstCall.args[0]).to.deep.equal({
      preBroadcast: true,
      error:
        'LI.FI approved quote collateral does not match current liquidation collateral',
    });
  });

  it('rejects a fresh LI.FI quote that becomes stale before submission', async () => {
    const chainId = 8453;
    const collateral = '0x1111111111111111111111111111111111111111';
    const quoteToken = '0x2222222222222222222222222222222222222222';
    const lifiTaker = '0x3333333333333333333333333333333333333333';
    const target = '0x4444444444444444444444444444444444444444';
    const spender = '0x5555555555555555555555555555555555555555';
    const selector = '0xabcdef12';
    const fromAmount = ethers.utils.parseEther('1');
    const routeMinOutRaw = ethers.utils.parseUnits('1900', 6);
    const quoteAmountRaw = ethers.utils.parseUnits('2000', 6);
    let nowMs = 1_000;
    sinon.stub(Date, 'now').callsFake(() => nowMs);
    stubLifiQuoteResponse({
      chainId,
      collateral,
      quoteToken,
      lifiTaker,
      target,
      spender,
      selector,
      fromAmount,
      routeMinOutRaw,
      quoteAmountRaw,
    });
    const populateTransaction = sinon.stub().resolves({
      to: '0x9999999999999999999999999999999999999999',
      data: '0x',
    });
    const estimateGas = sinon.stub().callsFake(async () => {
      nowMs = 1_005;
      return ethers.BigNumber.from(500_000);
    });
    sinon.stub(TakerRouter__factory, 'connect').returns({
      estimateGas: {
        takeWithAtomicSwap: estimateGas,
      },
      populateTransaction: {
        takeWithAtomicSwap: populateTransaction,
      },
    } as any);
    const submitTransaction = sinon.stub();
    const onLifiQuoteResult = sinon.spy();
    const onLifiExecutionFailure = sinon.spy();
    const txSigner = {
      getAddress: sinon
        .stub()
        .resolves('0x6666666666666666666666666666666666666666'),
      getTransactionCount: sinon.stub().resolves(0),
    };

    const succeeded = await takeLiquidationLifi({
      pool: {
        name: 'Queued Stale LI.FI Pool',
        poolAddress: '0x7777777777777777777777777777777777777777',
        collateralAddress: collateral,
        quoteAddress: quoteToken,
      } as any,
      signer: {
        getChainId: sinon.stub().resolves(chainId),
      } as any,
      poolConfig: {
        take: {
          liquiditySource: LiquiditySource.LIFI,
        },
      } as any,
      liquidation: {
        borrower: '0x8888888888888888888888888888888888888888',
        auctionPrice: ethers.utils.parseEther('100'),
        collateral: fromAmount,
        externalTakeExecutionPlan: malformedSingleExternalTakeExecutionPlan({
          isTakeable: true,
          externalTakePath: 'calldata_aggregator',
          selectedLiquiditySource: LiquiditySource.LIFI,
          quoteAmountRaw,
          routeMinOutRaw,
          approvedMinOutRaw: routeMinOutRaw,
          calldataQuote: {
            providerId: 'lifi',
            quoteAmountRaw,
            routeMinOutRaw,
          },
        }),
      } as any,
      config: {
        keeperTakerRouter: '0x9999999999999999999999999999999999999999',
        lifiTaker,
        chainId,
        lifi: {
          mode: 'production',
          allowExchanges: ['uniswap'],
          callTargetAllowlist: { [chainId]: [target] },
          approvalSpenderAllowlist: { [chainId]: [spender] },
          selectorAllowlist: { [chainId]: { [target]: [selector] } },
          maxQuoteAgeMs: 1,
        },
        tokenDecimalsCache: new Map([[`${chainId}:${collateral}`, 18]]),
        takeWriteTransport: {
          mode: TakeWriteTransportMode.PUBLIC_RPC,
          signer: txSigner,
          submitTransaction,
        },
        onLifiQuoteResult,
        onLifiExecutionFailure,
      } as any,
    });

    expect(succeeded).to.equal(false);
    expect(estimateGas.calledOnce).to.equal(true);
    expect(populateTransaction.called).to.equal(false);
    expect(submitTransaction.called).to.equal(false);
    // Staleness detected while the quote waited in the keeper's nonce queue /
    // gas-estimation path is keeper-side latency, not a LI.FI health failure,
    // so it must be recorded as non-retryable (neutral) and must not open the
    // execution_refresh circuit.
    expect(
      onLifiQuoteResult
        .getCalls()
        .some(
          (call) =>
            call.args[0].success === false &&
            call.args[0].retryable === false &&
            call.args[0].error === 'LI.FI fresh quote exceeded maxQuoteAgeMs'
        )
    ).to.equal(true);
    expect(
      onLifiQuoteResult
        .getCalls()
        .every((call) => call.args[0].retryable !== true)
    ).to.equal(true);
    expect(
      onLifiQuoteResult.getCalls().some((call) => call.args[0].success === true)
    ).to.equal(false);
    expect(onLifiExecutionFailure.calledOnce).to.equal(true);
    expect(onLifiExecutionFailure.firstCall.args[0]).to.deep.equal({
      preBroadcast: true,
      error: 'LI.FI fresh quote exceeded maxQuoteAgeMs',
    });
  });

  it('reports LI.FI gas estimation failure as pre-broadcast and does not populate or submit', async () => {
    const chainId = 8453;
    const collateral = '0x1111111111111111111111111111111111111111';
    const quoteToken = '0x2222222222222222222222222222222222222222';
    const lifiTaker = '0x3333333333333333333333333333333333333333';
    const target = '0x4444444444444444444444444444444444444444';
    const spender = '0x5555555555555555555555555555555555555555';
    const selector = '0xabcdef12';
    const fromAmount = ethers.utils.parseEther('1');
    const routeMinOutRaw = ethers.utils.parseUnits('1900', 6);
    const quoteAmountRaw = ethers.utils.parseUnits('2000', 6);
    stubLifiQuoteResponse({
      chainId,
      collateral,
      quoteToken,
      lifiTaker,
      target,
      spender,
      selector,
      fromAmount,
      routeMinOutRaw,
      quoteAmountRaw,
    });
    const populateTransaction = sinon.stub().resolves({
      to: '0x9999999999999999999999999999999999999999',
      data: '0x',
    });
    const estimateGas = sinon
      .stub()
      .rejects(new Error('gas estimation failed'));
    sinon.stub(TakerRouter__factory, 'connect').returns({
      estimateGas: {
        takeWithAtomicSwap: estimateGas,
      },
      populateTransaction: {
        takeWithAtomicSwap: populateTransaction,
      },
    } as any);
    const submitTransaction = sinon.stub();
    const onLifiExecutionFailure = sinon.spy();
    const txSigner = {
      getAddress: sinon
        .stub()
        .resolves('0x6666666666666666666666666666666666666666'),
      getTransactionCount: sinon.stub().resolves(0),
    };

    const succeeded = await takeLiquidationLifi({
      pool: {
        name: 'Gas Estimate Failure LI.FI Pool',
        poolAddress: '0x7777777777777777777777777777777777777777',
        collateralAddress: collateral,
        quoteAddress: quoteToken,
      } as any,
      signer: {
        getChainId: sinon.stub().resolves(chainId),
      } as any,
      poolConfig: {
        take: {
          liquiditySource: LiquiditySource.LIFI,
        },
      } as any,
      liquidation: {
        borrower: '0x8888888888888888888888888888888888888888',
        auctionPrice: ethers.utils.parseEther('100'),
        collateral: fromAmount,
        externalTakeExecutionPlan: malformedSingleExternalTakeExecutionPlan({
          isTakeable: true,
          externalTakePath: 'calldata_aggregator',
          selectedLiquiditySource: LiquiditySource.LIFI,
          quoteAmountRaw,
          routeMinOutRaw,
          approvedMinOutRaw: routeMinOutRaw,
          calldataQuote: {
            providerId: 'lifi',
            quoteAmountRaw,
            routeMinOutRaw,
          },
        }),
      } as any,
      config: {
        keeperTakerRouter: '0x9999999999999999999999999999999999999999',
        lifiTaker,
        chainId,
        lifi: {
          mode: 'production',
          allowExchanges: ['uniswap'],
          callTargetAllowlist: { [chainId]: [target] },
          approvalSpenderAllowlist: { [chainId]: [spender] },
          selectorAllowlist: { [chainId]: { [target]: [selector] } },
        },
        tokenDecimalsCache: new Map([[`${chainId}:${collateral}`, 18]]),
        takeWriteTransport: {
          mode: TakeWriteTransportMode.PUBLIC_RPC,
          signer: txSigner,
          submitTransaction,
        },
        onLifiExecutionFailure,
      } as any,
    });

    expect(succeeded).to.equal(false);
    expect(estimateGas.calledOnce).to.equal(true);
    expect(populateTransaction.called).to.equal(false);
    expect(submitTransaction.called).to.equal(false);
    expect(onLifiExecutionFailure.calledOnce).to.equal(true);
    expect(onLifiExecutionFailure.firstCall.args[0]).to.deep.equal({
      preBroadcast: true,
      error: 'gas estimation failed',
    });
  });

  it('reports LI.FI transport rejection before acceptance as pre-broadcast', async () => {
    const submitTransaction = sinon
      .stub()
      .rejects(new Error('local send rejected'));
    const onLifiExecutionFailure = sinon.spy();

    const result = await runLifiSubmissionBoundaryScenario({
      submitTransaction,
      onLifiExecutionFailure,
      pendingNonceAfterFailure: 0,
    });

    expect(result.succeeded).to.equal(false);
    expect(result.estimateGas.calledOnce).to.equal(true);
    expect(result.populateTransaction.calledOnce).to.equal(true);
    expect(submitTransaction.calledOnce).to.equal(true);
    expect(onLifiExecutionFailure.calledOnce).to.equal(true);
    expect(onLifiExecutionFailure.firstCall.args[0]).to.deep.equal({
      preBroadcast: true,
      error: 'local send rejected',
    });
  });

  it('does not report accepted LI.FI submission wait failure as pre-broadcast', async () => {
    const submitTransaction = sinon.stub().resolves({
      txHash:
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      wait: async () => {
        throw new Error('receipt wait failed');
      },
    });
    const onLifiExecutionFailure = sinon.spy();

    const result = await runLifiSubmissionBoundaryScenario({
      submitTransaction,
      onLifiExecutionFailure,
      pendingNonceAfterFailure: 1,
    });

    expect(result.succeeded).to.equal(false);
    expect(submitTransaction.calledOnce).to.equal(true);
    expect(onLifiExecutionFailure.calledOnce).to.equal(true);
    expect(onLifiExecutionFailure.firstCall.args[0]).to.deep.equal({
      preBroadcast: false,
      error: 'receipt wait failed',
    });
  });

  it('does not report nonce-consumed LI.FI submission errors as pre-broadcast', async () => {
    const submitTransaction = sinon.stub().rejects(
      new NonceConsumedTransactionError(
        'relay accepted LI.FI take before timeout',
        {
          txHash:
            '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        }
      )
    );
    const onLifiExecutionFailure = sinon.spy();

    const result = await runLifiSubmissionBoundaryScenario({
      submitTransaction,
      onLifiExecutionFailure,
      pendingNonceAfterFailure: 1,
    });

    expect(result.succeeded).to.equal(false);
    expect(submitTransaction.calledOnce).to.equal(true);
    expect(onLifiExecutionFailure.calledOnce).to.equal(true);
    expect(onLifiExecutionFailure.firstCall.args[0]).to.deep.equal({
      preBroadcast: false,
      error: 'relay accepted LI.FI take before timeout',
    });
  });

  it('encodes fresh LI.FI execution input in collateral token units while preserving Ajna WAD maxAmount', async () => {
    const chainId = 8453;
    const collateral = '0x1111111111111111111111111111111111111111';
    const quoteToken = '0x2222222222222222222222222222222222222222';
    const lifiTaker = '0x3333333333333333333333333333333333333333';
    const target = '0x4444444444444444444444444444444444444444';
    const spender = '0x5555555555555555555555555555555555555555';
    const selector = '0xabcdef12';
    const collateralWad = ethers.utils.parseEther('1');
    const fromAmountTokenUnits = ethers.utils.parseUnits('1', 6);
    const routeMinOutRaw = ethers.utils.parseUnits('1900', 6);
    const quoteAmountRaw = ethers.utils.parseUnits('2000', 6);

    stubLifiQuoteResponse({
      chainId,
      collateral,
      quoteToken,
      lifiTaker,
      target,
      spender,
      selector,
      fromAmount: fromAmountTokenUnits,
      routeMinOutRaw,
      quoteAmountRaw,
    });
    const populateTransaction = sinon.stub().resolves({
      to: '0x9999999999999999999999999999999999999999',
      data: '0x',
    });
    const estimateGas = sinon.stub().resolves(ethers.BigNumber.from(500_000));
    sinon.stub(TakerRouter__factory, 'connect').returns({
      estimateGas: {
        takeWithAtomicSwap: estimateGas,
      },
      populateTransaction: {
        takeWithAtomicSwap: populateTransaction,
      },
    } as any);
    const submitTransaction = sinon.stub().resolves({
      txHash:
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      wait: async () =>
        ({
          transactionHash:
            '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          gasUsed: ethers.BigNumber.from(450_000),
        }) as any,
    });
    const txSigner = {
      getAddress: sinon
        .stub()
        .resolves('0x6666666666666666666666666666666666666666'),
      getTransactionCount: sinon.stub().resolves(0),
    };

    const succeeded = await takeLiquidationLifi({
      pool: {
        name: 'USDC Collateral LI.FI Pool',
        poolAddress: '0x7777777777777777777777777777777777777777',
        collateralAddress: collateral,
        quoteAddress: quoteToken,
      } as any,
      signer: {
        getChainId: sinon.stub().resolves(chainId),
      } as any,
      poolConfig: {
        take: {
          liquiditySource: LiquiditySource.LIFI,
        },
      } as any,
      liquidation: {
        borrower: '0x8888888888888888888888888888888888888888',
        auctionPrice: ethers.utils.parseEther('100'),
        collateral: collateralWad,
        externalTakeExecutionPlan: malformedSingleExternalTakeExecutionPlan({
          isTakeable: true,
          externalTakePath: 'calldata_aggregator',
          selectedLiquiditySource: LiquiditySource.LIFI,
          quoteAmountRaw,
          routeMinOutRaw,
          approvedMinOutRaw: routeMinOutRaw,
          calldataQuote: {
            providerId: 'lifi',
            quoteAmountRaw,
            routeMinOutRaw,
          },
        }),
      } as any,
      config: {
        keeperTakerRouter: '0x9999999999999999999999999999999999999999',
        lifiTaker,
        chainId,
        lifi: {
          mode: 'production',
          allowExchanges: ['uniswap'],
          callTargetAllowlist: { [chainId]: [target] },
          approvalSpenderAllowlist: { [chainId]: [spender] },
          selectorAllowlist: { [chainId]: { [target]: [selector] } },
        },
        tokenDecimalsCache: new Map([[`${chainId}:${collateral}`, 6]]),
        takeWriteTransport: {
          mode: TakeWriteTransportMode.PUBLIC_RPC,
          signer: txSigner,
          submitTransaction,
        },
      } as any,
    });

    expect(succeeded).to.equal(true);
    expect(estimateGas.calledOnce).to.equal(true);
    expect(populateTransaction.calledOnce).to.equal(true);
    expect(submitTransaction.calledOnce).to.equal(true);

    const populatedArgs = populateTransaction.firstCall.args;
    expect(populatedArgs[3].eq(collateralWad)).to.equal(true);
    expect(populatedArgs[4]).to.equal(Number(LiquiditySource.LIFI));
    expect(populatedArgs[5]).to.equal(target);

    const [details] = ethers.utils.defaultAbiCoder.decode(
      [LIFI_DETAILS_ABI],
      populatedArgs[6]
    );
    expect(details.approvalSpender).to.equal(spender);
    expect(details.srcToken).to.equal(collateral);
    expect(details.dstToken).to.equal(quoteToken);
    expect(details.dstReceiver).to.equal(lifiTaker);
    expect(details.amountInTokenUnits.eq(fromAmountTokenUnits)).to.equal(true);
    expect(details.amountInTokenUnits.eq(collateralWad)).to.equal(false);
    expect(details.amountOutMinimum.eq(routeMinOutRaw)).to.equal(true);
    expect(details.callData.startsWith(selector)).to.equal(true);
  });
});
