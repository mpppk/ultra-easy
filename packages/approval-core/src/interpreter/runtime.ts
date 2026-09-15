import { Result } from "@praha/byethrow";

import {
  ApproverResolverProviderError,
  checkApprovalDecisionCandidate,
} from "../approver-resolver.ts";
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

type StartApprovalRuntimeInput = {
  plan: MaterializedApprovalPlan;
  resolver: ApproverResolver;
  startedAt: string;
  supportedInterpreterSemanticsVersions?: readonly number[];
};

type ApprovalDecisionInput = {
  plan: MaterializedApprovalPlan;
  resolver: ApproverResolver;
  state: ApprovalRuntimeState;
  event: ApprovalDecisionEvent;
};

type AdvanceApprovalRuntimeInput = {
  plan: MaterializedApprovalPlan;
  resolver: ApproverResolver;
  state: ApprovalRuntimeState;
  now: string;
};

function unsupportedInterpreterSemanticsVersion(
  version: number,
): UnsupportedInterpreterSemanticsVersionError {
  return new UnsupportedInterpreterSemanticsVersionError({
    code: "unsupported_interpreter_semantics_version",
    version,
  });
}

/**
 * Planへ固定されたsemantics versionを、対応する実装へdispatchする。
 * supportedInterpreterSemanticsVersionsはdeployment側のallow-listであり、
 * 実装が存在しないversionを有効化するものではない。
 */
export async function startApprovalRuntime(
  input: StartApprovalRuntimeInput,
): Result.ResultAsync<ApprovalRuntimeState, ApprovalInterpreterError> {
  const version = input.plan.interpreterSemanticsVersion;
  const configured = input.supportedInterpreterSemanticsVersions;
  if (configured && !configured.includes(version)) {
    return Result.fail(unsupportedInterpreterSemanticsVersion(version));
  }

  switch (version) {
    case 1:
      return startApprovalRuntimeV1(input);
    default:
      return Result.fail(unsupportedInterpreterSemanticsVersion(version));
  }
}

async function startApprovalRuntimeV1(
  input: StartApprovalRuntimeInput,
): Result.ResultAsync<ApprovalRuntimeState, ApprovalInterpreterError> {
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
  if ((input.step.resolution ?? "dynamic") !== "dynamic") {
    return Result.succeed(isProjected);
  }
  return checkApprovalDecisionCandidate({
    resolver: input.resolver,
    target: input.task.target,
    userId: input.userId,
  });
}

/**
 * Decisionそのものをstateへ記録する。後続Stepのactivationは行わない。
 * durable runtimeはこのstateを先に永続化してからadvanceApprovalRuntimeを呼ぶことで、
 * activation側の一時障害やfail-closedで受理済みDecisionを失わない。
 */
export async function recordApprovalDecision(
  input: ApprovalDecisionInput,
): Result.ResultAsync<ApprovalDecisionReceipt, ApprovalInterpreterError> {
  switch (input.plan.interpreterSemanticsVersion) {
    case 1:
      return recordApprovalDecisionV1(input);
    default:
      return Result.fail(
        unsupportedInterpreterSemanticsVersion(input.plan.interpreterSemanticsVersion),
      );
  }
}

async function recordApprovalDecisionV1(
  input: ApprovalDecisionInput,
): Result.ResultAsync<ApprovalDecisionReceipt, ApprovalInterpreterError> {
  const state = cloneState(input.state);
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

  const decidedAt = parseTimestamp(input.event.decidedAt);
  const activatedAt = parseTimestamp(task.activatedAt);
  if (decidedAt === null || activatedAt === null || decidedAt < activatedAt) {
    return Result.fail(
      new InvalidRuntimeTimestampError({
        code: "invalid_runtime_timestamp",
        value: input.event.decidedAt,
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
  updateRootStatus(input.plan, state, input.event.decidedAt);
  return Result.succeed({ state, duplicate: false });
}

/** 現在のstateから新たにactivate可能なStepを進める。 */
export async function advanceApprovalRuntime(
  input: AdvanceApprovalRuntimeInput,
): Result.ResultAsync<ApprovalRuntimeState, ApprovalInterpreterError> {
  switch (input.plan.interpreterSemanticsVersion) {
    case 1:
      return advanceApprovalRuntimeV1(input);
    default:
      return Result.fail(
        unsupportedInterpreterSemanticsVersion(input.plan.interpreterSemanticsVersion),
      );
  }
}

async function advanceApprovalRuntimeV1(
  input: AdvanceApprovalRuntimeInput,
): Result.ResultAsync<ApprovalRuntimeState, ApprovalInterpreterError> {
  if (parseTimestamp(input.now) === null) {
    return Result.fail(
      new InvalidRuntimeTimestampError({ code: "invalid_runtime_timestamp", value: input.now }),
    );
  }

  const state = cloneState(input.state);
  if (state.status !== "pending") return Result.succeed(state);

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

export async function applyApprovalDecision(
  input: ApprovalDecisionInput,
): Result.ResultAsync<ApprovalDecisionReceipt, ApprovalInterpreterError> {
  const recorded = await recordApprovalDecision(input);
  if (Result.isFailure(recorded)) return recorded;

  const advanced = await advanceApprovalRuntime({
    plan: input.plan,
    resolver: input.resolver,
    state: recorded.value.state,
    now: input.event.decidedAt,
  });
  if (Result.isFailure(advanced)) return advanced;
  return Result.succeed({ state: advanced.value, duplicate: recorded.value.duplicate });
}

export function nextApprovalRuntimeExpiry(state: ApprovalRuntimeState): string | undefined {
  return state.tasks
    .filter((task) => task.status === "pending" && task.expiresAt)
    .map((task) => task.expiresAt!)
    .sort(compareStrings)[0];
}

export async function expireApprovalRuntime(
  input: AdvanceApprovalRuntimeInput,
): Result.ResultAsync<ApprovalRuntimeState, ApprovalInterpreterError> {
  switch (input.plan.interpreterSemanticsVersion) {
    case 1:
      return expireApprovalRuntimeV1(input);
    default:
      return Result.fail(
        unsupportedInterpreterSemanticsVersion(input.plan.interpreterSemanticsVersion),
      );
  }
}

async function expireApprovalRuntimeV1(
  input: AdvanceApprovalRuntimeInput,
): Result.ResultAsync<ApprovalRuntimeState, ApprovalInterpreterError> {
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
