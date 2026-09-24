import { Result } from "@praha/byethrow";

import type { MaterializedApprovalPlan } from "@app/approval-core";
import {
  ActionRequestDependencyError,
  type ActionWorkflowStarter,
} from "@app/approval-application";
import {
  actionWorkflowInstanceId,
  type ActionWorkflowParams,
} from "@app/approval-runtime-cloudflare";

type WorkflowBinding = {
  create(options: { id: string; params: ActionWorkflowParams }): Promise<unknown>;
  get(id: string): Promise<unknown>;
};

/**
 * Cloudflare Workflows bindingへAction実行系Workflowを起動するadapter。
 * instance IDはplanから決定的に導出する（preview workerと同一方式）。
 *
 * startは同じActionRequestに対して冪等である。commit再開（MCP Gatewayのcrash recovery等）で
 * createが「既に存在する」で失敗した場合も、決定的IDのinstanceが存在すれば起動済みとして扱う。
 */
export class CloudflareActionWorkflowStarter implements ActionWorkflowStarter {
  constructor(private readonly workflow: WorkflowBinding) {}

  async start(input: {
    plan: MaterializedApprovalPlan;
    startedAt: string;
  }): Result.ResultAsync<{ workflowInstanceId: string }, ActionRequestDependencyError> {
    const instanceId = await actionWorkflowInstanceId({
      organizationId: input.plan.organizationId,
      actionRequestId: input.plan.actionRequestId,
    });
    const created = await Result.fn({
      try: () =>
        this.workflow.create({
          id: instanceId,
          params: {
            organizationId: input.plan.organizationId,
            actionRequestId: input.plan.actionRequestId,
            approvalPlanChecksum: input.plan.approvalPlanChecksum,
          },
        }),
      catch: (error) =>
        new ActionRequestDependencyError(
          "workflow_start_failed",
          true,
          error instanceof Error ? error.message : String(error),
        ),
    })();
    if (Result.isFailure(created)) {
      const existing = await Result.fn({
        try: () => this.workflow.get(instanceId),
        catch: () => created.error,
      })();
      if (Result.isFailure(existing)) return created;
    }
    return Result.succeed({ workflowInstanceId: instanceId });
  }
}
