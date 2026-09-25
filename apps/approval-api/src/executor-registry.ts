import { Result } from "@praha/byethrow";

import {
  ActionExecutorError,
  ActionExecutorRegistry,
  AUTHORIZATION_EXECUTOR_KEY,
  GOVERNANCE_EXECUTOR_KEY,
  GovernanceActionExecutor,
  type ActionExecutionRequest,
  type ActionExecutionResult,
  type ActionExecutor,
} from "@app/approval-core";
import { D1GovernanceRepository } from "@app/approval-d1";
import {
  CloudflareWorkflowCancellationControl,
  type WorkflowBindingControl,
  telemetrySinkFromEnv,
} from "@app/approval-runtime-cloudflare";

import { relationshipExecutor, type RelationshipMutationEnv } from "./relationship-mutation.ts";

export const STAGING_EXECUTOR_KEY = "staging";

export type ActionExecutorRegistryEnv = RelationshipMutationEnv & {
  ACTION_WORKFLOW: WorkflowBindingControl;
};

/**
 * staging用のside-effect sink。外部副作用を持たないため再実行しても安全（idempotent）。
 */
export class StagingSinkActionExecutor implements ActionExecutor {
  readonly guaranteeLevel = "idempotent" as const;

  async execute(
    request: ActionExecutionRequest,
  ): Result.ResultAsync<ActionExecutionResult, ActionExecutorError> {
    return Result.succeed({
      status: "succeeded",
      output: {
        executorKey: String(request.action.definition.executorKey),
        actionRequestId: String(request.actionRequestId),
        idempotencyKey: request.idempotencyKey,
        executedAt: new Date().toISOString(),
      },
    });
  }
}

/** 設定不足で利用できないexecutor。成功扱いにせずretriableに失敗させる。 */
class UnavailableActionExecutor implements ActionExecutor {
  readonly guaranteeLevel = "idempotent" as const;

  constructor(
    private readonly code: string,
    private readonly detail: string,
  ) {}

  async execute(): Result.ResultAsync<ActionExecutionResult, ActionExecutorError> {
    return Result.fail(
      new ActionExecutorError({ code: this.code, retriable: true, detail: this.detail }),
    );
  }
}

/**
 * approval-apiのexecutor registry。承認不要の同期実行と、Workflow経路のservice binding
 * （`StagingActionExecutor` entrypoint）の両方がこれでexecutorKeyをdispatchする。
 */
export function createActionExecutorRegistry(
  env: ActionExecutorRegistryEnv,
): ActionExecutorRegistry {
  return new ActionExecutorRegistry({
    [String(GOVERNANCE_EXECUTOR_KEY)]: new GovernanceActionExecutor(
      new D1GovernanceRepository(env.DB),
      new CloudflareWorkflowCancellationControl(
        env.DB,
        env.ACTION_WORKFLOW,
        telemetrySinkFromEnv(env),
      ),
    ),
    [String(AUTHORIZATION_EXECUTOR_KEY)]:
      relationshipExecutor(env) ??
      new UnavailableActionExecutor("fga_not_configured", "FGA接続設定がありません"),
    [STAGING_EXECUTOR_KEY]: new StagingSinkActionExecutor(),
  });
}
