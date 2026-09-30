import { Result } from "@praha/byethrow";

import {
  APPLICATION_APPROVAL_POLICY_ACTION_TYPE,
  canonicalizeJson,
  GovernancePersistenceError,
  type ApplicationApprovalPolicy,
  type ApplicationApprovalPolicyRecord,
  type ApplicationApprovalPolicyRepository,
  type ApplicationApprovalPolicyScope,
  type ApprovalPolicyDefinition,
  type JsonValue,
  type OrganizationId,
  type PrincipalRef,
} from "@app/approval-core";

import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1RunResultLike,
} from "./materialized-plan-repository.ts";

type D1BatchDatabaseLike = D1DatabaseLike & {
  batch(statements: D1PreparedStatementLike[]): Promise<D1RunResultLike[]>;
};

type RecordRow = {
  scope_id: string;
  version: number;
  policy_json: string;
  approval_policy_version: number;
  source_action_request_id: string;
  created_at: string;
};

const RECORD_COLUMNS =
  "scope_id, version, policy_json, approval_policy_version, source_action_request_id, created_at";

function repositoryError(error: unknown, fallback: string): GovernancePersistenceError {
  return new GovernancePersistenceError(
    "application_policy_repository_error",
    true,
    error instanceof Error ? error.message : fallback,
  );
}

function firstRow<T>(
  statement: D1PreparedStatementLike,
): Result.ResultAsync<T | null, GovernancePersistenceError> {
  return Result.fn({
    try: async () => statement.first<T>(),
    catch: (error) => repositoryError(error, "application policyの取得に失敗しました"),
  })();
}

function allRows<T>(
  statement: D1PreparedStatementLike,
): Result.ResultAsync<T[], GovernancePersistenceError> {
  return Result.fn({
    try: async () => (statement.all ? (await statement.all<T>()).results : []),
    catch: (error) => repositoryError(error, "application policyの取得に失敗しました"),
  })();
}

const parsePolicy = Result.fn({
  try: (value: string): ApplicationApprovalPolicy => JSON.parse(value) as ApplicationApprovalPolicy,
  catch: () =>
    new GovernancePersistenceError(
      "application_policy_corrupted",
      false,
      "保存済みapplication policyをparseできません",
    ),
});

function json(value: unknown): Result.Result<string, GovernancePersistenceError> {
  const canonical = canonicalizeJson(value as JsonValue);
  return Result.isSuccess(canonical)
    ? canonical
    : Result.fail(new GovernancePersistenceError("invalid_json", false, canonical.error.message));
}

function recordFromRow(
  row: RecordRow,
): Result.Result<ApplicationApprovalPolicyRecord, GovernancePersistenceError> {
  const policy = parsePolicy(row.policy_json);
  if (Result.isFailure(policy)) return policy;
  return Result.succeed({
    scopeId: row.scope_id,
    version: row.version,
    policy: policy.value,
    approvalPolicyVersion: row.approval_policy_version,
    sourceActionRequestId: row.source_action_request_id,
    createdAt: row.created_at,
  });
}

function isConstraintViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed|PRIMARY KEY/i.test(error.message);
}

/**
 * Application approval policy（#199）のD1実装。scope ruleの履歴（insert-only）と、compile済み
 * Approval Policyの新しいversionを1 batchで保存する。version / source ActionRequestの一意制約に
 * 違反したbatchは何も保存せず`conflict`になる（同時更新・再配送の判定は呼び出し側が再読込して行う）。
 */
export class D1ApplicationApprovalPolicyRepository implements ApplicationApprovalPolicyRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async current(
    scope: ApplicationApprovalPolicyScope,
  ): Result.ResultAsync<ApplicationApprovalPolicyRecord | null, GovernancePersistenceError> {
    const row = await firstRow<RecordRow>(
      this.db
        .prepare(
          `SELECT ${RECORD_COLUMNS} FROM application_approval_policies
            WHERE organization_id = ? AND application = ? AND scope_type = ? AND scope_id = ?
            ORDER BY version DESC LIMIT 1`,
        )
        .bind(String(scope.organizationId), scope.application, scope.scopeType, scope.scopeId),
    );
    if (Result.isFailure(row)) return row;
    return row.value ? recordFromRow(row.value) : Result.succeed(null);
  }

  async listCurrent(input: {
    organizationId: OrganizationId;
    application: string;
    scopeType: string;
  }): Result.ResultAsync<ApplicationApprovalPolicyRecord[], GovernancePersistenceError> {
    const rows = await allRows<RecordRow>(
      this.db
        .prepare(
          `SELECT ${RECORD_COLUMNS} FROM application_approval_policies AS current
            WHERE organization_id = ? AND application = ? AND scope_type = ?
              AND version = (
                SELECT MAX(version) FROM application_approval_policies AS latest
                 WHERE latest.organization_id = current.organization_id
                   AND latest.application = current.application
                   AND latest.scope_type = current.scope_type
                   AND latest.scope_id = current.scope_id
              )
            ORDER BY scope_id`,
        )
        .bind(String(input.organizationId), input.application, input.scopeType),
    );
    if (Result.isFailure(rows)) return rows;
    const records: ApplicationApprovalPolicyRecord[] = [];
    for (const row of rows.value) {
      const record = recordFromRow(row);
      if (Result.isFailure(record)) return record;
      records.push(record.value);
    }
    return Result.succeed(records);
  }

  async latestApprovalPolicyVersion(input: {
    organizationId: OrganizationId;
    policyKeys: readonly string[];
  }): Result.ResultAsync<number | null, GovernancePersistenceError> {
    let latest: number | null = null;
    for (const policyKey of input.policyKeys) {
      const row = await firstRow<{ version: number | null }>(
        this.db
          .prepare(
            `SELECT MAX(version) AS version FROM published_approval_policy_versions
              WHERE organization_id = ? AND policy_key = ?`,
          )
          .bind(String(input.organizationId), policyKey),
      );
      if (Result.isFailure(row)) return row;
      const version = row.value?.version ?? null;
      if (version === null) return Result.succeed(null);
      latest = Math.max(latest ?? 0, version);
    }
    return Result.succeed(latest);
  }

  async apply(input: {
    scope: ApplicationApprovalPolicyScope;
    record: ApplicationApprovalPolicyRecord;
    approvalPolicies: readonly ApprovalPolicyDefinition[];
    actor: PrincipalRef;
  }): Result.ResultAsync<{ type: "applied" } | { type: "conflict" }, GovernancePersistenceError> {
    const candidate = this.db as Partial<D1BatchDatabaseLike>;
    if (typeof candidate.batch !== "function") {
      return Result.fail(
        new GovernancePersistenceError("d1_batch_not_supported", false, "D1 batch()が必要です"),
      );
    }
    const policyJson = json(input.record.policy);
    const actorJson = json(input.actor);
    if (Result.isFailure(policyJson)) return policyJson;
    if (Result.isFailure(actorJson)) return actorJson;
    const statements: D1PreparedStatementLike[] = [
      this.db
        .prepare(
          `INSERT INTO application_approval_policies (
             organization_id, application, scope_type, scope_id, version, policy_json,
             approval_policy_version, actor_json, source_action_request_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          String(input.scope.organizationId),
          input.scope.application,
          input.scope.scopeType,
          input.scope.scopeId,
          input.record.version,
          policyJson.value,
          input.record.approvalPolicyVersion,
          actorJson.value,
          input.record.sourceActionRequestId,
          input.record.createdAt,
        ),
    ];
    for (const policy of input.approvalPolicies) {
      const compiled = json(policy);
      if (Result.isFailure(compiled)) return compiled;
      statements.push(
        this.db
          .prepare(
            `INSERT INTO published_approval_policy_versions (
               organization_id, policy_key, version, policy_json, actor_json,
               source_action_request_id, published_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            String(input.scope.organizationId),
            String(policy.key),
            input.record.approvalPolicyVersion,
            compiled.value,
            actorJson.value,
            input.record.sourceActionRequestId,
            input.record.createdAt,
          ),
      );
    }
    const batchDb = candidate as D1BatchDatabaseLike;
    const applied = await Result.fn({
      try: async () => batchDb.batch(statements),
      catch: (error) => error,
    })();
    if (Result.isSuccess(applied)) return Result.succeed({ type: "applied" });
    if (isConstraintViolation(applied.error)) return Result.succeed({ type: "conflict" });
    return Result.fail(repositoryError(applied.error, "application policyの保存に失敗しました"));
  }

  /** scopeへの`application.approval_policy.update` ActionRequest（新しい順）。 */
  async recentProposalIds(input: {
    organizationId: OrganizationId;
    scopeType: string;
    scopeId: string;
    limit: number;
  }): Result.ResultAsync<string[], GovernancePersistenceError> {
    const rows = await allRows<{ id: string }>(
      this.db
        .prepare(
          `SELECT id FROM action_requests
            WHERE organization_id = ?
              AND json_extract(materialized_plan, '$.action.type') = ?
              AND json_extract(materialized_plan, '$.action.resource.type') = ?
              AND json_extract(materialized_plan, '$.action.resource.id') = ?
            ORDER BY created_at DESC LIMIT ?`,
        )
        .bind(
          String(input.organizationId),
          String(APPLICATION_APPROVAL_POLICY_ACTION_TYPE),
          input.scopeType,
          input.scopeId,
          input.limit,
        ),
    );
    return Result.isFailure(rows) ? rows : Result.succeed(rows.value.map((row) => row.id));
  }
}
