import type { Result } from "@praha/byethrow";

import { actionEventRecord, type ActionEventRecord } from "./action-event.ts";
import type {
  ActionExecutionGuaranteeLevel,
  ActionExecutionResult,
  ActionExecutionTerminalStatus,
} from "./action-execution.ts";
import type { AuthorizationEvidence } from "./authorization.ts";
import type { ActionRequestId, OrganizationId } from "./domain/brand.ts";

/**
 * Action実行フェーズ（再認可 → 実行）の最終結果。承認不要の同期実行とWorkflow経路で同じ形を
 * 保存し、read APIはこの記録だけからterminal statusとresultを返す。
 */
export type ActionResultRecord = {
  organizationId: OrganizationId;
  actionRequestId: ActionRequestId;
  /** Workflow経路のinstance ID。承認不要の同期実行では持たない。 */
  workflowInstanceId?: string;
  status: ActionExecutionTerminalStatus;
  guaranteeLevel?: ActionExecutionGuaranteeLevel;
  idempotencyKey?: string;
  result?: ActionExecutionResult;
  code?: string;
  message?: string;
  completedAt: string;
};

export class ActionResultRepositoryError extends Error {
  readonly name: string = "ActionResultRepositoryError";

  constructor(
    readonly code: string,
    readonly retriable: boolean,
    message: string,
  ) {
    super(message);
  }
}

export interface ActionResultRepository {
  /** 実行結果と、その結果に至った監査イベントを原子的に保存する。 */
  save(
    record: ActionResultRecord,
    events: readonly ActionEventRecord[],
  ): Result.ResultAsync<void, ActionResultRepositoryError>;
}

/** 実行フェーズの結果を監査イベントへ写像するための入力。 */
export type ActionExecutionOutcomeSummary = {
  organizationId: OrganizationId;
  actionRequestId: ActionRequestId;
  status: ActionExecutionTerminalStatus;
  completedAt: string;
  /** 再認可が成功した場合のevidence（action.reauthorized）。 */
  authorizationEvidence?: AuthorizationEvidence;
  /** Executorを呼び出した場合のidempotency key（action.execution_started）。 */
  idempotencyKey?: string;
  retriable?: boolean;
  code?: string;
  message?: string;
};

/**
 * 実行フェーズの結果から監査イベントを導出する。同期実行とWorkflow経路で共有し、
 * eventKeyは同じ論理遷移で一致するため、事前に記録したexecution_startedとも重複しない。
 */
export function actionExecutionOutcomeEvents(
  input: ActionExecutionOutcomeSummary,
): ActionEventRecord[] {
  const { organizationId, actionRequestId, completedAt } = input;
  const events: ActionEventRecord[] = [];
  if (input.authorizationEvidence) {
    events.push(
      actionEventRecord({
        organizationId,
        occurredAt: input.authorizationEvidence.evaluatedAt,
        event: {
          type: "action.reauthorized",
          actionRequestId,
          evidence: input.authorizationEvidence,
        },
      }),
    );
  } else if (input.status === "authorization_revoked") {
    events.push(
      actionEventRecord({
        organizationId,
        occurredAt: completedAt,
        event: {
          type: "action.reauthorization_denied",
          actionRequestId,
          code: input.code ?? "authorization_revoked",
          reason: input.message ?? "Action authorization was revoked",
        },
      }),
    );
  } else if (input.status === "authorization_check_failed") {
    events.push(
      actionEventRecord({
        organizationId,
        occurredAt: completedAt,
        event: {
          type: "action.reauthorization_check_failed",
          actionRequestId,
          code: input.code ?? "authorization_check_failed",
        },
      }),
    );
  }

  if (input.idempotencyKey) {
    events.push(
      actionEventRecord({
        organizationId,
        occurredAt: completedAt,
        event: {
          type: "action.execution_started",
          actionRequestId,
          idempotencyKey: input.idempotencyKey,
        },
      }),
    );
  }
  if (input.status === "execution_failed" || input.status === "execution_unknown") {
    events.push(
      actionEventRecord({
        organizationId,
        occurredAt: completedAt,
        event: {
          type: "action.execution_failed",
          actionRequestId,
          code: input.code ?? input.status,
          retriable: input.retriable ?? input.status === "execution_unknown",
        },
      }),
    );
  }
  events.push(
    actionEventRecord({
      organizationId,
      occurredAt: completedAt,
      event: { type: "action.completed", actionRequestId, result: input.status },
    }),
  );
  return events;
}

/**
 * Executor呼び出し直前に記録するevent（再認可 → 実行開始）。結果の保存前にcrashしても
 * 「実行を開始した」ことが監査に残り、滞留検知の手掛かりになる。後から結果と一緒に保存する
 * `actionExecutionOutcomeEvents`とeventKeyが一致するため重複しない。
 */
export function actionExecutionStartEvents(input: {
  organizationId: OrganizationId;
  actionRequestId: ActionRequestId;
  authorizationEvidence: AuthorizationEvidence;
  idempotencyKey: string;
  completedAt: string;
}): ActionEventRecord[] {
  return actionExecutionOutcomeEvents({ ...input, status: "executed" }).filter(
    (record) =>
      record.event.type === "action.reauthorized" ||
      record.event.type === "action.execution_started",
  );
}

/**
 * Executor失敗の終端状態。at-most-onceのexecutorがretriableに失敗した場合、外部副作用が
 * 起きたか分からないためretryせず`execution_unknown`にし、人手でreconcileする。
 */
export function executorFailureStatus(input: {
  retriable: boolean;
  guaranteeLevel: ActionExecutionGuaranteeLevel;
}): "execution_failed" | "execution_unknown" {
  return input.retriable && input.guaranteeLevel === "best_effort_at_most_once"
    ? "execution_unknown"
    : "execution_failed";
}
