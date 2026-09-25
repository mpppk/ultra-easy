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
  ActionEventRepository,
  ActionRequestId,
  OrganizationId,
  TelemetrySink,
} from "@app/approval-core";

export function emitDomainEventTelemetry(
  telemetry: TelemetrySink,
  records: readonly ActionEventRecord[],
): void {
  for (const record of records) {
    telemetry.emit(safeActionEventLogRecord(record, "d1"));
  }
}

/** SLIの元データ（action_events）を読めなかったときのtelemetry error code（#110）。 */
export const SLI_SOURCE_UNAVAILABLE = "sli_source_unavailable";

/**
 * 終端したActionのSLI metricをaction_eventsから導出して出す。元データを読めなければ黙って
 * 捨てず、`telemetry.failed`（errorCode `sli_source_unavailable`）を出す（#110）。
 */
export async function emitActionSliSnapshot(input: {
  events: ActionEventRepository;
  organizationId: OrganizationId;
  actionRequestId: ActionRequestId;
  telemetry: TelemetrySink;
}): Promise<{ type: "emitted"; metrics: number } | { type: "failed"; code: string }> {
  const records = await input.events.listForAction({
    organizationId: input.organizationId,
    actionRequestId: input.actionRequestId,
  });
  if (Result.isFailure(records)) {
    input.telemetry.emit(
      safeLogRecord({
        level: "error",
        event: "telemetry.failed",
        correlation: actionCorrelation({
          organizationId: input.organizationId,
          actionRequestId: input.actionRequestId,
          component: "workflow",
          operation: "emit_action_sli",
        }),
        attributes: { errorCode: SLI_SOURCE_UNAVAILABLE },
      }),
    );
    return { type: "failed", code: SLI_SOURCE_UNAVAILABLE };
  }
  const metrics = deriveApprovalSliMetrics(records.value);
  for (const metric of metrics) input.telemetry.emit(metric);
  return { type: "emitted", metrics: metrics.length };
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
