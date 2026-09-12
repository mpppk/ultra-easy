import { Result } from "@praha/byethrow";

import { resolveApproverCandidates } from "../approver-resolver.ts";
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
import type { ApprovalInterpreterContext } from "./types.ts";

async function activateStep(
  step: MaterializedApprovalStep,
  distinctScopeId: string | undefined,
  context: ApprovalInterpreterContext,
): Result.ResultAsync<void, ApprovalInterpreterError> {
  if (taskForStep(context.state, step.materializedStepId)) return Result.succeed(undefined);

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
  const candidateUserIds = uniqueUsers(
    resolved.value.userIds.filter(
      (userId) => !isSameUser(selfSubject, userId) && !used.has(String(userId)),
    ),
  );
  if (candidateUserIds.length === 0) {
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
    target: resolved.value.target,
    candidateUserIds,
    decisions: [],
    activatedAt: context.now,
    ...(expiration.value ? { expiresAt: expiration.value } : {}),
    ...(distinctScopeId ? { distinctScopeId } : {}),
    ...(resolved.value.sourceRevision ? { sourceRevision: resolved.value.sourceRevision } : {}),
    usedFallback: resolved.value.usedFallback,
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
        return activateReadyNode(
          child,
          `${path}.children[${index}]`,
          distinctScopeId,
          context,
        );
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
