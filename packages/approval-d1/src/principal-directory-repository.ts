import { Result } from "@praha/byethrow";

import {
  PrincipalDirectoryError,
  type PrincipalDirectoryEntry,
  type PrincipalDirectoryRepository,
} from "@app/approval-application";
import { parseBrand } from "@app/approval-core";

import type { D1DatabaseLike, D1PreparedStatementLike } from "./materialized-plan-repository.ts";

type PrincipalRow = { principal_id: string; display_name: string };

function repositoryError(error: unknown): PrincipalDirectoryError {
  return new PrincipalDirectoryError(
    "principal_directory_repository_error",
    true,
    error instanceof Error ? error.message : "Principal directoryを読み書きできません",
  );
}

const allRows = Result.fn({
  try: async (statement: D1PreparedStatementLike): Promise<PrincipalRow[]> =>
    (await statement.all!<PrincipalRow>()).results,
  catch: repositoryError,
});

const runStatement = Result.fn({
  try: async (statement: D1PreparedStatementLike) => statement.run(),
  catch: repositoryError,
});

export class D1PrincipalDirectoryRepository implements PrincipalDirectoryRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async list(input: Parameters<PrincipalDirectoryRepository["list"]>[0]) {
    const statement = this.db
      .prepare(
        `SELECT principal_id, display_name
           FROM principal_directory
          WHERE organization_id = ? AND principal_type = 'user'
            AND (? IS NULL OR display_name > ?
              OR (display_name = ? AND principal_id > ?))
          ORDER BY display_name, principal_id
          LIMIT ?`,
      )
      .bind(
        String(input.organizationId),
        input.after?.displayName ?? null,
        input.after?.displayName ?? null,
        input.after?.displayName ?? null,
        input.after ? String(input.after.id) : null,
        input.limit,
      );
    if (!statement.all) {
      return Result.fail(
        new PrincipalDirectoryError("d1_all_not_supported", false, "D1 all()が利用できません"),
      );
    }
    const rows = await allRows(statement);
    if (Result.isFailure(rows)) return rows;
    const entries: PrincipalDirectoryEntry[] = [];
    for (const row of rows.value) {
      const id = parseBrand("UserId", row.principal_id);
      if (Result.isFailure(id) || typeof row.display_name !== "string") {
        return Result.fail(
          new PrincipalDirectoryError(
            "principal_directory_row_invalid",
            false,
            "保存済みprincipalが不正です",
          ),
        );
      }
      entries.push({ id: id.value, displayName: row.display_name });
    }
    return Result.succeed(entries);
  }

  async upsert(input: Parameters<PrincipalDirectoryRepository["upsert"]>[0]) {
    const saved = await runStatement(
      this.db
        .prepare(
          `INSERT INTO principal_directory
             (organization_id, principal_id, principal_type, display_name, created_at, updated_at)
           VALUES (?, ?, 'user', ?, ?, ?)
           ON CONFLICT (organization_id, principal_id) DO UPDATE SET
             display_name = excluded.display_name,
             updated_at = excluded.updated_at
           WHERE principal_directory.principal_type = 'user'`,
        )
        .bind(
          String(input.organizationId),
          String(input.principal.id),
          input.principal.displayName,
          input.now,
          input.now,
        ),
    );
    if (Result.isFailure(saved)) return saved;
    if (!saved.value.success) return Result.fail(repositoryError("D1 upsert failed"));
    return Result.succeed(undefined);
  }
}
