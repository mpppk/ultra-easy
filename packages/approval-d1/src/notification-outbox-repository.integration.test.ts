import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import { actionEventRecord } from "@app/approval-core";
import type {
  ActionFingerprint,
  ActionRequestId,
  ApprovalStepKey,
  AuthorizationObjectRef,
  MaterializedStepId,
  OrganizationId,
  RelationName,
  UserId,
} from "@app/approval-core";

import { D1ActionEventRepository } from "./action-event-repository.ts";
import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1RunResultLike,
} from "./materialized-plan-repository.ts";
import { D1NotificationOutboxRepository } from "./notification-outbox-repository.ts";

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

const organizationId = branded<OrganizationId>("org:notification");
const actionRequestId = branded<ActionRequestId>("action:notification");
const materializedStepId = branded<MaterializedStepId>("mstep:manager");
const stepKey = branded<ApprovalStepKey>("manager");
const alice = branded<UserId>("user:alice");
const bob = branded<UserId>("user:bob");

function createRepositories() {
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of [
    "0003_approval_runtime_projections.sql",
    "0007_action_events.sql",
    "0008_notification_outbox.sql",
  ]) {
    sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
  }
  const db = new SqliteD1Database(sqlite);
  return {
    sqlite,
    events: new D1ActionEventRepository(db),
    outbox: new D1NotificationOutboxRepository(db),
  };
}

function activatedEvent(
  target:
    | {
        type: "user";
        userId: UserId;
        sourceKind: "user";
      }
    | {
        type: "relation";
        object: AuthorizationObjectRef;
        relation: RelationName;
        sourceKind: "relation";
      },
) {
  return actionEventRecord({
    organizationId,
    occurredAt: "2026-09-20T08:00:00.000Z",
    event: {
      type: "step.activated",
      actionRequestId,
      materializedStepId,
      stepKey,
      target,
    },
  });
}

describe("D1NotificationOutboxRepository", () => {
  it("AC-M7-005: direct user step activationをdomain eventからoutboxへ投影する", async () => {
    const { sqlite, events, outbox } = createRepositories();
    const record = activatedEvent({ type: "user", userId: alice, sourceKind: "user" });

    assert(Result.isSuccess(await events.append(record)));
    assert(Result.isSuccess(await events.append(record)));

    const entries = await outbox.listDispatchable();
    assert(Result.isSuccess(entries));
    expect(entries.value).toHaveLength(1);
    expect(entries.value[0]).toMatchObject({
      actionRequestId,
      eventKey: record.eventKey,
      eventType: "step.activated",
      recipientMode: "direct_user",
      recipientUserId: alice,
      status: "pending",
    });
    const recipients = await outbox.resolveRecipients(entries.value[0]!);
    assert(Result.isSuccess(recipients));
    expect(recipients.value).toEqual([alice]);

    const count = sqlite.prepare("SELECT COUNT(*) AS count FROM outbox_events").get() as {
      count: number;
    };
    expect(count.count).toBe(1);
  });

  it("AC-M7-005: relation activationはapproval task candidatesからrecipientを解決する", async () => {
    const { sqlite, events, outbox } = createRepositories();
    sqlite
      .prepare(
        `INSERT INTO approval_tasks (
           organization_id, task_id, action_request_id, materialized_step_id,
           status, candidate_user_ids, decisions, activated_at
         ) VALUES (?, ?, ?, ?, 'pending', ?, '[]', ?)`,
      )
      .run(
        organizationId,
        "task:manager",
        actionRequestId,
        materializedStepId,
        JSON.stringify([alice, bob]),
        "2026-09-20T08:00:00.000Z",
      );

    const record = activatedEvent({
      type: "relation",
      object: branded<AuthorizationObjectRef>("document:1"),
      relation: branded<RelationName>("manager"),
      sourceKind: "relation",
    });
    assert(Result.isSuccess(await events.append(record)));

    const entries = await outbox.listDispatchable();
    assert(Result.isSuccess(entries));
    expect(entries.value[0]).toMatchObject({
      recipientMode: "task_candidates",
      materializedStepId,
    });
    const recipients = await outbox.resolveRecipients(entries.value[0]!);
    assert(Result.isSuccess(recipients));
    expect(recipients.value).toEqual([alice, bob]);
  });

  it("AC-M7-004: requester delivery stateとfailed deliveryをqueryできる", async () => {
    const { events, outbox } = createRepositories();
    const received = actionEventRecord({
      organizationId,
      occurredAt: "2026-09-20T08:00:00.000Z",
      event: {
        type: "action.received",
        actionRequestId,
        actor: { type: "service", id: branded("service:agent") },
        authority: { type: "user", id: bob },
        caller: { type: "user", id: alice },
        actionFingerprint: branded<ActionFingerprint>("sha256:action"),
      },
    });
    const completed = actionEventRecord({
      organizationId,
      occurredAt: "2026-09-20T08:05:00.000Z",
      event: {
        type: "action.completed",
        actionRequestId,
        result: "executed",
      },
    });
    assert(Result.isSuccess(await events.appendMany([received, completed])));

    const entries = await outbox.listDispatchable();
    assert(Result.isSuccess(entries));
    expect(entries.value).toHaveLength(1);
    const entry = entries.value[0]!;
    const recipients = await outbox.resolveRecipients(entry);
    assert(Result.isSuccess(recipients));
    expect(recipients.value).toEqual([alice]);

    const delivery = await outbox.ensureDelivery({
      entry,
      recipientUserId: alice,
      now: "2026-09-20T08:06:00.000Z",
    });
    assert(Result.isSuccess(delivery));
    expect(delivery.value.status).toBe("pending");

    assert(
      Result.isSuccess(
        await outbox.markDeliveryFailed({
          organizationId,
          notificationKey: entry.notificationKey,
          recipientUserId: alice,
          failedAt: "2026-09-20T08:07:00.000Z",
          error: "temporary provider outage",
        }),
      ),
    );

    const health = await outbox.health();
    assert(Result.isSuccess(health));
    expect(health.value).toEqual({
      pendingOutbox: 1,
      failedOutbox: 0,
      failedDeliveries: 1,
    });

    const request = outbox.notificationRequest({
      entry,
      event: completed.event,
      recipientUserId: alice,
    });
    expect(request.notificationKey).toBe(`${entry.notificationKey}:user:user:alice`);
  });
});
