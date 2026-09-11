import {
  canonicalizeJson,
  verifyMaterializedApprovalPlan,
} from "@app/approval-core";
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
};

function serialize(value: unknown): string {
  return canonicalizeJson(value as JsonValue);
}

function asApprovalPlanChecksum(value: string): ApprovalPlanChecksum {
  return value as ApprovalPlanChecksum;
}

export class D1MaterializedPlanRepository implements MaterializedPlanRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async save(plan: MaterializedApprovalPlan): Promise<MaterializedPlanSaveResult> {
    const result = await this.db
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
        serialize(plan.evaluationSnapshot),
        plan.evaluationSnapshotChecksum,
        serialize(plan.policyBindingSnapshots),
        serialize(plan),
        plan.approvalPlanChecksum,
        plan.approvalBindingFingerprint,
        plan.interpreterSemanticsVersion,
        plan.evaluationSnapshot.evaluatedAt,
      )
      .run();

    if (!result.success) {
      throw new Error(result.error ?? "Materialized Approval Planの保存に失敗しました");
    }
    if ((result.meta?.changes ?? 0) > 0) return { type: "created" };

    const existing = await this.readRow(String(plan.organizationId), String(plan.actionRequestId));
    if (!existing) {
      throw new Error("INSERT OR IGNORE後に既存Planを取得できませんでした");
    }
    if (existing.approval_plan_checksum === String(plan.approvalPlanChecksum)) {
      return { type: "existing" };
    }
    return {
      type: "conflict",
      existingApprovalPlanChecksum: asApprovalPlanChecksum(existing.approval_plan_checksum),
    };
  }

  async load(input: Parameters<MaterializedPlanRepository["load"]>[0]): Promise<MaterializedPlanLoadResult> {
    const row = await this.readRow(String(input.organizationId), String(input.actionRequestId));
    if (!row) return { type: "not_found" };

    const actualChecksum = asApprovalPlanChecksum(row.approval_plan_checksum);
    if (
      input.expectedApprovalPlanChecksum &&
      String(input.expectedApprovalPlanChecksum) !== row.approval_plan_checksum
    ) {
      return { type: "checksum_mismatch", actualApprovalPlanChecksum: actualChecksum };
    }

    let plan: MaterializedApprovalPlan;
    try {
      plan = JSON.parse(row.materialized_plan) as MaterializedApprovalPlan;
    } catch (error) {
      return {
        type: "invalid_plan",
        message: error instanceof Error ? error.message : "保存済みPlan JSONをparseできません",
      };
    }

    const verification = await verifyMaterializedApprovalPlan(plan);
    if (verification.type === "invalid") {
      return { type: "invalid_plan", message: verification.message };
    }
    if (String(plan.approvalPlanChecksum) !== row.approval_plan_checksum) {
      return { type: "invalid_plan", message: "DB列とMaterialized Plan内のchecksumが一致しません" };
    }

    return { type: "found", plan };
  }

  private readRow(organizationId: string, actionRequestId: string): Promise<StoredPlanRow | null> {
    return this.db
      .prepare(
        `SELECT materialized_plan, approval_plan_checksum
         FROM action_requests
         WHERE organization_id = ? AND id = ?`,
      )
      .bind(organizationId, actionRequestId)
      .first<StoredPlanRow>();
  }
}
