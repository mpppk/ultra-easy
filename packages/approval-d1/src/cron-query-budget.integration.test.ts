import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import { actionEventRecord } from "@app/approval-core";
import type {
  ActionEventRecord,
  ActionFingerprint,
  ActionRequestId,
  OrganizationId,
} from "@app/approval-core";

import { D1ActionEventRepository } from "./action-event-repository.ts";
import type { D1DatabaseLike, D1PreparedStatementLike } from "./materialized-plan-repository.ts";
import { listRecentOrganizations, loadOperatorDashboard } from "./operator-dashboard.ts";
import { migratedSqliteD1 } from "./testing/sqlite-d1.ts";

/** 実行したSQL文の数を数えるD1 wrapper（#95: cron 1回あたりのquery上限の回帰検知）。 */
class CountingD1 implements D1DatabaseLike {
  queries = 0;

  constructor(private readonly inner: D1DatabaseLike & { batch?: unknown }) {}

  prepare(query: string): D1PreparedStatementLike {
    this.queries += 1;
    return this.inner.prepare(query);
  }
}

function eventsFor(organizationId: OrganizationId, index: number): ActionEventRecord[] {
  const actionRequestId = `action:${String(organizationId)}:${index}` as ActionRequestId;
  const at = new Date(Date.UTC(2026, 8, 25, 0, 0, index)).toISOString();
  return [
    actionEventRecord({
      organizationId,
      occurredAt: at,
      event: {
        type: "action.received",
        actionRequestId,
        actor: { type: "user", id: "user:alice" as never },
        authority: { type: "user", id: "user:alice" as never },
        actionFingerprint: "sha256:budget" as ActionFingerprint,
      },
    }),
    actionEventRecord({
      organizationId,
      occurredAt: at,
      event: { type: "action.completed", actionRequestId, result: "executed" },
    }),
  ];
}

async function seed(actionsPerOrganization: number, organizations: number) {
  const db = migratedSqliteD1();
  const repository = new D1ActionEventRepository(db);
  for (let org = 0; org < organizations; org += 1) {
    const organizationId = `organization:budget-${org}` as OrganizationId;
    const records = Array.from({ length: actionsPerOrganization }, (_, index) =>
      eventsFor(organizationId, index),
    ).flat();
    const appended = await repository.appendMany(records);
    assert(Result.isSuccess(appended));
  }
  return db;
}

describe("#95 cron query budget", () => {
  it("dashboard snapshotのquery数は履歴量（ActionRequest数）に依存しない", async () => {
    const counts: number[] = [];
    for (const actions of [5, 150]) {
      const counting = new CountingD1(await seed(actions, 1));
      const snapshot = await loadOperatorDashboard(counting, {
        organizationId: "organization:budget-0" as OrganizationId,
      });
      assert(Result.isSuccess(snapshot));
      expect(snapshot.value.actionCount).toBe(actions);
      expect(snapshot.value.sli.completedByResult.executed).toBe(actions);
      counts.push(counting.queries);
    }
    expect(counts[0]).toBe(counts[1]);
    expect(counts[1]).toBeLessThanOrEqual(3);
  });

  it("対象organizationの列挙は1 queryで、alertがok以外の静かなorganizationも含める", async () => {
    const db = await seed(3, 4);
    await db
      .prepare(
        `INSERT INTO operator_alert_states (organization_id, alert_key, status, updated_at)
         VALUES ('organization:quiet', 'outbox_backlog', 'firing', '2026-09-25T00:00:00.000Z')`,
      )
      .run();
    const counting = new CountingD1(db);
    const organizations = await listRecentOrganizations(counting, 50);
    assert(Result.isSuccess(organizations));
    expect(counting.queries).toBe(1);
    expect(organizations.value.map(String).sort()).toEqual([
      "organization:budget-0",
      "organization:budget-1",
      "organization:budget-2",
      "organization:budget-3",
      "organization:quiet",
    ]);
  });
});
