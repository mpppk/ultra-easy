import { Result } from "@praha/byethrow";

import type { OrganizationId } from "@app/approval-core";
import { WorkflowRepositoryError } from "@app/workflow-application";
import type { ProgramRepository } from "@app/workflow-application";
import type { ProgramNodeVersion } from "@app/workflow-core";

import { allRows, changes, firstRow, parseJson, runBatch } from "./d1.ts";
import type { D1DatabaseLike } from "./d1.ts";

type ProgramRow = { source_digest: string; version_json: string };

/** publish済みProgram Node Version（insert-only、UPDATE / DELETEはtriggerで禁止）。 */
export class D1ProgramRepository implements ProgramRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async save(input: {
    organizationId: OrganizationId;
    version: ProgramNodeVersion;
  }): Result.ResultAsync<{ type: "created" | "existing" }, WorkflowRepositoryError> {
    const { version } = input;
    const saved = await runBatch({
      db: this.db,
      statements: [
        this.db
          .prepare(
            `INSERT OR IGNORE INTO workflow_programs
               (organization_id, program_id, version, source_digest, version_json, published_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            String(input.organizationId),
            version.programId,
            version.version,
            version.sourceDigest,
            JSON.stringify(version),
            version.publishedAt,
          ),
      ],
    });
    if (Result.isFailure(saved)) return saved;
    if (changes(saved.value[0]) === 1) return Result.succeed({ type: "created" });
    const existing = await this.load({
      organizationId: input.organizationId,
      programId: version.programId,
      version: version.version,
    });
    if (Result.isFailure(existing)) return existing;
    return existing.value?.sourceDigest === version.sourceDigest
      ? Result.succeed({ type: "existing" })
      : Result.fail(
          new WorkflowRepositoryError(
            "program_version_conflict",
            false,
            "同じProgram versionに別sourceは保存できません",
          ),
        );
  }

  async load(input: {
    organizationId: OrganizationId;
    programId: string;
    version: number;
  }): Result.ResultAsync<ProgramNodeVersion | null, WorkflowRepositoryError> {
    const row = await firstRow<ProgramRow>(
      this.db
        .prepare(
          "SELECT source_digest, version_json FROM workflow_programs WHERE organization_id = ? AND program_id = ? AND version = ?",
        )
        .bind(String(input.organizationId), input.programId, input.version),
    );
    if (Result.isFailure(row)) return row;
    return row.value ? parseJson<ProgramNodeVersion>(row.value.version_json) : Result.succeed(null);
  }

  async latest(input: {
    organizationId: OrganizationId;
    programId: string;
  }): Result.ResultAsync<ProgramNodeVersion | null, WorkflowRepositoryError> {
    const row = await firstRow<ProgramRow>(
      this.db
        .prepare(
          "SELECT source_digest, version_json FROM workflow_programs WHERE organization_id = ? AND program_id = ? ORDER BY version DESC LIMIT 1",
        )
        .bind(String(input.organizationId), input.programId),
    );
    if (Result.isFailure(row)) return row;
    return row.value ? parseJson<ProgramNodeVersion>(row.value.version_json) : Result.succeed(null);
  }

  async list(input: {
    organizationId: OrganizationId;
  }): Result.ResultAsync<ProgramNodeVersion[], WorkflowRepositoryError> {
    const rows = await allRows<ProgramRow>(
      this.db
        .prepare(
          "SELECT source_digest, version_json FROM workflow_programs WHERE organization_id = ? ORDER BY program_id, version",
        )
        .bind(String(input.organizationId)),
    );
    if (Result.isFailure(rows)) return rows;
    const versions: ProgramNodeVersion[] = [];
    for (const row of rows.value) {
      const parsed = parseJson<ProgramNodeVersion>(row.version_json);
      if (Result.isFailure(parsed)) return parsed;
      versions.push(parsed.value);
    }
    return Result.succeed(versions);
  }
}
