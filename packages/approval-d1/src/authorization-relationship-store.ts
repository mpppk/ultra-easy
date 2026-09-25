import { Result } from "@praha/byethrow";

import {
  AuthorizationRelationshipRepositoryError,
  type AuthorizationRelationshipStore,
  type LoadedRelationshipMutation,
  type OrganizationId,
  type PrepareRelationshipMutationInput,
  type ReconcilableTuple,
  type RelationshipMutationRecord,
} from "@app/approval-core";

import {
  allRows,
  D1AuthorizationRelationshipReadRepository,
  firstRow,
  mutationRecord,
  relationshipRecord,
  relationshipRepositoryError,
  type MutationRow,
  type RelationshipRow,
} from "./authorization-relationship-repository.ts";
import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1RunResultLike,
} from "./materialized-plan-repository.ts";

type D1BatchDatabaseLike = D1DatabaseLike & {
  batch(statements: D1PreparedStatementLike[]): Promise<D1RunResultLike[]>;
};

const OPEN_STATUSES = "('prepared', 'applying', 'indeterminate')";

/** Appends one audit event derived from the stored mutation row (dedup by event key). */
function eventInsert(input: {
  eventType: string;
  keySuffix: string;
  occurredAtSql: string;
  statusCondition: string;
  errorCodeSql?: string;
}): string {
  return `INSERT OR IGNORE INTO authorization_relationship_events (
      organization_id, event_key, event_type, occurred_at, actor_type, actor_id,
      source_action_request_id, mutation_key, tuple_key, revision, operation,
      desired_present, subject, relation, logical_object, authorization_model_id, error_code
    )
    SELECT m.organization_id,
           m.organization_id || ':' || m.mutation_key || ':' || ${input.keySuffix},
           '${input.eventType}', ${input.occurredAtSql},
           json_extract(m.actor_json, '$.type'), json_extract(m.actor_json, '$.id'),
           m.action_request_id, m.mutation_key, m.tuple_key, m.revision, m.operation,
           m.desired_present, m.subject, m.relation, m.logical_object,
           m.authorization_model_id, ${input.errorCodeSql ?? "NULL"}
      FROM authorization_relationship_mutations m
     WHERE m.organization_id = ? AND m.mutation_key = ? AND ${input.statusCondition}`;
}

/**
 * D1 write side of the relationship journal. Each transition is one atomic
 * `batch()` combining state change and append-only audit, so "requested"
 * is durable before the provider call and "confirmed" only exists together
 * with the confirmed revision.
 */
export class D1AuthorizationRelationshipStore
  extends D1AuthorizationRelationshipReadRepository
  implements AuthorizationRelationshipStore
{
  private batchDb(): Result.Result<D1BatchDatabaseLike, AuthorizationRelationshipRepositoryError> {
    const candidate = this.db as Partial<D1BatchDatabaseLike>;
    return typeof candidate.batch === "function"
      ? Result.succeed(this.db as D1BatchDatabaseLike)
      : Result.fail(
          new AuthorizationRelationshipRepositoryError(
            "d1_batch_not_supported",
            false,
            "D1 batch()が利用できません",
          ),
        );
  }

  private async runBatch(
    statements: D1PreparedStatementLike[],
  ): Result.ResultAsync<D1RunResultLike[], AuthorizationRelationshipRepositoryError> {
    const db = this.batchDb();
    if (Result.isFailure(db)) return db;
    try {
      const results = await db.value.batch(statements);
      const failed = results.find((result) => !result.success);
      if (failed) {
        return Result.fail(relationshipRepositoryError(failed.error, "D1 batchに失敗しました"));
      }
      return Result.succeed(results);
    } catch (error) {
      return Result.fail(relationshipRepositoryError(error, "D1 batchに失敗しました"));
    }
  }

  async prepare(
    input: PrepareRelationshipMutationInput,
  ): Result.ResultAsync<LoadedRelationshipMutation, AuthorizationRelationshipRepositoryError> {
    const org = input.organizationId;
    const batched = await this.runBatch([
      // 1. durable intent with the next per-tuple revision (idempotent per mutation key)
      this.db
        .prepare(
          `INSERT INTO authorization_relationship_mutations (
             organization_id, mutation_key, action_request_id, tuple_key, revision, operation,
             desired_present, subject, relation, logical_object, actor_json, status,
             authorization_model_id, attempt_count, requested_at, updated_at
           )
           SELECT ?, ?, ?, ?,
                  COALESCE((SELECT MAX(revision) FROM authorization_relationship_mutations
                             WHERE organization_id = ? AND tuple_key = ?), 0) + 1,
                  ?, ?, ?, ?, ?, ?, 'prepared', ?, 0, ?, ?
            WHERE NOT EXISTS (SELECT 1 FROM authorization_relationship_mutations
                               WHERE organization_id = ? AND mutation_key = ?)`,
        )
        .bind(
          org,
          input.mutationKey,
          input.actionRequestId,
          input.tupleKey,
          org,
          input.tupleKey,
          input.operation,
          input.desiredPresent ? 1 : 0,
          input.tuple.user,
          input.tuple.relation,
          input.tuple.object,
          JSON.stringify({ type: input.actor.type, id: String(input.actor.id) }),
          input.authorizationModelId,
          input.requestedAt,
          input.requestedAt,
          org,
          input.mutationKey,
        ),
      // 2. latest desired state (only moves forward in revision)
      this.db
        .prepare(
          `INSERT INTO authorization_relationships (
             organization_id, tuple_key, subject, relation, logical_object, object_type,
             desired_present, revision, latest_mutation_key, latest_action_request_id,
             confirmed_revision, confirmed_present, sync_status, last_error_code,
             created_at, updated_at
           )
           SELECT m.organization_id, m.tuple_key, m.subject, m.relation, m.logical_object, ?,
                  m.desired_present, m.revision, m.mutation_key, m.action_request_id,
                  NULL, NULL, 'prepared', NULL, m.requested_at, m.requested_at
             FROM authorization_relationship_mutations m
            WHERE m.organization_id = ? AND m.mutation_key = ? AND m.status = 'prepared'
              AND m.revision > COALESCE((SELECT r.revision FROM authorization_relationships r
                                          WHERE r.organization_id = m.organization_id
                                            AND r.tuple_key = m.tuple_key), 0)
           ON CONFLICT (organization_id, tuple_key) DO UPDATE SET
             desired_present = excluded.desired_present,
             revision = excluded.revision,
             latest_mutation_key = excluded.latest_mutation_key,
             latest_action_request_id = excluded.latest_action_request_id,
             sync_status = 'prepared',
             last_error_code = NULL,
             updated_at = excluded.updated_at`,
        )
        .bind(input.objectType, org, input.mutationKey),
      // 3. "requested" audit (the fact of the request, not of the effect)
      this.db
        .prepare(
          eventInsert({
            eventType: "authorization.relationship_change_requested",
            keySuffix: "'requested'",
            occurredAtSql: "m.requested_at",
            statusCondition: "1 = 1",
          }),
        )
        .bind(org, input.mutationKey),
    ]);
    if (Result.isFailure(batched)) return batched;
    const loaded = await this.load({ organizationId: org, mutationKey: input.mutationKey });
    if (Result.isFailure(loaded)) return loaded;
    if (!loaded.value) {
      return Result.fail(
        new AuthorizationRelationshipRepositoryError(
          "relationship_mutation_not_found",
          true,
          "prepare後のmutationを読めません",
        ),
      );
    }
    return Result.succeed(loaded.value);
  }

  async load(input: {
    organizationId: OrganizationId;
    mutationKey: string;
  }): Result.ResultAsync<
    LoadedRelationshipMutation | null,
    AuthorizationRelationshipRepositoryError
  > {
    const mutation = await firstRow<MutationRow>(
      this.db
        .prepare(
          `SELECT * FROM authorization_relationship_mutations
            WHERE organization_id = ? AND mutation_key = ?`,
        )
        .bind(input.organizationId, input.mutationKey),
    );
    if (Result.isFailure(mutation)) return mutation;
    if (!mutation.value) return Result.succeed(null);
    return this.withRelationship(mutation.value);
  }

  async loadLatest(input: {
    organizationId: OrganizationId;
    tupleKey: string;
  }): Result.ResultAsync<
    LoadedRelationshipMutation | null,
    AuthorizationRelationshipRepositoryError
  > {
    const mutation = await firstRow<MutationRow>(
      this.db
        .prepare(
          `SELECT m.* FROM authorization_relationship_mutations m
             JOIN authorization_relationships r
               ON r.organization_id = m.organization_id AND r.tuple_key = m.tuple_key
              AND r.revision = m.revision
            WHERE m.organization_id = ? AND m.tuple_key = ?`,
        )
        .bind(input.organizationId, input.tupleKey),
    );
    if (Result.isFailure(mutation)) return mutation;
    if (!mutation.value) return Result.succeed(null);
    return this.withRelationship(mutation.value);
  }

  private async withRelationship(
    row: MutationRow,
  ): Result.ResultAsync<
    LoadedRelationshipMutation | null,
    AuthorizationRelationshipRepositoryError
  > {
    const relationship = await firstRow<RelationshipRow>(
      this.db
        .prepare(
          `SELECT * FROM authorization_relationships WHERE organization_id = ? AND tuple_key = ?`,
        )
        .bind(row.organization_id, row.tuple_key),
    );
    if (Result.isFailure(relationship)) return relationship;
    if (!relationship.value) return Result.succeed(null);
    const mutation = mutationRecord(row);
    if (Result.isFailure(mutation)) return mutation;
    const relationshipRow = relationshipRecord(relationship.value);
    if (Result.isFailure(relationshipRow)) return relationshipRow;
    return Result.succeed({ mutation: mutation.value, relationship: relationshipRow.value });
  }

  private async currentStatus(
    mutation: RelationshipMutationRecord,
  ): Result.ResultAsync<
    RelationshipMutationRecord | null,
    AuthorizationRelationshipRepositoryError
  > {
    const loaded = await this.load({
      organizationId: mutation.organizationId,
      mutationKey: mutation.mutationKey,
    });
    return Result.isFailure(loaded) ? loaded : Result.succeed(loaded.value?.mutation ?? null);
  }

  async markApplying(input: {
    mutation: RelationshipMutationRecord;
    at: string;
  }): Result.ResultAsync<
    "applying" | "not_latest" | "terminal",
    AuthorizationRelationshipRepositoryError
  > {
    const { mutation, at } = input;
    const org = mutation.organizationId;
    const batched = await this.runBatch([
      this.db
        .prepare(
          `UPDATE authorization_relationship_mutations
              SET status = 'applying', apply_started_at = COALESCE(apply_started_at, ?),
                  attempt_count = attempt_count + 1, updated_at = ?
            WHERE organization_id = ? AND mutation_key = ? AND status IN ${OPEN_STATUSES}
              AND revision = (SELECT revision FROM authorization_relationships
                               WHERE organization_id = ? AND tuple_key = ?)`,
        )
        .bind(at, at, org, mutation.mutationKey, org, mutation.tupleKey),
      this.db
        .prepare(
          `UPDATE authorization_relationships SET sync_status = 'applying', updated_at = ?
            WHERE organization_id = ? AND tuple_key = ? AND revision = ?
              AND EXISTS (SELECT 1 FROM authorization_relationship_mutations
                           WHERE organization_id = ? AND mutation_key = ? AND status = 'applying')`,
        )
        .bind(at, org, mutation.tupleKey, mutation.revision, org, mutation.mutationKey),
      this.db
        .prepare(
          eventInsert({
            eventType: "authorization.relationship_apply_started",
            keySuffix: "'apply_started:' || m.attempt_count",
            occurredAtSql: "m.updated_at",
            statusCondition: "m.status = 'applying'",
          }),
        )
        .bind(org, mutation.mutationKey),
    ]);
    if (Result.isFailure(batched)) return batched;
    if ((batched.value[0]?.meta?.changes ?? 0) > 0) return Result.succeed("applying");
    const current = await this.currentStatus(mutation);
    if (Result.isFailure(current)) return current;
    if (!current.value || ["confirmed", "superseded", "failed"].includes(current.value.status)) {
      return Result.succeed("terminal");
    }
    return Result.succeed("not_latest");
  }

  async markConfirmed(input: {
    mutation: RelationshipMutationRecord;
    observedPresent: boolean;
    at: string;
  }): Result.ResultAsync<"confirmed" | "not_latest", AuthorizationRelationshipRepositoryError> {
    const { mutation, at } = input;
    const org = mutation.organizationId;
    const batched = await this.runBatch([
      this.db
        .prepare(
          `UPDATE authorization_relationship_mutations
              SET status = 'confirmed', confirmed_at = ?, completed_at = ?,
                  last_error_code = NULL, updated_at = ?
            WHERE organization_id = ? AND mutation_key = ? AND status IN ${OPEN_STATUSES}
              AND revision = (SELECT revision FROM authorization_relationships
                               WHERE organization_id = ? AND tuple_key = ?)`,
        )
        .bind(at, at, at, org, mutation.mutationKey, org, mutation.tupleKey),
      this.db
        .prepare(
          `UPDATE authorization_relationships
              SET confirmed_revision = ?, confirmed_present = ?, sync_status = 'confirmed',
                  last_error_code = NULL, updated_at = ?
            WHERE organization_id = ? AND tuple_key = ? AND revision = ?
              AND EXISTS (SELECT 1 FROM authorization_relationship_mutations
                           WHERE organization_id = ? AND mutation_key = ? AND status = 'confirmed')`,
        )
        .bind(
          mutation.revision,
          input.observedPresent ? 1 : 0,
          at,
          org,
          mutation.tupleKey,
          mutation.revision,
          org,
          mutation.mutationKey,
        ),
      this.db
        .prepare(
          eventInsert({
            eventType: "authorization.relationship_change_confirmed",
            keySuffix: "'confirmed'",
            occurredAtSql: "m.confirmed_at",
            statusCondition: "m.status = 'confirmed'",
          }),
        )
        .bind(org, mutation.mutationKey),
    ]);
    if (Result.isFailure(batched)) return batched;
    if ((batched.value[0]?.meta?.changes ?? 0) > 0) return Result.succeed("confirmed");
    const current = await this.currentStatus(mutation);
    if (Result.isFailure(current)) return current;
    return Result.succeed(current.value?.status === "confirmed" ? "confirmed" : "not_latest");
  }

  async supersedeStale(input: {
    organizationId: OrganizationId;
    tupleKey: string;
    at: string;
  }): Result.ResultAsync<number, AuthorizationRelationshipRepositoryError> {
    const org = input.organizationId;
    const batched = await this.runBatch([
      this.db
        .prepare(
          `UPDATE authorization_relationship_mutations
              SET status = 'superseded', completed_at = ?, updated_at = ?
            WHERE organization_id = ? AND tuple_key = ? AND status IN ${OPEN_STATUSES}
              AND revision < (SELECT revision FROM authorization_relationships
                               WHERE organization_id = ? AND tuple_key = ?)`,
        )
        .bind(input.at, input.at, org, input.tupleKey, org, input.tupleKey),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO authorization_relationship_events (
             organization_id, event_key, event_type, occurred_at, actor_type, actor_id,
             source_action_request_id, mutation_key, tuple_key, revision, operation,
             desired_present, subject, relation, logical_object, authorization_model_id, error_code
           )
           SELECT m.organization_id, m.organization_id || ':' || m.mutation_key || ':superseded',
                  'authorization.relationship_change_superseded', m.completed_at,
                  json_extract(m.actor_json, '$.type'), json_extract(m.actor_json, '$.id'),
                  m.action_request_id, m.mutation_key, m.tuple_key, m.revision, m.operation,
                  m.desired_present, m.subject, m.relation, m.logical_object,
                  m.authorization_model_id, NULL
             FROM authorization_relationship_mutations m
            WHERE m.organization_id = ? AND m.tuple_key = ? AND m.status = 'superseded'`,
        )
        .bind(org, input.tupleKey),
    ]);
    if (Result.isFailure(batched)) return batched;
    return Result.succeed(batched.value[0]?.meta?.changes ?? 0);
  }

  private async markTerminalOrOpen(input: {
    mutation: RelationshipMutationRecord;
    status: "indeterminate" | "failed";
    errorCode: string;
    at: string;
  }): Result.ResultAsync<void, AuthorizationRelationshipRepositoryError> {
    const { mutation, at, errorCode, status } = input;
    const org = mutation.organizationId;
    const batched = await this.runBatch([
      this.db
        .prepare(
          `UPDATE authorization_relationship_mutations
              SET status = ?, last_error_code = ?, updated_at = ?,
                  completed_at = CASE WHEN ? = 'failed' THEN ? ELSE completed_at END
            WHERE organization_id = ? AND mutation_key = ? AND status IN ${OPEN_STATUSES}`,
        )
        .bind(status, errorCode, at, status, at, org, mutation.mutationKey),
      this.db
        .prepare(
          `UPDATE authorization_relationships
              SET sync_status = ?, last_error_code = ?, updated_at = ?
            WHERE organization_id = ? AND tuple_key = ? AND revision = ?
              AND latest_mutation_key = ?
              AND EXISTS (SELECT 1 FROM authorization_relationship_mutations
                           WHERE organization_id = ? AND mutation_key = ? AND status = ?)`,
        )
        .bind(
          status,
          errorCode,
          at,
          org,
          mutation.tupleKey,
          mutation.revision,
          mutation.mutationKey,
          org,
          mutation.mutationKey,
          status,
        ),
      this.db
        .prepare(
          eventInsert({
            eventType:
              status === "failed"
                ? "authorization.relationship_change_failed"
                : "authorization.relationship_change_indeterminate",
            keySuffix: status === "failed" ? "'failed'" : "'indeterminate:' || m.attempt_count",
            occurredAtSql: "m.updated_at",
            statusCondition: `m.status = '${status}'`,
            errorCodeSql: "m.last_error_code",
          }),
        )
        .bind(org, mutation.mutationKey),
    ]);
    return Result.isFailure(batched) ? batched : Result.succeed(undefined);
  }

  markIndeterminate(input: {
    mutation: RelationshipMutationRecord;
    errorCode: string;
    at: string;
  }): Result.ResultAsync<void, AuthorizationRelationshipRepositoryError> {
    return this.markTerminalOrOpen({ ...input, status: "indeterminate" });
  }

  markFailed(input: {
    mutation: RelationshipMutationRecord;
    errorCode: string;
    at: string;
  }): Result.ResultAsync<void, AuthorizationRelationshipRepositoryError> {
    return this.markTerminalOrOpen({ ...input, status: "failed" });
  }

  async recordDriftRepaired(input: {
    mutation: RelationshipMutationRecord;
    at: string;
  }): Result.ResultAsync<void, AuthorizationRelationshipRepositoryError> {
    const { mutation, at } = input;
    const org = mutation.organizationId;
    const batched = await this.runBatch([
      this.db
        .prepare(
          `UPDATE authorization_relationships
              SET confirmed_present = desired_present, sync_status = 'confirmed', updated_at = ?
            WHERE organization_id = ? AND tuple_key = ? AND revision = ?`,
        )
        .bind(at, org, mutation.tupleKey, mutation.revision),
      this.db
        .prepare(
          eventInsert({
            eventType: "authorization.relationship_drift_repaired",
            keySuffix: `'drift_repaired:' || ?`,
            occurredAtSql: "?",
            statusCondition: "m.status = 'confirmed'",
          }),
        )
        .bind(at, at, org, mutation.mutationKey),
    ]);
    return Result.isFailure(batched) ? batched : Result.succeed(undefined);
  }

  async listReconcilable(input: {
    organizationId: OrganizationId;
    idleBefore: string;
    limit: number;
  }): Result.ResultAsync<ReconcilableTuple[], AuthorizationRelationshipRepositoryError> {
    const rows = await allRows<{ organization_id: string; tuple_key: string }>(
      this.db
        .prepare(
          `SELECT organization_id, tuple_key, MIN(updated_at) AS oldest
             FROM authorization_relationship_mutations
            WHERE organization_id = ?
              AND (status = 'indeterminate'
                   OR (status IN ('prepared', 'applying') AND updated_at <= ?))
            GROUP BY organization_id, tuple_key
            ORDER BY oldest
            LIMIT ?`,
        )
        .bind(input.organizationId, input.idleBefore, Math.max(1, Math.min(100, input.limit))),
    );
    if (Result.isFailure(rows)) return rows;
    // WHERE organization_id = ? で絞っているため入力のorganizationIdと一致する。
    return Result.succeed(
      rows.value.map((row) => ({ organizationId: input.organizationId, tupleKey: row.tuple_key })),
    );
  }
}
