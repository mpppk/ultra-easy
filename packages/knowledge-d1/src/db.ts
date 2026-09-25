import { Result } from "@praha/byethrow";

/** Structural subset of Cloudflare D1 used by the Knowledge repositories. */
export type D1RunResultLike = { success: boolean; meta?: { changes?: number } };

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<D1RunResultLike>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch(statements: D1PreparedStatementLike[]): Promise<D1RunResultLike[]>;
}

export type KnowledgeStoreErrorCode = "store_failed" | "duplicate_key" | "draft_conflict";

export class KnowledgeStoreError extends Error {
  constructor(
    readonly code: KnowledgeStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeStoreError";
  }
}

function storeFailed(error: unknown): KnowledgeStoreError {
  return new KnowledgeStoreError(
    "store_failed",
    error instanceof Error ? error.message : "knowledge store operation failed",
  );
}

type Bindable = string | number | null;

/** Thin Result-returning wrapper so repositories never throw. */
export class Sql {
  constructor(readonly db: D1DatabaseLike) {}

  statement(query: string, ...values: Bindable[]): D1PreparedStatementLike {
    return this.db.prepare(query).bind(...values);
  }

  first<T>(
    query: string,
    ...values: Bindable[]
  ): Result.ResultAsync<T | null, KnowledgeStoreError> {
    return Result.try({
      try: () => this.statement(query, ...values).first<T>(),
      catch: storeFailed,
    });
  }

  all<T>(query: string, ...values: Bindable[]): Result.ResultAsync<T[], KnowledgeStoreError> {
    return Result.try({
      try: async () => (await this.statement(query, ...values).all<T>()).results,
      catch: storeFailed,
    });
  }

  /** Runs one statement and returns the number of changed rows. */
  run(query: string, ...values: Bindable[]): Result.ResultAsync<number, KnowledgeStoreError> {
    return Result.try({
      try: async () => (await this.statement(query, ...values).run()).meta?.changes ?? 0,
      catch: storeFailed,
    });
  }

  /** Atomic batch (D1 runs it as one transaction). Returns changes per statement. */
  batch(statements: D1PreparedStatementLike[]): Result.ResultAsync<number[], KnowledgeStoreError> {
    return Result.try({
      try: async () => (await this.db.batch(statements)).map((result) => result.meta?.changes ?? 0),
      catch: storeFailed,
    });
  }
}

export function parseTags(json: string): string[] {
  const parsed = Result.try({
    try: (): unknown => JSON.parse(json),
    catch: () => null,
  });
  if (Result.isFailure(parsed) || !Array.isArray(parsed.value)) return [];
  return parsed.value.filter((tag): tag is string => typeof tag === "string");
}

/** SQL fragment: tags of a JSON column as one space-separated string (for FTS). */
export const tagsText = (column: string) =>
  `(SELECT coalesce(group_concat(value, ' '), '') FROM json_each(${column}))`;

/** Maps the success value of an async Result. */
export async function mapResult<T, U, E>(
  result: Result.ResultAsync<T, E>,
  map: (value: T) => U,
): Result.ResultAsync<U, E> {
  const resolved = await result;
  if (Result.isFailure(resolved)) return resolved;
  // `U` is never a Promise here; succeed()'s async overload only widens the type.
  return Result.succeed(map(resolved.value)) as Result.Result<U, E>;
}
