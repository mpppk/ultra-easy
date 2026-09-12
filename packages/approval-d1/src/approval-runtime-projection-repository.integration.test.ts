import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import type {
  ActionRequestId,
  ApprovalPlanChecksum,
  ApprovalRuntimeState,
  ApprovalTaskId,
  MaterializedStepId,
  OrganizationId,
  UserId,
} from "@app/approval-core";

import { D1ApprovalRuntimeProjectionRepository } from "./approval-runtime-projection-repository.ts";
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

const organizationId = branded<OrganizationId>("org:m4");
const actionRequestId = branded<ActionRequestId>("action-request:m4");
const taskId = branded<ApprovalTaskId>("task:m4:manager");

function state(status: ApprovalRuntimeState["status"] = "pending"): ApprovalRuntimeState {
  return {
    schemaVersion: 1,
    actionRequestId,
    approvalPlanChecksum: branded<ApprovalPlanChecksum>("sha256:plan-m4"),
    interpreterSemanticsVersion: 1,
    status,
    startedAt: "2026-09-13T00:00:00.000Z",
    ...(status === "approved" ? { completedAt: "2026-09-13T00:02:00.000Z" } : {}),
    processedDecisionKeys: status === "approved" ? ["decision:1"] : [],
    tasks: [
      {
        id: taskId,
        materializedStepId: branded<MaterializedStepId>("mstep:manager"),
        status: status === "approved" ? "approved" : "pending",
        target: {
          type: "user",
          userId: branded<UserId>("user:alice"),
          sourceKind: "user",
        },
        candidateUserIds: [branded<UserId>("user:alice")],
        decisions:
          status === "approved"
            ? [
                {
                  idempotencyKey: "decision:1",
                  taskId,
                  userId: branded<UserId>("user:alice"),
                  decision: "approve",
                  decidedAt: "2026-09-13T00:02:00.000Z",
                },
              ]
            : [],
        activatedAt: "2026-09-13T00:00:00.000Z",
        ...(status === "approved" ? { closedAt: "2026-09-13T00:02:00.000Z" } : {}),
        usedFallback: false,
      },
    ],
  };
}

function createRepository() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    readFileSync(
      new URL("../migrations/0003_approval_runtime_projections.sql", import.meta.url),
      "utf8",
    ),
  );
  const database = new SqliteD1Database(sqlite);
  return { repository: new D1ApprovalRuntimeProjectionRepository(database), sqlite };
}

describe("D1ApprovalRuntimeProjectionRepository", () => {
  it("runtime stateとtask read modelを保存・再読込できる", async () => {
    const { repository, sqlite } = createRepository();
    const saved = await repository.replace({ organizationId, state: state() });
    assert(Result.isSuccess(saved));

    const loaded = await repository.load({ organizationId, actionRequestId });
    assert(Result.isSuccess(loaded));
    expect(loaded.value).toEqual(state());

    const task = sqlite
      .prepare(
        "SELECT status, candidate_user_ids FROM approval_tasks WHERE organization_id = ? AND task_id = ?",
      )
      .get(organizationId, taskId) as { status: string; candidate_user_ids: string } | undefined;
    expect(task?.status).toBe("pending");
    expect(JSON.parse(task?.candidate_user_ids ?? "[]")).toEqual(["user:alice"]);
  });

  it("Decision後のstate/task projectionを更新する", async () => {
    const { repository, sqlite } = createRepository();
    assert(Result.isSuccess(await repository.replace({ organizationId, state: state() })));
    assert(
      Result.isSuccess(await repository.replace({ organizationId, state: state("approved") })),
    );

    const loaded = await repository.load({ organizationId, actionRequestId });
    assert(Result.isSuccess(loaded));
    expect(loaded.value?.status).toBe("approved");
    expect(loaded.value?.tasks[0]?.decisions).toHaveLength(1);

    const runtime = sqlite
      .prepare(
        "SELECT status, updated_at FROM approval_runtime_projections WHERE organization_id = ? AND action_request_id = ?",
      )
      .get(organizationId, actionRequestId) as { status: string; updated_at: string } | undefined;
    expect(runtime).toEqual({ status: "approved", updated_at: "2026-09-13T00:02:00.000Z" });
  });
});
