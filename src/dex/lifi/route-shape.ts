import { BigNumber } from 'ethers';
import {
  isBroadLifiExchangeFilter,
  isUnsupportedLifiExchangeTool,
} from './filters';
import {
  LifiAction,
  LifiEstimate,
  LifiQuoteResponse,
  LifiStep,
} from './schema';
import {
  assertOptionalAddressEq,
  assertTokenAddress,
  requireObject,
  requireOptionalChainId,
  requirePositiveAmount,
} from './validation-primitives';

export type NormalizedLifiRouteShape =
  | {
      kind: 'direct-swap';
      topLevelTool: string;
      executableTool: string;
      effectiveSwapFromAmount: BigNumber;
      hasFeeCollectionStep: false;
    }
  | {
      kind: 'included-swap';
      topLevelTool: string;
      executableTool: string;
      executableSwapEstimate: LifiEstimate;
      executableSwapStepFeeCosts: unknown;
      effectiveSwapFromAmount: BigNumber;
      hasFeeCollectionStep: false;
    }
  | {
      kind: 'fee-collection-swap';
      topLevelTool: string;
      executableTool: string;
      executableSwapEstimate: LifiEstimate;
      executableSwapStepFeeCosts: unknown;
      feeCollectionStepFeeCosts: unknown;
      effectiveSwapFromAmount: BigNumber;
      sourceTokenFeeRaw: BigNumber;
      hasFeeCollectionStep: true;
    };

export function normalizeLifiAllowedToolSet(
  tools: readonly string[]
): Set<string> {
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

function isFeeCollectionStep(step: LifiStep): boolean {
  return (
    step.type === 'protocol' &&
    typeof step.tool === 'string' &&
    step.tool.trim().toLowerCase() === 'feecollection'
  );
}

export function parseLifiEstimateOutputs(params: {
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
  const { quoteAmountRaw, routeMinOutRaw } = parseLifiEstimateOutputs({
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
  swapStep?: LifiStep;
  feeCollectionStep?: LifiStep;
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
      effectiveSwapFromAmount: params.fromAmount,
      hasFeeCollectionStep: false,
    };
  }

  if (params.includedSteps.length === 1) {
    return {
      swapStep: params.includedSteps[0],
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

function requireStepEstimate(step: LifiStep, label: string): LifiEstimate {
  return requireObject<LifiEstimate>(step.estimate, `${label}.estimate`);
}

function getLifiEstimateFeeCosts(estimate: LifiEstimate): unknown {
  return estimate.feeCosts;
}

function requireStepTool(tool: string | undefined, label: string): string {
  if (!tool) {
    throw new Error(`${label}.tool must be a non-empty string`);
  }
  return tool;
}

export function normalizeLifiRouteShape(params: {
  quote: LifiQuoteResponse;
  chainId: number;
  fromToken: string;
  toToken: string;
  fromAmount: BigNumber;
  takerAddress: string;
  allowedTools: Set<string>;
}): NormalizedLifiRouteShape {
  if (params.quote.type !== 'swap' && params.quote.type !== 'lifi') {
    throw new Error('LI.FI quote.type must be swap or lifi');
  }
  const quoteType = params.quote.type;

  if (
    quoteType === 'lifi' &&
    (typeof params.quote.tool !== 'string' ||
      params.quote.tool.trim().length === 0)
  ) {
    throw new Error('LI.FI quote.tool must be a non-empty string');
  }

  const topLevelTool = assertStepSemantics({
    step: params.quote,
    label: 'LI.FI quote',
    expectedType: quoteType,
    chainId: params.chainId,
    fromToken: params.fromToken,
    toToken: params.toToken,
    fromAmount: params.fromAmount,
    takerAddress: params.takerAddress,
    allowedTools: params.allowedTools,
    requireAllowedTool:
      quoteType === 'swap' ||
      (quoteType === 'lifi' &&
        typeof params.quote.tool === 'string' &&
        params.quote.tool.trim().toLowerCase() !== 'lifi'),
  });
  const included = getExecutableIncludedSwap({
    quote: params.quote,
    includedSteps: getIncludedSteps(params.quote, 'LI.FI quote'),
    chainId: params.chainId,
    fromToken: params.fromToken,
    fromAmount: params.fromAmount,
  });

  if (!included.swapStep) {
    const directTopLevelTool = requireStepTool(topLevelTool, 'LI.FI quote');
    return {
      kind: 'direct-swap',
      topLevelTool: directTopLevelTool,
      executableTool: directTopLevelTool,
      effectiveSwapFromAmount: included.effectiveSwapFromAmount,
      hasFeeCollectionStep: false,
    };
  }
  const resolvedTopLevelTool = requireStepTool(topLevelTool, 'LI.FI quote');

  const executableTool = assertStepSemantics({
    step: included.swapStep,
    label: 'LI.FI included swap step',
    expectedType: 'swap',
    chainId: params.chainId,
    fromToken: params.fromToken,
    toToken: params.toToken,
    fromAmount: included.effectiveSwapFromAmount,
    takerAddress: params.takerAddress,
    allowedTools: params.allowedTools,
    requireAllowedTool: true,
    requireTakerAddresses: false,
  });
  const resolvedExecutableTool = requireStepTool(
    executableTool,
    'LI.FI included swap step'
  );
  const executableSwapEstimate = requireStepEstimate(
    included.swapStep,
    'LI.FI included swap step'
  );

  if (included.hasFeeCollectionStep) {
    if (!included.feeCollectionStep) {
      throw new Error(
        'LI.FI quote.includedSteps must include feeCollection metadata'
      );
    }
    const feeCollectionStepEstimate = requireStepEstimate(
      included.feeCollectionStep,
      'LI.FI included feeCollection step'
    );
    return {
      kind: 'fee-collection-swap',
      topLevelTool: resolvedTopLevelTool,
      executableTool: resolvedExecutableTool,
      executableSwapEstimate,
      executableSwapStepFeeCosts: getLifiEstimateFeeCosts(
        executableSwapEstimate
      ),
      feeCollectionStepFeeCosts: getLifiEstimateFeeCosts(
        feeCollectionStepEstimate
      ),
      effectiveSwapFromAmount: included.effectiveSwapFromAmount,
      sourceTokenFeeRaw: params.fromAmount.sub(
        included.effectiveSwapFromAmount
      ),
      hasFeeCollectionStep: true,
    };
  }

  return {
    kind: 'included-swap',
    topLevelTool: resolvedTopLevelTool,
    executableTool: resolvedExecutableTool,
    executableSwapEstimate,
    executableSwapStepFeeCosts: getLifiEstimateFeeCosts(executableSwapEstimate),
    effectiveSwapFromAmount: included.effectiveSwapFromAmount,
    hasFeeCollectionStep: false,
  };
}
