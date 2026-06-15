import { LiquiditySource } from '../../config';
import {
  BoundExternalTakeRouteEvaluation,
  ExternalTakeEvaluationResult,
  ExternalTakeExecutionCandidate,
  ExternalTakeExecutionPlan,
  ExternalTakeQuoteEvaluation,
} from '../types';
import { bindExternalTakeRouteForCandidate } from './quote-approval-rules';

export function createExternalTakeExecutionCandidate<TApprovalContext>(params: {
  evaluation: BoundExternalTakeRouteEvaluation;
  approvalContext?: TApprovalContext;
}): ExternalTakeExecutionCandidate<TApprovalContext> {
  return {
    evaluation: params.evaluation,
    ...(params.approvalContext === undefined
      ? {}
      : { approvalContext: params.approvalContext }),
  };
}

export function createExternalTakeExecutionPlan<TApprovalContext>(params: {
  primaryEvaluation: BoundExternalTakeRouteEvaluation;
  primaryApprovalContext?: TApprovalContext;
  fallbacks?: readonly ExternalTakeExecutionCandidate<TApprovalContext>[];
}): ExternalTakeExecutionPlan<TApprovalContext> {
  return {
    primary: createExternalTakeExecutionCandidate({
      evaluation: params.primaryEvaluation,
      approvalContext: params.primaryApprovalContext,
    }),
    fallbacks: [...(params.fallbacks ?? [])],
  };
}

export function replaceExternalTakeExecutionPlanPrimary<TApprovalContext>(params: {
  plan: ExternalTakeExecutionPlan<TApprovalContext>;
  primaryEvaluation: BoundExternalTakeRouteEvaluation;
  primaryApprovalContext?: TApprovalContext;
}): ExternalTakeExecutionPlan<TApprovalContext> {
  return {
    primary: createExternalTakeExecutionCandidate({
      evaluation: params.primaryEvaluation,
      approvalContext: params.primaryApprovalContext,
    }),
    fallbacks: params.plan.fallbacks,
  };
}

export function bindExternalTakeQuoteToExecutionResult<TApprovalContext>(params: {
  quoteEvaluation: ExternalTakeQuoteEvaluation;
  selectedLiquiditySource?: LiquiditySource;
  configuredLiquiditySource?: LiquiditySource;
  poolName: string;
  borrower: string;
  approvalContext?: TApprovalContext;
}): ExternalTakeEvaluationResult<TApprovalContext> {
  if (!params.quoteEvaluation.isTakeable) {
    return {
      takeable: false,
      quoteEvaluation: params.quoteEvaluation,
      reason: params.quoteEvaluation.reason,
    };
  }

  const binding = bindExternalTakeRouteForCandidate({
    quoteEvaluation: params.quoteEvaluation,
    selectedLiquiditySource: params.selectedLiquiditySource,
    configuredLiquiditySource: params.configuredLiquiditySource,
    poolName: params.poolName,
    borrower: params.borrower,
  });
  if (!binding.bound) {
    return {
      takeable: false,
      quoteEvaluation: params.quoteEvaluation,
      reason: binding.reason,
    };
  }

  return {
    takeable: true,
    executionPlan: createExternalTakeExecutionPlan({
      primaryEvaluation: binding.quoteEvaluation,
      primaryApprovalContext: params.approvalContext,
    }),
  };
}

export function resolveExternalTakeExecutionCandidates<TApprovalContext>(params: {
  executionPlan?: ExternalTakeExecutionPlan<TApprovalContext>;
}): readonly ExternalTakeExecutionCandidate<TApprovalContext>[] {
  if (!params.executionPlan) {
    return [];
  }
  return [params.executionPlan.primary, ...params.executionPlan.fallbacks];
}

export function getExternalTakeExecutionPlanPrimaryEvaluation<TApprovalContext>(
  executionPlan: ExternalTakeExecutionPlan<TApprovalContext> | undefined
): BoundExternalTakeRouteEvaluation | undefined {
  return executionPlan?.primary.evaluation;
}
