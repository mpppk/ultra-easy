import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import type {
  ApprovalTaskCandidateProjection,
  ApprovalTaskId,
  MaterializedStepId,
  OrganizationId,
  UserId,
} from "@app/approval-core";

import { D1ApproverCandidateProjectionRepository } from "./approver-candidate-projection-repository.ts";
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
  constructor(private readonly db: DatabaseSync) {}

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
      async run(): Promise<D1RunResultLike> {
        const result = statement.run(...sqlValues(values));
        return { success: true, meta: { changes: Number(result.changes) } };
      },
    };
    return prepared;
  }
}

function branded<T extends string>(value: string): T {
  return value as T;
}

function projection(userIds: string[]): ApprovalTaskCandidateProjection {
  return {
    organizationId: branded<OrganizationId>("org:m3"),
    approvalTaskId: branded<ApprovalTaskId>("task:m3"),
    materializedStepId: branded<MaterializedStepId>("mstep:m3"),
    candidateUserIds: userIds.map((userId) => branded<UserId>(userId)),
    complete: false,
    resolvedAt: "2026-09-12T12:00:00.000Z",
    sourceRevision: "fga:model-1",
  };
}

function createRepository(): D1ApproverCandidateProjectionRepository {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    readFileSync(
      new URL("../migrations/0002_approval_task_candidate_projections.sql", import.meta.url),
      "utf8",
    ),
  );
  return new D1ApproverCandidateProjectionRepository(new SqliteD1Database(sqlite));
}

describe("D1ApproverCandidateProjectionRepository", () => {
  it("dynamic candidate projectionを保存・再読込できる", async () => {
    const repository = createRepository();
    const saved = await repository.replace(projection(["user:alice", "user:bob"]));
    assert(Result.isSuccess(saved));

    const loaded = await repository.load({
      organizationId: branded<OrganizationId>("org:m3"),
      approvalTaskId: branded<ApprovalTaskId>("task:m3"),
    });
    assert(Result.isSuccess(loaded));
    expect(loaded.value?.candidateUserIds.map(String)).toEqual(["user:alice", "user:bob"]);
    expect(loaded.value?.complete).toBe(false);
  });

  it("同じtaskのprojectionを組織変更後の候補集合でatomicに置換する", async () => {
    const repository = createRepository();
    assert(Result.isSuccess(await repository.replace(projection(["user:alice"]))));
    assert(Result.isSuccess(await repository.replace(projection(["user:bob"]))));

    const loaded = await repository.load({
      organizationId: branded<OrganizationId>("org:m3"),
      approvalTaskId: branded<ApprovalTaskId>("task:m3"),
    });
    assert(Result.isSuccess(loaded));
    expect(loaded.value?.candidateUserIds.map(String)).toEqual(["user:bob"]);
  });
});
