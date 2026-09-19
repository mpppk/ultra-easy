import { Result } from "@praha/byethrow";

import type {
  ActionDefinition,
  ActionRequestId,
  MaterializedApprovalPlan,
  PolicyEvaluationContext,
  VersionedApprovalPolicyBinding,
} from "@app/approval-core";

export class ActionRequestDependencyError extends Error {
  readonly name = "ActionRequestDependencyError";

  constructor(
    readonly code: string,
    readonly retriable: boolean,
    message: string,
    readonly cause?: Error,
  ) {
    super(message);
  }
}

export interface ActionRequestIdGenerator {
  next(): ActionRequestId;
}

export interface VersionedPolicyBindingResolver {
  resolve(input: {
    context: PolicyEvaluationContext;
    actionDefinition: ActionDefinition;
  }): Result.ResultAsync<readonly VersionedApprovalPolicyBinding[], ActionRequestDependencyError>;
}

export interface ActionWorkflowStarter {
  start(input: {
    plan: MaterializedApprovalPlan;
    startedAt: string;
  }): Result.ResultAsync<{ workflowInstanceId: string }, ActionRequestDependencyError>;
}
