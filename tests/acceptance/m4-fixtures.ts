import { Result } from "@praha/byethrow";

import type {
  ActionDefinitionKey,
  ActionFingerprint,
  ActionRequestId,
  ApprovalBindingFingerprint,
  ApprovalDecisionEvent,
  ApprovalPlanChecksum,
  ApprovalTaskId,
  ApproverCandidateList,
  ApproverResolver,
  ApproverResolverProviderError,
  AuthorizationConsistency,
  EvaluationSnapshotChecksum,
  ExecutorKey,
  MaterializedApprovalPlan,
  MaterializedApprovalStep,
  MaterializedFlow,
  MaterializedStepId,
  OrganizationId,
  RelationName,
  ResolvedApproverTarget,
  ResourceId,
  ResourceType,
  SchemaKey,
  UserId,
} from "@app/approval-core";
import { InMemoryApprovalRuntime } from "@app/approval-runtime-memory";

export function branded<T extends string>(value: string): T {
  return value as T;
}

export const alice = branded<UserId>("user:alice");
export const bob = branded<UserId>("user:bob");
export const carol = branded<UserId>("user:carol");
export const startedAt = "2026-09-13T00:00:00.000Z";

export class MutableResolver implements ApproverResolver {
  private readonly memberships = new Map<string, UserId[]>();

  set(target: ResolvedApproverTarget, users: UserId[]): void {
    this.memberships.set(this.key(target), [...users]);
  }

  async check(input: {
    target: ResolvedApproverTarget;
    userId: UserId;
    context?: Record<string, unknown>;
    consistency: AuthorizationConsistency;
  }): Result.ResultAsync<boolean, ApproverResolverProviderError> {
    return Result.succeed(
      (this.memberships.get(this.key(input.target)) ?? []).some(
        (candidate) => String(candidate) === String(input.userId),
      ),
    );
  }

  async list(input: {
    target: ResolvedApproverTarget;
    context?: Record<string, unknown>;
    consistency: AuthorizationConsistency;
  }): Result.ResultAsync<ApproverCandidateList, ApproverResolverProviderError> {
    return Result.succeed({
      userIds: [...(this.memberships.get(this.key(input.target)) ?? [])],
      complete: true,
    });
  }

  private key(target: ResolvedApproverTarget): string {
    return target.type === "user"
      ? `user:${String(target.userId)}`
      : `${String(target.object)}#${String(target.relation)}`;
  }
}

export function directStep(
  key: string,
  userId: UserId,
  input: Partial<MaterializedApprovalStep> = {},
): MaterializedApprovalStep {
  return {
    type: "approval",
    materializedStepId: branded<MaterializedStepId>(`mstep:${key}`),
    stepKey: branded(key),
    source: {
      policyBindingId: branded(`binding:${key}`),
      policyKey: branded(`policy:${key}`),
      policyVersion: 1,
      flowPath: `root.${key}`,
    },
    target: { type: "user", userId, sourceKind: "user" },
    resolution: "snapshot",
    candidateCompletion: "any",
    ...input,
  };
}

export function relationStep(
  key: string,
  relation: string,
  input: Partial<MaterializedApprovalStep> = {},
): MaterializedApprovalStep {
  return {
    type: "approval",
    materializedStepId: branded<MaterializedStepId>(`mstep:${key}`),
    stepKey: branded(key),
    source: {
      policyBindingId: branded(`binding:${key}`),
      policyKey: branded(`policy:${key}`),
      policyVersion: 1,
      flowPath: `root.${key}`,
    },
    target: {
      type: "relation",
      object: branded(`ticket:TICKET-${key}`),
      relation: branded<RelationName>(relation),
      sourceKind: "relation",
    },
    resolution: "snapshot",
    candidateCompletion: "any",
    ...input,
  };
}

export function plan(
  flow: MaterializedFlow,
  suffix: string,
  version = 1,
): MaterializedApprovalPlan {
  const actionRequestId = branded<ActionRequestId>(`action-request:${suffix}`);
  const organizationId = branded<OrganizationId>("org:m4");
  return {
    schemaVersion: 1,
    actionRequestId,
    organizationId,
    action: {
      definition: {
        key: branded<ActionDefinitionKey>("ticket-priority-change"),
        version: 1,
        actionType: branded("ticket.priority.change"),
        inputSchema: { key: branded<SchemaKey>("ticket-input"), version: 1 },
        executorKey: branded<ExecutorKey>("ticket-executor"),
      },
      type: branded("ticket.priority.change"),
      resource: {
        type: branded<ResourceType>("ticket"),
        id: branded<ResourceId>("TICKET-123"),
      },
      input: {},
    },
    evaluationSnapshot: {
      actor: { type: "user", id: alice },
      authority: { principal: { type: "user", id: alice } },
      origin: { type: "ui" },
      organization: { id: organizationId },
      evaluatedAt: startedAt,
    },
    policyBindingSnapshots: [],
    flow,
    interpreterSemanticsVersion: version,
    actionFingerprint: branded<ActionFingerprint>(`sha256:action-${suffix}`),
    evaluationSnapshotChecksum: branded<EvaluationSnapshotChecksum>(`sha256:evaluation-${suffix}`),
    approvalPlanChecksum: branded<ApprovalPlanChecksum>(`sha256:plan-${suffix}`),
    approvalBindingFingerprint: branded<ApprovalBindingFingerprint>(`sha256:binding-${suffix}`),
  };
}

export function taskId(state: { tasks: { id: ApprovalTaskId }[] }, index = 0): ApprovalTaskId {
  return state.tasks[index]!.id;
}

export function decision(
  taskIdValue: ApprovalTaskId,
  userId: UserId,
  value: "approve" | "reject",
  key: string,
  decidedAt = "2026-09-13T00:01:00.000Z",
): ApprovalDecisionEvent {
  return {
    idempotencyKey: key,
    taskId: taskIdValue,
    userId,
    decision: value,
    decidedAt,
  };
}

export function runtime(
  resolver = new MutableResolver(),
  versions: readonly number[] = [1],
): { runtime: InMemoryApprovalRuntime; resolver: MutableResolver } {
  return { runtime: new InMemoryApprovalRuntime(resolver, versions), resolver };
}
