import { Result } from "@praha/byethrow";

import type { ActionEventRecord } from "../action-event.ts";
import type {
  AsyncActionExecutionRecord,
  AsyncActionExecutionRepository,
  AsyncExecutionCompletion,
} from "../async-action-execution.ts";
import type { ActionFingerprint, ActionRequestId, OrganizationId } from "../domain/brand.ts";
import type { InMemoryActionAuditStore } from "./audit-store.ts";

function key(organizationId: OrganizationId, actionRequestId: ActionRequestId): string {
  return `${String(organizationId)}|${String(actionRequestId)}`;
}

/** テスト用のaction_async_executions。D1と同じCAS semanticsを持つ。 */
export class InMemoryAsyncActionExecutionStore implements AsyncActionExecutionRepository {
  readonly records = new Map<string, AsyncActionExecutionRecord>();

  constructor(private readonly audit?: InMemoryActionAuditStore) {}

  async accept(input: {
    record: AsyncActionExecutionRecord;
    events: readonly ActionEventRecord[];
  }) {
    const id = key(input.record.organizationId, input.record.actionRequestId);
    const existing = this.records.get(id);
    if (existing)
      return Result.succeed({ type: "existing" as const, record: structuredClone(existing) });
    this.records.set(id, structuredClone(input.record));
    if (this.audit) await this.audit.appendMany(input.events);
    return Result.succeed({ type: "accepted" as const });
  }

  async load(input: { organizationId: OrganizationId; actionRequestId: ActionRequestId }) {
    const found = this.records.get(key(input.organizationId, input.actionRequestId));
    return Result.succeed(found ? structuredClone(found) : null);
  }

  async settle(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
    actionFingerprint: ActionFingerprint;
    executionRef: string;
    idempotencyKey: string;
    completion: AsyncExecutionCompletion;
    completedAt: string;
  }) {
    const found = this.records.get(key(input.organizationId, input.actionRequestId));
    if (
      !found ||
      String(found.actionFingerprint) !== String(input.actionFingerprint) ||
      found.executionRef !== input.executionRef ||
      found.idempotencyKey !== input.idempotencyKey
    ) {
      return Result.succeed({ type: "not_found" as const });
    }
    if (found.status === "completed") {
      return Result.succeed({ type: "already_settled" as const, record: structuredClone(found) });
    }
    const settled: AsyncActionExecutionRecord = {
      ...found,
      status: "completed",
      completion: structuredClone(input.completion),
      completedAt: input.completedAt,
    };
    this.records.set(key(input.organizationId, input.actionRequestId), settled);
    return Result.succeed({ type: "settled" as const, record: structuredClone(settled) });
  }

  async requestCancel(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
    reason: string;
    requestedAt: string;
  }) {
    const found = this.records.get(key(input.organizationId, input.actionRequestId));
    if (!found) return Result.succeed({ type: "not_found" as const });
    if (found.status === "completed") {
      return Result.succeed({ type: "already_settled" as const, record: structuredClone(found) });
    }
    const next: AsyncActionExecutionRecord = {
      ...found,
      status: "cancel_requested",
      cancelRequestedAt: found.cancelRequestedAt ?? input.requestedAt,
      cancelReason: found.cancelReason ?? input.reason,
    };
    this.records.set(key(input.organizationId, input.actionRequestId), next);
    return Result.succeed({ type: "cancel_requested" as const, record: structuredClone(next) });
  }
}
