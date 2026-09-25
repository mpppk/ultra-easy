import { Result } from "@praha/byethrow";

import type { AuthorizationEvidence } from "./authorization.ts";
import type {
  ActionFingerprint,
  ActionRequestId,
  ApprovalBindingFingerprint,
  ApprovalPlanChecksum,
  ApprovalStepKey,
  ApprovalTaskId,
  EvaluationSnapshotChecksum,
  MaterializedStepId,
  OrganizationId,
  UserId,
} from "./domain/brand.ts";
import type { DelegationHop, PrincipalRef } from "./domain/principal.ts";
import type {
  ApprovalDecisionValue,
  ApprovalRuntimeState,
  ApprovalTaskRuntimeState,
} from "./interpreter/types.ts";
import type {
  MaterializedApprovalPlan,
  MaterializedApprovalStep,
  MaterializedFlow,
  ResolvedApproverTarget,
} from "./materialization.ts";

export type ActionCompletedResult =
  | "executed"
  | "rejected"
  | "cancelled"
  | "expired"
  | "authorization_revoked"
  | "authorization_check_failed"
  | "execution_failed";

export type ActionEvent =
  | {
      type: "action.received";
      actionRequestId: ActionRequestId;
      actor: PrincipalRef;
      authority: PrincipalRef;
      caller?: PrincipalRef;
      delegationChain?: DelegationHop[];
      actionFingerprint: ActionFingerprint;
    }
  | {
      type: "action.authorized";
      actionRequestId: ActionRequestId;
      evidence: AuthorizationEvidence;
    }
  | {
      type: "action.authorization_denied";
      actionRequestId: ActionRequestId;
      code: string;
      reason: string;
    }
  | {
      type: "action.authorization_check_failed";
      actionRequestId: ActionRequestId;
      code: string;
    }
  | {
      type: "approval_plan.materialized";
      actionRequestId: ActionRequestId;
      evaluationSnapshotChecksum: EvaluationSnapshotChecksum;
      approvalPlanChecksum: ApprovalPlanChecksum;
      interpreterSemanticsVersion: number;
    }
  | {
      type: "workflow.started";
      actionRequestId: ActionRequestId;
      workflowInstanceId: string;
    }
  | {
      type: "step.activated";
      actionRequestId: ActionRequestId;
      materializedStepId: MaterializedStepId;
      stepKey: ApprovalStepKey;
      purpose?: string;
      target?: ResolvedApproverTarget;
    }
  | {
      type: "step.approved";
      actionRequestId: ActionRequestId;
      materializedStepId: MaterializedStepId;
      stepKey: ApprovalStepKey;
      decisionKey: string;
      actorId: UserId;
      approvalBindingFingerprint?: ApprovalBindingFingerprint;
      comment?: string;
    }
  | {
      type: "step.rejected";
      actionRequestId: ActionRequestId;
      materializedStepId: MaterializedStepId;
      stepKey: ApprovalStepKey;
      decisionKey: string;
      actorId: UserId;
      approvalBindingFingerprint?: ApprovalBindingFingerprint;
      comment?: string;
    }
  | {
      /**
       * Durable runtimeが受け取ったDecisionを業務制約（closed task・候補外・既決・自己承認・
       * comment必須など）で却下した記録。runtime stateは変化せず、同じTaskの待機を継続する。
       */
      type: "approval_decision.rejected";
      actionRequestId: ActionRequestId;
      taskId: ApprovalTaskId;
      decisionKey: string;
      actorId: UserId;
      decision: ApprovalDecisionValue;
      code: string;
    }
  | {
      type: "step.expired";
      actionRequestId: ActionRequestId;
      materializedStepId: MaterializedStepId;
      stepKey: ApprovalStepKey;
    }
  | {
      type: "action.reauthorized";
      actionRequestId: ActionRequestId;
      evidence: AuthorizationEvidence;
    }
  | {
      type: "action.reauthorization_denied";
      actionRequestId: ActionRequestId;
      code: string;
      reason: string;
    }
  | {
      type: "action.reauthorization_check_failed";
      actionRequestId: ActionRequestId;
      code: string;
    }
  | {
      type: "action.execution_started";
      actionRequestId: ActionRequestId;
      idempotencyKey: string;
    }
  | {
      type: "action.execution_failed";
      actionRequestId: ActionRequestId;
      code: string;
      retriable: boolean;
    }
  | {
      type: "action.completed";
      actionRequestId: ActionRequestId;
      result: ActionCompletedResult;
    };

export type ActionEventRecord = {
  organizationId: OrganizationId;
  eventKey: string;
  occurredAt: string;
  event: ActionEvent;
};

export class ActionEventRepositoryError extends Error {
  readonly name: string = "ActionEventRepositoryError";

  constructor(
    readonly code: string,
    readonly retriable: boolean,
    message: string,
  ) {
    super(message);
  }
}

export interface ActionEventRepository {
  appendMany(
    records: readonly ActionEventRecord[],
  ): Result.ResultAsync<void, ActionEventRepositoryError>;
  listForAction(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
  }): Result.ResultAsync<ActionEventRecord[], ActionEventRepositoryError>;
}

function eventDiscriminator(event: ActionEvent): string {
  switch (event.type) {
    case "step.approved":
    case "step.rejected":
      return `${String(event.materializedStepId)}:${event.decisionKey}`;
    case "approval_decision.rejected":
      return `${String(event.taskId)}:${event.decisionKey}`;
    case "step.activated":
    case "step.expired":
      return String(event.materializedStepId);
    case "workflow.started":
      return event.workflowInstanceId;
    default:
      return "action";
  }
}

/**
 * Stable identity for one logical domain transition.
 * Workflow retries/replays reuse the same key so append-only persistence can
 * suppress duplicate delivery without mutating an existing audit row.
 */
export function actionEventKey(input: {
  organizationId: OrganizationId;
  event: ActionEvent;
}): string {
  return [
    String(input.organizationId),
    String(input.event.actionRequestId),
    input.event.type,
    eventDiscriminator(input.event),
  ].join(":");
}

export function actionEventRecord(input: {
  organizationId: OrganizationId;
  occurredAt: string;
  event: ActionEvent;
}): ActionEventRecord {
  return {
    ...input,
    eventKey: actionEventKey({ organizationId: input.organizationId, event: input.event }),
  };
}

export function actionPlanAuditEvents(input: {
  plan: MaterializedApprovalPlan;
  authorizationEvidence?: AuthorizationEvidence;
}): ActionEventRecord[] {
  const { plan } = input;
  const occurredAt = plan.evaluationSnapshot.evaluatedAt;
  const received: ActionEvent = {
    type: "action.received",
    actionRequestId: plan.actionRequestId,
    actor: plan.evaluationSnapshot.actor,
    authority: plan.evaluationSnapshot.authority.principal,
    ...(plan.evaluationSnapshot.origin.caller
      ? { caller: plan.evaluationSnapshot.origin.caller }
      : {}),
    ...(plan.evaluationSnapshot.authority.delegation
      ? { delegationChain: plan.evaluationSnapshot.authority.delegation.chain }
      : {}),
    actionFingerprint: plan.actionFingerprint,
  };
  const materialized: ActionEvent = {
    type: "approval_plan.materialized",
    actionRequestId: plan.actionRequestId,
    evaluationSnapshotChecksum: plan.evaluationSnapshotChecksum,
    approvalPlanChecksum: plan.approvalPlanChecksum,
    interpreterSemanticsVersion: plan.interpreterSemanticsVersion,
  };
  return [
    actionEventRecord({ organizationId: plan.organizationId, occurredAt, event: received }),
    ...(input.authorizationEvidence
      ? [
          actionEventRecord({
            organizationId: plan.organizationId,
            occurredAt: input.authorizationEvidence.evaluatedAt,
            event: {
              type: "action.authorized",
              actionRequestId: plan.actionRequestId,
              evidence: input.authorizationEvidence,
            },
          }),
        ]
      : []),
    actionEventRecord({ organizationId: plan.organizationId, occurredAt, event: materialized }),
  ];
}

function findStep(
  flow: MaterializedFlow,
  materializedStepId: MaterializedStepId,
): MaterializedApprovalStep | null {
  if (flow.type === "approval") {
    return String(flow.materializedStepId) === String(materializedStepId) ? flow : null;
  }
  if (flow.type === "none") return null;
  for (const child of flow.children) {
    const found = findStep(child, materializedStepId);
    if (found) return found;
  }
  return null;
}

function taskByStep(state: ApprovalRuntimeState | null): Map<string, ApprovalTaskRuntimeState> {
  return new Map((state?.tasks ?? []).map((task) => [String(task.materializedStepId), task]));
}

/**
 * Derives domain events from an immutable before/after runtime transition.
 * It deliberately records only semantic transitions, never the mutable
 * projection itself, so the audit log remains replay-safe.
 */
export function actionRuntimeTransitionEvents(input: {
  plan: MaterializedApprovalPlan;
  previousState: ApprovalRuntimeState | null;
  nextState: ApprovalRuntimeState;
  workflowInstanceId?: string;
}): ActionEventRecord[] {
  const records: ActionEventRecord[] = [];
  const previousTasks = taskByStep(input.previousState);

  if (!input.previousState && input.workflowInstanceId) {
    records.push(
      actionEventRecord({
        organizationId: input.plan.organizationId,
        occurredAt: input.nextState.startedAt,
        event: {
          type: "workflow.started",
          actionRequestId: input.plan.actionRequestId,
          workflowInstanceId: input.workflowInstanceId,
        },
      }),
    );
  }

  for (const task of input.nextState.tasks) {
    const previous = previousTasks.get(String(task.materializedStepId));
    const step = findStep(input.plan.flow, task.materializedStepId);
    if (!step) continue;

    if (!previous) {
      records.push(
        actionEventRecord({
          organizationId: input.plan.organizationId,
          occurredAt: task.activatedAt,
          event: {
            type: "step.activated",
            actionRequestId: input.plan.actionRequestId,
            materializedStepId: task.materializedStepId,
            stepKey: step.stepKey,
            ...(step.purpose ? { purpose: step.purpose } : {}),
            target: task.target,
          },
        }),
      );
    }

    const previousDecisionKeys = new Set(
      (previous?.decisions ?? []).map((decision) => decision.idempotencyKey),
    );
    for (const decision of task.decisions) {
      if (previousDecisionKeys.has(decision.idempotencyKey)) continue;
      records.push(
        actionEventRecord({
          organizationId: input.plan.organizationId,
          occurredAt: decision.decidedAt,
          event: {
            type: decision.decision === "approve" ? "step.approved" : "step.rejected",
            actionRequestId: input.plan.actionRequestId,
            materializedStepId: task.materializedStepId,
            stepKey: step.stepKey,
            decisionKey: decision.idempotencyKey,
            actorId: decision.userId,
            ...(decision.approvalBindingFingerprint
              ? { approvalBindingFingerprint: decision.approvalBindingFingerprint }
              : {}),
            ...(decision.comment !== undefined ? { comment: decision.comment } : {}),
          },
        }),
      );
    }

    if (previous?.status === task.status || task.status !== "expired") continue;
    const occurredAt = task.closedAt ?? input.nextState.completedAt ?? input.nextState.startedAt;
    records.push(
      actionEventRecord({
        organizationId: input.plan.organizationId,
        occurredAt,
        event: {
          type: "step.expired",
          actionRequestId: input.plan.actionRequestId,
          materializedStepId: task.materializedStepId,
          stepKey: step.stepKey,
        },
      }),
    );
  }

  if (
    input.previousState?.status !== input.nextState.status &&
    (input.nextState.status === "rejected" ||
      input.nextState.status === "expired" ||
      input.nextState.status === "cancelled")
  ) {
    records.push(
      actionEventRecord({
        organizationId: input.plan.organizationId,
        occurredAt: input.nextState.completedAt ?? input.nextState.startedAt,
        event: {
          type: "action.completed",
          actionRequestId: input.plan.actionRequestId,
          result: input.nextState.status,
        },
      }),
    );
  }

  return records;
}
