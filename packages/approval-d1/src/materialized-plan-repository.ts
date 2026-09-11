import { Result } from "@praha/byethrow";

import { canonicalizeJson, verifyMaterializedApprovalPlan } from "@app/approval-core";
import type {
  ApprovalPlanChecksum,
  JsonValue,
  MaterializedApprovalPlan,
  MaterializedPlanLoadResult,
  MaterializedPlanRepository,
  MaterializedPlanSaveResult,
} from "@app/approval-core";

export type D1RunResultLike = {
  success: boolean;
  error?: string;
  meta?: { changes?: number };
};

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T>(): Promise<T | null>;
  run(): Promise<D1RunResultLike>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
}

type StoredPlanRow = {
  materialized_plan: string;
  approval_plan_checksum: string;
  approval_binding_fingerprint: string;
};

class D1RepositoryError extends Error {
  readonly name = "D1RepositoryError";
}

function repositoryError(error: unknown, fallback: string): D1RepositoryError {
  return new D1RepositoryError(error instanceof Error ? error.message : fallback);
}

const runStatement = Result.fn({
  try: async (statement: D1PreparedStatementLike): Promise<D1RunResultLike> => statement.run(),
  catch: (error): D1RepositoryError => repositoryError(error, "D1 statementの実行に失敗しました"),
});

const firstStoredPlanRow = Result.fn({
  try: async (statement: D1PreparedStatementLike): Promise<StoredPlanRow | null> =>
    statement.first<StoredPlanRow>(),
  catch: (error): D1RepositoryError => repositoryError(error, "D1 rowの取得に失敗しました"),
});

const parsePlan = Result.fn({
  try: (value: string): MaterializedApprovalPlan => JSON.parse(value) as MaterializedApprovalPlan,
  catch: (error): D1RepositoryError => repositoryError(error, "保存済みPlan JSONをparseできません"),
});

function serialize(value: unknown) {
  return canonicalizeJson(value as JsonValue);
}

function asApprovalPlanChecksum(value: string): ApprovalPlanChecksum {
  return value as ApprovalPlanChecksum;
}

export class D1MaterializedPlanRepository implements MaterializedPlanRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async save(plan: MaterializedApprovalPlan): Promise<MaterializedPlanSaveResult> {
    const verification = await verifyMaterializedApprovalPlan(plan);
    if (verification.type === "invalid") {
      return { type: "invalid_plan", message: verification.message };
    }

    const evaluationSnapshot = serialize(plan.evaluationSnapshot);
    const policyBindingSnapshots = serialize(plan.policyBindingSnapshots);
    const materializedPlan = serialize(plan);
    if (Result.isFailure(evaluationSnapshot)) {
      return { type: "invalid_plan", message: evaluationSnapshot.error.message };
    }
    if (Result.isFailure(policyBindingSnapshots)) {
      return { type: "invalid_plan", message: policyBindingSnapshots.error.message };
    }
    if (Result.isFailure(materializedPlan)) {
      return { type: "invalid_plan", message: materializedPlan.error.message };
    }

    const insert = await runStatement(
      this.db
        .prepare(
          `INSERT OR IGNORE INTO action_requests (
            id,
            organization_id,
            action_fingerprint,
            evaluation_snapshot,
            evaluation_snapshot_checksum,
            policy_binding_snapshots,
            materialized_plan,
            approval_plan_checksum,
            approval_binding_fingerprint,
            interpreter_semantics_version,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          plan.actionRequestId,
          plan.organizationId,
          plan.actionFingerprint,
          evaluationSnapshot.value,
          plan.evaluationSnapshotChecksum,
          policyBindingSnapshots.value,
          materializedPlan.value,
          plan.approvalPlanChecksum,
          plan.approvalBindingFingerprint,
          plan.interpreterSemanticsVersion,
          plan.evaluationSnapshot.evaluatedAt,
        ),
    );
    if (Result.isFailure(insert)) {
      return { type: "repository_error", message: insert.error.message };
    }
    if (!insert.value.success) {
      return {
        type: "repository_error",
        message: insert.value.error ?? "Materialized Approval Planの保存に失敗しました",
      };
    }
    if ((insert.value.meta?.changes ?? 0) > 0) return { type: "created" };

    const existing = await this.readRow(String(plan.organizationId), String(plan.actionRequestId));
    if (Result.isFailure(existing)) {
      return { type: "repository_error", message: existing.error.message };
    }
    if (!existing.value) {
      return {
        type: "repository_error",
        message: "INSERT OR IGNORE後に既存Planを取得できませんでした",
      };
    }
    if (existing.value.approval_binding_fingerprint === String(plan.approvalBindingFingerprint)) {
      return { type: "existing" };
    }
    return {
      type: "conflict",
      existingApprovalPlanChecksum: asApprovalPlanChecksum(existing.value.approval_plan_checksum),
    };
  }

  async load(
    input: Parameters<MaterializedPlanRepository["load"]>[0],
  ): Promise<MaterializedPlanLoadResult> {
    const rowResult = await this.readRow(
      String(input.organizationId),
      String(input.actionRequestId),
    );
    if (Result.isFailure(rowResult)) {
      return { type: "repository_error", message: rowResult.error.message };
    }
    const row = rowResult.value;
    if (!row) return { type: "not_found" };

    const actualChecksum = asApprovalPlanChecksum(row.approval_plan_checksum);
    if (
      input.expectedApprovalPlanChecksum &&
      String(input.expectedApprovalPlanChecksum) !== row.approval_plan_checksum
    ) {
      return { type: "checksum_mismatch", actualApprovalPlanChecksum: actualChecksum };
    }

    const parsed = parsePlan(row.materialized_plan);
    if (Result.isFailure(parsed)) {
      return { type: "invalid_plan", message: parsed.error.message };
    }
    const plan = parsed.value;

    if (
      String(plan.organizationId) !== String(input.organizationId) ||
      String(plan.actionRequestId) !== String(input.actionRequestId)
    ) {
      return {
        type: "invalid_plan",
        message: "DB検索キーとMaterialized Plan内部のorganizationId/actionRequestIdが一致しません",
      };
    }

    const verification = await verifyMaterializedApprovalPlan(plan);
    if (verification.type === "invalid") {
      return { type: "invalid_plan", message: verification.message };
    }
    if (String(plan.approvalPlanChecksum) !== row.approval_plan_checksum) {
      return { type: "invalid_plan", message: "DB列とMaterialized Plan内のchecksumが一致しません" };
    }
    if (String(plan.approvalBindingFingerprint) !== row.approval_binding_fingerprint) {
      return {
        type: "invalid_plan",
        message: "DB列とMaterialized Plan内のapprovalBindingFingerprintが一致しません",
      };
    }

    return { type: "found", plan };
  }

  private async readRow(
    organizationId: string,
    actionRequestId: string,
  ): Result.ResultAsync<StoredPlanRow | null, D1RepositoryError> {
    return firstStoredPlanRow(
      this.db
        .prepare(
          `SELECT materialized_plan, approval_plan_checksum, approval_binding_fingerprint
           FROM action_requests
           WHERE organization_id = ? AND id = ?`,
        )
        .bind(organizationId, actionRequestId),
    );
  }
}
