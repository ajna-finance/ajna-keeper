import type {
  BoundExternalTakeRouteEvaluation,
  ExternalTakeExecutionPlan,
} from '../../src/take/types';
import { createExternalTakeExecutionPlan } from '../../src/take/external-take/execution-plan';

export function singleExternalTakeExecutionPlan<TApprovalContext = unknown>(
  evaluation: BoundExternalTakeRouteEvaluation,
  approvalContext?: TApprovalContext
): ExternalTakeExecutionPlan<TApprovalContext> {
  return createExternalTakeExecutionPlan({
    primaryEvaluation: evaluation,
    primaryApprovalContext: approvalContext,
  });
}

export function malformedSingleExternalTakeExecutionPlan<
  TApprovalContext = unknown,
>(
  evaluation: Record<string, unknown>,
  approvalContext?: TApprovalContext
): ExternalTakeExecutionPlan<TApprovalContext> {
  return singleExternalTakeExecutionPlan(
    evaluation as unknown as BoundExternalTakeRouteEvaluation,
    approvalContext
  );
}
