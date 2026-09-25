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
import {
  actionWorkflowInstanceId,
  approvalDecisionWorkflowEvent,
} from "@app/approval-runtime-cloudflare";

type WorkflowBinding = {
  get(id: string): Promise<{
    sendEvent(input: ReturnType<typeof approvalDecisionWorkflowEvent>): Promise<unknown>;
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
 * 配送成功は「delivered」であり、受理/却下はWorkflowがcommandへ書き戻す。
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
      await instance.sendEvent(
        approvalDecisionWorkflowEvent({
          idempotencyKey: input.commandId,
          taskId: input.taskId,
          userId: input.userId,
          decision: input.decision,
          decidedAt: input.decidedAt,
          ...(input.comment !== undefined ? { comment: input.comment } : {}),
        }),
      );
    } catch (error) {
      return fail(
        "decision_workflow_send_failed",
        true,
        error instanceof Error ? error.message : String(error),
      );
    }
    return Result.succeed({ type: "delivered" });
  }
}
