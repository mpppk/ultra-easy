import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import { actionEventRecord } from "@app/approval-core";
import type {
  ActionRequestId,
  ApprovalPlanChecksum,
  EvaluationSnapshotChecksum,
  OrganizationId,
} from "@app/approval-core";

import { D1ActionEventRepository } from "./action-event-repository.ts";
import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1RunResultLike,
} from "./materialized-plan-repository.ts";

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

function branded<T extends string>(value: string): T {
  return value as T;
}

const organizationId = branded<OrganizationId>("org:audit");
const actionRequestId = branded<ActionRequestId>("action:audit");

function createRepository() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    readFileSync(new URL("../migrations/0007_action_events.sql", import.meta.url), "utf8"),
  );
  sqlite.exec(
    readFileSync(new URL("../migrations/0008_notification_outbox.sql", import.meta.url), "utf8"),
  );
  return {
    repository: new D1ActionEventRepository(new SqliteD1Database(sqlite)),
    sqlite,
  };
}

function materializedEvent(occurredAt = "2026-09-20T00:00:00.000Z") {
  return actionEventRecord({
    organizationId,
    occurredAt,
    event: {
      type: "approval_plan.materialized",
      actionRequestId,
      evaluationSnapshotChecksum: branded<EvaluationSnapshotChecksum>("sha256:evaluation"),
      approvalPlanChecksum: branded<ApprovalPlanChecksum>("sha256:plan"),
      interpreterSemanticsVersion: 1,
    },
  });
}

describe("D1ActionEventRepository", () => {
  it("same event replayを1 rowへcollapseする", async () => {
    const { repository, sqlite } = createRepository();
    const record = materializedEvent();

    const first = await repository.append(record);
    const replay = await repository.append(record);
    assert(Result.isSuccess(first));
    assert(Result.isSuccess(replay));
    expect(first.value).toBe("created");
    expect(replay.value).toBe("existing");

    const row = sqlite.prepare("SELECT COUNT(*) AS count FROM action_events").get() as {
      count: number;
    };
    expect(row.count).toBe(1);
  });

  it("同じeventKeyを異なるpayloadへ上書きしない", async () => {
    const { repository, sqlite } = createRepository();
    const original = materializedEvent();
    assert(Result.isSuccess(await repository.append(original)));

    const conflict = await repository.append({
      ...original,
      occurredAt: "2026-09-20T00:00:01.000Z",
    });
    assert(Result.isFailure(conflict));
    expect(conflict.error.conflict).toBe(true);

    const row = sqlite
      .prepare("SELECT occurred_at FROM action_events WHERE event_key = ?")
      .get(original.eventKey) as { occurred_at: string };
    expect(row.occurred_at).toBe(original.occurredAt);
  });

  it("append sequenceでAction auditを再構成できる", async () => {
    const { repository } = createRepository();
    const records = [
      actionEventRecord({
        organizationId,
        occurredAt: "2026-09-20T00:00:00.000Z",
        event: {
          type: "workflow.started",
          actionRequestId,
          workflowInstanceId: "workflow:audit",
        },
      }),
      materializedEvent("2026-09-20T00:00:01.000Z"),
      actionEventRecord({
        organizationId,
        occurredAt: "2026-09-20T00:00:02.000Z",
        event: {
          type: "action.completed",
          actionRequestId,
          result: "executed",
        },
      }),
    ];

    const appended = await repository.appendMany(records);
    assert(Result.isSuccess(appended));
    const loaded = await repository.listForAction({ organizationId, actionRequestId });
    assert(Result.isSuccess(loaded));
    expect(loaded.value.map((record) => record.event.type)).toEqual([
      "workflow.started",
      "approval_plan.materialized",
      "action.completed",
    ]);
    expect(loaded.value.map((record) => record.eventKey)).toEqual(
      records.map((record) => record.eventKey),
    );

    const outbox = sqlite
      .prepare(
        "SELECT event_type, notification_key, status FROM outbox_events ORDER BY sequence ASC",
      )
      .all() as Array<{ event_type: string; notification_key: string; status: string }>;
    expect(outbox).toEqual([
      {
        event_type: "action.completed",
        notification_key: `notification:${records[2]?.eventKey}`,
        status: "pending",
      },
    ]);
  });
});
