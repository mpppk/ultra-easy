import { Result } from "@praha/byethrow";

import {
  ApplicationRelationshipReadError,
  type ApplicationRelationshipReadRepository,
  type SpaceMemberEntry,
  type SpaceRoleEntry,
} from "@app/approval-application";
import { parseBrand } from "@app/approval-core";

import type { D1DatabaseLike, D1PreparedStatementLike } from "./materialized-plan-repository.ts";

type RoleRow = { logical_object: string; relation: string };
type MemberRow = { subject: string; relation: string; display_name: string | null };

function error(cause: unknown): ApplicationRelationshipReadError {
  return new ApplicationRelationshipReadError(
    "application_relationship_read_failed",
    true,
    cause instanceof Error ? cause.message : "relationshipを取得できません",
  );
}

async function rows<T>(
  statement: D1PreparedStatementLike,
): Result.ResultAsync<T[], ApplicationRelationshipReadError> {
  try {
    return Result.succeed((await statement.all!<T>()).results);
  } catch (cause) {
    return Result.fail(error(cause));
  }
}

function role(value: string): value is SpaceRoleEntry["role"] {
  return value === "owner" || value === "editor" || value === "viewer";
}

function corrupt(): ApplicationRelationshipReadError {
  return new ApplicationRelationshipReadError(
    "application_relationship_row_invalid",
    false,
    "保存済みrelationshipが不正です",
  );
}

export class D1ApplicationRelationshipReadRepository implements ApplicationRelationshipReadRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async roles(input: Parameters<ApplicationRelationshipReadRepository["roles"]>[0]) {
    const statement = this.db
      .prepare(
        `SELECT logical_object, relation FROM (
           SELECT logical_object, relation,
             ROW_NUMBER() OVER (
               PARTITION BY logical_object
               ORDER BY CASE relation WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END
             ) AS role_rank
           FROM authorization_relationships
           WHERE organization_id = ? AND subject = ? AND object_type = 'knowledge_space'
             AND relation IN ('viewer', 'editor', 'owner')
             AND desired_present = 1 AND confirmed_present = 1 AND sync_status = 'confirmed'
         ) WHERE role_rank = 1 AND (? IS NULL OR logical_object > ?)
         ORDER BY logical_object LIMIT ?`,
      )
      .bind(
        String(input.organizationId),
        String(input.subject),
        input.after?.object ?? null,
        input.after?.object ?? null,
        input.limit,
      );
    if (!statement.all) return Result.fail(corrupt());
    const found = await rows<RoleRow>(statement);
    if (Result.isFailure(found)) return found;
    const items: SpaceRoleEntry[] = [];
    for (const row of found.value) {
      if (!row.logical_object.startsWith("knowledge_space:") || !role(row.relation))
        return Result.fail(corrupt());
      items.push({
        spaceId: row.logical_object.slice("knowledge_space:".length),
        role: row.relation,
      });
    }
    return Result.succeed(items);
  }

  async members(input: Parameters<ApplicationRelationshipReadRepository["members"]>[0]) {
    const statement = this.db
      .prepare(
        `SELECT r.subject, r.relation, p.display_name
           FROM (
             SELECT organization_id, subject, relation,
               ROW_NUMBER() OVER (
                 PARTITION BY subject
                 ORDER BY CASE relation WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END
               ) AS role_rank
             FROM authorization_relationships
             WHERE organization_id = ? AND logical_object = ? AND object_type = 'knowledge_space'
               AND relation IN ('viewer', 'editor', 'owner')
               AND desired_present = 1 AND confirmed_present = 1 AND sync_status = 'confirmed'
           ) r
           LEFT JOIN principal_directory p
             ON p.organization_id = r.organization_id AND p.principal_id = r.subject
             AND p.principal_type = 'user'
          WHERE r.role_rank = 1 AND (? IS NULL OR r.subject > ?)
          ORDER BY r.subject LIMIT ?`,
      )
      .bind(
        String(input.organizationId),
        `knowledge_space:${input.spaceId}`,
        input.after?.subject ?? null,
        input.after?.subject ?? null,
        input.limit,
      );
    if (!statement.all) return Result.fail(corrupt());
    const found = await rows<MemberRow>(statement);
    if (Result.isFailure(found)) return found;
    const items: SpaceMemberEntry[] = [];
    for (const row of found.value) {
      const id = parseBrand("UserId", row.subject);
      if (Result.isFailure(id) || !row.subject.startsWith("user:") || !role(row.relation))
        return Result.fail(corrupt());
      items.push({
        id: id.value,
        displayName: row.display_name ?? row.subject,
        role: row.relation,
      });
    }
    return Result.succeed(items);
  }
}
