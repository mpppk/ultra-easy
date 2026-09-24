import { Result } from "@praha/byethrow";

import type { ActionRequestId, OrganizationId } from "@app/approval-core";
import {
  leaseLostError,
  McpGatewayError,
  sameRouteSnapshot,
  type McpInvocationPatch,
  type McpInvocationRecord,
  type McpInvocationRepository,
  type McpInvocationReserveResult,
  type McpRouteSnapshot,
  type McpRouteSnapshotRepository,
} from "@app/approval-mcp";

import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1RunResultLike,
} from "./materialized-plan-repository.ts";

type StoredRecordRow = { record_json: string };
type StoredSnapshotRow = { snapshot_json: string };

function repositoryError(error: unknown, fallback: string): McpGatewayError {
  return new McpGatewayError(
    "mcp_gateway_repository_error",
    true,
    error instanceof Error ? error.message : fallback,
  );
}

const run = Result.fn({
  try: async (statement: D1PreparedStatementLike): Promise<D1RunResultLike> => statement.run(),
  catch: (error): McpGatewayError =>
    repositoryError(error, "MCP Gateway stateの保存に失敗しました"),
});

const firstRecordRow = Result.fn({
  try: async (statement: D1PreparedStatementLike): Promise<StoredRecordRow | null> =>
    statement.first<StoredRecordRow>(),
  catch: (error): McpGatewayError => repositoryError(error, "MCP invocationの取得に失敗しました"),
});

const firstSnapshotRow = Result.fn({
  try: async (statement: D1PreparedStatementLike): Promise<StoredSnapshotRow | null> =>
    statement.first<StoredSnapshotRow>(),
  catch: (error): McpGatewayError =>
    repositoryError(error, "MCP route snapshotの取得に失敗しました"),
});

function invalidRecord(error: unknown): McpGatewayError {
  return new McpGatewayError(
    "mcp_gateway_record_invalid",
    false,
    error instanceof Error ? error.message : "MCP Gateway recordをparseできません",
  );
}

const parseRecord = Result.fn({
  try: (value: string): McpInvocationRecord => JSON.parse(value) as McpInvocationRecord,
  catch: invalidRecord,
});

const parseSnapshot = Result.fn({
  try: (value: string): McpRouteSnapshot => JSON.parse(value) as McpRouteSnapshot,
  catch: invalidRecord,
});

function changed(result: D1RunResultLike): boolean {
  return result.success && (result.meta?.changes ?? 0) > 0;
}

/**
 * MCP Gateway logical invocation / durable Task reservationのD1実装。
 *
 * - reserveはINSERT OR IGNOREで原子的に1件だけを勝たせる
 * - takeOver / update / releaseはlease_token（+ lease期限）でfenceしたcompare-and-set
 * - Task IDはpartial unique indexでorganization内一意、invocationと1:1
 */
export class D1McpInvocationRepository implements McpInvocationRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async reserve(
    record: McpInvocationRecord,
  ): Result.ResultAsync<McpInvocationReserveResult, McpGatewayError> {
    const inserted = await run(
      this.db
        .prepare(
          `INSERT OR IGNORE INTO mcp_invocations (
             organization_id, invocation_id, status, request_hash, lease_token,
             lease_expires_at, task_id, action_request_id, record_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(...this.rowValues(record), record.createdAt, record.updatedAt),
    );
    if (Result.isFailure(inserted)) return inserted;
    if (changed(inserted.value)) return Result.succeed({ type: "acquired", record });

    const existing = await this.load({
      organizationId: record.organizationId,
      invocationId: record.invocationId,
    });
    if (Result.isFailure(existing)) return existing;
    if (!existing.value) {
      // INSERT OR IGNOREとSELECTの間にreleaseされた。callerは同じkeyで再試行できる。
      return Result.fail(
        new McpGatewayError("mcp_invocation_reserve_race", true, "invocationの予約が競合しました"),
      );
    }
    return Result.succeed({ type: "existing", record: existing.value });
  }

  async takeOver(input: {
    organizationId: OrganizationId;
    invocationId: string;
    expectedLeaseToken: string;
    leaseToken: string;
    leaseExpiresAt: string;
    now: string;
  }): Result.ResultAsync<McpInvocationRecord | null, McpGatewayError> {
    const existing = await this.load(input);
    if (Result.isFailure(existing)) return existing;
    const record = existing.value;
    if (
      !record ||
      record.leaseToken !== input.expectedLeaseToken ||
      record.leaseExpiresAt > input.now ||
      (record.status !== "reserved" && record.status !== "prepared")
    ) {
      return Result.succeed(null);
    }
    const next: McpInvocationRecord = {
      ...record,
      leaseToken: input.leaseToken,
      leaseExpiresAt: input.leaseExpiresAt,
      updatedAt: input.now,
    };
    const updated = await run(
      this.db
        .prepare(
          `UPDATE mcp_invocations
              SET lease_token = ?, lease_expires_at = ?, record_json = ?, updated_at = ?
            WHERE organization_id = ? AND invocation_id = ?
              AND lease_token = ? AND lease_expires_at <= ?
              AND status IN ('reserved', 'prepared')`,
        )
        .bind(
          next.leaseToken,
          next.leaseExpiresAt,
          JSON.stringify(next),
          next.updatedAt,
          String(input.organizationId),
          input.invocationId,
          input.expectedLeaseToken,
          input.now,
        ),
    );
    if (Result.isFailure(updated)) return updated;
    return Result.succeed(changed(updated.value) ? next : null);
  }

  async update(input: {
    organizationId: OrganizationId;
    invocationId: string;
    leaseToken: string;
    patch: McpInvocationPatch;
  }): Result.ResultAsync<McpInvocationRecord, McpGatewayError> {
    const existing = await this.load(input);
    if (Result.isFailure(existing)) return existing;
    const record = existing.value;
    if (!record || record.leaseToken !== input.leaseToken) return Result.fail(leaseLostError());
    if (
      record.taskId !== undefined &&
      input.patch.taskId !== undefined &&
      record.taskId !== input.patch.taskId
    ) {
      return Result.fail(
        new McpGatewayError("invocation_task_rebind", false, "MCP Taskは付け替えできません"),
      );
    }
    const next: McpInvocationRecord = { ...record, ...input.patch };
    const updated = await run(
      this.db
        .prepare(
          `UPDATE mcp_invocations
              SET status = ?, request_hash = ?, lease_token = ?, lease_expires_at = ?,
                  task_id = ?, action_request_id = ?, record_json = ?, updated_at = ?
            WHERE organization_id = ? AND invocation_id = ? AND lease_token = ?`,
        )
        .bind(
          ...this.rowValues(next).slice(2),
          next.updatedAt,
          String(input.organizationId),
          input.invocationId,
          input.leaseToken,
        ),
    );
    if (Result.isFailure(updated)) return updated;
    if (!changed(updated.value)) return Result.fail(leaseLostError());
    return Result.succeed(next);
  }

  async release(input: {
    organizationId: OrganizationId;
    invocationId: string;
    leaseToken: string;
  }): Result.ResultAsync<void, McpGatewayError> {
    const deleted = await run(
      this.db
        .prepare(
          `DELETE FROM mcp_invocations
            WHERE organization_id = ? AND invocation_id = ? AND lease_token = ?
              AND status IN ('reserved', 'prepared')`,
        )
        .bind(String(input.organizationId), input.invocationId, input.leaseToken),
    );
    return Result.isFailure(deleted) ? deleted : Result.succeed(undefined);
  }

  async load(input: {
    organizationId: OrganizationId;
    invocationId: string;
  }): Result.ResultAsync<McpInvocationRecord | null, McpGatewayError> {
    return this.readRecord(
      this.db
        .prepare(
          `SELECT record_json FROM mcp_invocations
            WHERE organization_id = ? AND invocation_id = ?`,
        )
        .bind(String(input.organizationId), input.invocationId),
    );
  }

  async loadByTaskId(input: {
    organizationId: OrganizationId;
    taskId: string;
  }): Result.ResultAsync<McpInvocationRecord | null, McpGatewayError> {
    return this.readRecord(
      this.db
        .prepare(
          `SELECT record_json FROM mcp_invocations
            WHERE organization_id = ? AND task_id = ?`,
        )
        .bind(String(input.organizationId), input.taskId),
    );
  }

  private rowValues(record: McpInvocationRecord): unknown[] {
    return [
      String(record.organizationId),
      record.invocationId,
      record.status,
      record.requestHash,
      record.leaseToken,
      record.leaseExpiresAt,
      record.taskId ?? null,
      record.actionRequestId === undefined ? null : String(record.actionRequestId),
      JSON.stringify(record),
    ];
  }

  private async readRecord(
    statement: D1PreparedStatementLike,
  ): Result.ResultAsync<McpInvocationRecord | null, McpGatewayError> {
    const row = await firstRecordRow(statement);
    if (Result.isFailure(row)) return row;
    if (!row.value) return Result.succeed(null);
    return parseRecord(row.value.record_json);
  }
}

/** admission時にActionRequestへbindするdownstream route snapshotのD1実装（INSERT-only）。 */
export class D1McpRouteSnapshotRepository implements McpRouteSnapshotRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async save(snapshot: McpRouteSnapshot): Result.ResultAsync<void, McpGatewayError> {
    const inserted = await run(
      this.db
        .prepare(
          `INSERT OR IGNORE INTO mcp_route_snapshots (
             organization_id, action_request_id, action_fingerprint,
             binding_fingerprint, snapshot_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          String(snapshot.organizationId),
          String(snapshot.actionRequestId),
          String(snapshot.actionFingerprint),
          snapshot.bindingFingerprint,
          JSON.stringify(snapshot),
          snapshot.createdAt,
        ),
    );
    if (Result.isFailure(inserted)) return inserted;
    if (changed(inserted.value)) return Result.succeed(undefined);

    const existing = await this.load(snapshot);
    if (Result.isFailure(existing)) return existing;
    if (existing.value && sameRouteSnapshot(existing.value, snapshot)) {
      return Result.succeed(undefined);
    }
    return Result.fail(
      new McpGatewayError(
        "route_snapshot_conflict",
        false,
        "ActionRequestには別のroute snapshotが既に保存されています",
      ),
    );
  }

  async load(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
  }): Result.ResultAsync<McpRouteSnapshot | null, McpGatewayError> {
    const row = await firstSnapshotRow(
      this.db
        .prepare(
          `SELECT snapshot_json FROM mcp_route_snapshots
            WHERE organization_id = ? AND action_request_id = ?`,
        )
        .bind(String(input.organizationId), String(input.actionRequestId)),
    );
    if (Result.isFailure(row)) return row;
    if (!row.value) return Result.succeed(null);
    return parseSnapshot(row.value.snapshot_json);
  }
}
