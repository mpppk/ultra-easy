import type { AuthorizationEvidence } from "./authorization.ts";
import type {
  ActionFingerprint,
  ActionRequestId,
  ApprovalPlanChecksum,
  ApprovalStepKey,
  EvaluationSnapshotChecksum,
  MaterializedStepId,
  OrganizationId,
  UserId,
} from "./domain/brand.ts";
import type { DelegationHop, PrincipalRef } from "./domain/principal.ts";
import type { ResolvedApproverTarget } from "./materialization.ts";

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
      actorId: UserId;
    }
  | {
      type: "step.rejected";
      actionRequestId: ActionRequestId;
      materializedStepId: MaterializedStepId;
      stepKey: ApprovalStepKey;
      actorId: UserId;
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

function eventDiscriminator(event: ActionEvent): string {
  switch (event.type) {
    case "step.activated":
    case "step.approved":
    case "step.rejected":
    case "step.expired":
      return String(event.materializedStepId);
    case "workflow.started":
      return event.workflowInstanceId;
    default:
      return "action";
  }
}

/**
 * Returns a stable key for one logical domain transition.
 * Workflow retries/replays must reuse this key so append-only persistence can
 * safely collapse duplicate delivery without mutating prior audit rows.
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
