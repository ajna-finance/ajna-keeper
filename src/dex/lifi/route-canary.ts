import { BigNumber, ethers } from 'ethers';
import type { KeeperConfig, LifiDexConfig } from '../../config';
import { getErrorMessage } from '../../utils';
import { fetchLifiQuote, fetchLifiTools } from './client';
import {
  assertLifiToolsContainFilters,
  extractLifiExchangeToolKeys,
  normalizeLifiExchangeFilters,
} from './filters';
import {
  hasBroadExchangeFilter,
  LifiRouteCanaryEnv,
  LifiRouteCanaryRoute,
  resolveLifiRouteCanaryConfig,
} from './route-canary-config';
import { validateLifiQuote } from './validate-route';

export type LifiRouteCanaryCheck = {
  label: string;
  success: boolean;
  skipped?: boolean;
  source: 'lifi-tools' | 'lifi-quote' | 'canary-env';
  error?: string;
  chainId?: number;
  fromToken?: string;
  toToken?: string;
  fromAmount?: string;
  toAmountRaw?: string;
  toAmountMinRaw?: string;
  tool?: string;
  topLevelTool?: string;
  transactionTarget?: string;
  approvalSpender?: string;
  selector?: string;
};

export type LifiRouteCanarySummary = {
  status: 'passed' | 'failed' | 'skipped';
  chainId: number;
  apiBaseUrl: string;
  requireLive: boolean;
  takerAddress?: string;
  checks: LifiRouteCanaryCheck[];
  observedSelectorAllowlist?: Record<string, Record<string, string[]>>;
  observedSelectorsByTool?: Record<
    string,
    Record<string, Record<string, string[]>>
  >;
  failureCount: number;
};

export type LifiRouteCanaryDeps = {
  fetchTools?: (params: {
    config: LifiDexConfig;
    apiKey?: string;
  }) => Promise<unknown>;
  fetchQuote?: typeof fetchLifiQuote;
};

export type RunLifiRouteCanaryInput = {
  env?: LifiRouteCanaryEnv;
  config?: KeeperConfig;
  deps?: LifiRouteCanaryDeps;
};

export type RunLifiRouteCanaryResult = {
  summary: LifiRouteCanarySummary;
  exitCode: number;
};

function buildSkippedSummary(params: {
  chainId: number;
  apiBaseUrl: string;
  requireLive: boolean;
  error: string;
  takerAddress?: string;
}): LifiRouteCanarySummary {
  return {
    status: 'skipped',
    chainId: params.chainId,
    apiBaseUrl: params.apiBaseUrl,
    requireLive: params.requireLive,
    takerAddress: params.takerAddress,
    checks: [
      {
        label: 'canary-env',
        success: false,
        skipped: true,
        source: 'canary-env',
        error: params.error,
      },
    ],
    failureCount: 0,
  };
}

function skippedResult(
  summary: LifiRouteCanarySummary
): RunLifiRouteCanaryResult {
  return {
    summary,
    exitCode: summary.requireLive ? 1 : 0,
  };
}

function addObservedSelector(params: {
  targetMap: Record<string, string[]>;
  target: string;
  selector: string;
}): void {
  const selectors = (params.targetMap[params.target] ??= []);
  if (!selectors.includes(params.selector)) {
    selectors.push(params.selector);
    selectors.sort();
  }
}

function buildObservedSelectorTelemetry(
  checks: readonly LifiRouteCanaryCheck[]
): Pick<
  LifiRouteCanarySummary,
  'observedSelectorAllowlist' | 'observedSelectorsByTool'
> {
  const observedSelectorAllowlist: Record<
    string,
    Record<string, string[]>
  > = {};
  const observedSelectorsByTool: Record<
    string,
    Record<string, Record<string, string[]>>
  > = {};

  for (const check of checks) {
    if (
      !check.success ||
      check.source !== 'lifi-quote' ||
      check.chainId === undefined ||
      check.transactionTarget === undefined ||
      check.selector === undefined ||
      check.tool === undefined
    ) {
      continue;
    }
    const chainKey = String(check.chainId);
    const target = ethers.utils.getAddress(check.transactionTarget);
    const selector = check.selector.toLowerCase();
    const tool = check.tool.trim().toLowerCase();

    addObservedSelector({
      targetMap: (observedSelectorAllowlist[chainKey] ??= {}),
      target,
      selector,
    });
    const toolTargets = (observedSelectorsByTool[chainKey] ??= {});
    addObservedSelector({
      targetMap: (toolTargets[tool] ??= {}),
      target,
      selector,
    });
  }

  return Object.keys(observedSelectorAllowlist).length === 0
    ? {}
    : {
        observedSelectorAllowlist,
        observedSelectorsByTool,
      };
}

async function runLifiToolsCheck(params: {
  config: LifiDexConfig;
  apiKey?: string;
  deps?: LifiRouteCanaryDeps;
}): Promise<{ check: LifiRouteCanaryCheck; exchangeTools?: string[] }> {
  try {
    const filters = normalizeLifiExchangeFilters(params.config);
    const toolsResponse = await (params.deps?.fetchTools ?? fetchLifiTools)({
      config: params.config,
      apiKey: params.apiKey,
    });
    assertLifiToolsContainFilters({ filters, toolsResponse });
    return {
      check: {
        label: 'lifi-tools-filter-validation',
        success: true,
        source: 'lifi-tools',
      },
      exchangeTools: extractLifiExchangeToolKeys(toolsResponse),
    };
  } catch (error) {
    return {
      check: {
        label: 'lifi-tools-filter-validation',
        success: false,
        source: 'lifi-tools',
        error: getErrorMessage(error),
      },
    };
  }
}

async function runLifiQuoteCheck(params: {
  config: LifiDexConfig;
  apiKey?: string;
  chainId: number;
  route: LifiRouteCanaryRoute;
  takerAddress: string;
  callTargets: string[];
  approvalSpenders: string[];
  selectorAllowlist: Record<string, string[]>;
  validationExchangeTools?: string[];
  deps?: LifiRouteCanaryDeps;
}): Promise<LifiRouteCanaryCheck> {
  const routeTaker = params.route.takerAddress ?? params.takerAddress;
  try {
    if (params.callTargets.length === 0) {
      throw new Error('LI.FI call target allowlist is required');
    }
    if (params.approvalSpenders.length === 0) {
      throw new Error('LI.FI approval spender allowlist is required');
    }
    if (Object.keys(params.selectorAllowlist).length === 0) {
      throw new Error('LI.FI selector allowlist is required');
    }
    const result = await (params.deps?.fetchQuote ?? fetchLifiQuote)({
      config: params.config,
      apiKey: params.apiKey,
      request: {
        chainId: params.chainId,
        fromToken: params.route.fromToken,
        toToken: params.route.toToken,
        fromAmount: params.route.fromAmount,
        fromAddress: routeTaker,
        toAddress: routeTaker,
        slippage: params.config.defaultSlippage,
        maxPriceImpact: params.config.maxPriceImpact,
      },
    });
    const approved = validateLifiQuote({
      quote: result.data,
      chainId: params.chainId,
      fromToken: params.route.fromToken,
      toToken: params.route.toToken,
      fromAmount: BigNumber.from(params.route.fromAmount),
      takerAddress: routeTaker,
      allowedExchangeTools:
        params.validationExchangeTools ?? params.config.allowExchanges ?? [],
      callTargetAllowlist: params.callTargets,
      approvalSpenderAllowlist: params.approvalSpenders,
      selectorAllowlist: params.selectorAllowlist,
      feeCostPolicy: params.config.feeCostPolicy,
    });
    return {
      label: params.route.label,
      success: true,
      source: 'lifi-quote',
      chainId: params.chainId,
      fromToken: params.route.fromToken,
      toToken: params.route.toToken,
      fromAmount: params.route.fromAmount,
      toAmountRaw: approved.quoteAmountRaw.toString(),
      toAmountMinRaw: approved.routeMinOutRaw.toString(),
      tool: approved.tool,
      topLevelTool: approved.topLevelTool,
      transactionTarget: approved.transactionTarget,
      approvalSpender: approved.approvalSpender,
      selector: approved.selector,
    };
  } catch (error) {
    return {
      label: params.route.label,
      success: false,
      source: 'lifi-quote',
      chainId: params.chainId,
      fromToken: params.route.fromToken,
      toToken: params.route.toToken,
      fromAmount: params.route.fromAmount,
      error: getErrorMessage(error),
    };
  }
}

export async function runLifiRouteCanary(
  input: RunLifiRouteCanaryInput = {}
): Promise<RunLifiRouteCanaryResult> {
  const resolvedConfig = resolveLifiRouteCanaryConfig({
    env: input.env,
    config: input.config,
  });
  if (resolvedConfig.status === 'skipped') {
    return skippedResult(
      buildSkippedSummary({
        chainId: resolvedConfig.chainId,
        apiBaseUrl: resolvedConfig.apiBaseUrl,
        requireLive: resolvedConfig.requireLive,
        takerAddress: resolvedConfig.takerAddress,
        error: resolvedConfig.error,
      })
    );
  }
  const toolsResult = await runLifiToolsCheck({
    config: resolvedConfig.lifiConfig,
    apiKey: resolvedConfig.apiKey,
    deps: input.deps,
  });
  const checks: LifiRouteCanaryCheck[] = [toolsResult.check];
  const validationExchangeTools =
    hasBroadExchangeFilter(resolvedConfig.lifiConfig) &&
    toolsResult.exchangeTools
      ? toolsResult.exchangeTools
      : undefined;

  for (const route of resolvedConfig.routes) {
    checks.push(
      await runLifiQuoteCheck({
        config: resolvedConfig.lifiConfig,
        apiKey: resolvedConfig.apiKey,
        chainId: resolvedConfig.chainId,
        route,
        takerAddress: resolvedConfig.takerAddress,
        callTargets: resolvedConfig.callTargets,
        approvalSpenders: resolvedConfig.approvalSpenders,
        selectorAllowlist: resolvedConfig.selectorAllowlist,
        validationExchangeTools,
        deps: input.deps,
      })
    );
  }

  const failureCount = checks.filter((check) => !check.success).length;
  const selectorTelemetry = buildObservedSelectorTelemetry(checks);
  const summary: LifiRouteCanarySummary = {
    status: failureCount === 0 ? 'passed' : 'failed',
    chainId: resolvedConfig.chainId,
    apiBaseUrl: resolvedConfig.apiBaseUrl,
    requireLive: resolvedConfig.requireLive,
    takerAddress: resolvedConfig.takerAddress,
    checks,
    ...selectorTelemetry,
    failureCount,
  };
  return {
    summary,
    exitCode: failureCount > 0 ? 1 : 0,
  };
}
