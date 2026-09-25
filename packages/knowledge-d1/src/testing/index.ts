import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type { D1DatabaseLike, D1PreparedStatementLike, D1RunResultLike } from "../db.ts";

type SqlValue = string | number | bigint | Uint8Array | null;

function sqlValues(values: readonly unknown[]): SqlValue[] {
  return values.map((value) =>
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    value instanceof Uint8Array
      ? value
      : JSON.stringify(value),
  );
}

/**
 * In-memory SQLite stand-in for D1 (tests only, node:sqlite ships FTS5).
 * `batch()` is atomic and serialized like D1.
 */
export class SqliteD1Database implements D1DatabaseLike {
  private queue: Promise<unknown> = Promise.resolve();

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

  batch(statements: D1PreparedStatementLike[]): Promise<D1RunResultLike[]> {
    const run = this.queue.then(async () => {
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
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

/** Fresh in-memory database with every `*.sql` migration of `directory` applied. */
export function sqliteD1WithMigrations(directory: URL): SqliteD1Database {
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    sqlite.exec(readFileSync(new URL(migration, directory), "utf8"));
  }
  return new SqliteD1Database(sqlite);
}

export const KNOWLEDGE_MIGRATIONS = new URL("../../migrations/", import.meta.url);

export function migratedKnowledgeD1(): SqliteD1Database {
  return sqliteD1WithMigrations(KNOWLEDGE_MIGRATIONS);
}
