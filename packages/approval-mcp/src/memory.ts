import { Result } from "@praha/byethrow";

import type { ActionRequestId, OrganizationId } from "@app/approval-core";

import { McpGatewayError } from "./binding.ts";
import {
  leaseLostError,
  sameRouteSnapshot,
  type McpInvocationPatch,
  type McpInvocationRecord,
  type McpInvocationRepository,
  type McpRouteSnapshot,
  type McpRouteSnapshotRepository,
} from "./invocation.ts";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function key(organizationId: OrganizationId | string, id: string): string {
  return JSON.stringify([String(organizationId), id]);
}

/**
 * テスト / preview用のin-memory実装。各操作は同期的に完了するため、
 * 同一isolate内の並行reserve / takeOverは自然に直列化され、1件だけが成功する。
 */
export class InMemoryMcpInvocationRepository implements McpInvocationRepository {
  private readonly records = new Map<string, McpInvocationRecord>();
  private readonly tasks = new Map<string, string>();

  reserve(record: McpInvocationRecord) {
    const recordKey = key(record.organizationId, record.invocationId);
    const existing = this.records.get(recordKey);
    if (existing) {
      return Promise.resolve(
        Result.succeed({ type: "existing" as const, record: clone(existing) }),
      );
    }
    this.records.set(recordKey, clone(record));
    return Promise.resolve(Result.succeed({ type: "acquired" as const, record: clone(record) }));
  }

  takeOver(input: {
    organizationId: OrganizationId;
    invocationId: string;
    expectedLeaseToken: string;
    leaseToken: string;
    leaseExpiresAt: string;
    now: string;
  }) {
    const recordKey = key(input.organizationId, input.invocationId);
    const existing = this.records.get(recordKey);
    if (
      !existing ||
      existing.leaseToken !== input.expectedLeaseToken ||
      existing.leaseExpiresAt > input.now ||
      existing.status === "committed" ||
      existing.status === "completed"
    ) {
      return Promise.resolve(Result.succeed(null));
    }
    const next: McpInvocationRecord = {
      ...existing,
      leaseToken: input.leaseToken,
      leaseExpiresAt: input.leaseExpiresAt,
      updatedAt: input.now,
    };
    this.records.set(recordKey, next);
    return Promise.resolve(Result.succeed(clone(next)));
  }

  update(input: {
    organizationId: OrganizationId;
    invocationId: string;
    leaseToken: string;
    patch: McpInvocationPatch;
  }) {
    const recordKey = key(input.organizationId, input.invocationId);
    const existing = this.records.get(recordKey);
    if (!existing || existing.leaseToken !== input.leaseToken) {
      return Promise.resolve(Result.fail(leaseLostError()));
    }
    if (
      existing.taskId !== undefined &&
      input.patch.taskId !== undefined &&
      existing.taskId !== input.patch.taskId
    ) {
      return Promise.resolve(
        Result.fail(
          new McpGatewayError("invocation_task_rebind", false, "MCP Taskは付け替えできません"),
        ),
      );
    }
    const next: McpInvocationRecord = { ...existing, ...clone(input.patch) };
    if (next.taskId !== undefined) {
      const taskKey = key(input.organizationId, next.taskId);
      const bound = this.tasks.get(taskKey);
      if (bound !== undefined && bound !== input.invocationId) {
        return Promise.resolve(
          Result.fail(
            new McpGatewayError("mcp_task_already_exists", false, "MCP Task IDが重複しています"),
          ),
        );
      }
      this.tasks.set(taskKey, input.invocationId);
    }
    this.records.set(recordKey, next);
    return Promise.resolve(Result.succeed(clone(next)));
  }

  release(input: { organizationId: OrganizationId; invocationId: string; leaseToken: string }) {
    const recordKey = key(input.organizationId, input.invocationId);
    const existing = this.records.get(recordKey);
    if (
      existing &&
      existing.leaseToken === input.leaseToken &&
      (existing.status === "reserved" || existing.status === "prepared")
    ) {
      this.records.delete(recordKey);
      if (existing.taskId !== undefined) {
        this.tasks.delete(key(input.organizationId, existing.taskId));
      }
    }
    return Promise.resolve(Result.succeed(undefined));
  }

  load(input: { organizationId: OrganizationId; invocationId: string }) {
    const record = this.records.get(key(input.organizationId, input.invocationId));
    return Promise.resolve(Result.succeed(record ? clone(record) : null));
  }

  loadByTaskId(input: { organizationId: OrganizationId; taskId: string }) {
    const invocationId = this.tasks.get(key(input.organizationId, input.taskId));
    const record =
      invocationId === undefined
        ? undefined
        : this.records.get(key(input.organizationId, invocationId));
    return Promise.resolve(Result.succeed(record ? clone(record) : null));
  }

  /** テスト用: 全invocation record。 */
  all(): McpInvocationRecord[] {
    return [...this.records.values()].map(clone);
  }
}

export class InMemoryMcpRouteSnapshotRepository implements McpRouteSnapshotRepository {
  private readonly snapshots = new Map<string, McpRouteSnapshot>();

  save(snapshot: McpRouteSnapshot) {
    const snapshotKey = key(snapshot.organizationId, String(snapshot.actionRequestId));
    const existing = this.snapshots.get(snapshotKey);
    if (existing && !sameRouteSnapshot(existing, snapshot)) {
      return Promise.resolve(
        Result.fail(
          new McpGatewayError(
            "route_snapshot_conflict",
            false,
            "ActionRequestには別のroute snapshotが既に保存されています",
          ),
        ),
      );
    }
    if (!existing) this.snapshots.set(snapshotKey, clone(snapshot));
    return Promise.resolve(Result.succeed(undefined));
  }

  load(input: { organizationId: OrganizationId; actionRequestId: ActionRequestId }) {
    const snapshot = this.snapshots.get(key(input.organizationId, String(input.actionRequestId)));
    return Promise.resolve(Result.succeed(snapshot ? clone(snapshot) : null));
  }
}
