import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import { actionEventRecord } from "@app/approval-core";
import type { ActionFingerprint, ActionRequestId, OrganizationId } from "@app/approval-core";

import { D1ActionEventRepository } from "./action-event-repository.ts";
import { purgeExpiredOperationalData } from "./retention.ts";
import { migratedSqliteD1 } from "./testing/sqlite-d1.ts";

const org = "organization:retention" as OrganizationId;
const now = "2026-09-25T00:00:00.000Z";
const old = "2026-01-01T00:00:00.000Z";
const recent = "2026-09-24T12:00:00.000Z";

function received(actionRequestId: string, fingerprint = "sha256:a") {
  return actionEventRecord({
    organizationId: org,
    occurredAt: recent,
    event: {
      type: "action.received",
      actionRequestId: actionRequestId as ActionRequestId,
      actor: { type: "user", id: "user:alice" as never },
      authority: { type: "user", id: "user:alice" as never },
      actionFingerprint: fingerprint as ActionFingerprint,
    },
  });
}

describe("#99 append-only audit", () => {
  it("action_events / force_cancel_auditへのUPDATE / DELETEをDBが拒否する", async () => {
    const db = migratedSqliteD1();
    const appended = await new D1ActionEventRepository(db).appendMany([received("action:1")]);
    assert(Result.isSuccess(appended));
    db.db.exec(
      `INSERT INTO force_cancel_audit (organization_id, source_action_request_id,
         target_action_request_id, actor_json, reason, occurred_at, post_review_required)
       VALUES ('${org}', 'action:fc', 'action:1', '{}', 'drill', '${recent}', 1)`,
    );
    for (const statement of [
      "UPDATE action_events SET event_json = '{}'",
      "DELETE FROM action_events",
      "UPDATE force_cancel_audit SET reason = 'rewritten'",
      "DELETE FROM force_cancel_audit",
    ]) {
      expect(() => db.db.exec(statement), statement).toThrow(/append-only/);
    }
  });

  it("appendManyは同じeventKeyで内容が異なるeventを黙って無視せずerrorにする", async () => {
    const repository = new D1ActionEventRepository(migratedSqliteD1());
    assert(Result.isSuccess(await repository.appendMany([received("action:2")])));
    // 同じ内容の再送（retry）は冪等に成功する
    assert(Result.isSuccess(await repository.appendMany([received("action:2")])));
    const conflicting = await repository.appendMany([received("action:2", "sha256:tampered")]);
    assert(Result.isFailure(conflicting));
    expect(conflicting.error.code).toBe("action_event_conflict");
  });
});

describe("#99 operational data retention", () => {
  it("保持期間を過ぎた運用データだけを削除する", async () => {
    const db = migratedSqliteD1();
    const nowMs = Date.parse(now);
    db.db.exec(`
      INSERT INTO rate_limit_counters (scope_key, window_start_ms, count, reset_at_ms) VALUES
        ('expired', 1, 1, ${nowMs - 2 * 60 * 60 * 1000}),
        ('current', 2, 1, ${nowMs + 60 * 1000});
      INSERT INTO api_idempotency_keys (organization_id, operation, idempotency_key, request_hash,
        status, created_at, updated_at, locked_until) VALUES
        ('${org}', 'op', 'old-completed', 'h', 'completed', '${old}', '${old}', NULL),
        ('${org}', 'op', 'recent-completed', 'h', 'completed', '${recent}', '${recent}', NULL),
        ('${org}', 'op', 'stale-pending', 'h', 'pending', '${old}', '${old}', '${old}');
      INSERT INTO approval_commands (command_id, organization_id, action_request_id, task_id,
        command_type, status, created_at, applied_at) VALUES
        ('old-applied', '${org}', 'a', 't', 'approve', 'applied', '${old}', '${old}'),
        ('old-delivered', '${org}', 'a', 't', 'approve', 'delivered', '${old}', NULL),
        ('recent-applied', '${org}', 'a', 't', 'approve', 'applied', '${recent}', '${recent}');
      INSERT INTO outbox_events (organization_id, action_request_id, outbox_key, notification_key,
        event_key, event_type, recipient_mode, status, created_at) VALUES
        ('${org}', 'a', 'o1', 'n1', 'e1', 'action.completed', 'action_requester', 'dispatched', '${old}'),
        ('${org}', 'a', 'o2', 'n2', 'e2', 'action.completed', 'action_requester', 'pending', '${old}'),
        ('${org}', 'a', 'o3', 'n3', 'e3', 'action.completed', 'action_requester', 'dispatched', '${recent}');
      INSERT INTO notification_deliveries (organization_id, notification_key, event_key,
        recipient_user_id, status, created_at, updated_at) VALUES
        ('${org}', 'n1', 'e1', 'u1', 'sent', '${old}', '${old}'),
        ('${org}', 'n3', 'e3', 'u1', 'sent', '${recent}', '${recent}');
    `);
    const appended = await new D1ActionEventRepository(db).appendMany([received("action:kept")]);
    assert(Result.isSuccess(appended));

    const purged = await purgeExpiredOperationalData(db, { now });
    assert(Result.isSuccess(purged));
    expect(purged.value).toEqual({
      rateLimitCounters: 1,
      idempotencyKeys: 2,
      approvalCommands: 1,
      notificationDeliveries: 1,
      outboxEvents: 1,
    });
    const keys = (table: string, column: string) =>
      (
        db.db.prepare(`SELECT ${column} AS key FROM ${table} ORDER BY 1`).all() as { key: string }[]
      ).map((row) => row.key);
    expect(keys("rate_limit_counters", "scope_key")).toEqual(["current"]);
    expect(keys("api_idempotency_keys", "idempotency_key")).toEqual(["recent-completed"]);
    // 未終端（delivered）のcommandとpendingのoutboxは期間を過ぎても消さない
    expect(keys("approval_commands", "command_id")).toEqual(["old-delivered", "recent-applied"]);
    expect(keys("outbox_events", "outbox_key")).toEqual(["o2", "o3"]);
    // 監査は保持期間の対象外
    expect(keys("action_events", "event_type")).toEqual(["action.received"]);
  });
});
