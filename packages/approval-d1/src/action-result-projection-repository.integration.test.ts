import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import type { ActionRequestId, OrganizationId } from "@app/approval-core";

import { D1ActionResultProjectionRepository } from "./action-result-projection-repository.ts";
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

describe("D1ActionResultProjectionRepository", () => {
  it("AC-M5-008: best-effort保証をexactly-onceへ昇格せず保存・再読込する", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(
      readFileSync(new URL("../migrations/0005_action_results.sql", import.meta.url), "utf8"),
    );
    const repository = new D1ActionResultProjectionRepository(new SqliteD1Database(sqlite));
    const organizationId = branded<OrganizationId>("org:m5");
    const actionRequestId = branded<ActionRequestId>("action-request:m5-projection");

    const saved = await repository.save({
      organizationId,
      actionRequestId,
      workflowInstanceId: String(actionRequestId),
      status: "executed",
      guaranteeLevel: "best_effort_at_most_once",
      idempotencyKey: "action-request:m5-projection:sha256:action",
      result: { status: "succeeded", output: { ok: true } },
      completedAt: "2026-09-18T14:00:00.000Z",
    });
    assert(Result.isSuccess(saved));

    const loaded = await repository.load({ organizationId, actionRequestId });
    assert(Result.isSuccess(loaded));
    expect(loaded.value).toEqual({
      organizationId,
      actionRequestId,
      workflowInstanceId: String(actionRequestId),
      status: "executed",
      guaranteeLevel: "best_effort_at_most_once",
      idempotencyKey: "action-request:m5-projection:sha256:action",
      result: { status: "succeeded", output: { ok: true } },
      completedAt: "2026-09-18T14:00:00.000Z",
    });
  });
});
