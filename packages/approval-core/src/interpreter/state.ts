import { Result } from "@praha/byethrow";

import type { ApprovalTaskId, MaterializedStepId, UserId } from "../domain/brand.ts";
import type { PrincipalRef } from "../domain/principal.ts";
import type {
  MaterializedApprovalPlan,
  MaterializedApprovalStep,
  MaterializedFlow,
} from "../materialization.ts";
import { InvalidRuntimeTimestampError } from "./errors.ts";
import type {
  ApprovalRuntimeState,
  ApprovalTaskRuntimeState,
  ApprovalTaskRuntimeStatus,
} from "./types.ts";

export type FlowRuntimeStatus = "not_started" | ApprovalRuntimeState["status"];

export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function uniqueUsers(userIds: readonly UserId[]): UserId[] {
  return [...new Map(userIds.map((userId) => [String(userId), userId])).values()].sort((a, b) =>
    compareStrings(String(a), String(b)),
  );
}

export function cloneState(state: ApprovalRuntimeState): ApprovalRuntimeState {
  return structuredClone(state);
}

export function asTaskId(
  plan: MaterializedApprovalPlan,
  step: MaterializedApprovalStep,
): ApprovalTaskId {
  return `task:${String(plan.actionRequestId)}:${String(step.materializedStepId)}` as ApprovalTaskId;
}

export function parseTimestamp(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function stepExpiresAt(
  activatedAt: string,
  step: MaterializedApprovalStep,
): Result.Result<string | undefined, InvalidRuntimeTimestampError> {
  if (!step.expiresAfter) return Result.succeed(undefined);
  const timestamp = parseTimestamp(activatedAt);
  if (timestamp === null) {
    return Result.fail(
      new InvalidRuntimeTimestampError({ code: "invalid_runtime_timestamp", value: activatedAt }),
    );
  }
  return Result.succeed(new Date(timestamp + step.expiresAfter.seconds * 1000).toISOString());
}

export function taskForStep(
  state: ApprovalRuntimeState,
  materializedStepId: MaterializedStepId,
): ApprovalTaskRuntimeState | undefined {
  return state.tasks.find((task) => String(task.materializedStepId) === String(materializedStepId));
}

export function findStep(
  flow: MaterializedFlow,
  materializedStepId: MaterializedStepId,
): MaterializedApprovalStep | undefined {
  if (flow.type === "approval") {
    return String(flow.materializedStepId) === String(materializedStepId) ? flow : undefined;
  }
  if (flow.type === "none") return undefined;
  for (const child of flow.children) {
    const found = findStep(child, materializedStepId);
    if (found) return found;
  }
  return undefined;
}

function taskFlowStatus(task: ApprovalTaskRuntimeState | undefined): FlowRuntimeStatus {
  if (!task) return "not_started";
  if (task.status === "cancelled") return "rejected";
  return task.status;
}

export function flowStatus(flow: MaterializedFlow, state: ApprovalRuntimeState): FlowRuntimeStatus {
  if (flow.type === "none") return "approved";
  if (flow.type === "approval") return taskFlowStatus(taskForStep(state, flow.materializedStepId));

  const statuses = flow.children.map((child) => flowStatus(child, state));
  if (flow.type === "serial") {
    for (const status of statuses) {
      if (status === "approved") continue;
      return status;
    }
    return "approved";
  }

  const approvals = statuses.filter((status) => status === "approved").length;
  const rejections = statuses.filter((status) => status === "rejected").length;
  const expiries = statuses.filter((status) => status === "expired").length;
  const pending = statuses.filter(
    (status) => status === "pending" || status === "not_started",
  ).length;

  if (flow.strategy === "all") {
    if (rejections > 0) return "rejected";
    if (expiries > 0) return "expired";
    return approvals === statuses.length ? "approved" : "pending";
  }
  if (flow.strategy === "any") {
    if (approvals > 0) return "approved";
    if (pending > 0) return "pending";
    if (rejections === statuses.length) return "rejected";
    return "expired";
  }
  if (flow.strategy === "quorum") {
    if (approvals >= flow.quorum) return "approved";
    if (approvals + pending < flow.quorum) return rejections > 0 ? "rejected" : "expired";
  }
  return "pending";
}

export function selfApprovalSubject(
  plan: MaterializedApprovalPlan,
  step: MaterializedApprovalStep,
): PrincipalRef | undefined {
  if (step.selfApproval?.mode !== "deny") return undefined;
  return step.selfApproval.subject ?? plan.evaluationSnapshot.authority.principal;
}

export function isSameUser(subject: PrincipalRef | undefined, userId: UserId): boolean {
  return subject?.type === "user" && String(subject.id) === String(userId);
}

export function usersUsedInDistinctScope(
  state: ApprovalRuntimeState,
  scopeId: string,
): Set<string> {
  const values = new Set<string>();
  for (const task of state.tasks) {
    if (task.distinctScopeId !== scopeId) continue;
    for (const decision of task.decisions) values.add(String(decision.userId));
  }
  return values;
}

export function effectiveDistinctScopeId(
  flow: Extract<MaterializedFlow, { type: "serial" | "parallel" }>,
  path: string,
  inherited?: string,
): string | undefined {
  if (inherited) return inherited;
  return flow.constraints?.distinctApprovers ? path : undefined;
}

export function createInitialApprovalRuntimeState(
  plan: MaterializedApprovalPlan,
  startedAt: string,
): ApprovalRuntimeState {
  return {
    schemaVersion: 1,
    actionRequestId: plan.actionRequestId,
    approvalPlanChecksum: plan.approvalPlanChecksum,
    interpreterSemanticsVersion: plan.interpreterSemanticsVersion,
    status: "pending",
    startedAt,
    tasks: [],
    processedDecisionKeys: [],
  };
}

function cancelPendingTasks(state: ApprovalRuntimeState, closedAt: string): void {
  for (const task of state.tasks) {
    if (task.status !== "pending") continue;
    task.status = "cancelled";
    task.closedAt = closedAt;
  }
}

export function updateRootStatus(
  plan: MaterializedApprovalPlan,
  state: ApprovalRuntimeState,
  now: string,
): void {
  const status = flowStatus(plan.flow, state);
  if (status === "not_started" || status === "pending") {
    state.status = "pending";
    return;
  }
  state.status = status;
  state.completedAt = now;
  cancelPendingTasks(state, now);
}

export function completionForStep(
  step: MaterializedApprovalStep,
  task: ApprovalTaskRuntimeState,
): ApprovalTaskRuntimeStatus {
  const approvals = task.decisions.filter((decision) => decision.decision === "approve").length;
  const rejections = task.decisions.filter((decision) => decision.decision === "reject").length;
  const decidedUsers = new Set(task.decisions.map((decision) => String(decision.userId)));
  const completion = step.candidateCompletion ?? "any";

  if (completion === "any") {
    if (approvals > 0) return "approved";
    if (step.resolution === "snapshot" && decidedUsers.size >= task.candidateUserIds.length) {
      return "rejected";
    }
    return "pending";
  }
  if (completion === "all") {
    if (rejections > 0) return "rejected";
    return approvals >= task.candidateUserIds.length ? "approved" : "pending";
  }

  if (approvals >= completion.count) return "approved";
  const remaining = task.candidateUserIds.length - decidedUsers.size;
  return approvals + remaining < completion.count ? "rejected" : "pending";
}
