import { BigNumber } from 'ethers';
import {
  isBroadLifiExchangeFilter,
  isUnsupportedLifiExchangeTool,
} from './filters';
import {
  LifiAction,
  LifiEstimate,
  LifiFeeCost,
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
      topLevelFeeCosts?: readonly LifiFeeCost[];
      effectiveSwapFromAmount: BigNumber;
      hasFeeCollectionStep: false;
    }
  | {
      kind: 'included-swap';
      topLevelTool: string;
      executableTool: string;
      executableSwapEstimate: LifiEstimate;
      topLevelFeeCosts?: readonly LifiFeeCost[];
      executableSwapStepFeeCosts?: readonly LifiFeeCost[];
      effectiveSwapFromAmount: BigNumber;
      hasFeeCollectionStep: false;
    }
  | {
      kind: 'fee-collection-swap';
      topLevelTool: string;
      executableTool: string;
      executableSwapEstimate: LifiEstimate;
      topLevelFeeCosts?: readonly LifiFeeCost[];
      executableSwapStepFeeCosts?: readonly LifiFeeCost[];
      feeCollectionStepFeeCosts?: readonly LifiFeeCost[];
      effectiveSwapFromAmount: BigNumber;
      sourceTokenFeeRaw: BigNumber;
      hasFeeCollectionStep: true;
    };

export function normalizeLifiAllowedToolSet(
  tools: readonly string[],
  options: { requireNonEmpty?: boolean } = {}
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
  if (options.requireNonEmpty === true && normalized.size === 0) {
    throw new Error('LI.FI allowedExchangeTools must be non-empty');
  }
  return normalized;
}

type ExpectedLifiStepType = 'swap' | 'lifi' | 'protocol';

type NormalizedLifiStepSemantics = {
  action: LifiAction;
  estimate: LifiEstimate;
  tool?: string;
  actionFromAmount: BigNumber;
};

function normalizeLifiStepSemantics(params: {
  step: LifiStep;
  label: string;
  expectedType: ExpectedLifiStepType;
  expectedTool?: string;
  chainId: number;
  fromToken: string;
  toToken: string;
  fromAmount: BigNumber;
  takerAddress: string;
  allowedTools?: Set<string>;
  requireAllowedTool?: boolean;
  requireTakerAddresses?: boolean;
  expectedToolError?: string;
}): NormalizedLifiStepSemantics {
  if (params.step.type !== params.expectedType) {
    throw new Error(`${params.label}.type must be ${params.expectedType}`);
  }
  const tool =
    typeof params.step.tool === 'string'
      ? params.step.tool.trim().toLowerCase()
      : undefined;
  if (
    params.expectedTool !== undefined &&
    tool !== params.expectedTool.toLowerCase()
  ) {
    throw new Error(
      params.expectedToolError ??
        `${params.label}.tool must be ${params.expectedTool}`
    );
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

  if (params.requireAllowedTool) {
    if (!tool || !params.allowedTools?.has(tool)) {
      throw new Error(`${params.label}.tool is not allowlisted`);
    }
  }
  return {
    action,
    estimate,
    tool,
    actionFromAmount,
  };
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
  takerAddress: string;
}): BigNumber {
  const step = normalizeLifiStepSemantics({
    step: params.step,
    label: params.label,
    expectedType: 'protocol',
    expectedTool: 'feecollection',
    expectedToolError: `${params.label} must be feeCollection protocol step`,
    chainId: params.chainId,
    fromToken: params.sourceToken,
    toToken: params.sourceToken,
    fromAmount: params.fromAmount,
    takerAddress: params.takerAddress,
    requireTakerAddresses: false,
  });
  const { quoteAmountRaw, routeMinOutRaw } = parseLifiEstimateOutputs({
    estimate: step.estimate,
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
  takerAddress: string;
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
      takerAddress: params.takerAddress,
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

function normalizeLifiFeeCosts(
  value: unknown,
  fieldName: string
): readonly LifiFeeCost[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array`);
  }
  return value as LifiFeeCost[];
}

function getOptionalLifiStepFeeCosts(
  step: LifiStep,
  fieldName: string
): readonly LifiFeeCost[] | undefined {
  if (
    step.estimate === undefined ||
    step.estimate === null ||
    typeof step.estimate !== 'object' ||
    Array.isArray(step.estimate)
  ) {
    return undefined;
  }
  return normalizeLifiFeeCosts(
    (step.estimate as LifiEstimate).feeCosts,
    fieldName
  );
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
  requireAllowedExchangeTool: boolean;
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
  const topLevelFeeCosts = getOptionalLifiStepFeeCosts(
    params.quote,
    'LI.FI top-level feeCosts'
  );

  const topLevelStep = normalizeLifiStepSemantics({
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
      params.requireAllowedExchangeTool &&
      (quoteType === 'swap' ||
        (quoteType === 'lifi' &&
          typeof params.quote.tool === 'string' &&
          params.quote.tool.trim().toLowerCase() !== 'lifi')),
  });
  const topLevelTool = topLevelStep.tool;
  const included = getExecutableIncludedSwap({
    quote: params.quote,
    includedSteps: getIncludedSteps(params.quote, 'LI.FI quote'),
    chainId: params.chainId,
    fromToken: params.fromToken,
    fromAmount: params.fromAmount,
    takerAddress: params.takerAddress,
  });

  if (!included.swapStep) {
    const directTopLevelTool = requireStepTool(topLevelTool, 'LI.FI quote');
    return {
      kind: 'direct-swap',
      topLevelTool: directTopLevelTool,
      executableTool: directTopLevelTool,
      topLevelFeeCosts,
      effectiveSwapFromAmount: included.effectiveSwapFromAmount,
      hasFeeCollectionStep: false,
    };
  }
  const resolvedTopLevelTool = requireStepTool(topLevelTool, 'LI.FI quote');

  const executableStep = normalizeLifiStepSemantics({
    step: included.swapStep,
    label: 'LI.FI included swap step',
    expectedType: 'swap',
    chainId: params.chainId,
    fromToken: params.fromToken,
    toToken: params.toToken,
    fromAmount: included.effectiveSwapFromAmount,
    takerAddress: params.takerAddress,
    allowedTools: params.allowedTools,
    requireAllowedTool: params.requireAllowedExchangeTool,
    requireTakerAddresses: false,
  });
  const resolvedExecutableTool = requireStepTool(
    executableStep.tool,
    'LI.FI included swap step'
  );
  const executableSwapEstimate = executableStep.estimate;

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
      topLevelFeeCosts,
      executableSwapStepFeeCosts: normalizeLifiFeeCosts(
        executableSwapEstimate.feeCosts,
        'LI.FI included executable swap step feeCosts'
      ),
      feeCollectionStepFeeCosts: normalizeLifiFeeCosts(
        feeCollectionStepEstimate.feeCosts,
        'LI.FI included feeCollection step feeCosts'
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
    topLevelFeeCosts,
    executableSwapStepFeeCosts: normalizeLifiFeeCosts(
      executableSwapEstimate.feeCosts,
      'LI.FI included executable swap step feeCosts'
    ),
    effectiveSwapFromAmount: included.effectiveSwapFromAmount,
    hasFeeCollectionStep: false,
  };
}
