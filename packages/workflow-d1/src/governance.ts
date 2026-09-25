import { Result } from "@praha/byethrow";

import type { OrganizationId } from "@app/approval-core";
import type { JsonValue } from "@app/expression-core";
import type {
  LlmUsage,
  LlmUsageLedger,
  LlmUsageRecord,
  QuotaLedger,
  WorkflowRepositoryError,
} from "@app/workflow-application";
import type { EffectId, NodeRunId, WorkflowRunId } from "@app/workflow-core";

import { changes, firstRow, parseJson, runBatch } from "./d1.ts";
import type { D1DatabaseLike } from "./d1.ts";

/**
 * D1のquota ledger。上限判定と記録を1つのconditional INSERTで行い、同時acquireでも
 * 上限を超えない（SQLiteのstatementは原子的）。
 */
export class D1QuotaLedger implements QuotaLedger {
  constructor(private readonly db: D1DatabaseLike) {}

  async acquire(input: {
    leaseId: string;
    scopeKey: string;
    amount: number;
    limit: number;
    now: string;
    expiresAt: string;
  }): Result.ResultAsync<
    { type: "acquired" } | { type: "exhausted"; current: number },
    WorkflowRepositoryError
  > {
    const inserted = await runBatch({
      db: this.db,
      statements: [
        this.db
          .prepare("DELETE FROM workflow_quota_leases WHERE scope_key = ? AND expires_at <= ?")
          .bind(input.scopeKey, input.now),
        this.db
          .prepare(
            `INSERT OR IGNORE INTO workflow_quota_leases (lease_id, scope_key, amount, acquired_at, expires_at)
             SELECT ?, ?, ?, ?, ?
             WHERE EXISTS (SELECT 1 FROM workflow_quota_leases WHERE lease_id = ?)
                OR (SELECT COALESCE(SUM(amount), 0) FROM workflow_quota_leases WHERE scope_key = ?) + ? <= ?`,
          )
          .bind(
            input.leaseId,
            input.scopeKey,
            input.amount,
            input.now,
            input.expiresAt,
            input.leaseId,
            input.scopeKey,
            input.amount,
            input.limit,
          ),
      ],
    });
    if (Result.isFailure(inserted)) return inserted;
    const held = await firstRow<{ lease_id: string }>(
      this.db
        .prepare("SELECT lease_id FROM workflow_quota_leases WHERE lease_id = ?")
        .bind(input.leaseId),
    );
    if (Result.isFailure(held)) return held;
    if (held.value || changes(inserted.value[1]) === 1) return Result.succeed({ type: "acquired" });
    const current = await firstRow<{ total: number }>(
      this.db
        .prepare(
          "SELECT COALESCE(SUM(amount), 0) AS total FROM workflow_quota_leases WHERE scope_key = ?",
        )
        .bind(input.scopeKey),
    );
    if (Result.isFailure(current)) return current;
    return Result.succeed({ type: "exhausted", current: current.value?.total ?? 0 });
  }

  async release(input: { leaseId: string }): Result.ResultAsync<void, WorkflowRepositoryError> {
    const released = await runBatch({
      db: this.db,
      statements: [
        this.db.prepare("DELETE FROM workflow_quota_leases WHERE lease_id = ?").bind(input.leaseId),
      ],
    });
    if (Result.isFailure(released)) return released;
    return Result.succeed(undefined);
  }

  async increment(input: {
    scopeKey: string;
    idempotencyKey: string;
    amount: number;
    limit: number;
    now: string;
  }): Result.ResultAsync<
    { type: "incremented" | "existing" } | { type: "exhausted"; current: number },
    WorkflowRepositoryError
  > {
    const existing = await firstRow<{ amount: number }>(
      this.db
        .prepare(
          "SELECT amount FROM workflow_quota_counters WHERE scope_key = ? AND idempotency_key = ?",
        )
        .bind(input.scopeKey, input.idempotencyKey),
    );
    if (Result.isFailure(existing)) return existing;
    if (existing.value) return Result.succeed({ type: "existing" });
    const inserted = await runBatch({
      db: this.db,
      statements: [
        this.db
          .prepare(
            `INSERT OR IGNORE INTO workflow_quota_counters (scope_key, idempotency_key, amount, created_at)
             SELECT ?, ?, ?, ?
             WHERE (SELECT COALESCE(SUM(amount), 0) FROM workflow_quota_counters WHERE scope_key = ?) + ? <= ?`,
          )
          .bind(
            input.scopeKey,
            input.idempotencyKey,
            input.amount,
            input.now,
            input.scopeKey,
            input.amount,
            input.limit,
          ),
      ],
    });
    if (Result.isFailure(inserted)) return inserted;
    if (changes(inserted.value[0]) === 1) return Result.succeed({ type: "incremented" });
    const current = await firstRow<{ total: number }>(
      this.db
        .prepare(
          "SELECT COALESCE(SUM(amount), 0) AS total FROM workflow_quota_counters WHERE scope_key = ?",
        )
        .bind(input.scopeKey),
    );
    if (Result.isFailure(current)) return current;
    return Result.succeed({ type: "exhausted", current: current.value?.total ?? 0 });
  }
}

type UsageRow = {
  organization_id: string;
  effect_id: string;
  run_id: string;
  node_run_id: string;
  model: string;
  status: LlmUsageRecord["status"];
  input_tokens: number;
  output_tokens: number;
  cost_micro_usd: number;
  code: string | null;
  output_json: string | null;
  created_at: string;
};

export class D1LlmUsageLedger implements LlmUsageLedger {
  constructor(private readonly db: D1DatabaseLike) {}

  async find(input: {
    organizationId: OrganizationId;
    runId: WorkflowRunId;
    effectId: EffectId;
  }): Result.ResultAsync<LlmUsageRecord | null, WorkflowRepositoryError> {
    const row = await firstRow<UsageRow>(
      this.db
        .prepare(
          "SELECT * FROM workflow_llm_usage WHERE organization_id = ? AND run_id = ? AND effect_id = ?",
        )
        .bind(String(input.organizationId), String(input.runId), String(input.effectId)),
    );
    if (Result.isFailure(row)) return row;
    if (!row.value) return Result.succeed(null);
    let output: JsonValue | undefined;
    if (row.value.output_json !== null) {
      const parsed = parseJson<JsonValue>(row.value.output_json);
      if (Result.isFailure(parsed)) return parsed;
      output = parsed.value;
    }
    return Result.succeed({
      organizationId: input.organizationId,
      effectId: input.effectId,
      runId: input.runId,
      nodeRunId: row.value.node_run_id as NodeRunId,
      model: row.value.model,
      status: row.value.status,
      inputTokens: row.value.input_tokens,
      outputTokens: row.value.output_tokens,
      costMicroUsd: row.value.cost_micro_usd,
      ...(row.value.code !== null ? { code: row.value.code } : {}),
      ...(output !== undefined ? { output } : {}),
      createdAt: row.value.created_at,
    });
  }

  async usage(input: {
    organizationId: OrganizationId;
    runId: WorkflowRunId;
    nodeRunId: NodeRunId;
  }): Result.ResultAsync<LlmUsage, WorkflowRepositoryError> {
    const row = await firstRow<{
      calls: number;
      input_tokens: number;
      output_tokens: number;
      cost: number;
    }>(
      this.db
        .prepare(
          `SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens), 0) AS input_tokens,
                  COALESCE(SUM(output_tokens), 0) AS output_tokens, COALESCE(SUM(cost_micro_usd), 0) AS cost
             FROM workflow_llm_usage
            WHERE organization_id = ? AND run_id = ? AND node_run_id = ? AND status IN ('reserved', 'completed')`,
        )
        .bind(String(input.organizationId), String(input.runId), String(input.nodeRunId)),
    );
    if (Result.isFailure(row)) return row;
    return Result.succeed({
      calls: row.value?.calls ?? 0,
      inputTokens: row.value?.input_tokens ?? 0,
      outputTokens: row.value?.output_tokens ?? 0,
      costMicroUsd: row.value?.cost ?? 0,
    });
  }

  async record(
    record: LlmUsageRecord,
  ): Result.ResultAsync<
    { type: "recorded" } | { type: "existing"; record: LlmUsageRecord },
    WorkflowRepositoryError
  > {
    const inserted = await runBatch({
      db: this.db,
      statements: [
        this.db
          .prepare(
            `INSERT OR IGNORE INTO workflow_llm_usage
               (organization_id, effect_id, run_id, node_run_id, model, status, input_tokens, output_tokens,
                cost_micro_usd, code, output_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            String(record.organizationId),
            String(record.effectId),
            String(record.runId),
            String(record.nodeRunId),
            record.model,
            record.status,
            record.inputTokens,
            record.outputTokens,
            record.costMicroUsd,
            record.code ?? null,
            record.output === undefined ? null : JSON.stringify(record.output),
            record.createdAt,
          ),
      ],
    });
    if (Result.isFailure(inserted)) return inserted;
    if (changes(inserted.value[0]) === 1) return Result.succeed({ type: "recorded" });
    const existing = await this.find(record);
    if (Result.isFailure(existing)) return existing;
    return existing.value
      ? Result.succeed({ type: "existing", record: existing.value })
      : Result.succeed({ type: "recorded" });
  }

  async complete(input: {
    organizationId: OrganizationId;
    runId: WorkflowRunId;
    effectId: EffectId;
    inputTokens: number;
    outputTokens: number;
    costMicroUsd: number;
    output: JsonValue;
  }): Result.ResultAsync<void, WorkflowRepositoryError> {
    const updated = await runBatch({
      db: this.db,
      statements: [
        this.db
          .prepare(
            `UPDATE workflow_llm_usage
                SET status = 'completed', input_tokens = ?, output_tokens = ?, cost_micro_usd = ?, output_json = ?
              WHERE organization_id = ? AND run_id = ? AND effect_id = ? AND status = 'reserved'`,
          )
          .bind(
            input.inputTokens,
            input.outputTokens,
            input.costMicroUsd,
            JSON.stringify(input.output),
            String(input.organizationId),
            String(input.runId),
            String(input.effectId),
          ),
      ],
    });
    if (Result.isFailure(updated)) return updated;
    return Result.succeed(undefined);
  }
}
