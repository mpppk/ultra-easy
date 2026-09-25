import { Result } from "@praha/byethrow";

import type { ActionEventRecord, ActionEventRepository } from "../action-event.ts";
import type { ActionResultRecord, ActionResultRepository } from "../action-execution-record.ts";
import type { ActionRequestId, OrganizationId } from "../domain/brand.ts";

/**
 * テスト用のaction_events / action_results。D1と同じくeventKeyの重複は無視し、
 * resultはActionRequestごとに最新の1件を保持する。
 */
export class InMemoryActionAuditStore implements ActionEventRepository, ActionResultRepository {
  readonly events: ActionEventRecord[] = [];
  readonly results = new Map<string, ActionResultRecord>();

  async appendMany(records: readonly ActionEventRecord[]) {
    for (const record of records) {
      const exists = this.events.some(
        (event) =>
          String(event.organizationId) === String(record.organizationId) &&
          event.eventKey === record.eventKey,
      );
      if (!exists) this.events.push(structuredClone(record));
    }
    return Result.succeed(undefined);
  }

  async listForAction(input: { organizationId: OrganizationId; actionRequestId: ActionRequestId }) {
    return Result.succeed(
      this.events.filter(
        (record) =>
          String(record.organizationId) === String(input.organizationId) &&
          String(record.event.actionRequestId) === String(input.actionRequestId),
      ),
    );
  }

  async save(record: ActionResultRecord, events: readonly ActionEventRecord[]) {
    this.results.set(
      `${String(record.organizationId)}|${String(record.actionRequestId)}`,
      structuredClone(record),
    );
    return this.appendMany(events);
  }

  result(input: {
    organizationId: OrganizationId;
    actionRequestId: ActionRequestId;
  }): ActionResultRecord | undefined {
    return this.results.get(`${String(input.organizationId)}|${String(input.actionRequestId)}`);
  }
}
