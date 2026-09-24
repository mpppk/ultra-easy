import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import type { OrganizationId } from "@app/approval-core";

import { D1AuthorizationRelationshipReadRepository } from "./authorization-relationship-repository.ts";
import { migratedSqliteD1, type SqliteD1Database } from "./testing/sqlite-d1.ts";

const orgA = "organization:tenant-a" as OrganizationId;
const orgB = "organization:tenant-b" as OrganizationId;

function insertRelationship(
  db: SqliteD1Database,
  input: {
    organizationId: string;
    tupleKey: string;
    user: string;
    relation?: string;
    object?: string;
    syncStatus?: string;
    updatedAt: string;
  },
) {
  db.db
    .prepare(
      `INSERT INTO authorization_relationships (
         organization_id, tuple_key, subject, relation, logical_object, object_type,
         desired_present, revision, latest_mutation_key, latest_action_request_id,
         confirmed_revision, confirmed_present, sync_status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'ticket', 1, 1, 'm-1', 'action:1', 1, 1, ?, ?, ?)`,
    )
    .run(
      input.organizationId,
      input.tupleKey,
      input.user,
      input.relation ?? "can_execute",
      input.object ?? "ticket:T-1",
      input.syncStatus ?? "confirmed",
      input.updatedAt,
      input.updatedAt,
    );
}

function insertEvent(db: SqliteD1Database, organizationId: string, key: string, type: string) {
  db.db
    .prepare(
      `INSERT INTO authorization_relationship_events (
         organization_id, event_key, event_type, occurred_at, actor_type, actor_id,
         source_action_request_id, mutation_key, tuple_key, revision, operation,
         desired_present, subject, relation, logical_object, authorization_model_id
       ) VALUES (?, ?, ?, '2026-09-24T00:00:00.000Z', 'user', 'user:editor', 'action:1', 'm-1',
                 'tuple:1', 1, 'write', 1, 'user:alice', 'can_execute', 'ticket:T-1', 'model-1')`,
    )
    .run(organizationId, key, type);
}

describe("D1AuthorizationRelationshipReadRepository (AC-M9-003)", () => {
  it("lists only the current organization with filters and an opaque bounded cursor", async () => {
    const db = migratedSqliteD1();
    for (let index = 0; index < 5; index += 1) {
      insertRelationship(db, {
        organizationId: orgA,
        tupleKey: `tuple:a-${index}`,
        user: index % 2 === 0 ? "user:alice" : "user:bob",
        updatedAt: `2026-09-24T00:00:0${index}.000Z`,
      });
    }
    insertRelationship(db, {
      organizationId: orgB,
      tupleKey: "tuple:b-0",
      user: "user:alice",
      updatedAt: "2026-09-24T00:00:09.000Z",
    });
    const repository = new D1AuthorizationRelationshipReadRepository(db);

    const first = await repository.list({ organizationId: orgA, limit: 2 });
    assert(Result.isSuccess(first));
    expect(first.value.items.map((item) => item.tupleKey)).toEqual(["tuple:a-4", "tuple:a-3"]);
    assert(first.value.nextCursor);
    expect(first.value.nextCursor).not.toContain("tuple:");

    const second = await repository.list({
      organizationId: orgA,
      limit: 2,
      cursor: first.value.nextCursor,
    });
    assert(Result.isSuccess(second));
    expect(second.value.items.map((item) => item.tupleKey)).toEqual(["tuple:a-2", "tuple:a-1"]);

    const all = await repository.list({ organizationId: orgA, limit: 500 });
    assert(Result.isSuccess(all));
    expect(all.value.items).toHaveLength(5);
    expect(all.value.items.every((item) => item.organizationId === orgA)).toBe(true);

    const filtered = await repository.list({
      organizationId: orgA,
      subject: "user:bob",
      limit: 10,
    });
    assert(Result.isSuccess(filtered));
    expect(filtered.value.items.map((item) => item.tuple.user)).toEqual(["user:bob", "user:bob"]);

    const invalid = await repository.list({ organizationId: orgA, cursor: "!!", limit: 10 });
    assert(Result.isFailure(invalid));
    expect(invalid.error.code).toBe("invalid_cursor");
  });

  it("get() never returns another organization's tuple", async () => {
    const db = migratedSqliteD1();
    insertRelationship(db, {
      organizationId: orgB,
      tupleKey: "tuple:shared",
      user: "user:alice",
      updatedAt: "2026-09-24T00:00:00.000Z",
    });
    const repository = new D1AuthorizationRelationshipReadRepository(db);
    const loaded = await repository.get({ organizationId: orgA, tupleKey: "tuple:shared" });
    assert(Result.isSuccess(loaded));
    expect(loaded.value).toBeNull();
  });

  it("audit is append-only at the database level and filtered per organization", async () => {
    const db = migratedSqliteD1();
    insertEvent(db, orgA, "e-1", "authorization.relationship_change_requested");
    insertEvent(db, orgA, "e-2", "authorization.relationship_change_confirmed");
    insertEvent(db, orgB, "e-3", "authorization.relationship_change_requested");
    expect(() =>
      db.db.exec("UPDATE authorization_relationship_events SET event_type = 'x'"),
    ).toThrow(/append-only/);
    expect(() => db.db.exec("DELETE FROM authorization_relationship_events")).toThrow(
      /append-only/,
    );

    const repository = new D1AuthorizationRelationshipReadRepository(db);
    const confirmed = await repository.listAudit({
      organizationId: orgA,
      eventType: "authorization.relationship_change_confirmed",
      limit: 10,
    });
    assert(Result.isSuccess(confirmed));
    expect(confirmed.value.items.map((event) => event.eventKey)).toEqual(["e-2"]);

    const page = await repository.listAudit({ organizationId: orgA, limit: 1 });
    assert(Result.isSuccess(page) && page.value.nextCursor);
    const next = await repository.listAudit({
      organizationId: orgA,
      limit: 1,
      cursor: page.value.nextCursor,
    });
    assert(Result.isSuccess(next));
    expect([...page.value.items, ...next.value.items].map((event) => event.eventKey)).toEqual([
      "e-2",
      "e-1",
    ]);
  });
});
