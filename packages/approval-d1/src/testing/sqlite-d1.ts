import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1RunResultLike,
} from "../materialized-plan-repository.ts";

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
    return JSON.stringify(value);
  });
}

/**
 * In-memory SQLite stand-in for D1 (tests only). `batch()` is atomic like
 * D1: every statement commits together or none does.
 */
export class SqliteD1Database implements D1DatabaseLike {
  /** Test hook: fail the Nth upcoming batch() (1-based) before it commits. */
  failNextBatchAt: number | null = null;

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
    if (this.failNextBatchAt !== null) {
      this.failNextBatchAt -= 1;
      if (this.failNextBatchAt <= 0) {
        this.failNextBatchAt = null;
        return Promise.reject(new Error("injected D1 batch failure"));
      }
    }
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

export function migratedSqliteD1(): SqliteD1Database {
  const sqlite = new DatabaseSync(":memory:");
  const directory = new URL("../../migrations/", import.meta.url);
  for (const migration of readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    sqlite.exec(readFileSync(new URL(migration, directory), "utf8"));
  }
  return new SqliteD1Database(sqlite);
}
