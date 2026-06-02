import { BigNumber, ethers } from 'ethers';
import { LifiFeeCostPolicy } from '../../config';
import { validateLifiFeeCosts } from './fee-policy';
import { normalizeLifiAddressAllowlistSet } from './address-allowlist';
import {
  ApprovedLifiQuote,
  DEFAULT_LIFI_FEE_COST_POLICY,
  LifiEstimate,
  LifiQuoteResponse,
  LifiTransactionRequest,
} from './schema';
import { normalizeLifiSelectorAllowlist } from './selector-allowlist';
import {
  normalizeLifiAllowedToolSet,
  normalizeLifiRouteShape,
  parseLifiEstimateOutputs,
} from './route-shape';
import {
  assertOptionalAddressEq,
  requireAddress,
  requireObject,
  requireOptionalChainId,
  requireString,
  ZERO_ADDRESS,
} from './validation-primitives';

export interface ValidateLifiQuoteParams {
  quote: unknown;
  chainId: number;
  fromToken: string;
  toToken: string;
  fromAmount: BigNumber;
  takerAddress: string;
  allowedExchangeTools: readonly string[];
  callTargetAllowlist: readonly string[];
  approvalSpenderAllowlist: readonly string[];
  selectorAllowlist?: Record<string, readonly string[]>;
  feeCostPolicy?: LifiFeeCostPolicy;
  nowMs?: number;
}

function assertIncludedStepEstimate(params: {
  estimate: LifiEstimate;
  approvalSpenders: Set<string>;
  topLevelRouteMinOutRaw: BigNumber;
  topLevelApprovalSpender: string;
  enforceApprovalSpender: boolean;
}): void {
  if (params.enforceApprovalSpender) {
    const approvalSpender = requireAddress(
      params.estimate.approvalAddress,
      'LI.FI included swap step.estimate.approvalAddress'
    );
    if (approvalSpender.toLowerCase() === ZERO_ADDRESS) {
      throw new Error(
        'LI.FI included swap step approvalAddress cannot be zero address'
      );
    }
    if (!params.approvalSpenders.has(approvalSpender.toLowerCase())) {
      throw new Error(
        'LI.FI included swap step approvalAddress is not allowlisted'
      );
    }
    if (
      approvalSpender.toLowerCase() !==
      params.topLevelApprovalSpender.toLowerCase()
    ) {
      throw new Error(
        'LI.FI included swap step approvalAddress conflicts with top-level approvalAddress'
      );
    }
  }

  const includedOutputs = parseLifiEstimateOutputs({
    estimate: params.estimate,
    label: 'LI.FI included step',
  });
  if (includedOutputs.routeMinOutRaw.lt(params.topLevelRouteMinOutRaw)) {
    throw new Error(
      'LI.FI included step.estimate.toAmountMin conflicts with top-level min output'
    );
  }
}

function assertZeroValue(value: unknown): string {
  if (value === undefined) {
    return '0';
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error('LI.FI transactionRequest.value must be zero');
  }
  const parsed = BigNumber.from(value);
  if (!parsed.isZero()) {
    throw new Error('LI.FI transactionRequest.value must be zero');
  }
  return typeof value === 'string' ? value : String(value);
}

export function validateLifiQuote(
  params: ValidateLifiQuoteParams
): ApprovedLifiQuote {
  const quote = requireObject<LifiQuoteResponse>(params.quote, 'LI.FI quote');
  if (quote.type !== 'swap' && quote.type !== 'lifi') {
    throw new Error('LI.FI quote type must be swap or lifi');
  }

  const allowedTools = normalizeLifiAllowedToolSet(params.allowedExchangeTools);
  if (allowedTools.size === 0) {
    throw new Error('LI.FI allowedExchangeTools must be non-empty');
  }
  const callTargets = normalizeLifiAddressAllowlistSet(
    params.callTargetAllowlist,
    'LI.FI callTargetAllowlist'
  );
  const approvalSpenders = normalizeLifiAddressAllowlistSet(
    params.approvalSpenderAllowlist,
    'LI.FI approvalSpenderAllowlist'
  );
  const selectorsByTarget = normalizeLifiSelectorAllowlist(
    params.selectorAllowlist,
    params.selectorAllowlist === undefined
      ? {}
      : {
          requireNonEmpty: true,
          callTargetAllowlist: params.callTargetAllowlist,
          requireCallTargetCoverage: true,
        }
  );

  const routeShape = normalizeLifiRouteShape({
    quote,
    allowedTools,
    chainId: params.chainId,
    fromToken: params.fromToken,
    toToken: params.toToken,
    fromAmount: params.fromAmount,
    takerAddress: params.takerAddress,
  });

  const estimate = requireObject<LifiEstimate>(
    quote.estimate,
    'LI.FI quote.estimate'
  );
  const { quoteAmountRaw, routeMinOutRaw } = parseLifiEstimateOutputs({
    estimate,
    label: 'LI.FI quote',
  });

  const approvalSpender = requireAddress(
    estimate.approvalAddress,
    'LI.FI quote.estimate.approvalAddress'
  );
  if (approvalSpender.toLowerCase() === ZERO_ADDRESS) {
    throw new Error('LI.FI approvalAddress cannot be zero address');
  }
  if (!approvalSpenders.has(approvalSpender.toLowerCase())) {
    throw new Error('LI.FI approvalAddress is not allowlisted');
  }
  if ('executableSwapEstimate' in routeShape) {
    assertIncludedStepEstimate({
      estimate: routeShape.executableSwapEstimate,
      approvalSpenders,
      topLevelRouteMinOutRaw: routeMinOutRaw,
      topLevelApprovalSpender: approvalSpender,
      enforceApprovalSpender:
        quote.type === 'swap' || !routeShape.hasFeeCollectionStep,
    });
  }

  const feeCosts = validateLifiFeeCosts({
    topLevelFeeCosts: estimate.feeCosts,
    feeCollectionStepFeeCosts:
      routeShape.kind === 'fee-collection-swap'
        ? routeShape.feeCollectionStepFeeCosts
        : undefined,
    executableSwapStepFeeCosts:
      'executableSwapEstimate' in routeShape
        ? routeShape.executableSwapStepFeeCosts
        : undefined,
    expectedSourceToken: params.fromToken,
    expectedOutputToken: params.toToken,
    expectedChainId: params.chainId,
    expectedSourceTokenFeeRaw:
      routeShape.kind === 'fee-collection-swap'
        ? routeShape.sourceTokenFeeRaw
        : undefined,
    allowSourceTokenFees: routeShape.hasFeeCollectionStep,
    feeCostPolicy: params.feeCostPolicy ?? DEFAULT_LIFI_FEE_COST_POLICY,
  });

  const transactionRequest = requireObject<LifiTransactionRequest>(
    quote.transactionRequest,
    'LI.FI transactionRequest'
  );
  const transactionTarget = requireAddress(
    transactionRequest.to,
    'LI.FI transactionRequest.to'
  );
  if (transactionTarget.toLowerCase() === ZERO_ADDRESS) {
    throw new Error('LI.FI transactionRequest.to cannot be zero address');
  }
  if (!callTargets.has(transactionTarget.toLowerCase())) {
    throw new Error('LI.FI transactionRequest.to is not allowlisted');
  }
  const data = requireString(
    transactionRequest.data,
    'LI.FI transactionRequest.data'
  );
  if (
    !/^0x[0-9a-fA-F]*$/.test(data) ||
    data.length < 10 ||
    data.length % 2 !== 0
  ) {
    throw new Error('LI.FI transactionRequest.data must contain calldata');
  }
  const selector = data.slice(0, 10).toLowerCase();
  const targetSelectors = selectorsByTarget.get(
    transactionTarget.toLowerCase()
  );
  if (params.selectorAllowlist !== undefined && targetSelectors === undefined) {
    throw new Error('LI.FI transaction target has no selector allowlist');
  }
  if (targetSelectors !== undefined && !targetSelectors.has(selector)) {
    throw new Error('LI.FI transaction selector is not allowlisted');
  }
  const value = assertZeroValue(transactionRequest.value);
  if (transactionRequest.chainId === undefined) {
    throw new Error('LI.FI transactionRequest.chainId is required');
  }
  const txChainId = requireOptionalChainId(
    transactionRequest.chainId,
    'LI.FI transactionRequest.chainId'
  );
  if (txChainId !== params.chainId) {
    throw new Error('LI.FI transactionRequest.chainId mismatch');
  }
  assertOptionalAddressEq({
    actual: transactionRequest.from,
    expected: params.takerAddress,
    label: 'LI.FI transactionRequest.from',
  });

  return {
    raw: quote,
    quoteAmountRaw,
    routeMinOutRaw,
    amountInTokenUnits: params.fromAmount,
    srcToken: ethers.utils.getAddress(params.fromToken),
    dstToken: ethers.utils.getAddress(params.toToken),
    dstReceiver: ethers.utils.getAddress(params.takerAddress),
    approvalSpender,
    transactionTarget,
    transactionRequest: {
      to: transactionTarget,
      data,
      value,
      ...(typeof transactionRequest.from === 'string'
        ? { from: ethers.utils.getAddress(transactionRequest.from) }
        : {}),
      chainId: txChainId,
      // Provider-reported gasLimit/gasPrice are intentionally dropped: with
      // skipSimulation=true they are not authoritative. Execution derives a
      // local gas limit before submission, so they must never reach the wire.
    },
    tool: routeShape.executableTool,
    topLevelTool: routeShape.topLevelTool,
    feeCosts,
    selector,
    quotedAtMs: params.nowMs ?? Date.now(),
  };
}
