import { Result } from "@praha/byethrow";

import type { ActionRequestId, OrganizationId } from "@app/approval-core";

import type { D1DatabaseLike, D1PreparedStatementLike } from "./materialized-plan-repository.ts";
import { storedBrand } from "./stored-brand.ts";

// #109: operator alertのうち、D1から導けるsignal（Workflow異常終了・滞留候補）。

export class D1OperatorSignalError extends Error {
  readonly name = "D1OperatorSignalError";
  readonly code = "operator_signal_error";
  readonly retriable = true;
}

function signalError(error: unknown, fallback: string): D1OperatorSignalError {
  return new D1OperatorSignalError(error instanceof Error ? error.message : fallback);
}

const allUnknownRows = Result.fn({
  try: async (statement: D1PreparedStatementLike): Promise<unknown[]> => {
    if (!statement.all) return Promise.reject(new Error("D1 all()が利用できません"));
    return (await statement.all<unknown>()).results;
  },
  catch: (error): D1OperatorSignalError =>
    signalError(error, "operator signal rowsの取得に失敗しました"),
});

/** `since`以降に記録されたworkflow.failed eventの件数（1 query、index range scan）。 */
export async function countRecentWorkflowFailures(
  db: D1DatabaseLike,
  input: { organizationId: OrganizationId; since: string },
): Result.ResultAsync<number, D1OperatorSignalError> {
  const rows = await allUnknownRows(
    db
      .prepare(
        `SELECT COUNT(*) AS failures
           FROM action_events
          WHERE organization_id = ? AND event_type = 'workflow.failed' AND occurred_at >= ?`,
      )
      .bind(input.organizationId, input.since),
  );
  if (Result.isFailure(rows)) return rows;
  const failures = (rows.value[0] as { failures?: unknown } | undefined)?.failures;
  return Result.succeed(typeof failures === "number" ? failures : 0);
}

export type StuckActionRequestCandidate = {
  actionRequestId: ActionRequestId;
  projectionStatus: "pending" | "approved";
  updatedAt: string;
};

/**
 * 滞留候補: projectionが非終端（pending）またはapprovedのまま`updatedBefore`より前から
 * 更新が無く、action_resultsも無いActionRequest。Workflow instanceの状態と照合して判定する
 * （承認待ちは正常に長く続くため、候補だけでは滞留と断定しない）。古い順に`limit`件（1 query）。
 */
export async function listStuckActionRequestCandidates(
  db: D1DatabaseLike,
  input: { organizationId: OrganizationId; updatedBefore: string; limit: number },
): Result.ResultAsync<StuckActionRequestCandidate[], D1OperatorSignalError> {
  const rows = await allUnknownRows(
    db
      .prepare(
        `SELECT p.action_request_id AS actionRequestId, p.status AS status, p.updated_at AS updatedAt
           FROM approval_runtime_projections p
          WHERE p.organization_id = ?
            AND p.status IN ('pending', 'approved')
            AND p.updated_at < ?
            AND NOT EXISTS (
              SELECT 1 FROM action_results r
               WHERE r.organization_id = p.organization_id
                 AND r.action_request_id = p.action_request_id
            )
          ORDER BY p.updated_at
          LIMIT ?`,
      )
      .bind(input.organizationId, input.updatedBefore, input.limit),
  );
  if (Result.isFailure(rows)) return rows;
  const candidates: StuckActionRequestCandidate[] = [];
  for (const unknown of rows.value) {
    const row = unknown as { actionRequestId: unknown; status: unknown; updatedAt: unknown };
    const actionRequestId = storedBrand("ActionRequestId", row.actionRequestId, (message) =>
      signalError(undefined, message),
    );
    if (Result.isFailure(actionRequestId)) return actionRequestId;
    if (
      (row.status !== "pending" && row.status !== "approved") ||
      typeof row.updatedAt !== "string"
    ) {
      return Result.fail(signalError(undefined, "滞留候補の行が不正です"));
    }
    candidates.push({
      actionRequestId: actionRequestId.value,
      projectionStatus: row.status,
      updatedAt: row.updatedAt,
    });
  }
  return Result.succeed(candidates);
}
