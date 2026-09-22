import { Result } from "@praha/byethrow";

import {
  ActionExecutorError,
  type ActionExecutionGuaranteeLevel,
  type ActionExecutionRequest,
  type ActionExecutionResult,
  type ActionExecutor,
} from "@app/approval-core";

/**
 * executorKeyでdelegate executorへ振り分ける。本番Workerのservice-level実行用。
 * guaranteeLevelは最も弱いbest_effortを申告する（過剰な保証をしない）。
 */
export class DispatchingActionExecutor implements ActionExecutor {
  readonly guaranteeLevel: ActionExecutionGuaranteeLevel = "best_effort_at_most_once";

  constructor(private readonly delegates: Readonly<Record<string, ActionExecutor>>) {}

  async execute(
    request: ActionExecutionRequest,
  ): Result.ResultAsync<ActionExecutionResult, ActionExecutorError> {
    const key = String(request.action.definition.executorKey);
    const delegate = this.delegates[key];
    if (!delegate) {
      return Result.fail(
        new ActionExecutorError({
          code: "unknown_executor_key",
          retriable: false,
          detail: `未対応のexecutorKeyです: ${key}`,
        }),
      );
    }
    return delegate.execute(request);
  }
}
