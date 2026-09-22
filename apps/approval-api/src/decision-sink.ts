import { Result } from "@praha/byethrow";

import type {
  ActionRequestId,
  ApprovalDecisionValue,
  ApprovalTaskId,
  OrganizationId,
  UserId,
} from "@app/approval-core";
import {
  PublicApiRepositoryError,
  type ApprovalDecisionApplyResult,
  type ApprovalDecisionSink,
} from "@app/approval-application";
import { actionWorkflowInstanceId } from "@app/approval-runtime-cloudflare";

type WorkflowBinding = {
  get(id: string): Promise<{
    sendEvent(input: { type: string; payload: Record<string, unknown> }): Promise<unknown>;
  }>;
};

function fail(
  code: string,
  retriable: boolean,
  message: string,
): Result.Result<never, PublicApiRepositoryError> {
  return Result.fail(new PublicApiRepositoryError(code, retriable, message));
}

/**
 * Decision commandをWorkflowのapproval-decision eventへ配送するsink。
 * commandIdをidempotencyKeyにしてat-least-once配送を冪等化する。
 */
export class WorkflowDecisionSink implements ApprovalDecisionSink {
  constructor(private readonly workflow: WorkflowBinding) {}

  async apply(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
    taskId: ApprovalTaskId;
    userId: UserId;
    decision: ApprovalDecisionValue;
    decidedAt: string;
    commandId: string;
    comment?: string;
  }): Result.ResultAsync<ApprovalDecisionApplyResult, PublicApiRepositoryError> {
    const instanceId = await actionWorkflowInstanceId({
      organizationId: input.organizationId,
      actionRequestId: input.actionRequestId,
    });
    let instance: Awaited<ReturnType<WorkflowBinding["get"]>>;
    try {
      instance = await this.workflow.get(instanceId);
    } catch (error) {
      return fail(
        "decision_workflow_lookup_failed",
        true,
        error instanceof Error ? error.message : String(error),
      );
    }
    try {
      await instance.sendEvent({
        type: "approval-decision",
        payload: {
          idempotencyKey: input.commandId,
          taskId: String(input.taskId),
          userId: String(input.userId),
          decision: input.decision,
          decidedAt: input.decidedAt,
        },
      });
    } catch (error) {
      return fail(
        "decision_workflow_send_failed",
        true,
        error instanceof Error ? error.message : String(error),
      );
    }
    return Result.succeed({ type: "applied" });
  }
}
