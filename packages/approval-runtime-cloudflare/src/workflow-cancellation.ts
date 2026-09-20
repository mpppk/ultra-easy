import { Result } from "@praha/byethrow";

import {
  actionRuntimeTransitionEvents,
  cancelApprovalRuntimeState,
  WorkflowCancellationError,
  type ActionRequestId,
  type OrganizationId,
  type WorkflowCancellationControl,
} from "@app/approval-core";
import {
  D1ApprovalRuntimeProjectionRepository,
  D1MaterializedPlanRepository,
  type D1DatabaseLike,
} from "@app/approval-d1";

import { actionWorkflowInstanceId } from "./workflow.ts";

export type WorkflowInstanceStatus =
  | "queued"
  | "running"
  | "paused"
  | "errored"
  | "terminated"
  | "complete"
  | "waiting"
  | "waitingForPause"
  | "unknown";

export interface WorkflowInstanceControl {
  status(): Promise<{ status: WorkflowInstanceStatus }>;
  terminate(options?: { rollback?: boolean }): Promise<void>;
}

export interface WorkflowBindingControl {
  get(id: string): Promise<WorkflowInstanceControl>;
}

/**
 * force-cancel用のCloudflare Workflows control adapter。
 *
 * Workflow terminateは外部control plane side effectなのでD1 transactionには入らない。
 * 先にinstanceを停止し、その後runtime projection + action.completed(cancelled)を
 * atomic batchで保存する。retry時はterminated instanceを許容してprojectionを補完する。
 */
export class CloudflareWorkflowCancellationControl implements WorkflowCancellationControl {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly workflow: WorkflowBindingControl,
  ) {}

  async cancel(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
    cancelledAt: string;
  }): Result.ResultAsync<{ duplicate: boolean }, WorkflowCancellationError> {
    const repository = new D1ApprovalRuntimeProjectionRepository(this.db);
    const loaded = await repository.load({
      organizationId: input.organizationId,
      actionRequestId: input.actionRequestId,
    });
    if (Result.isFailure(loaded)) {
      return Result.fail(
        new WorkflowCancellationError(
          "force_cancel_projection_read_failed",
          true,
          loaded.error.message,
        ),
      );
    }
    if (!loaded.value) {
      return Result.fail(
        new WorkflowCancellationError(
          "force_cancel_target_not_found",
          false,
          "対象ActionRequestのapproval runtimeが見つかりません",
        ),
      );
    }

    const transition = cancelApprovalRuntimeState(loaded.value, input.cancelledAt);
    if (transition.duplicate) return Result.succeed({ duplicate: true });
    if (!transition.cancelled) {
      return Result.fail(
        new WorkflowCancellationError(
          "force_cancel_target_not_pending",
          false,
          `pending以外のActionRequestはforce cancelできません: ${loaded.value.status}`,
        ),
      );
    }

    const instanceId = await actionWorkflowInstanceId(input);
    try {
      const instance = await this.workflow.get(instanceId);
      const status = await instance.status();
      if (
        status.status === "queued" ||
        status.status === "running" ||
        status.status === "paused" ||
        status.status === "waiting" ||
        status.status === "waitingForPause" ||
        status.status === "unknown"
      ) {
        await instance.terminate();
      }
    } catch (error) {
      return Result.fail(
        new WorkflowCancellationError(
          "force_cancel_workflow_control_failed",
          true,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }

    const plan = await new D1MaterializedPlanRepository(this.db).load({
      organizationId: input.organizationId,
      actionRequestId: input.actionRequestId,
    });
    if (plan.type !== "found") {
      return Result.fail(
        new WorkflowCancellationError(
          "force_cancel_plan_read_failed",
          plan.type === "repository_error",
          `force cancel対象のMaterialized Planを取得できません: ${plan.type}`,
        ),
      );
    }

    const events = actionRuntimeTransitionEvents({
      plan: plan.plan,
      previousState: loaded.value,
      nextState: transition.state,
    });
    const saved = await repository.replace({
      organizationId: input.organizationId,
      state: transition.state,
      events,
    });
    if (Result.isFailure(saved)) {
      return Result.fail(
        new WorkflowCancellationError(
          "force_cancel_projection_write_failed",
          true,
          saved.error.message,
        ),
      );
    }
    return Result.succeed({ duplicate: false });
  }
}
