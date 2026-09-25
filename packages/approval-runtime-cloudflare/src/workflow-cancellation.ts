import { Result } from "@praha/byethrow";

import {
  actionCorrelation,
  ConsoleTelemetrySink,
  safeLogRecord,
  type TelemetrySink,
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

/** force-cancelが書き込むprojectionのwriter ID（Workflow stepのwriterと区別する）。 */
export const FORCE_CANCEL_PROJECTION_WRITER = "force-cancel";

const MAX_CANCEL_ATTEMPTS = 3;

/**
 * force-cancel用のCloudflare Workflows control adapter（#89）。
 *
 * 1. projectionをversion付きで読み、pendingならcancelled stateをcompare-and-setで書く。
 *    Workflowが間にDecisionを記録・approvedへ遷移していればCASが負け、状態は巻き戻らない
 *    （approved以降はforce_cancel_target_not_pending）。
 * 2. D1でcancelを確定してから、Workflow instanceをbest-effortでterminateする。terminateに
 *    失敗しても、Workflowは次のprojection書き込みでCASに負けてcancelledを採用し自ら終了する。
 *    実行フェーズはprojectionがapprovedであることを前提にするため、cancel後に実行されない。
 */
export class CloudflareWorkflowCancellationControl implements WorkflowCancellationControl {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly workflow: WorkflowBindingControl,
    private readonly telemetry: TelemetrySink = new ConsoleTelemetrySink(),
  ) {}

  async cancel(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
    cancelledAt: string;
  }): Result.ResultAsync<{ duplicate: boolean }, WorkflowCancellationError> {
    const repository = new D1ApprovalRuntimeProjectionRepository(this.db);
    const plan = await new D1MaterializedPlanRepository(this.db).load({
      organizationId: input.organizationId,
      actionRequestId: input.actionRequestId,
    });
    if (plan.type === "not_found") {
      return Result.fail(
        new WorkflowCancellationError(
          "force_cancel_target_not_found",
          false,
          "対象ActionRequestのapproval runtimeが見つかりません",
        ),
      );
    }
    if (plan.type !== "found") {
      return Result.fail(
        new WorkflowCancellationError(
          "force_cancel_plan_read_failed",
          plan.type === "repository_error",
          `force cancel対象のMaterialized Planを取得できません: ${plan.type}`,
        ),
      );
    }

    for (let attempt = 0; attempt < MAX_CANCEL_ATTEMPTS; attempt += 1) {
      const loaded = await repository.loadVersioned({
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

      const transition = cancelApprovalRuntimeState(loaded.value.state, input.cancelledAt);
      if (transition.duplicate) {
        await this.terminate(input);
        return Result.succeed({ duplicate: true });
      }
      if (!transition.cancelled) {
        return Result.fail(
          new WorkflowCancellationError(
            "force_cancel_target_not_pending",
            false,
            `pending以外のActionRequestはforce cancelできません: ${loaded.value.state.status}`,
          ),
        );
      }

      const saved = await repository.compareAndReplace({
        organizationId: input.organizationId,
        state: transition.state,
        events: actionRuntimeTransitionEvents({
          plan: plan.plan,
          previousState: loaded.value.state,
          nextState: transition.state,
        }),
        expectedVersion: loaded.value.version,
        writer: FORCE_CANCEL_PROJECTION_WRITER,
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
      if (saved.value.type === "written") {
        await this.terminate(input);
        return Result.succeed({ duplicate: false });
      }
      // Workflowが先に書いた。最新のstateで判定し直す（pendingのままならもう一度cancelを試みる）。
    }
    return Result.fail(
      new WorkflowCancellationError(
        "force_cancel_projection_conflict",
        true,
        "Workflowとの競合が続いたためforce cancelを確定できませんでした",
      ),
    );
  }

  /** D1でcancelを確定した後のbest-effort停止。失敗してもWorkflowはCASで終端を検知する。 */
  private async terminate(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
  }): Promise<void> {
    try {
      const instance = await this.workflow.get(await actionWorkflowInstanceId(input));
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
    } catch {
      // 例外messageはlogへ出さない（provider応答を含みうる）。safe error codeだけを残す（#110）。
      this.telemetry.emit(
        safeLogRecord({
          level: "warn",
          event: "workflow.failed",
          correlation: actionCorrelation({
            organizationId: input.organizationId,
            actionRequestId: input.actionRequestId,
            component: "workflow",
            operation: "force_cancel.terminate",
          }),
          attributes: { errorCode: "force_cancel_workflow_control_failed" },
        }),
      );
    }
  }
}
