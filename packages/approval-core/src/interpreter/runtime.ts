import { Result } from "@praha/byethrow";

import { ApproverResolverProviderError, checkApproverTarget } from "../approver-resolver.ts";
import type { ApproverResolver } from "../approver-resolver.ts";
import type { UserId } from "../domain/brand.ts";
import type { MaterializedApprovalPlan, MaterializedApprovalStep } from "../materialization.ts";
import { activateReadyNode } from "./activation.ts";
import {
  ApprovalCandidateRejectedError,
  ApprovalCommentRequiredError,
  ApprovalDistinctApproverViolationError,
  ApprovalSelfApprovalDeniedError,
  ApprovalTaskClosedError,
  ApprovalTaskNotFoundError,
  ApprovalUserAlreadyDecidedError,
  InvalidRuntimeTimestampError,
  UnsupportedInterpreterSemanticsVersionError,
} from "./errors.ts";
import type { ApprovalInterpreterError } from "./errors.ts";
import {
  cloneState,
  compareStrings,
  completionForStep,
  createInitialApprovalRuntimeState,
  findStep,
  isSameUser,
  parseTimestamp,
  selfApprovalSubject,
  uniqueUsers,
  updateRootStatus,
  usersUsedInDistinctScope,
} from "./state.ts";
import type {
  ApprovalDecisionEvent,
  ApprovalDecisionReceipt,
  ApprovalRuntimeState,
  ApprovalTaskRuntimeState,
} from "./types.ts";

export { createInitialApprovalRuntimeState } from "./state.ts";

export async function startApprovalRuntime(input: {
  plan: MaterializedApprovalPlan;
  resolver: ApproverResolver;
  startedAt: string;
  supportedInterpreterSemanticsVersions?: readonly number[];
}): Result.ResultAsync<ApprovalRuntimeState, ApprovalInterpreterError> {
  const supported = input.supportedInterpreterSemanticsVersions ?? [1];
  if (!supported.includes(input.plan.interpreterSemanticsVersion)) {
    return Result.fail(
      new UnsupportedInterpreterSemanticsVersionError({
        code: "unsupported_interpreter_semantics_version",
        version: input.plan.interpreterSemanticsVersion,
      }),
    );
  }
  if (parseTimestamp(input.startedAt) === null) {
    return Result.fail(
      new InvalidRuntimeTimestampError({
        code: "invalid_runtime_timestamp",
        value: input.startedAt,
      }),
    );
  }

  const state = createInitialApprovalRuntimeState(input.plan, input.startedAt);
  const activated = await activateReadyNode(input.plan.flow, "root", undefined, {
    plan: input.plan,
    resolver: input.resolver,
    state,
    now: input.startedAt,
  });
  if (Result.isFailure(activated)) return activated;
  updateRootStatus(input.plan, state, input.startedAt);
  return Result.succeed(state);
}

async function validateDecisionCandidate(input: {
  resolver: ApproverResolver;
  step: MaterializedApprovalStep;
  task: ApprovalTaskRuntimeState;
  userId: UserId;
}): Result.ResultAsync<boolean, ApproverResolverProviderError> {
  const isProjected = input.task.candidateUserIds.some(
    (candidate) => String(candidate) === String(input.userId),
  );
  if (input.step.resolution !== "dynamic" || input.task.target.type === "user") {
    return Result.succeed(isProjected);
  }
  return checkApproverTarget({
    resolver: input.resolver,
    target: input.task.target,
    userId: input.userId,
    consistency: "higher_consistency",
  });
}

export async function applyApprovalDecision(input: {
  plan: MaterializedApprovalPlan;
  resolver: ApproverResolver;
  state: ApprovalRuntimeState;
  event: ApprovalDecisionEvent;
}): Result.ResultAsync<ApprovalDecisionReceipt, ApprovalInterpreterError> {
  const state = structuredClone(input.state);
  if (state.processedDecisionKeys.includes(input.event.idempotencyKey)) {
    return Result.succeed({ state, duplicate: true });
  }

  const task = state.tasks.find((candidate) => String(candidate.id) === String(input.event.taskId));
  if (!task) {
    return Result.fail(
      new ApprovalTaskNotFoundError({
        code: "approval_task_not_found",
        taskId: input.event.taskId,
      }),
    );
  }
  if (task.status !== "pending") {
    return Result.fail(
      new ApprovalTaskClosedError({
        code: "approval_task_closed",
        taskId: task.id,
        status: task.status,
      }),
    );
  }

  const step = findStep(input.plan.flow, task.materializedStepId);
  if (!step) {
    return Result.fail(
      new ApprovalTaskNotFoundError({ code: "approval_task_not_found", taskId: task.id }),
    );
  }
  if (task.decisions.some((item) => String(item.userId) === String(input.event.userId))) {
    return Result.fail(
      new ApprovalUserAlreadyDecidedError({
        code: "approval_user_already_decided",
        taskId: task.id,
        userId: input.event.userId,
      }),
    );
  }

  const candidate = await validateDecisionCandidate({
    resolver: input.resolver,
    step,
    task,
    userId: input.event.userId,
  });
  if (Result.isFailure(candidate)) return candidate;
  if (!candidate.value) {
    return Result.fail(
      new ApprovalCandidateRejectedError({
        code: "approval_candidate_rejected",
        taskId: task.id,
        userId: input.event.userId,
      }),
    );
  }

  const selfSubject = selfApprovalSubject(input.plan, step);
  if (isSameUser(selfSubject, input.event.userId)) {
    return Result.fail(
      new ApprovalSelfApprovalDeniedError({
        code: "approval_self_approval_denied",
        taskId: task.id,
        userId: input.event.userId,
      }),
    );
  }
  if (task.distinctScopeId) {
    const used = usersUsedInDistinctScope(state, task.distinctScopeId);
    if (used.has(String(input.event.userId))) {
      return Result.fail(
        new ApprovalDistinctApproverViolationError({
          code: "approval_distinct_approver_violation",
          taskId: task.id,
          userId: input.event.userId,
          scopeId: task.distinctScopeId,
        }),
      );
    }
  }
  if (step.requireCommentOn?.includes(input.event.decision) && !input.event.comment?.trim()) {
    return Result.fail(
      new ApprovalCommentRequiredError({
        code: "approval_comment_required",
        taskId: task.id,
        decision: input.event.decision,
      }),
    );
  }

  if (!task.candidateUserIds.some((id) => String(id) === String(input.event.userId))) {
    task.candidateUserIds = uniqueUsers([...task.candidateUserIds, input.event.userId]);
  }
  task.decisions.push({ ...input.event });
  state.processedDecisionKeys.push(input.event.idempotencyKey);
  task.status = completionForStep(step, task);
  if (task.status !== "pending") task.closedAt = input.event.decidedAt;

  const activated = await activateReadyNode(input.plan.flow, "root", undefined, {
    plan: input.plan,
    resolver: input.resolver,
    state,
    now: input.event.decidedAt,
  });
  if (Result.isFailure(activated)) return activated;
  updateRootStatus(input.plan, state, input.event.decidedAt);
  return Result.succeed({ state, duplicate: false });
}

export function nextApprovalRuntimeExpiry(state: ApprovalRuntimeState): string | undefined {
  return state.tasks
    .filter((task) => task.status === "pending" && task.expiresAt)
    .map((task) => task.expiresAt!)
    .sort(compareStrings)[0];
}

export async function expireApprovalRuntime(input: {
  plan: MaterializedApprovalPlan;
  resolver: ApproverResolver;
  state: ApprovalRuntimeState;
  now: string;
}): Result.ResultAsync<ApprovalRuntimeState, ApprovalInterpreterError> {
  const nowTimestamp = parseTimestamp(input.now);
  if (nowTimestamp === null) {
    return Result.fail(
      new InvalidRuntimeTimestampError({ code: "invalid_runtime_timestamp", value: input.now }),
    );
  }

  const state = cloneState(input.state);
  for (const task of state.tasks) {
    if (task.status !== "pending" || !task.expiresAt) continue;
    const expiry = parseTimestamp(task.expiresAt);
    if (expiry !== null && expiry <= nowTimestamp) {
      task.status = "expired";
      task.closedAt = input.now;
    }
  }

  const activated = await activateReadyNode(input.plan.flow, "root", undefined, {
    plan: input.plan,
    resolver: input.resolver,
    state,
    now: input.now,
  });
  if (Result.isFailure(activated)) return activated;
  updateRootStatus(input.plan, state, input.now);
  return Result.succeed(state);
}
