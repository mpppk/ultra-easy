import { Result } from "@praha/byethrow";

import {
  actionEventRecord,
  actionExecutionOutcomeEvents,
  sameAsyncExecutionCompletion,
} from "@app/approval-core";
import type {
  ActionEventRepository,
  ActionFingerprint,
  ActionRequestId,
  ActionResultRepository,
  AsyncActionExecutionRecord,
  AsyncActionExecutionRepository,
  AsyncExecutionCompletion,
  OrganizationId,
} from "@app/approval-core";

export type ActionExecutionCompletionErrorCode =
  | "execution_not_accepted"
  | "completion_binding_mismatch"
  | "completion_conflict"
  | "completion_persistence_failed";

export class ActionExecutionCompletionError extends Error {
  override readonly name = "ActionExecutionCompletionError";

  constructor(
    readonly code: ActionExecutionCompletionErrorCode,
    readonly retriable: boolean,
    message: string,
  ) {
    super(message);
  }
}

export type ActionExecutionCompletionInput = {
  organizationId: OrganizationId;
  actionRequestId: ActionRequestId;
  actionFingerprint: ActionFingerprint;
  executionRef: string;
  /** 元の実行で使ったidempotency key（実行attemptの同一性）。 */
  idempotencyKey: string;
  completion: AsyncExecutionCompletion;
  completedAt: string;
};

export type ActionExecutionCompletionResult =
  | { type: "completed"; record: AsyncActionExecutionRecord }
  /** 同じ完了の再送。状態は変えない（projectionの書き込みだけ冪等に再試行する）。 */
  | { type: "replayed"; record: AsyncActionExecutionRecord };

export type ActionExecutionCompletionDependencies = {
  asyncExecutions: AsyncActionExecutionRepository;
  results: ActionResultRepository;
  events: ActionEventRepository;
};

/**
 * async executorの最終完了を受け付けるtrusted internal port（#165）。
 *
 * - organizationId / actionRequestId / actionFingerprint / executionRef / idempotencyKeyが
 *   受付記録と一致する完了だけを受理する（別Action・stale・spoofed completionを拒否）
 * - `accepted | cancel_requested -> completed` をCASで一度だけ確定する（cancelとの競合も含め
 *   最初の終端completionが勝つ）
 * - 同じ完了の再送はidempotentに同じ終端結果へ収束し、矛盾する完了はfail-closedで拒否して監査に残す
 *
 * 外部へ公開するendpointから直接呼ばず、同じtrust boundary内のexecutor adapter
 * （WorkflowRunの終端通知等）だけが呼ぶ。
 */
export class ActionExecutionCompletionService {
  constructor(private readonly deps: ActionExecutionCompletionDependencies) {}

  private async audit(
    input: ActionExecutionCompletionInput,
    code: ActionExecutionCompletionErrorCode,
  ): Promise<void> {
    await this.deps.events.appendMany([
      actionEventRecord({
        organizationId: input.organizationId,
        occurredAt: input.completedAt,
        event: {
          type: "action.execution_completion_rejected",
          actionRequestId: input.actionRequestId,
          executionRef: input.executionRef,
          code,
        },
      }),
    ]);
  }

  private async reject(
    input: ActionExecutionCompletionInput,
    code: ActionExecutionCompletionErrorCode,
    message: string,
  ): Result.ResultAsync<never, ActionExecutionCompletionError> {
    await this.audit(input, code);
    return Result.fail(new ActionExecutionCompletionError(code, false, message));
  }

  /** 確定済みcompletionからaction_results + 終端監査イベントを書く（冪等なupsert / eventKey）。 */
  private async project(
    record: AsyncActionExecutionRecord,
  ): Result.ResultAsync<void, ActionExecutionCompletionError> {
    const completion = record.completion;
    if (!completion || !record.completedAt) return Result.succeed(undefined);
    const failure = completion.status === "executed" ? undefined : completion;
    const events = actionExecutionOutcomeEvents({
      organizationId: record.organizationId,
      actionRequestId: record.actionRequestId,
      status: completion.status,
      completedAt: record.completedAt,
      idempotencyKey: record.idempotencyKey,
      ...(failure
        ? {
            code: failure.code,
            message: failure.message,
            ...(failure.retriable !== undefined ? { retriable: failure.retriable } : {}),
          }
        : {}),
    });
    const saved = await this.deps.results.save(
      {
        organizationId: record.organizationId,
        actionRequestId: record.actionRequestId,
        ...(record.workflowInstanceId ? { workflowInstanceId: record.workflowInstanceId } : {}),
        status: completion.status,
        guaranteeLevel: record.guaranteeLevel,
        idempotencyKey: record.idempotencyKey,
        ...(completion.status === "executed"
          ? {
              result: {
                status: "succeeded" as const,
                ...(completion.output !== undefined ? { output: completion.output } : {}),
              },
            }
          : { code: completion.code, message: completion.message }),
        completedAt: record.completedAt,
      },
      events,
    );
    if (Result.isFailure(saved)) {
      return Result.fail(
        new ActionExecutionCompletionError(
          "completion_persistence_failed",
          saved.error.retriable,
          saved.error.message,
        ),
      );
    }
    return Result.succeed(undefined);
  }

  async complete(
    input: ActionExecutionCompletionInput,
  ): Result.ResultAsync<ActionExecutionCompletionResult, ActionExecutionCompletionError> {
    const loaded = await this.deps.asyncExecutions.load(input);
    if (Result.isFailure(loaded)) {
      return Result.fail(
        new ActionExecutionCompletionError(
          "completion_persistence_failed",
          loaded.error.retriable,
          loaded.error.message,
        ),
      );
    }
    const record = loaded.value;
    if (!record) {
      return Result.fail(
        new ActionExecutionCompletionError(
          "execution_not_accepted",
          false,
          "受け付けられていない実行の完了は受理できません",
        ),
      );
    }
    if (
      String(record.actionFingerprint) !== String(input.actionFingerprint) ||
      record.executionRef !== input.executionRef ||
      record.idempotencyKey !== input.idempotencyKey
    ) {
      return this.reject(
        input,
        "completion_binding_mismatch",
        "完了通知のbinding（fingerprint / executionRef / idempotency key）が受付記録と一致しません",
      );
    }

    const settled = await this.deps.asyncExecutions.settle(input);
    if (Result.isFailure(settled)) {
      return Result.fail(
        new ActionExecutionCompletionError(
          "completion_persistence_failed",
          settled.error.retriable,
          settled.error.message,
        ),
      );
    }
    if (settled.value.type === "not_found") {
      return this.reject(input, "completion_binding_mismatch", "受付記録と一致しません");
    }
    const stored = settled.value.record;
    if (settled.value.type === "already_settled") {
      if (
        !stored.completion ||
        !sameAsyncExecutionCompletion(stored.completion, input.completion)
      ) {
        return this.reject(input, "completion_conflict", "既に別の結果で終端した実行です");
      }
      const projected = await this.project(stored);
      if (Result.isFailure(projected)) return projected;
      return Result.succeed({ type: "replayed", record: stored });
    }
    const projected = await this.project(stored);
    if (Result.isFailure(projected)) return projected;
    return Result.succeed({ type: "completed", record: stored });
  }

  /**
   * 未確定のasync実行へcancelを要求する。終端はexecutor（WorkflowRun等）が返す完了で確定し、
   * completionとの競合はsettleのCASで解決する。
   */
  async requestCancel(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
    reason: string;
    requestedAt: string;
  }): Result.ResultAsync<
    | { type: "cancel_requested" | "already_settled"; record: AsyncActionExecutionRecord }
    | { type: "not_found" },
    ActionExecutionCompletionError
  > {
    const requested = await this.deps.asyncExecutions.requestCancel(input);
    if (Result.isFailure(requested)) {
      return Result.fail(
        new ActionExecutionCompletionError(
          "completion_persistence_failed",
          requested.error.retriable,
          requested.error.message,
        ),
      );
    }
    if (requested.value.type === "cancel_requested") {
      await this.deps.events.appendMany([
        actionEventRecord({
          organizationId: input.organizationId,
          occurredAt: input.requestedAt,
          event: {
            type: "action.execution_cancel_requested",
            actionRequestId: input.actionRequestId,
            executionRef: requested.value.record.executionRef,
            reason: input.reason,
          },
        }),
      ]);
    }
    return Result.succeed(requested.value);
  }
}
