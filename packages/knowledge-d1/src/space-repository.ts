import { Result } from "@praha/byethrow";

import type { Space } from "@app/knowledge-core";

import { KnowledgeStoreError, mapResult, type D1DatabaseLike, Sql } from "./db.ts";
import { toSpace, type SpaceRow } from "./rows.ts";

const SPACE_COLUMNS = "id, organization_id, key, name, description, created_by, created_at";

export class D1SpaceRepository {
  private readonly sql: Sql;

  constructor(db: D1DatabaseLike) {
    this.sql = new Sql(db);
  }

  /** Inserts a space; an existing key in the organization is `duplicate_key`. */
  async create(space: Space): Result.ResultAsync<Space, KnowledgeStoreError> {
    const changes = await this.sql.run(
      `INSERT INTO spaces (${SPACE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (organization_id, key) DO NOTHING`,
      space.id,
      space.organizationId,
      space.key,
      space.name,
      space.description,
      space.createdBy,
      space.createdAt,
    );
    if (Result.isFailure(changes)) return changes;
    if (changes.value === 0) {
      return Result.fail(new KnowledgeStoreError("duplicate_key", "space key already exists"));
    }
    return Result.succeed(space);
  }

  findByKey(
    organizationId: string,
    key: string,
  ): Result.ResultAsync<Space | null, KnowledgeStoreError> {
    return mapResult(
      this.sql.first<SpaceRow>(
        `SELECT ${SPACE_COLUMNS} FROM spaces WHERE organization_id = ? AND key = ?`,
        organizationId,
        key,
      ),
      (row) => (row ? toSpace(row) : null),
    );
  }

  findById(id: string): Result.ResultAsync<Space | null, KnowledgeStoreError> {
    return mapResult(
      this.sql.first<SpaceRow>(`SELECT ${SPACE_COLUMNS} FROM spaces WHERE id = ?`, id),
      (row) => (row ? toSpace(row) : null),
    );
  }

  listByIds(
    organizationId: string,
    ids: readonly string[],
  ): Result.ResultAsync<Space[], KnowledgeStoreError> {
    return mapResult(
      this.sql.all<SpaceRow>(
        `SELECT ${SPACE_COLUMNS} FROM spaces
         WHERE organization_id = ? AND id IN (SELECT value FROM json_each(?))
         ORDER BY name`,
        organizationId,
        JSON.stringify(ids),
      ),
      (rows) => rows.map(toSpace),
    );
  }

  count(organizationId: string): Result.ResultAsync<number, KnowledgeStoreError> {
    return mapResult(
      this.sql.first<{ total: number }>(
        "SELECT count(*) AS total FROM spaces WHERE organization_id = ?",
        organizationId,
      ),
      (row) => Number(row?.total ?? 0),
    );
  }
}
