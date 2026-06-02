import {
  BoundExternalTakeRouteEvaluation,
  ExternalTakeExecutionCandidate,
  ExternalTakeExecutionPlan,
} from './types';

export function bindExternalTakeExecutionPlanPrimary<TApprovalContext>(params: {
  plan: ExternalTakeExecutionPlan<TApprovalContext>;
  primaryEvaluation: BoundExternalTakeRouteEvaluation;
}): ExternalTakeExecutionPlan<TApprovalContext> {
  return {
    primary: {
      ...params.plan.primary,
      evaluation: params.primaryEvaluation,
    },
    fallbacks: params.plan.fallbacks,
  };
}

export function resolveExternalTakeExecutionCandidates<TApprovalContext>(params: {
  primaryEvaluation: BoundExternalTakeRouteEvaluation | undefined;
  executionPlan?: ExternalTakeExecutionPlan<TApprovalContext>;
}): readonly ExternalTakeExecutionCandidate<TApprovalContext>[] {
  if (!params.primaryEvaluation) {
    return [];
  }
  if (params.executionPlan) {
    const plan = bindExternalTakeExecutionPlanPrimary({
      plan: params.executionPlan,
      primaryEvaluation: params.primaryEvaluation,
    });
    return [plan.primary, ...plan.fallbacks];
  }
  return [{ evaluation: params.primaryEvaluation }];
}
