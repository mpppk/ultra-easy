import { Result } from "@praha/byethrow";
import { WorkerEntrypoint } from "cloudflare:workers";

import {
  ActionExecutorError,
  ActionExecutorRegistry,
  GOVERNANCE_EXECUTOR_KEY,
  GovernanceActionExecutor,
  type ActionExecutionGuaranteeLevel,
  type ActionExecutionRequest,
  type ActionExecutionResult,
  type ActionExecutor,
} from "@app/approval-core";
import { D1GovernanceRepository } from "@app/approval-d1";

import { serveActionExecutorRegistry } from "../service-binding.ts";
import { CloudflareWorkflowCancellationControl } from "../workflow-cancellation.ts";

export { ActionWorkflow } from "../workflow.ts";

/** Workflow統合テストが登録するexecutorKey。 */
export const TEST_EXECUTOR_KEYS = {
  idempotent: "executor:workflow",
  atMostOnce: "executor:at-most-once",
  unregistered: "executor:unregistered",
} as const;

const attempts = new Map<string, { count: number; idempotencyKey: string }>();

/**
 * action.input.executorScenarioで失敗を注入するtest executor。
 * attemptはisolate内で数え、retry間でidempotency keyが変わらないことも検証する。
 */
class ScenarioActionExecutor implements ActionExecutor {
  constructor(readonly guaranteeLevel: ActionExecutionGuaranteeLevel) {}

  async execute(
    request: ActionExecutionRequest,
  ): Result.ResultAsync<ActionExecutionResult, ActionExecutorError> {
    const key = JSON.stringify([String(request.organizationId), String(request.actionRequestId)]);
    const previous = attempts.get(key);
    if (previous && previous.idempotencyKey !== request.idempotencyKey) {
      return Result.fail(
        new ActionExecutorError({
          code: "idempotency_key_changed",
          retriable: false,
          detail: "retry間でidempotency keyが変化しました",
        }),
      );
    }
    const attempt = (previous?.count ?? 0) + 1;
    attempts.set(key, { count: attempt, idempotencyKey: request.idempotencyKey });

    const input = request.action.input as { executorScenario?: unknown };
    if (input.executorScenario === "retry-once" && attempt === 1) {
      return Result.fail(
        new ActionExecutorError({
          code: "temporary_timeout",
          retriable: true,
          detail: "temporary executor failure",
        }),
      );
    }
    if (input.executorScenario === "non-retriable" && attempt === 1) {
      return Result.fail(
        new ActionExecutorError({
          code: "business_validation_failed",
          retriable: false,
          detail: "business validation failed",
        }),
      );
    }
    return Result.succeed({
      status: "succeeded",
      output: { attempt, idempotencyKey: request.idempotencyKey },
    });
  }
}

/**
 * Workflow統合テスト用のdownstream executor registry。本番（approval-api）と同じ
 * `serveActionExecutorRegistry` contractで、governanceは実際のGovernanceActionExecutorへ届く。
 */
export class TestActionExecutor extends WorkerEntrypoint<Cloudflare.Env> {
  override async fetch(request: Request): Promise<Response> {
    const registry = new ActionExecutorRegistry({
      [TEST_EXECUTOR_KEYS.idempotent]: new ScenarioActionExecutor("idempotent"),
      [TEST_EXECUTOR_KEYS.atMostOnce]: new ScenarioActionExecutor("best_effort_at_most_once"),
      [String(GOVERNANCE_EXECUTOR_KEY)]: new GovernanceActionExecutor(
        new D1GovernanceRepository(this.env.DB),
        new CloudflareWorkflowCancellationControl(this.env.DB, this.env.ACTION_WORKFLOW),
      ),
    });
    return serveActionExecutorRegistry(request, registry);
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("approval-runtime-cloudflare test worker", { status: 404 });
  },
};
