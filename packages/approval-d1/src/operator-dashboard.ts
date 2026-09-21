import { Result } from "@praha/byethrow";

import {
  computeOrganizationActionSli,
  type ActionEventRecord,
  type ActionRequestId,
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

async function listOrganizationActionIds(
  db: D1DatabaseLike,
  input: { organizationId: OrganizationId; limit: number },
): Result.ResultAsync<ActionRequestId[], D1OperatorDashboardError> {
  const rows = await allUnknownRows(
    db
      .prepare(
        `SELECT action_request_id AS actionRequestId, MAX(sequence) AS maxSequence
           FROM action_events
          WHERE organization_id = ?
          GROUP BY action_request_id
          ORDER BY maxSequence DESC
          LIMIT ?`,
      )
      .bind(input.organizationId, input.limit),
  );
  if (Result.isFailure(rows)) return rows;
  return Result.succeed(
    rows.value.map(
      (row) => (row as { actionRequestId: string }).actionRequestId as ActionRequestId,
    ),
  );
}

export async function listRecentOrganizations(
  db: D1DatabaseLike,
  limit = 50,
): Result.ResultAsync<OrganizationId[], D1OperatorDashboardError> {
  const rows = await allUnknownRows(
    db
      .prepare(
        `SELECT organization_id AS organizationId, MAX(sequence) AS maxSequence
           FROM action_events
          GROUP BY organization_id
          ORDER BY maxSequence DESC
          LIMIT ?`,
      )
      .bind(limit),
  );
  if (Result.isFailure(rows)) return rows;
  return Result.succeed(
    rows.value.map((row) => (row as { organizationId: string }).organizationId as OrganizationId),
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
  const actionLimit = input.actionLimit ?? 200;
  const actionIds = await listOrganizationActionIds(db, {
    organizationId: input.organizationId,
    limit: actionLimit,
  });
  if (Result.isFailure(actionIds)) return actionIds;

  const eventRepository = new D1ActionEventRepository(db);
  const allRecords: ActionEventRecord[] = [];
  for (const actionRequestId of actionIds.value) {
    const events = await eventRepository.listForAction({
      organizationId: input.organizationId,
      actionRequestId,
    });
    if (Result.isFailure(events)) {
      return Result.fail(dashboardError(events.error, "Action eventsの取得に失敗しました"));
    }
    allRecords.push(...events.value);
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
    actionCount: actionIds.value.length,
    sli: computeOrganizationActionSli(allRecords),
    outbox: {
      ...health.value,
      backlog: health.value.pendingOutbox + health.value.failedOutbox,
    },
  });
}
