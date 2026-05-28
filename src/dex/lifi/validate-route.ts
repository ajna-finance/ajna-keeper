import { BigNumber, ethers } from 'ethers';
import { LifiFeeCostPolicy } from '../../config';
import { validateLifiFeeCosts } from './fee-policy';
import {
  isBroadLifiExchangeFilter,
  isUnsupportedLifiExchangeTool,
} from './filters';
import { normalizeLifiAddressAllowlistSet } from './address-allowlist';
import {
  ApprovedLifiQuote,
  DEFAULT_LIFI_FEE_COST_POLICY,
  LifiAction,
  LifiEstimate,
  LifiQuoteResponse,
  LifiStep,
  LifiTransactionRequest,
} from './schema';
import { normalizeLifiSelectorAllowlist } from './selector-allowlist';

const ZERO_ADDRESS = ethers.constants.AddressZero.toLowerCase();

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

function requireObject<T extends object>(value: unknown, label: string): T {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as T;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireAddress(value: unknown, label: string): string {
  const address = requireString(value, label);
  if (!ethers.utils.isAddress(address)) {
    throw new Error(`${label} must be an address`);
  }
  return ethers.utils.getAddress(address);
}

function requirePositiveAmount(value: unknown, label: string): BigNumber {
  const amount = requireString(value, label);
  if (!/^(0|[1-9]\d*)$/.test(amount)) {
    throw new Error(`${label} must be a decimal integer string`);
  }
  const parsed = BigNumber.from(amount);
  if (parsed.lte(0)) {
    throw new Error(`${label} must be greater than zero`);
  }
  return parsed;
}

function requireOptionalChainId(
  value: unknown,
  label: string
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function normalizeToolSet(tools: readonly string[]): Set<string> {
  const normalized = new Set<string>();
  for (const tool of tools) {
    const normalizedTool = tool.trim().toLowerCase();
    if (normalizedTool.length === 0) {
      throw new Error('LI.FI allowedExchangeTools cannot contain empty tools');
    }
    if (isBroadLifiExchangeFilter(normalizedTool)) {
      throw new Error(
        `LI.FI allowedExchangeTools cannot include broad filter keyword ${tool}`
      );
    }
    if (isUnsupportedLifiExchangeTool(normalizedTool)) {
      throw new Error(
        `LI.FI allowedExchangeTools cannot include unsupported tool ${tool}`
      );
    }
    normalized.add(normalizedTool);
  }
  return normalized;
}

function assertAddressEq(params: {
  actual: string;
  expected: string;
  label: string;
}): void {
  if (
    ethers.utils.getAddress(params.actual).toLowerCase() !==
    ethers.utils.getAddress(params.expected).toLowerCase()
  ) {
    throw new Error(`${params.label} mismatch`);
  }
}

function assertOptionalAddressEq(params: {
  actual: unknown;
  expected: string;
  label: string;
}): void {
  if (params.actual === undefined) {
    return;
  }
  assertAddressEq({
    actual: requireAddress(params.actual, params.label),
    expected: params.expected,
    label: params.label,
  });
}

function assertTokenAddress(params: {
  token: unknown;
  expected: string;
  label: string;
  chainId: number;
}): void {
  const token = requireObject<{ address?: unknown; chainId?: unknown }>(
    params.token,
    params.label
  );
  const address = requireAddress(token.address, `${params.label}.address`);
  if (address.toLowerCase() === ZERO_ADDRESS) {
    throw new Error(
      `${params.label}.address cannot be native token placeholder`
    );
  }
  assertAddressEq({
    actual: address,
    expected: params.expected,
    label: `${params.label}.address`,
  });
  const tokenChainId = requireOptionalChainId(
    token.chainId,
    `${params.label}.chainId`
  );
  if (tokenChainId !== undefined && tokenChainId !== params.chainId) {
    throw new Error(`${params.label}.chainId mismatch`);
  }
}

function assertStepSemantics(params: {
  step: LifiStep;
  label: string;
  expectedType: 'swap' | 'lifi';
  chainId: number;
  fromToken: string;
  toToken: string;
  fromAmount: BigNumber;
  takerAddress: string;
  allowedTools: Set<string>;
  requireAllowedTool: boolean;
  requireTakerAddresses?: boolean;
}): string | undefined {
  if (params.step.type !== params.expectedType) {
    throw new Error(`${params.label}.type must be ${params.expectedType}`);
  }
  const action = requireObject<LifiAction>(
    params.step.action,
    `${params.label}.action`
  );
  const estimate = requireObject<LifiEstimate>(
    params.step.estimate,
    `${params.label}.estimate`
  );

  assertTokenAddress({
    token: action.fromToken,
    expected: params.fromToken,
    label: `${params.label}.action.fromToken`,
    chainId: params.chainId,
  });
  assertTokenAddress({
    token: action.toToken,
    expected: params.toToken,
    label: `${params.label}.action.toToken`,
    chainId: params.chainId,
  });

  const fromChainId = requireOptionalChainId(
    action.fromChainId,
    `${params.label}.action.fromChainId`
  );
  const toChainId = requireOptionalChainId(
    action.toChainId,
    `${params.label}.action.toChainId`
  );
  if (fromChainId !== undefined && fromChainId !== params.chainId) {
    throw new Error(`${params.label}.action.fromChainId mismatch`);
  }
  if (toChainId !== undefined && toChainId !== params.chainId) {
    throw new Error(`${params.label}.action.toChainId mismatch`);
  }
  if (
    action.destinationCall !== undefined &&
    action.destinationCall !== false
  ) {
    throw new Error(`${params.label}.action.destinationCall is not supported`);
  }

  const actionFromAmount = requirePositiveAmount(
    action.fromAmount,
    `${params.label}.action.fromAmount`
  );
  if (!actionFromAmount.eq(params.fromAmount)) {
    throw new Error(`${params.label}.action.fromAmount mismatch`);
  }
  if (estimate.fromAmount !== undefined) {
    const estimateFromAmount = requirePositiveAmount(
      estimate.fromAmount,
      `${params.label}.estimate.fromAmount`
    );
    if (!estimateFromAmount.eq(params.fromAmount)) {
      throw new Error(`${params.label}.estimate.fromAmount mismatch`);
    }
  }

  if (params.requireTakerAddresses !== false) {
    assertOptionalAddressEq({
      actual: action.fromAddress,
      expected: params.takerAddress,
      label: `${params.label}.action.fromAddress`,
    });
    assertOptionalAddressEq({
      actual: action.toAddress,
      expected: params.takerAddress,
      label: `${params.label}.action.toAddress`,
    });
  }

  const tool =
    typeof params.step.tool === 'string'
      ? params.step.tool.trim().toLowerCase()
      : undefined;
  if (params.requireAllowedTool) {
    if (!tool || !params.allowedTools.has(tool)) {
      throw new Error(`${params.label}.tool is not allowlisted`);
    }
  }
  return tool;
}

function getIncludedSteps(quote: LifiQuoteResponse, label: string): LifiStep[] {
  if (quote.includedSteps === undefined) {
    return [];
  }
  if (!Array.isArray(quote.includedSteps)) {
    throw new Error(`${label}.includedSteps must be an array`);
  }
  return quote.includedSteps.map((includedStep, index) => {
    const step = requireObject<LifiStep>(
      includedStep,
      `${label}.includedSteps[${index}]`
    );
    if (
      step.includedSteps !== undefined &&
      (!Array.isArray(step.includedSteps) || step.includedSteps.length > 0)
    ) {
      throw new Error(
        `${label}.includedSteps[${index}] cannot contain nested steps`
      );
    }
    return step;
  });
}

function normalizeStepTool(step: LifiStep, label: string): string {
  if (typeof step.tool !== 'string' || step.tool.trim().length === 0) {
    throw new Error(`${label}.tool must be a non-empty string`);
  }
  return step.tool.trim().toLowerCase();
}

function isFeeCollectionStep(step: LifiStep): boolean {
  return (
    step.type === 'protocol' &&
    typeof step.tool === 'string' &&
    step.tool.trim().toLowerCase() === 'feecollection'
  );
}

function parseEstimateOutputs(params: {
  estimate: LifiEstimate;
  label: string;
}): { quoteAmountRaw: BigNumber; routeMinOutRaw: BigNumber } {
  const quoteAmountRaw = requirePositiveAmount(
    params.estimate.toAmount,
    `${params.label}.estimate.toAmount`
  );
  const routeMinOutRaw = requirePositiveAmount(
    params.estimate.toAmountMin,
    `${params.label}.estimate.toAmountMin`
  );
  if (routeMinOutRaw.gt(quoteAmountRaw)) {
    throw new Error(
      `${params.label}.estimate.toAmountMin cannot exceed toAmount`
    );
  }
  return { quoteAmountRaw, routeMinOutRaw };
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

  const includedOutputs = parseEstimateOutputs({
    estimate: params.estimate,
    label: 'LI.FI included step',
  });
  if (includedOutputs.routeMinOutRaw.lt(params.topLevelRouteMinOutRaw)) {
    throw new Error(
      'LI.FI included step.estimate.toAmountMin conflicts with top-level min output'
    );
  }
}

function assertFeeCollectionStep(params: {
  step: LifiStep;
  label: string;
  chainId: number;
  sourceToken: string;
  fromAmount: BigNumber;
}): BigNumber {
  if (!isFeeCollectionStep(params.step)) {
    throw new Error(`${params.label} must be feeCollection protocol step`);
  }
  const action = requireObject<LifiAction>(
    params.step.action,
    `${params.label}.action`
  );
  const estimate = requireObject<LifiEstimate>(
    params.step.estimate,
    `${params.label}.estimate`
  );
  assertTokenAddress({
    token: action.fromToken,
    expected: params.sourceToken,
    label: `${params.label}.action.fromToken`,
    chainId: params.chainId,
  });
  assertTokenAddress({
    token: action.toToken,
    expected: params.sourceToken,
    label: `${params.label}.action.toToken`,
    chainId: params.chainId,
  });
  const fromChainId = requireOptionalChainId(
    action.fromChainId,
    `${params.label}.action.fromChainId`
  );
  const toChainId = requireOptionalChainId(
    action.toChainId,
    `${params.label}.action.toChainId`
  );
  if (fromChainId !== undefined && fromChainId !== params.chainId) {
    throw new Error(`${params.label}.action.fromChainId mismatch`);
  }
  if (toChainId !== undefined && toChainId !== params.chainId) {
    throw new Error(`${params.label}.action.toChainId mismatch`);
  }
  if (
    action.destinationCall !== undefined &&
    action.destinationCall !== false
  ) {
    throw new Error(`${params.label}.action.destinationCall is not supported`);
  }
  const feeInput = requirePositiveAmount(
    action.fromAmount,
    `${params.label}.action.fromAmount`
  );
  if (!feeInput.eq(params.fromAmount)) {
    throw new Error(`${params.label}.action.fromAmount mismatch`);
  }
  if (estimate.fromAmount !== undefined) {
    const estimateFromAmount = requirePositiveAmount(
      estimate.fromAmount,
      `${params.label}.estimate.fromAmount`
    );
    if (!estimateFromAmount.eq(params.fromAmount)) {
      throw new Error(`${params.label}.estimate.fromAmount mismatch`);
    }
  }
  const { quoteAmountRaw, routeMinOutRaw } = parseEstimateOutputs({
    estimate,
    label: params.label,
  });
  if (!quoteAmountRaw.eq(routeMinOutRaw)) {
    throw new Error(`${params.label}.estimate.toAmountMin must equal toAmount`);
  }
  if (quoteAmountRaw.gte(params.fromAmount)) {
    throw new Error(`${params.label}.estimate.toAmount must be post-fee`);
  }
  return quoteAmountRaw;
}

function getExecutableIncludedSwap(params: {
  quote: LifiQuoteResponse;
  includedSteps: LifiStep[];
  chainId: number;
  fromToken: string;
  fromAmount: BigNumber;
}): {
  swapStep: LifiStep | undefined;
  feeCollectionStep: LifiStep | undefined;
  effectiveSwapFromAmount: BigNumber;
  hasFeeCollectionStep: boolean;
} {
  if (params.includedSteps.length === 0) {
    if (params.quote.type === 'lifi') {
      throw new Error(
        'LI.FI quote.includedSteps must contain one swap step and optional feeCollection step'
      );
    }
    return {
      swapStep: undefined,
      feeCollectionStep: undefined,
      effectiveSwapFromAmount: params.fromAmount,
      hasFeeCollectionStep: false,
    };
  }

  if (params.includedSteps.length === 1) {
    return {
      swapStep: params.includedSteps[0],
      feeCollectionStep: undefined,
      effectiveSwapFromAmount: params.fromAmount,
      hasFeeCollectionStep: false,
    };
  }

  if (
    params.includedSteps.length === 2 &&
    isFeeCollectionStep(params.includedSteps[0])
  ) {
    const effectiveSwapFromAmount = assertFeeCollectionStep({
      step: params.includedSteps[0],
      label: 'LI.FI included feeCollection step',
      chainId: params.chainId,
      sourceToken: params.fromToken,
      fromAmount: params.fromAmount,
    });
    return {
      swapStep: params.includedSteps[1],
      feeCollectionStep: params.includedSteps[0],
      effectiveSwapFromAmount,
      hasFeeCollectionStep: true,
    };
  }

  throw new Error(
    'LI.FI quote.includedSteps must contain one swap step and optional feeCollection step'
  );
}

function getEstimateFeeCosts(step: LifiStep | undefined): unknown {
  if (!step) {
    return undefined;
  }
  const estimate = step.estimate;
  return typeof estimate === 'object' && estimate !== null
    ? (estimate as { feeCosts?: unknown }).feeCosts
    : undefined;
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

  const allowedTools = normalizeToolSet(params.allowedExchangeTools);
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

  if (
    quote.type === 'lifi' &&
    (typeof quote.tool !== 'string' || quote.tool.trim().length === 0)
  ) {
    throw new Error('LI.FI quote.tool must be a non-empty string');
  }

  const topLevelTool = assertStepSemantics({
    step: quote,
    label: 'LI.FI quote',
    expectedType: quote.type,
    chainId: params.chainId,
    fromToken: params.fromToken,
    toToken: params.toToken,
    fromAmount: params.fromAmount,
    takerAddress: params.takerAddress,
    allowedTools,
    requireAllowedTool:
      quote.type === 'swap' ||
      (quote.type === 'lifi' &&
        typeof quote.tool === 'string' &&
        quote.tool.trim().toLowerCase() !== 'lifi'),
  });
  const includedSteps = getIncludedSteps(quote, 'LI.FI quote');
  const executableIncludedSwap = getExecutableIncludedSwap({
    quote,
    includedSteps,
    chainId: params.chainId,
    fromToken: params.fromToken,
    fromAmount: params.fromAmount,
  });
  let includedTool = topLevelTool;
  if (executableIncludedSwap.swapStep) {
    includedTool = assertStepSemantics({
      step: executableIncludedSwap.swapStep,
      label: 'LI.FI included swap step',
      expectedType: 'swap',
      chainId: params.chainId,
      fromToken: params.fromToken,
      toToken: params.toToken,
      fromAmount: executableIncludedSwap.effectiveSwapFromAmount,
      takerAddress: params.takerAddress,
      allowedTools,
      requireAllowedTool: true,
      requireTakerAddresses: false,
    });
  }

  const estimate = requireObject<LifiEstimate>(
    quote.estimate,
    'LI.FI quote.estimate'
  );
  const { quoteAmountRaw, routeMinOutRaw } = parseEstimateOutputs({
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
  if (executableIncludedSwap.swapStep) {
    assertIncludedStepEstimate({
      estimate: requireObject<LifiEstimate>(
        executableIncludedSwap.swapStep.estimate,
        'LI.FI included swap step.estimate'
      ),
      approvalSpenders,
      topLevelRouteMinOutRaw: routeMinOutRaw,
      topLevelApprovalSpender: approvalSpender,
      enforceApprovalSpender:
        quote.type === 'swap' || !executableIncludedSwap.hasFeeCollectionStep,
    });
  }

  const feeCosts = validateLifiFeeCosts({
    topLevelFeeCosts: estimate.feeCosts,
    feeCollectionStepFeeCosts: getEstimateFeeCosts(
      executableIncludedSwap.feeCollectionStep
    ),
    executableSwapStepFeeCosts: getEstimateFeeCosts(
      executableIncludedSwap.swapStep
    ),
    expectedSourceToken: params.fromToken,
    expectedOutputToken: params.toToken,
    expectedChainId: params.chainId,
    expectedSourceTokenFeeRaw: executableIncludedSwap.hasFeeCollectionStep
      ? params.fromAmount.sub(executableIncludedSwap.effectiveSwapFromAmount)
      : undefined,
    allowSourceTokenFees: executableIncludedSwap.hasFeeCollectionStep,
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
      ...(typeof transactionRequest.gasLimit === 'string'
        ? { gasLimit: transactionRequest.gasLimit }
        : {}),
      ...(typeof transactionRequest.gasPrice === 'string'
        ? { gasPrice: transactionRequest.gasPrice }
        : {}),
    },
    tool: includedTool ?? normalizeStepTool(quote, 'LI.FI quote'),
    ...(topLevelTool ? { topLevelTool } : {}),
    feeCosts,
    selector,
    quotedAtMs: params.nowMs ?? Date.now(),
  };
}
