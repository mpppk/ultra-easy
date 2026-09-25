import { Result } from "@praha/byethrow";
import { storedBrand } from "./stored-brand.ts";

import {
  AuthorizationRelationshipRepositoryError,
  type AuthorizationRelationshipReadRepository,
  type AuthorizationRelationshipRecord,
  type OrganizationId,
  type PrincipalRef,
  type RelationshipAuditEvent,
  type RelationshipAuditEventType,
  type RelationshipAuditFilter,
  type RelationshipListFilter,
  type RelationshipMutationRecord,
  type RelationshipMutationStatus,
  type RelationshipOperation,
  type RelationshipPage,
  type RelationshipSyncStatus,
} from "@app/approval-core";

import type { D1DatabaseLike, D1PreparedStatementLike } from "./materialized-plan-repository.ts";

export type RelationshipRow = {
  organization_id: string;
  tuple_key: string;
  subject: string;
  relation: string;
  logical_object: string;
  object_type: string;
  desired_present: number;
  revision: number;
  latest_mutation_key: string;
  latest_action_request_id: string;
  confirmed_revision: number | null;
  confirmed_present: number | null;
  sync_status: RelationshipSyncStatus;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
};

export type MutationRow = {
  organization_id: string;
  mutation_key: string;
  action_request_id: string;
  tuple_key: string;
  revision: number;
  operation: RelationshipOperation;
  desired_present: number;
  subject: string;
  relation: string;
  logical_object: string;
  actor_json: string;
  status: RelationshipMutationStatus;
  authorization_model_id: string;
  attempt_count: number;
  requested_at: string;
  apply_started_at: string | null;
  confirmed_at: string | null;
  completed_at: string | null;
  last_error_code: string | null;
  updated_at: string;
};

type EventRow = {
  sequence: number;
  organization_id: string;
  event_key: string;
  event_type: RelationshipAuditEventType;
  occurred_at: string;
  actor_type: PrincipalRef["type"];
  actor_id: string;
  source_action_request_id: string;
  mutation_key: string;
  tuple_key: string;
  revision: number;
  operation: RelationshipOperation;
  desired_present: number;
  subject: string;
  relation: string;
  logical_object: string;
  authorization_model_id: string;
  error_code: string | null;
};

export function relationshipRepositoryError(
  error: unknown,
  fallback: string,
): AuthorizationRelationshipRepositoryError {
  return error instanceof AuthorizationRelationshipRepositoryError
    ? error
    : new AuthorizationRelationshipRepositoryError(
        "authorization_relationship_repository_error",
        true,
        error instanceof Error ? error.message : fallback,
      );
}

export async function allRows<T>(
  statement: D1PreparedStatementLike,
): Result.ResultAsync<T[], AuthorizationRelationshipRepositoryError> {
  if (!statement.all) {
    return Result.fail(
      new AuthorizationRelationshipRepositoryError(
        "d1_all_not_supported",
        false,
        "D1 all()が利用できません",
      ),
    );
  }
  try {
    const rows: T[] = (await statement.all<T>()).results;
    return Result.succeed(rows) as Result.Result<T[], AuthorizationRelationshipRepositoryError>;
  } catch (error) {
    return Result.fail(relationshipRepositoryError(error, "relationship rowsの取得に失敗しました"));
  }
}

export async function firstRow<T>(
  statement: D1PreparedStatementLike,
): Result.ResultAsync<T | null, AuthorizationRelationshipRepositoryError> {
  try {
    const row: T | null = await statement.first<T>();
    return Result.succeed(row) as Result.Result<T | null, AuthorizationRelationshipRepositoryError>;
  } catch (error) {
    return Result.fail(relationshipRepositoryError(error, "relationship rowの取得に失敗しました"));
  }
}

function rowIntegrityError(message: string): AuthorizationRelationshipRepositoryError {
  return new AuthorizationRelationshipRepositoryError(
    "authorization_relationship_row_invalid",
    false,
    message,
  );
}

/** 保存済みのprincipal（type + id）をsmart constructorでPrincipalRefへ戻す（#102）。 */
function storedPrincipal(
  type: unknown,
  id: unknown,
): Result.Result<PrincipalRef, AuthorizationRelationshipRepositoryError> {
  if (type === "user") {
    const parsed = storedBrand("UserId", id, rowIntegrityError);
    return Result.isFailure(parsed) ? parsed : Result.succeed({ type, id: parsed.value });
  }
  if (type === "agent") {
    const parsed = storedBrand("AgentId", id, rowIntegrityError);
    return Result.isFailure(parsed) ? parsed : Result.succeed({ type, id: parsed.value });
  }
  if (type === "service") {
    const parsed = storedBrand("ServiceId", id, rowIntegrityError);
    return Result.isFailure(parsed) ? parsed : Result.succeed({ type, id: parsed.value });
  }
  return Result.fail(rowIntegrityError("保存済みのprincipal typeが不正です"));
}

const parseActorJson = Result.fn({
  try: (value: string): unknown => JSON.parse(value),
  catch: (): AuthorizationRelationshipRepositoryError =>
    rowIntegrityError("保存済みのactorをparseできません"),
});

function parseActor(
  value: string,
): Result.Result<PrincipalRef, AuthorizationRelationshipRepositoryError> {
  const parsed = parseActorJson(value);
  if (Result.isFailure(parsed)) return parsed;
  const actor = parsed.value as { type?: unknown; id?: unknown } | null;
  return storedPrincipal(actor?.type, actor?.id);
}

/** rowの配列をmapperでResultのまま変換する（1件でも不正ならerror）。 */
function mapRows<Row, Item>(
  rows: readonly Row[],
  mapper: (row: Row) => Result.Result<Item, AuthorizationRelationshipRepositoryError>,
): Result.Result<Item[], AuthorizationRelationshipRepositoryError> {
  const items: Item[] = [];
  for (const row of rows) {
    const item = mapper(row);
    if (Result.isFailure(item)) return item;
    items.push(item.value);
  }
  return Result.succeed(items);
}

export function relationshipRecord(
  row: RelationshipRow,
): Result.Result<AuthorizationRelationshipRecord, AuthorizationRelationshipRepositoryError> {
  const organizationId = storedBrand("OrganizationId", row.organization_id, rowIntegrityError);
  if (Result.isFailure(organizationId)) return organizationId;
  const latestActionRequestId = storedBrand(
    "ActionRequestId",
    row.latest_action_request_id,
    rowIntegrityError,
  );
  if (Result.isFailure(latestActionRequestId)) return latestActionRequestId;
  return Result.succeed({
    organizationId: organizationId.value,
    tupleKey: row.tuple_key,
    tuple: { user: row.subject, relation: row.relation, object: row.logical_object },
    objectType: row.object_type,
    desiredPresent: row.desired_present === 1,
    revision: row.revision,
    latestMutationKey: row.latest_mutation_key,
    latestActionRequestId: latestActionRequestId.value,
    confirmedRevision: row.confirmed_revision,
    confirmedPresent: row.confirmed_present === null ? null : row.confirmed_present === 1,
    syncStatus: row.sync_status,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function mutationRecord(
  row: MutationRow,
): Result.Result<RelationshipMutationRecord, AuthorizationRelationshipRepositoryError> {
  const organizationId = storedBrand("OrganizationId", row.organization_id, rowIntegrityError);
  if (Result.isFailure(organizationId)) return organizationId;
  const actionRequestId = storedBrand("ActionRequestId", row.action_request_id, rowIntegrityError);
  if (Result.isFailure(actionRequestId)) return actionRequestId;
  const actor = parseActor(row.actor_json);
  if (Result.isFailure(actor)) return actor;
  return Result.succeed({
    organizationId: organizationId.value,
    mutationKey: row.mutation_key,
    actionRequestId: actionRequestId.value,
    tupleKey: row.tuple_key,
    tuple: { user: row.subject, relation: row.relation, object: row.logical_object },
    revision: row.revision,
    operation: row.operation,
    desiredPresent: row.desired_present === 1,
    actor: actor.value,
    status: row.status,
    authorizationModelId: row.authorization_model_id,
    attemptCount: row.attempt_count,
    requestedAt: row.requested_at,
    applyStartedAt: row.apply_started_at,
    confirmedAt: row.confirmed_at,
    completedAt: row.completed_at,
    lastErrorCode: row.last_error_code,
    updatedAt: row.updated_at,
  });
}

function auditEvent(
  row: EventRow,
): Result.Result<RelationshipAuditEvent, AuthorizationRelationshipRepositoryError> {
  const organizationId = storedBrand("OrganizationId", row.organization_id, rowIntegrityError);
  if (Result.isFailure(organizationId)) return organizationId;
  const sourceActionRequestId = storedBrand(
    "ActionRequestId",
    row.source_action_request_id,
    rowIntegrityError,
  );
  if (Result.isFailure(sourceActionRequestId)) return sourceActionRequestId;
  const actor = storedPrincipal(row.actor_type, row.actor_id);
  if (Result.isFailure(actor)) return actor;
  return Result.succeed({
    sequence: row.sequence,
    organizationId: organizationId.value,
    eventKey: row.event_key,
    type: row.event_type,
    occurredAt: row.occurred_at,
    actor: actor.value,
    sourceActionRequestId: sourceActionRequestId.value,
    mutationKey: row.mutation_key,
    tupleKey: row.tuple_key,
    revision: row.revision,
    operation: row.operation,
    desiredPresent: row.desired_present === 1,
    tuple: { user: row.subject, relation: row.relation, object: row.logical_object },
    authorizationModelId: row.authorization_model_id,
    errorCode: row.error_code,
  });
}

function encodeCursor(value: Record<string, string | number>): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(value: string): Record<string, unknown> | null {
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const parsed = JSON.parse(atob(base64)) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function invalidCursor(): Result.Result<never, AuthorizationRelationshipRepositoryError> {
  return Result.fail(
    new AuthorizationRelationshipRepositoryError("invalid_cursor", false, "cursorが不正です"),
  );
}

export const MAX_RELATIONSHIP_PAGE_SIZE = 100;

function boundedLimit(limit: number): number {
  return Math.max(1, Math.min(MAX_RELATIONSHIP_PAGE_SIZE, Math.trunc(limit)));
}

/**
 * Tenant-scoped D1 read side for console-managed relationships. Every query
 * is pinned to `organization_id`; there is no cross-organization or FGA
 * store-wide listing.
 */
export class D1AuthorizationRelationshipReadRepository implements AuthorizationRelationshipReadRepository {
  constructor(protected readonly db: D1DatabaseLike) {}

  async list(
    filter: RelationshipListFilter,
  ): Result.ResultAsync<
    RelationshipPage<AuthorizationRelationshipRecord>,
    AuthorizationRelationshipRepositoryError
  > {
    const limit = boundedLimit(filter.limit);
    const where = ["organization_id = ?"];
    const values: unknown[] = [filter.organizationId];
    if (filter.subject) {
      where.push("subject = ?");
      values.push(filter.subject);
    }
    if (filter.relation) {
      where.push("relation = ?");
      values.push(filter.relation);
    }
    if (filter.object) {
      where.push("logical_object = ?");
      values.push(filter.object);
    }
    if (filter.syncStatus) {
      where.push("sync_status = ?");
      values.push(filter.syncStatus);
    }
    if (filter.cursor) {
      const cursor = decodeCursor(filter.cursor);
      if (!cursor || typeof cursor.u !== "string" || typeof cursor.k !== "string") {
        return invalidCursor();
      }
      where.push("(updated_at < ? OR (updated_at = ? AND tuple_key < ?))");
      values.push(cursor.u, cursor.u, cursor.k);
    }
    const rows = await allRows<RelationshipRow>(
      this.db
        .prepare(
          `SELECT * FROM authorization_relationships
            WHERE ${where.join(" AND ")}
            ORDER BY updated_at DESC, tuple_key DESC
            LIMIT ?`,
        )
        .bind(...values, limit + 1),
    );
    if (Result.isFailure(rows)) return rows;
    const page = rows.value.slice(0, limit);
    const last = page.at(-1);
    const items = mapRows(page, relationshipRecord);
    if (Result.isFailure(items)) return items;
    return Result.succeed({
      items: items.value,
      nextCursor:
        rows.value.length > limit && last
          ? encodeCursor({ u: last.updated_at, k: last.tuple_key })
          : null,
    });
  }

  async get(input: { organizationId: OrganizationId; tupleKey: string }): Result.ResultAsync<
    {
      relationship: AuthorizationRelationshipRecord;
      mutations: RelationshipMutationRecord[];
    } | null,
    AuthorizationRelationshipRepositoryError
  > {
    const row = await firstRow<RelationshipRow>(
      this.db
        .prepare(
          `SELECT * FROM authorization_relationships WHERE organization_id = ? AND tuple_key = ?`,
        )
        .bind(input.organizationId, input.tupleKey),
    );
    if (Result.isFailure(row)) return row;
    if (!row.value) return Result.succeed(null);
    const mutations = await allRows<MutationRow>(
      this.db
        .prepare(
          `SELECT * FROM authorization_relationship_mutations
            WHERE organization_id = ? AND tuple_key = ?
            ORDER BY revision DESC
            LIMIT 50`,
        )
        .bind(input.organizationId, input.tupleKey),
    );
    if (Result.isFailure(mutations)) return mutations;
    const relationship = relationshipRecord(row.value);
    if (Result.isFailure(relationship)) return relationship;
    const mutationRecords = mapRows(mutations.value, mutationRecord);
    if (Result.isFailure(mutationRecords)) return mutationRecords;
    return Result.succeed({ relationship: relationship.value, mutations: mutationRecords.value });
  }

  async listAudit(
    filter: RelationshipAuditFilter,
  ): Result.ResultAsync<
    RelationshipPage<RelationshipAuditEvent>,
    AuthorizationRelationshipRepositoryError
  > {
    const limit = boundedLimit(filter.limit);
    const where = ["organization_id = ?"];
    const values: unknown[] = [filter.organizationId];
    const equals: Array<[string, string | number | undefined]> = [
      ["actor_id", filter.actorId],
      ["event_type", filter.eventType],
      ["operation", filter.operation],
      ["subject", filter.subject],
      ["relation", filter.relation],
      ["logical_object", filter.object],
      ["source_action_request_id", filter.sourceActionRequestId],
      ["mutation_key", filter.mutationKey],
      ["revision", filter.revision],
    ];
    for (const [column, value] of equals) {
      if (value === undefined || value === "") continue;
      where.push(`${column} = ?`);
      values.push(value);
    }
    if (filter.from) {
      where.push("occurred_at >= ?");
      values.push(filter.from);
    }
    if (filter.to) {
      where.push("occurred_at < ?");
      values.push(filter.to);
    }
    if (filter.cursor) {
      const cursor = decodeCursor(filter.cursor);
      if (!cursor || typeof cursor.s !== "number" || !Number.isSafeInteger(cursor.s)) {
        return invalidCursor();
      }
      where.push("sequence < ?");
      values.push(cursor.s);
    }
    const rows = await allRows<EventRow>(
      this.db
        .prepare(
          `SELECT * FROM authorization_relationship_events
            WHERE ${where.join(" AND ")}
            ORDER BY sequence DESC
            LIMIT ?`,
        )
        .bind(...values, limit + 1),
    );
    if (Result.isFailure(rows)) return rows;
    const page = rows.value.slice(0, limit);
    const last = page.at(-1);
    const auditItems = mapRows(page, auditEvent);
    if (Result.isFailure(auditItems)) return auditItems;
    return Result.succeed({
      items: auditItems.value,
      nextCursor: rows.value.length > limit && last ? encodeCursor({ s: last.sequence }) : null,
    });
  }
}
