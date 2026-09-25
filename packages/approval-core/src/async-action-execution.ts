import { Result } from "@praha/byethrow";

import { actionEventRecord, type ActionEventRecord } from "./action-event.ts";
import type { ActionExecutionGuaranteeLevel } from "./action-execution.ts";
import {
  actionExecutionStartEvents,
  type ActionResultRepositoryError,
} from "./action-execution-record.ts";
import type { AuthorizationEvidence } from "./authorization.ts";
import { canonicalizeJson } from "./canonical-json.ts";
import type {
  ActionFingerprint,
  ActionRequestId,
  ExecutorKey,
  OrganizationId,
} from "./domain/brand.ts";
import type { JsonValue } from "./domain/json.ts";

/** async実行の最終結果。trusted completion portだけが受け付ける。 */
export type AsyncExecutionCompletion =
  | { status: "executed"; output?: JsonValue }
  | {
      status: "execution_failed" | "execution_unknown";
      code: string;
      message: string;
      retriable?: boolean;
    };

/**
 * async executorが受け付けた実行の記録（#165）。completionはこのrecordの
 * organizationId / actionRequestId / actionFingerprint / executionRef / idempotencyKeyに
 * 一致する場合だけ受理し、`accepted | cancel_requested -> completed` をCASで一度だけ確定する。
 */
export type AsyncActionExecutionRecord = {
  organizationId: OrganizationId;
  actionRequestId: ActionRequestId;
  actionFingerprint: ActionFingerprint;
  executionRef: string;
  idempotencyKey: string;
  executorKey: ExecutorKey;
  guaranteeLevel: ActionExecutionGuaranteeLevel;
  /** Workflow経路のinstance ID。承認不要の同期経路では持たない。 */
  workflowInstanceId?: string;
  status: "accepted" | "cancel_requested" | "completed";
  acceptedAt: string;
  cancelRequestedAt?: string;
  cancelReason?: string;
  completion?: AsyncExecutionCompletion;
  completedAt?: string;
};

export type AsyncExecutionAcceptResult =
  | { type: "accepted" }
  /** 同じActionRequestが既に受付済み（replay）。executionRefが異なる場合も既存を返す。 */
  | { type: "existing"; record: AsyncActionExecutionRecord };

export type AsyncExecutionSettleResult =
  | { type: "settled"; record: AsyncActionExecutionRecord }
  | { type: "already_settled"; record: AsyncActionExecutionRecord }
  | { type: "not_found" };

export type AsyncExecutionCancelResult =
  | { type: "cancel_requested"; record: AsyncActionExecutionRecord }
  | { type: "already_settled"; record: AsyncActionExecutionRecord }
  | { type: "not_found" };

export interface AsyncActionExecutionRepository {
  /** 受付を記録する（実行開始の監査イベントと原子的に）。ActionRequestごとに1件。 */
  accept(input: {
    record: AsyncActionExecutionRecord;
    events: readonly ActionEventRecord[];
  }): Result.ResultAsync<AsyncExecutionAcceptResult, ActionResultRepositoryError>;
  load(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
  }): Result.ResultAsync<AsyncActionExecutionRecord | null, ActionResultRepositoryError>;
  /**
   * `accepted | cancel_requested` のrecordを、binding（executionRef等）が一致する場合だけ
   * completedへCASで確定する。確定済みなら確定済みrecordを返す（最初のcompletionが勝つ）。
   */
  settle(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
    actionFingerprint: ActionFingerprint;
    executionRef: string;
    idempotencyKey: string;
    completion: AsyncExecutionCompletion;
    completedAt: string;
  }): Result.ResultAsync<AsyncExecutionSettleResult, ActionResultRepositoryError>;
  /** 未確定の実行にcancel要求を記録する（終端はexecutorのcompletionで確定する）。 */
  requestCancel(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
    reason: string;
    requestedAt: string;
  }): Result.ResultAsync<AsyncExecutionCancelResult, ActionResultRepositoryError>;
}

/** accepted時に記録する監査イベント（再認可 → 実行開始 → 受付）。 */
export function asyncExecutionAcceptedEvents(input: {
  organizationId: OrganizationId;
  actionRequestId: ActionRequestId;
  authorizationEvidence: AuthorizationEvidence;
  idempotencyKey: string;
  executionRef: string;
  acceptedAt: string;
}): ActionEventRecord[] {
  return [
    ...actionExecutionStartEvents({
      organizationId: input.organizationId,
      actionRequestId: input.actionRequestId,
      authorizationEvidence: input.authorizationEvidence,
      idempotencyKey: input.idempotencyKey,
      completedAt: input.acceptedAt,
    }),
    actionEventRecord({
      organizationId: input.organizationId,
      occurredAt: input.acceptedAt,
      event: {
        type: "action.execution_accepted",
        actionRequestId: input.actionRequestId,
        executionRef: input.executionRef,
      },
    }),
  ];
}

/** 2つのcompletionが同じ終端結果か（replayの冪等判定）。 */
export function sameAsyncExecutionCompletion(
  left: AsyncExecutionCompletion,
  right: AsyncExecutionCompletion,
): boolean {
  const a = canonicalizeJson(left as unknown as JsonValue);
  const b = canonicalizeJson(right as unknown as JsonValue);
  return Result.isSuccess(a) && Result.isSuccess(b) && a.value === b.value;
}
