import { Result } from "@praha/byethrow";
import { assert, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  definePolicy,
  rule,
  always,
  none,
  type ApplicationApprovalPolicyRecord,
  type OrganizationId,
  type UserId,
} from "@app/approval-core";

import { D1ApplicationApprovalPolicyRepository } from "./application-approval-policy-repository.ts";
import { migratedSqliteD1, type SqliteD1Database } from "./testing/sqlite-d1.ts";

const org = "organization:tenant-a" as OrganizationId;
const alice = { type: "user" as const, id: "user:alice" as UserId };
const scope = {
  organizationId: org,
  application: "knowledge",
  scopeType: "knowledge_space",
  scopeId: "spc-1",
};
const policyKey = "app:knowledge:approval:knowledge.page.archive";
const compiled = definePolicy({
  key: policyKey,
  name: "archive",
  rules: [rule("default:none", { when: always(), flow: none() })],
});

function record(
  overrides: Partial<ApplicationApprovalPolicyRecord> = {},
): ApplicationApprovalPolicyRecord {
  return {
    scopeId: "spc-1",
    version: 1,
    policy: { rules: [] },
    approvalPolicyVersion: 2,
    sourceActionRequestId: "ar-1",
    createdAt: "2026-09-30T00:00:00.000Z",
    ...overrides,
  };
}

function bootstrap(db: SqliteD1Database) {
  db.db
    .prepare(
      `INSERT INTO published_approval_policy_versions (organization_id, policy_key, version, policy_json,
         actor_json, source_action_request_id, published_at) VALUES (?, ?, 1, '{}', '{}', 'bootstrap', 't')`,
    )
    .run(String(org), policyKey);
}

describe("D1ApplicationApprovalPolicyRepository", () => {
  let db: SqliteD1Database;
  let repository: D1ApplicationApprovalPolicyRepository;

  beforeEach(() => {
    db = migratedSqliteD1();
    repository = new D1ApplicationApprovalPolicyRepository(db);
    bootstrap(db);
  });

  it("stores a rule version and the compiled policy version together", async () => {
    expect(
      await repository.latestApprovalPolicyVersion({
        organizationId: org,
        policyKeys: [policyKey],
      }),
    ).toEqual(Result.succeed(1));
    const applied = await repository.apply({
      scope,
      record: record(),
      approvalPolicies: [compiled],
      actor: alice,
    });
    assert(Result.isSuccess(applied));
    expect(applied.value.type).toBe("applied");
    const current = await repository.current(scope);
    assert(Result.isSuccess(current));
    expect(current.value).toEqual(record());
    const listed = await repository.listCurrent(scope);
    assert(Result.isSuccess(listed));
    expect(listed.value.map((entry) => entry.scopeId)).toEqual(["spc-1"]);
    expect(
      await repository.latestApprovalPolicyVersion({
        organizationId: org,
        policyKeys: [policyKey],
      }),
    ).toEqual(Result.succeed(2));
  });

  it("writes nothing when either version already exists", async () => {
    assert(
      Result.isSuccess(
        await repository.apply({
          scope,
          record: record(),
          approvalPolicies: [compiled],
          actor: alice,
        }),
      ),
    );

    // Same scope version from another proposal.
    const sameScope = await repository.apply({
      scope,
      record: record({ approvalPolicyVersion: 3, sourceActionRequestId: "ar-2" }),
      approvalPolicies: [compiled],
      actor: alice,
    });
    assert(Result.isSuccess(sameScope));
    expect(sameScope.value.type).toBe("conflict");

    // Another space took the policy version first.
    const samePolicy = await repository.apply({
      scope: { ...scope, scopeId: "spc-2" },
      record: record({ scopeId: "spc-2", sourceActionRequestId: "ar-3" }),
      approvalPolicies: [compiled],
      actor: alice,
    });
    assert(Result.isSuccess(samePolicy));
    expect(samePolicy.value.type).toBe("conflict");

    const rows = db.db
      .prepare("SELECT count(*) AS total FROM application_approval_policies")
      .get() as { total: number };
    expect(rows.total).toBe(1);
    const versions = db.db
      .prepare(
        "SELECT count(*) AS total FROM published_approval_policy_versions WHERE organization_id = ? AND policy_key = ?",
      )
      .get(String(org), policyKey) as { total: number };
    expect(versions.total).toBe(2);
  });

  it("keeps the rule history immutable", async () => {
    assert(
      Result.isSuccess(
        await repository.apply({
          scope,
          record: record(),
          approvalPolicies: [compiled],
          actor: alice,
        }),
      ),
    );
    expect(() => db.db.exec("UPDATE application_approval_policies SET policy_json = '{}'")).toThrow(
      /immutable/,
    );
    expect(() => db.db.exec("DELETE FROM application_approval_policies")).toThrow(/immutable/);
  });

  it("reports a missing bootstrap policy as null", async () => {
    expect(
      await repository.latestApprovalPolicyVersion({
        organizationId: org,
        policyKeys: [policyKey, "app:other"],
      }),
    ).toEqual(Result.succeed(null));
  });

  it("finds recent rule-change proposals of one scope", async () => {
    const insert = (
      id: string,
      spaceId: string,
      createdAt: string,
      type = "application.approval_policy.update",
    ) =>
      db.db
        .prepare(
          `INSERT INTO action_requests (id, organization_id, action_fingerprint, evaluation_snapshot,
             evaluation_snapshot_checksum, policy_binding_snapshots, materialized_plan, approval_plan_checksum,
             approval_binding_fingerprint, interpreter_semantics_version, created_at)
           VALUES (?, ?, 'fp', '{}', 'c', '[]', ?, 'p', 'b', 1, ?)`,
        )
        .run(
          id,
          String(org),
          JSON.stringify({ action: { type, resource: { type: "knowledge_space", id: spaceId } } }),
          createdAt,
        );
    insert("ar-old", "spc-1", "2026-09-30T00:00:00.000Z");
    insert("ar-new", "spc-1", "2026-09-30T01:00:00.000Z");
    insert("ar-other-space", "spc-2", "2026-09-30T02:00:00.000Z");
    insert("ar-other-type", "spc-1", "2026-09-30T03:00:00.000Z", "knowledge.page.archive");
    const found = await repository.recentProposalIds({
      organizationId: org,
      scopeType: "knowledge_space",
      scopeId: "spc-1",
      limit: 5,
    });
    expect(found).toEqual(Result.succeed(["ar-new", "ar-old"]));
  });
});
