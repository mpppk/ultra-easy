import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";

import type { ApproverResolver } from "../approver-resolver.ts";
import type {
  ActionRequestId,
  ApprovalPlanChecksum,
  ApprovalTaskId,
  MaterializedStepId,
  OrganizationId,
  UserId,
} from "../domain/brand.ts";
import type { MaterializedApprovalPlan, ResolvedApproverTarget } from "../materialization.ts";

export type ApprovalDecisionValue = "approve" | "reject";
export type ApprovalTaskRuntimeStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "cancelled";
export type ApprovalRuntimeStatus = "pending" | "approved" | "rejected" | "expired";

export type ApprovalDecisionEvent = {
  idempotencyKey: string;
  taskId: ApprovalTaskId;
  userId: UserId;
  decision: ApprovalDecisionValue;
  decidedAt: string;
  comment?: string;
};

export type ApprovalTaskRuntimeState = {
  id: ApprovalTaskId;
  materializedStepId: MaterializedStepId;
  status: ApprovalTaskRuntimeStatus;
  target: ResolvedApproverTarget;
  candidateUserIds: UserId[];
  decisions: ApprovalDecisionEvent[];
  activatedAt: string;
  expiresAt?: string;
  closedAt?: string;
  distinctScopeId?: string;
  sourceRevision?: string;
  usedFallback: boolean;
};

export type ApprovalRuntimeState = {
  schemaVersion: 1;
  actionRequestId: ActionRequestId;
  approvalPlanChecksum: ApprovalPlanChecksum;
  interpreterSemanticsVersion: number;
  status: ApprovalRuntimeStatus;
  startedAt: string;
  completedAt?: string;
  tasks: ApprovalTaskRuntimeState[];
  processedDecisionKeys: string[];
};

export type ApprovalDecisionReceipt = {
  state: ApprovalRuntimeState;
  duplicate: boolean;
};

export interface DurableRuntime<RuntimeFailure extends Error> {
  start(input: {
    plan: MaterializedApprovalPlan;
    startedAt: string;
  }): Result.ResultAsync<ApprovalRuntimeState, RuntimeFailure>;
  decide(input: {
    actionRequestId: ActionRequestId;
    event: ApprovalDecisionEvent;
  }): Result.ResultAsync<ApprovalDecisionReceipt, RuntimeFailure>;
  advanceTime(input: {
    actionRequestId: ActionRequestId;
    now: string;
  }): Result.ResultAsync<ApprovalRuntimeState, RuntimeFailure>;
  load(
    actionRequestId: ActionRequestId,
  ): Result.ResultAsync<ApprovalRuntimeState | null, RuntimeFailure>;
}

export class ApprovalRuntimeProjectionRepositoryError extends ErrorFactory({
  name: "ApprovalRuntimeProjectionRepositoryError",
  message: ({ detail }) => `Approval runtime read projectionの永続化に失敗しました: ${detail}`,
  fields: ErrorFactory.fields<{
    code: "approval_runtime_projection_repository_error";
    detail: string;
  }>(),
}) {}

export interface ApprovalRuntimeProjectionRepository {
  replace(input: {
    organizationId: OrganizationId;
    state: ApprovalRuntimeState;
  }): Result.ResultAsync<void, ApprovalRuntimeProjectionRepositoryError>;
  load(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
  }): Result.ResultAsync<ApprovalRuntimeState | null, ApprovalRuntimeProjectionRepositoryError>;
}

export type ApprovalInterpreterContext = {
  plan: MaterializedApprovalPlan;
  resolver: ApproverResolver;
  state: ApprovalRuntimeState;
  now: string;
};
