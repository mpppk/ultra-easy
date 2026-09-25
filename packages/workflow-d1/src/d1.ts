import { Result } from "@praha/byethrow";

import { WorkflowRepositoryError } from "@app/workflow-application";

/** Cloudflare D1（とtest用SQLite shim）が満たす最小interface。 */
export type D1RunResultLike = { success: boolean; meta?: { changes?: number } };

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T>(): Promise<T | null>;
  all?<T>(): Promise<{ results: T[] }>;
  run(): Promise<D1RunResultLike>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch(statements: D1PreparedStatementLike[]): Promise<D1RunResultLike[]>;
}

export function repositoryError(error: unknown, fallback: string): WorkflowRepositoryError {
  return error instanceof WorkflowRepositoryError
    ? error
    : new WorkflowRepositoryError(
        "workflow_repository_error",
        true,
        error instanceof Error ? error.message : fallback,
      );
}

export const runBatch = Result.fn({
  try: async (input: {
    db: D1DatabaseLike;
    statements: D1PreparedStatementLike[];
  }): Promise<D1RunResultLike[]> => input.db.batch(input.statements),
  catch: (error): WorkflowRepositoryError => repositoryError(error, "D1 batchの実行に失敗しました"),
});

export const runStatement = Result.fn({
  try: async (statement: D1PreparedStatementLike): Promise<D1RunResultLike> => statement.run(),
  catch: (error): WorkflowRepositoryError =>
    repositoryError(error, "D1 statementの実行に失敗しました"),
});

const firstUnknown = Result.fn({
  try: async (statement: D1PreparedStatementLike): Promise<unknown> => statement.first<unknown>(),
  catch: (error): WorkflowRepositoryError => repositoryError(error, "D1 rowの取得に失敗しました"),
});

const allUnknown = Result.fn({
  try: async (statement: D1PreparedStatementLike): Promise<unknown[]> =>
    statement.all ? (await statement.all<unknown>()).results : [],
  catch: (error): WorkflowRepositoryError => repositoryError(error, "D1 rowsの取得に失敗しました"),
});

const parseUnknown = Result.fn({
  try: (value: string): unknown => JSON.parse(value),
  catch: (error): WorkflowRepositoryError =>
    new WorkflowRepositoryError(
      "workflow_stored_json_invalid",
      false,
      error instanceof Error ? error.message : "保存済みJSONをparseできません",
    ),
});

/** 自分たちが書いたrowを読む（row型はSQLのcolumnと対応させる）。 */
export async function firstRow<T>(
  statement: D1PreparedStatementLike,
): Result.ResultAsync<T | null, WorkflowRepositoryError> {
  return (await firstUnknown(statement)) as Result.Result<T | null, WorkflowRepositoryError>;
}

export async function allRows<T>(
  statement: D1PreparedStatementLike,
): Result.ResultAsync<T[], WorkflowRepositoryError> {
  return (await allUnknown(statement)) as Result.Result<T[], WorkflowRepositoryError>;
}

/** 自分たちが保存したJSON（canonical state / event）を戻す。 */
export function parseJson<T>(value: string): Result.Result<T, WorkflowRepositoryError> {
  return parseUnknown(value) as Result.Result<T, WorkflowRepositoryError>;
}

export function changes(result: D1RunResultLike | undefined): number {
  return result?.meta?.changes ?? 0;
}
