import axios from 'axios';
import { ethers } from 'ethers';
import sinon from 'sinon';
import { LiquiditySource, TakeWriteTransportMode } from '../../../src/config';
import { takeLiquidationLifi } from '../../../src/take/lifi-execution';
import { AjnaKeeperTakerFactory__factory } from '../../../typechain-types/factories/contracts/factories';
import { malformedSingleExternalTakeExecutionPlan } from '../../helpers/external-take-plan';

export interface ValidLifiQuoteResponseParams {
  chainId: number;
  collateral: string;
  quoteToken: string;
  lifiTaker: string;
  target: string;
  spender: string;
  selector: string;
  fromAmount: ethers.BigNumber;
  routeMinOutRaw: ethers.BigNumber;
  quoteAmountRaw: ethers.BigNumber;
  topLevelType?: 'swap' | 'lifi';
  topLevelTool?: string;
  includedSwapTool?: string;
}

export function makeValidLifiQuoteResponse(
  params: ValidLifiQuoteResponseParams
) {
  const topLevelType = params.topLevelType ?? 'swap';
  const topLevelTool =
    params.topLevelTool ?? (topLevelType === 'lifi' ? 'lifi' : 'uniswap');
  const swapStep = {
    type: 'swap',
    tool: params.includedSwapTool ?? 'uniswap',
    action: {
      fromToken: { address: params.collateral, chainId: params.chainId },
      toToken: { address: params.quoteToken, chainId: params.chainId },
      fromAmount: params.fromAmount.toString(),
      fromChainId: params.chainId,
      toChainId: params.chainId,
      fromAddress: params.lifiTaker,
      toAddress: params.lifiTaker,
      destinationCall: false,
    },
    estimate: {
      approvalAddress: params.spender,
      fromAmount: params.fromAmount.toString(),
      toAmount: params.quoteAmountRaw.toString(),
      toAmountMin: params.routeMinOutRaw.toString(),
    },
  };
  return {
    status: 200,
    headers: {},
    data: {
      type: topLevelType,
      tool: topLevelTool,
      action: {
        fromToken: { address: params.collateral, chainId: params.chainId },
        toToken: { address: params.quoteToken, chainId: params.chainId },
        fromAmount: params.fromAmount.toString(),
        fromChainId: params.chainId,
        toChainId: params.chainId,
        fromAddress: params.lifiTaker,
        toAddress: params.lifiTaker,
        destinationCall: false,
      },
      estimate: {
        approvalAddress: params.spender,
        fromAmount: params.fromAmount.toString(),
        toAmount: params.quoteAmountRaw.toString(),
        toAmountMin: params.routeMinOutRaw.toString(),
      },
      transactionRequest: {
        to: params.target,
        data: `${params.selector}00000000`,
        value: '0',
        from: params.lifiTaker,
        chainId: params.chainId,
      },
      ...(topLevelType === 'lifi' ? { includedSteps: [swapStep] } : {}),
    },
  };
}

export function stubLifiQuoteResponse(params: ValidLifiQuoteResponseParams) {
  return sinon
    .stub(axios, 'get')
    .resolves(makeValidLifiQuoteResponse(params) as any);
}

export async function runLifiSubmissionBoundaryScenario(params: {
  submitTransaction: sinon.SinonStub;
  onLifiExecutionFailure: sinon.SinonSpy;
  pendingNonceAfterFailure?: number;
}) {
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
  const estimateGas = sinon.stub().resolves(ethers.BigNumber.from(500_000));
  sinon.stub(AjnaKeeperTakerFactory__factory, 'connect').returns({
    estimateGas: {
      takeWithAtomicSwap: estimateGas,
    },
    populateTransaction: {
      takeWithAtomicSwap: populateTransaction,
    },
  } as any);
  const getTransactionCount = sinon.stub();
  getTransactionCount.onFirstCall().resolves(0);
  getTransactionCount
    .onSecondCall()
    .resolves(params.pendingNonceAfterFailure ?? 0);
  const txSigner = {
    getAddress: sinon
      .stub()
      .resolves('0x6666666666666666666666666666666666666666'),
    getTransactionCount,
  };

  const succeeded = await takeLiquidationLifi({
    pool: {
      name: 'Submission Boundary LI.FI Pool',
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
        externalTakePath: 'lifi',
        selectedLiquiditySource: LiquiditySource.LIFI,
        quoteAmountRaw,
        routeMinOutRaw,
        approvedMinOutRaw: routeMinOutRaw,
        lifiQuote: {
          quoteAmountRaw,
          routeMinOutRaw,
        },
      }),
    } as any,
    config: {
      keeperTakerFactory: '0x9999999999999999999999999999999999999999',
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
        submitTransaction: params.submitTransaction,
      },
      onLifiExecutionFailure: params.onLifiExecutionFailure,
    } as any,
  });

  return {
    succeeded,
    estimateGas,
    populateTransaction,
    getTransactionCount,
  };
}
