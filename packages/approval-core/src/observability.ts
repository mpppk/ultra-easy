import type { ActionEventRecord } from "./action-event.ts";
import type { ActionRequestId, OrganizationId } from "./domain/brand.ts";
import type { PrincipalRef } from "./domain/principal.ts";

export type TelemetryComponent =
  | "http"
  | "mcp"
  | "workflow"
  | "d1"
  | "fga"
  | "executor"
  | "notification"
  | "outbox";

export type CorrelationContext = {
  organizationId: OrganizationId;
  actionRequestId: ActionRequestId;
  correlationId: string;
  component: TelemetryComponent;
  operation: string;
  principal?: PrincipalRef;
};

export function actionCorrelation(input: {
  organizationId: OrganizationId;
  actionRequestId: ActionRequestId;
  component: TelemetryComponent;
  operation: string;
  principal?: PrincipalRef;
}): CorrelationContext {
  return {
    ...input,
    correlationId: String(input.actionRequestId),
  };
}

export type SafeLogAttributes = {
  status?: string;
  result?: string;
  errorCode?: string;
  eventType?: string;
  materializedStepId?: string;
  stepKey?: string;
  retriable?: boolean;
  retryCount?: number;
  durationMs?: number;
  queueDepth?: number;
};

export type SafeLogEvent =
  | "request.accepted"
  | "request.denied"
  | "request.failed"
  | "workflow.retry"
  | "workflow.failed"
  | "executor.failed"
  | "notification.failed"
  | "domain.event";

export type SafeLogRecord = {
  kind: "log";
  level: "info" | "warn" | "error";
  event: SafeLogEvent;
  correlation: CorrelationContext;
  attributes: SafeLogAttributes;
};

export type SliMetricName =
  | "approval.lead_time_ms"
  | "approval.step_dwell_time_ms"
  | "approval.rejected_total"
  | "approval.expired_total"
  | "fga.check_latency_ms"
  | "fga.list_users_latency_ms"
  | "fga.error_total"
  | "workflow.retry_total"
  | "workflow.failure_total"
  | "action_executor.failure_total"
  | "outbox.backlog"
  | "outbox.failure_total";

export type MetricRecord = {
  kind: "metric";
  name: SliMetricName;
  value: number;
  unit: "count" | "milliseconds" | "items";
  correlation?: CorrelationContext;
  attributes?: SafeLogAttributes;
};

export type TelemetryRecord = SafeLogRecord | MetricRecord;

export interface TelemetrySink {
  emit(record: TelemetryRecord): void;
}

export function safeLogRecord(input: {
  level: SafeLogRecord["level"];
  event: SafeLogEvent;
  correlation: CorrelationContext;
  attributes?: SafeLogAttributes;
}): SafeLogRecord {
  return {
    kind: "log",
    level: input.level,
    event: input.event,
    correlation: input.correlation,
    attributes: input.attributes ?? {},
  };
}

export function metricRecord(input: Omit<MetricRecord, "kind">): MetricRecord {
  return { kind: "metric", ...input };
}

function timestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function safeActionEventLogRecord(
  record: ActionEventRecord,
  component: TelemetryComponent = "d1",
): SafeLogRecord {
  const event = record.event;
  const attributes: SafeLogAttributes = { eventType: event.type };

  if ("materializedStepId" in event) {
    attributes.materializedStepId = String(event.materializedStepId);
  }
  if ("stepKey" in event) attributes.stepKey = String(event.stepKey);
  if (event.type === "action.execution_failed") {
    attributes.errorCode = event.code;
    attributes.retriable = event.retriable;
  }
  if (event.type === "action.completed") attributes.result = event.result;

  return safeLogRecord({
    level:
      event.type === "action.execution_failed" ||
      event.type === "action.authorization_check_failed" ||
      event.type === "action.reauthorization_check_failed"
        ? "error"
        : event.type === "step.rejected" || event.type === "step.expired"
          ? "warn"
          : "info",
    event: "domain.event",
    correlation: actionCorrelation({
      organizationId: record.organizationId,
      actionRequestId: event.actionRequestId,
      component,
      operation: event.type,
    }),
    attributes,
  });
}

export function deriveApprovalSliMetrics(
  records: readonly ActionEventRecord[],
): MetricRecord[] {
  const metrics: MetricRecord[] = [];
  const receivedAt = new Map<string, number>();
  const stepActivatedAt = new Map<string, number>();

  for (const record of records) {
    const actionRequestId = String(record.event.actionRequestId);
    const occurredAt = timestamp(record.occurredAt);
    const correlation = actionCorrelation({
      organizationId: record.organizationId,
      actionRequestId: record.event.actionRequestId,
      component: "d1",
      operation: record.event.type,
    });

    if (record.event.type === "action.received" && occurredAt !== null) {
      receivedAt.set(actionRequestId, occurredAt);
    }

    if (record.event.type === "step.activated" && occurredAt !== null) {
      stepActivatedAt.set(
        `${actionRequestId}:${String(record.event.materializedStepId)}`,
        occurredAt,
      );
    }

    if (
      (record.event.type === "step.approved" ||
        record.event.type === "step.rejected" ||
        record.event.type === "step.expired") &&
      occurredAt !== null
    ) {
      const key = `${actionRequestId}:${String(record.event.materializedStepId)}`;
      const activatedAt = stepActivatedAt.get(key);
      if (activatedAt !== undefined && occurredAt >= activatedAt) {
        metrics.push(
          metricRecord({
            name: "approval.step_dwell_time_ms",
            value: occurredAt - activatedAt,
            unit: "milliseconds",
            correlation,
            attributes: {
              materializedStepId: String(record.event.materializedStepId),
              stepKey: String(record.event.stepKey),
            },
          }),
        );
      }
    }

    if (record.event.type === "step.rejected") {
      metrics.push(
        metricRecord({
          name: "approval.rejected_total",
          value: 1,
          unit: "count",
          correlation,
        }),
      );
    }
    if (record.event.type === "step.expired") {
      metrics.push(
        metricRecord({
          name: "approval.expired_total",
          value: 1,
          unit: "count",
          correlation,
        }),
      );
    }
    if (record.event.type === "action.execution_failed") {
      metrics.push(
        metricRecord({
          name: "action_executor.failure_total",
          value: 1,
          unit: "count",
          correlation,
          attributes: {
            errorCode: record.event.code,
            retriable: record.event.retriable,
          },
        }),
      );
    }

    if (record.event.type === "action.completed" && occurredAt !== null) {
      const startedAt = receivedAt.get(actionRequestId);
      if (startedAt !== undefined && occurredAt >= startedAt) {
        metrics.push(
          metricRecord({
            name: "approval.lead_time_ms",
            value: occurredAt - startedAt,
            unit: "milliseconds",
            correlation,
            attributes: { result: record.event.result },
          }),
        );
      }
    }
  }

  return metrics;
}

export class MemoryTelemetrySink implements TelemetrySink {
  readonly records: TelemetryRecord[] = [];

  emit(record: TelemetryRecord): void {
    this.records.push(record);
  }
}

/**
 * Production default for Workers: emits one JSON object per record.
 * Records are constructed from allow-listed correlation/attribute types only;
 * callers must never attach raw Action input, Decision comments, attachment
 * contents, credentials, or arbitrary Error objects.
 */
export class ConsoleTelemetrySink implements TelemetrySink {
  emit(record: TelemetryRecord): void {
    console.log(JSON.stringify(record));
  }
}
