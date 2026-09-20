import { Result } from "@praha/byethrow";

import {
  actionCorrelation,
  deriveApprovalSliMetrics,
  metricRecord,
  safeActionEventLogRecord,
  safeLogRecord,
} from "@app/approval-core";
import type {
  ActionEventRecord,
  ActionRequestId,
  OrganizationId,
  TelemetrySink,
} from "@app/approval-core";
import { D1ActionEventRepository } from "@app/approval-d1";
import type { D1DatabaseLike } from "@app/approval-d1";

export function emitDomainEventTelemetry(
  telemetry: TelemetrySink,
  records: readonly ActionEventRecord[],
): void {
  for (const record of records) {
    telemetry.emit(safeActionEventLogRecord(record, "d1"));
  }
}

export async function emitActionSliSnapshot(input: {
  db: D1DatabaseLike;
  organizationId: OrganizationId;
  actionRequestId: ActionRequestId;
  telemetry: TelemetrySink;
}): Promise<void> {
  const records = await new D1ActionEventRepository(input.db).listForAction({
    organizationId: input.organizationId,
    actionRequestId: input.actionRequestId,
  });
  if (Result.isFailure(records)) return;
  for (const metric of deriveApprovalSliMetrics(records.value)) {
    input.telemetry.emit(metric);
  }
}

export function emitWorkflowRetry(input: {
  telemetry: TelemetrySink;
  organizationId: OrganizationId;
  actionRequestId: ActionRequestId;
  operation: string;
  errorCode: string;
  retryCount?: number;
}): void {
  const correlation = actionCorrelation({
    organizationId: input.organizationId,
    actionRequestId: input.actionRequestId,
    component: "workflow",
    operation: input.operation,
  });
  input.telemetry.emit(
    safeLogRecord({
      level: "warn",
      event: "workflow.retry",
      correlation,
      attributes: {
        errorCode: input.errorCode,
        ...(input.retryCount !== undefined ? { retryCount: input.retryCount } : {}),
      },
    }),
  );
  input.telemetry.emit(
    metricRecord({
      name: "workflow.retry_total",
      value: 1,
      unit: "count",
      correlation,
      attributes: { errorCode: input.errorCode },
    }),
  );
}

export function emitWorkflowFailure(input: {
  telemetry: TelemetrySink;
  organizationId: OrganizationId;
  actionRequestId: ActionRequestId;
  operation: string;
  errorCode: string;
}): void {
  const correlation = actionCorrelation({
    organizationId: input.organizationId,
    actionRequestId: input.actionRequestId,
    component: "workflow",
    operation: input.operation,
  });
  input.telemetry.emit(
    safeLogRecord({
      level: "error",
      event: "workflow.failed",
      correlation,
      attributes: { errorCode: input.errorCode },
    }),
  );
  input.telemetry.emit(
    metricRecord({
      name: "workflow.failure_total",
      value: 1,
      unit: "count",
      correlation,
      attributes: { errorCode: input.errorCode },
    }),
  );
}
