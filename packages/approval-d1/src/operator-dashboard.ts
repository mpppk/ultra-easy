import { Result } from "@praha/byethrow";
import { storedBrands } from "./stored-brand.ts";

import {
  computeOrganizationActionSli,
  type OrganizationActionSli,
  type OrganizationId,
} from "@app/approval-core";

import { D1ActionEventRepository } from "./action-event-repository.ts";
import type { D1DatabaseLike, D1PreparedStatementLike } from "./materialized-plan-repository.ts";
import {
  D1NotificationOutboxRepository,
  type NotificationOutboxHealth,
} from "./notification-outbox-repository.ts";

export class D1OperatorDashboardError extends Error {
  readonly name = "D1OperatorDashboardError";
  readonly code = "operator_dashboard_error";
  readonly retriable = true;
}

function dashboardError(error: unknown, fallback: string): D1OperatorDashboardError {
  return new D1OperatorDashboardError(error instanceof Error ? error.message : fallback);
}

const allUnknownRows = Result.fn({
  try: async (statement: D1PreparedStatementLike): Promise<unknown[]> => {
    if (!statement.all) return Promise.reject(new Error("D1 all()が利用できません"));
    return (await statement.all<unknown>()).results;
  },
  catch: (error): D1OperatorDashboardError =>
    dashboardError(error, "operator dashboard rowsの取得に失敗しました"),
});

export type OperatorDashboardSnapshot = {
  organizationId: OrganizationId;
  evaluatedAt: string;
  actionCount: number;
  sli: OrganizationActionSli;
  outbox: NotificationOutboxHealth & { backlog: number };
};

/**
 * alert評価の対象organization。action_events全体をGROUP BYせず、直近`eventWindow`件のevent
 * （sequenceのrange scan）に現れたorganizationと、alertがok以外（breaching / firing）の
 * organizationだけを返す（#95）。静かになったorganizationのalertもresolveまで評価し続ける。
 */
export async function listRecentOrganizations(
  db: D1DatabaseLike,
  limit = 50,
  eventWindow = 10_000,
): Result.ResultAsync<OrganizationId[], D1OperatorDashboardError> {
  const rows = await allUnknownRows(
    db
      .prepare(
        `SELECT organization_id AS organizationId, MAX(last_sequence) AS lastSequence
           FROM (
             SELECT organization_id, MAX(sequence) AS last_sequence
               FROM action_events
              WHERE sequence > (SELECT COALESCE(MAX(sequence), 0) FROM action_events) - ?
              GROUP BY organization_id
             UNION ALL
             SELECT organization_id, 0 AS last_sequence
               FROM operator_alert_states
              WHERE status <> 'ok'
           )
          GROUP BY organization_id
          ORDER BY lastSequence DESC
          LIMIT ?`,
      )
      .bind(eventWindow, limit),
  );
  if (Result.isFailure(rows)) return rows;
  return storedBrands(
    "OrganizationId",
    rows.value.map((row) => (row as { organizationId: unknown }).organizationId),
    (message) => dashboardError(undefined, message),
  );
}

/**
 * 組織単位のdashboard snapshotをD1から組み立てる。
 * SLIはappend-only Action events、outbox健全性はoutbox/delivery tablesがsource of truth。
 */
export async function loadOperatorDashboard(
  db: D1DatabaseLike,
  input: { organizationId: OrganizationId; actionLimit?: number; evaluatedAt?: string },
): Result.ResultAsync<OperatorDashboardSnapshot, D1OperatorDashboardError> {
  const recent = await new D1ActionEventRepository(db).listForRecentActions({
    organizationId: input.organizationId,
    limit: input.actionLimit ?? 200,
  });
  if (Result.isFailure(recent)) {
    return Result.fail(dashboardError(recent.error, "Action eventsの取得に失敗しました"));
  }

  const health = await new D1NotificationOutboxRepository(db).healthForOrganization({
    organizationId: input.organizationId,
  });
  if (Result.isFailure(health)) {
    return Result.fail(dashboardError(health.error, "outbox健全性の取得に失敗しました"));
  }

  return Result.succeed({
    organizationId: input.organizationId,
    evaluatedAt: input.evaluatedAt ?? new Date().toISOString(),
    actionCount: recent.value.actionRequestIds.length,
    sli: computeOrganizationActionSli(recent.value.records),
    outbox: {
      ...health.value,
      backlog: health.value.pendingOutbox + health.value.failedOutbox,
    },
  });
}
