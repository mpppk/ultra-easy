import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import { actionEventRecord } from "@app/approval-core";
import type {
  ActionFingerprint,
  ActionRequestId,
  ApprovalStepKey,
  MaterializedStepId,
  OrganizationId,
  UserId,
} from "@app/approval-core";

import { prepareActionEventInsert } from "./action-event-repository.ts";
import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1RunResultLike,
} from "./materialized-plan-repository.ts";
import { D1OperatorAlertStateRepository } from "./operator-alert-state-repository.ts";
import { loadOperatorDashboard } from "./operator-dashboard.ts";

type SqlValue = string | number | bigint | Uint8Array | null;

function sqlValues(values: readonly unknown[]): SqlValue[] {
  return values.map((value) => {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "bigint" ||
      value instanceof Uint8Array
    ) {
      return value;
    }
    assert.fail(`SQLiteへbindできない値です: ${typeof value}`);
  });
}

class SqliteD1Database implements D1DatabaseLike {
  constructor(readonly db: DatabaseSync) {}

  prepare(query: string): D1PreparedStatementLike {
    const statement = this.db.prepare(query);
    let values: unknown[] = [];
    const prepared: D1PreparedStatementLike = {
      bind(...nextValues: unknown[]) {
        values = nextValues;
        return prepared;
      },
      async first<T>() {
        return (statement.get(...sqlValues(values)) as T | undefined) ?? null;
      },
      async all<T>() {
        return { results: statement.all(...sqlValues(values)) as T[] };
      },
      async run(): Promise<D1RunResultLike> {
        const result = statement.run(...sqlValues(values));
        return { success: true, meta: { changes: Number(result.changes) } };
      },
    };
    return prepared;
  }

  async batch(statements: D1PreparedStatementLike[]): Promise<D1RunResultLike[]> {
    this.db.exec("BEGIN");
    try {
      const results: D1RunResultLike[] = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      return Promise.reject(error);
    }
  }
}

const org = "organization:ops" as OrganizationId;
const otherOrg = "organization:other" as OrganizationId;
const alice = "user:alice" as UserId;

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of [
    "../migrations/0007_action_events.sql",
    "../migrations/0008_notification_outbox.sql",
    "../migrations/0011_operator_alert_states.sql",
  ]) {
    sqlite.exec(readFileSync(new URL(migration, import.meta.url), "utf8"));
  }
  return new SqliteD1Database(sqlite);
}

async function insertEvent(
  db: D1DatabaseLike,
  record: Parameters<typeof prepareActionEventInsert>[1],
): Promise<void> {
  const statement = prepareActionEventInsert(db, record);
  assert(Result.isSuccess(statement));
  await statement.value.run();
}

describe("operator dashboard", () => {
  it("組織単位のSLI snapshotを組み立てる", async () => {
    const db = setup();
    await insertEvent(
      db,
      actionEventRecord({
        organizationId: org,
        occurredAt: "2026-09-21T00:00:00.000Z",
        event: {
          type: "action.received",
          actionRequestId: "action:one" as ActionRequestId,
          actor: { type: "user", id: alice },
          authority: { type: "user", id: alice },
          actionFingerprint: "fingerprint:one" as ActionFingerprint,
        },
      }),
    );
    await insertEvent(
      db,
      actionEventRecord({
        organizationId: org,
        occurredAt: "2026-09-21T00:00:10.000Z",
        event: {
          type: "action.completed",
          actionRequestId: "action:one" as ActionRequestId,
          result: "executed",
        },
      }),
    );
    await insertEvent(
      db,
      actionEventRecord({
        organizationId: org,
        occurredAt: "2026-09-21T00:01:00.000Z",
        event: {
          type: "step.activated",
          actionRequestId: "action:two" as ActionRequestId,
          materializedStepId: "mstep:one" as MaterializedStepId,
          stepKey: "manager" as ApprovalStepKey,
        },
      }),
    );
    await insertEvent(
      db,
      actionEventRecord({
        organizationId: org,
        occurredAt: "2026-09-21T00:02:00.000Z",
        event: {
          type: "step.approved",
          actionRequestId: "action:two" as ActionRequestId,
          materializedStepId: "mstep:one" as MaterializedStepId,
          stepKey: "manager" as ApprovalStepKey,
          decisionKey: "decision:one",
          actorId: alice,
        },
      }),
    );
    await insertEvent(
      db,
      actionEventRecord({
        organizationId: otherOrg,
        occurredAt: "2026-09-21T00:00:00.000Z",
        event: {
          type: "action.received",
          actionRequestId: "action:other" as ActionRequestId,
          actor: { type: "user", id: alice },
          authority: { type: "user", id: alice },
          actionFingerprint: "fingerprint:other" as ActionFingerprint,
        },
      }),
    );

    const dashboard = await loadOperatorDashboard(db, { organizationId: org });
    assert(Result.isSuccess(dashboard));
    expect(dashboard.value.actionCount).toBe(2);
    expect(dashboard.value.sli.leadTimeMs).toMatchObject({ count: 1, p50Ms: 10_000 });
    expect(dashboard.value.sli.dwellByStepKey["manager"]).toMatchObject({
      count: 1,
      p50Ms: 60_000,
    });
    expect(dashboard.value.outbox).toMatchObject({
      pendingOutbox: 0,
      failedOutbox: 0,
      failedDeliveries: 0,
      backlog: 0,
    });

    const isolated = await loadOperatorDashboard(db, { organizationId: otherOrg });
    assert(Result.isSuccess(isolated));
    expect(isolated.value.actionCount).toBe(1);
    expect(isolated.value.sli.leadTimeMs).toMatchObject({ count: 0 });
  });

  it("outbox健全性を組織スコープで集計する", async () => {
    const db = setup();
    db.db.exec(
      `INSERT INTO outbox_events (
         organization_id, action_request_id, outbox_key, notification_key, event_key,
         event_type, recipient_mode, status, created_at
       ) VALUES
         ('organization:ops', 'action:one', 'outbox:one', 'notification:one', 'event:one',
          'step.activated', 'direct_user', 'pending', '2026-09-21T00:00:00.000Z'),
         ('organization:ops', 'action:two', 'outbox:two', 'notification:two', 'event:two',
          'step.activated', 'direct_user', 'failed', '2026-09-21T00:00:00.000Z'),
         ('organization:other', 'action:three', 'outbox:three', 'notification:three', 'event:three',
          'step.activated', 'direct_user', 'pending', '2026-09-21T00:00:00.000Z')`,
    );

    const dashboard = await loadOperatorDashboard(db, { organizationId: org });
    assert(Result.isSuccess(dashboard));
    expect(dashboard.value.outbox).toMatchObject({
      pendingOutbox: 1,
      failedOutbox: 1,
      backlog: 2,
    });
  });

  it("alert stateを保存して読み戻せる", async () => {
    const db = setup();
    const repository = new D1OperatorAlertStateRepository(db);
    const saved = await repository.save({
      organizationId: org,
      key: "outbox_backlog",
      status: "breaching",
      breachedSince: "2026-09-21T00:00:00.000Z",
      lastOutboxFailedTotal: 3,
      lastExecutorFailureTotal: null,
      updatedAt: "2026-09-21T00:01:00.000Z",
    });
    assert(Result.isSuccess(saved));

    const loaded = await repository.loadAll({ organizationId: org });
    assert(Result.isSuccess(loaded));
    expect(loaded.value).toEqual([
      {
        key: "outbox_backlog",
        status: "breaching",
        breachedSince: "2026-09-21T00:00:00.000Z",
        lastOutboxFailedTotal: 3,
        lastExecutorFailureTotal: null,
        updatedAt: "2026-09-21T00:01:00.000Z",
      },
    ]);

    const isolated = await repository.loadAll({ organizationId: otherOrg });
    assert(Result.isSuccess(isolated));
    expect(isolated.value).toEqual([]);
  });
});
