import { Result } from "@praha/byethrow";

import {
  NoApproverCandidatesError,
  resolveApproverCandidates,
  type ResolvedApproverCandidates,
} from "../approver-resolver.ts";
import type { UserId } from "../domain/brand.ts";
import type { MaterializedApprovalStep, MaterializedFlow } from "../materialization.ts";
import { NoEligibleApproverCandidatesError } from "./errors.ts";
import type { ApprovalInterpreterError } from "./errors.ts";
import {
  asTaskId,
  effectiveDistinctScopeId,
  flowStatus,
  isSameUser,
  selfApprovalSubject,
  stepExpiresAt,
  taskForStep,
  uniqueUsers,
  usersUsedInDistinctScope,
} from "./state.ts";
import type { ApprovalInterpreterContext, ApprovalTaskRuntimeState } from "./types.ts";

function resolutionFor(step: MaterializedApprovalStep): "dynamic" | "snapshot" {
  return step.resolution ?? "dynamic";
}

function requiredApprovalCount(
  step: MaterializedApprovalStep,
  task: ApprovalTaskRuntimeState,
): number {
  const completion = step.candidateCompletion ?? "any";
  if (completion === "any") return 1;
  if (completion === "all") return task.candidateUserIds.length;
  return completion.count;
}

function usersUsedByOtherTasks(
  context: ApprovalInterpreterContext,
  distinctScopeId: string,
  task: ApprovalTaskRuntimeState,
): Set<string> {
  const used = new Set<string>();
  for (const candidate of context.state.tasks) {
    if (candidate.distinctScopeId !== distinctScopeId || candidate.id === task.id) continue;
    for (const decision of candidate.decisions) used.add(String(decision.userId));
  }
  return used;
}

/**
 * self-approval / distinctApproversの除外後に承認できる候補が残らないstepは、承認者を解決できない
 * stepと同じく`onUnresolved: fallback`の候補を使う（fallback先でも除外は同じに適用する）。
 * fallbackが無い・fallbackでも候補が無ければnull（呼び出し側の従来のfail closedのまま）。
 */
async function eligibleFallback(
  step: MaterializedApprovalStep,
  primary: ResolvedApproverCandidates,
  excluded: (userId: UserId) => boolean,
  context: ApprovalInterpreterContext,
): Result.ResultAsync<
  (ResolvedApproverCandidates & { eligible: UserId[] }) | null,
  ApprovalInterpreterError
> {
  if (primary.usedFallback || step.onUnresolved?.type !== "fallback") return Result.succeed(null);
  const { onUnresolved, ...rest } = step;
  const fallback = await resolveApproverCandidates({
    resolver: context.resolver,
    step: { ...rest, target: onUnresolved.target },
    consistency: "minimize_latency",
  });
  if (Result.isFailure(fallback)) {
    return fallback.error instanceof NoApproverCandidatesError ? Result.succeed(null) : fallback;
  }
  const eligible = uniqueUsers(fallback.value.userIds.filter((userId) => !excluded(userId)));
  return Result.succeed(
    eligible.length > 0 ? { ...fallback.value, usedFallback: true, eligible } : null,
  );
}

async function reconcilePendingStep(
  step: MaterializedApprovalStep,
  distinctScopeId: string | undefined,
  task: ApprovalTaskRuntimeState,
  context: ApprovalInterpreterContext,
): Result.ResultAsync<void, ApprovalInterpreterError> {
  if (task.status !== "pending") return Result.succeed(undefined);

  const selfSubject = selfApprovalSubject(context.plan, step);
  const used = distinctScopeId
    ? usersUsedByOtherTasks(context, distinctScopeId, task)
    : new Set<string>();

  if (resolutionFor(step) === "dynamic") {
    const resolved = await resolveApproverCandidates({
      resolver: context.resolver,
      step,
      consistency: "minimize_latency",
    });
    if (Result.isFailure(resolved)) {
      if (resolved.error instanceof NoApproverCandidatesError) {
        task.candidateUserIds = [];
      } else {
        return resolved;
      }
    } else {
      const excluded = (userId: UserId) =>
        isSameUser(selfSubject, userId) || used.has(String(userId));
      let candidates: ResolvedApproverCandidates = resolved.value;
      let eligible = uniqueUsers(candidates.userIds.filter((userId) => !excluded(userId)));
      if (eligible.length === 0) {
        const fallback = await eligibleFallback(step, candidates, excluded, context);
        if (Result.isFailure(fallback)) return fallback;
        if (fallback.value) {
          candidates = fallback.value;
          eligible = fallback.value.eligible;
        }
      }
      task.target = candidates.target;
      task.candidateUserIds = eligible;
      task.usedFallback = candidates.usedFallback;
      if (candidates.sourceRevision) task.sourceRevision = candidates.sourceRevision;
      else delete task.sourceRevision;
    }
  }

  const decidedUsers = new Set(task.decisions.map((decision) => String(decision.userId)));
  const approvals = task.decisions.filter((decision) => decision.decision === "approve").length;
  const available = task.candidateUserIds.filter(
    (userId) => !used.has(String(userId)) && !decidedUsers.has(String(userId)),
  ).length;
  const required = requiredApprovalCount(step, task);

  if (approvals + available < required) {
    task.status = "rejected";
    task.closedAt = context.now;
  }

  return Result.succeed(undefined);
}

async function activateStep(
  step: MaterializedApprovalStep,
  distinctScopeId: string | undefined,
  context: ApprovalInterpreterContext,
): Result.ResultAsync<void, ApprovalInterpreterError> {
  const existing = taskForStep(context.state, step.materializedStepId);
  if (existing) return reconcilePendingStep(step, distinctScopeId, existing, context);

  const resolved = await resolveApproverCandidates({
    resolver: context.resolver,
    step,
    consistency: "minimize_latency",
  });
  if (Result.isFailure(resolved)) return resolved;

  const selfSubject = selfApprovalSubject(context.plan, step);
  const used = distinctScopeId
    ? usersUsedInDistinctScope(context.state, distinctScopeId)
    : new Set<string>();
  const excluded = (userId: UserId) => isSameUser(selfSubject, userId) || used.has(String(userId));
  let candidates: ResolvedApproverCandidates = resolved.value;
  let candidateUserIds = uniqueUsers(candidates.userIds.filter((userId) => !excluded(userId)));
  if (candidateUserIds.length === 0) {
    const fallback = await eligibleFallback(step, candidates, excluded, context);
    if (Result.isFailure(fallback)) return fallback;
    if (fallback.value) {
      candidates = fallback.value;
      candidateUserIds = fallback.value.eligible;
    }
  }
  const completion = step.candidateCompletion ?? "any";
  const minimumCandidateCount =
    typeof completion === "object" ? completion.count : candidateUserIds.length > 0 ? 1 : 0;
  if (candidateUserIds.length === 0 || candidateUserIds.length < minimumCandidateCount) {
    return Result.fail(
      new NoEligibleApproverCandidatesError({
        code: "no_eligible_approver_candidates",
        materializedStepId: step.materializedStepId,
      }),
    );
  }

  const expiration = stepExpiresAt(context.now, step);
  if (Result.isFailure(expiration)) return expiration;
  context.state.tasks.push({
    id: asTaskId(context.plan, step),
    materializedStepId: step.materializedStepId,
    status: "pending",
    target: candidates.target,
    candidateUserIds,
    decisions: [],
    activatedAt: context.now,
    ...(expiration.value ? { expiresAt: expiration.value } : {}),
    ...(distinctScopeId ? { distinctScopeId } : {}),
    ...(candidates.sourceRevision ? { sourceRevision: candidates.sourceRevision } : {}),
    usedFallback: candidates.usedFallback,
  });
  return Result.succeed(undefined);
}

/** 現在のFlow状態から、今activate可能なApproval Stepだけを作成する。 */
export async function activateReadyNode(
  flow: MaterializedFlow,
  path: string,
  inheritedDistinctScopeId: string | undefined,
  context: ApprovalInterpreterContext,
): Result.ResultAsync<void, ApprovalInterpreterError> {
  const status = flowStatus(flow, context.state);
  if (status !== "not_started" && status !== "pending") return Result.succeed(undefined);

  if (flow.type === "none") return Result.succeed(undefined);
  if (flow.type === "approval") {
    return activateStep(flow, inheritedDistinctScopeId, context);
  }

  const distinctScopeId = effectiveDistinctScopeId(flow, path, inheritedDistinctScopeId);
  if (flow.type === "serial") {
    for (let index = 0; index < flow.children.length; index += 1) {
      const child = flow.children[index]!;
      const childStatus = flowStatus(child, context.state);
      if (childStatus === "approved") continue;
      if (childStatus === "not_started" || childStatus === "pending") {
        return activateReadyNode(child, `${path}.children[${index}]`, distinctScopeId, context);
      }
      return Result.succeed(undefined);
    }
    return Result.succeed(undefined);
  }

  for (let index = 0; index < flow.children.length; index += 1) {
    const child = flow.children[index]!;
    const childStatus = flowStatus(child, context.state);
    if (childStatus !== "not_started" && childStatus !== "pending") continue;
    const activated = await activateReadyNode(
      child,
      `${path}.children[${index}]`,
      distinctScopeId,
      context,
    );
    if (Result.isFailure(activated)) return activated;
  }
  return Result.succeed(undefined);
}
