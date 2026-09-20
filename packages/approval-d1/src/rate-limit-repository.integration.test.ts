import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import type { OrganizationId, UserId } from "@app/approval-core";

import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1RunResultLike,
} from "./materialized-plan-repository.ts";
import { D1FixedWindowRateLimiter } from "./rate-limit-repository.ts";

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

function createLimiter(): D1FixedWindowRateLimiter {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    readFileSync(new URL("../migrations/0010_rate_limit_counters.sql", import.meta.url), "utf8"),
  );
  return new D1FixedWindowRateLimiter(new SqliteD1Database(sqlite));
}

const tenantA = branded<OrganizationId>("organization:rate-a");
const tenantB = branded<OrganizationId>("organization:rate-b");
const alice = branded<UserId>("user:alice");
const bob = branded<UserId>("user:bob");

describe("D1 fixed-window rate limiter", () => {
  it("tenant/principal/operation scopeをD1上でも分離する", async () => {
    const limiter = createLimiter();
    const policy = { limit: 1, windowSeconds: 60 };
    const now = "2026-09-20T12:00:10.000Z";

    const consume = (input: {
      organizationId: OrganizationId;
      userId: UserId;
      operation: "action_request.submit" | "approval_decision.submit";
    }) =>
      limiter.consume({
        organizationId: input.organizationId,
        principal: { type: "user", id: input.userId },
        operation: input.operation,
        policy,
        now,
      });

    const first = await consume({
      organizationId: tenantA,
      userId: alice,
      operation: "action_request.submit",
    });
    const same = await consume({
      organizationId: tenantA,
      userId: alice,
      operation: "action_request.submit",
    });
    const tenant = await consume({
      organizationId: tenantB,
      userId: alice,
      operation: "action_request.submit",
    });
    const principal = await consume({
      organizationId: tenantA,
      userId: bob,
      operation: "action_request.submit",
    });
    const operation = await consume({
      organizationId: tenantA,
      userId: alice,
      operation: "approval_decision.submit",
    });

    assert(Result.isSuccess(first));
    assert(Result.isSuccess(same));
    assert(Result.isSuccess(tenant));
    assert(Result.isSuccess(principal));
    assert(Result.isSuccess(operation));
    expect(first.value.allowed).toBe(true);
    expect(same.value.allowed).toBe(false);
    expect(tenant.value.allowed).toBe(true);
    expect(principal.value.allowed).toBe(true);
    expect(operation.value.allowed).toBe(true);
  });

  it("window reset後は同じscopeを再度許可する", async () => {
    const limiter = createLimiter();
    const base = {
      organizationId: tenantA,
      principal: { type: "user" as const, id: alice },
      operation: "action_request.submit" as const,
      policy: { limit: 1, windowSeconds: 60 },
    };

    const first = await limiter.consume({ ...base, now: "2026-09-20T12:00:59.000Z" });
    const limited = await limiter.consume({ ...base, now: "2026-09-20T12:00:59.500Z" });
    const reset = await limiter.consume({ ...base, now: "2026-09-20T12:01:00.000Z" });

    assert(Result.isSuccess(first));
    assert(Result.isSuccess(limited));
    assert(Result.isSuccess(reset));
    expect(first.value.allowed).toBe(true);
    expect(limited.value.allowed).toBe(false);
    expect(limited.value.retryAfterSeconds).toBe(1);
    expect(reset.value.allowed).toBe(true);
  });
});
