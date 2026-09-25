import { describe, expect, it } from "vite-plus/test";

import {
  actionCorrelation,
  CompositeTelemetrySink,
  MemoryTelemetrySink,
  metricRecord,
  safeLogRecord,
  type ActionRequestId,
  type OrganizationId,
} from "@app/approval-core";

import {
  ANALYTICS_ENGINE_BLOBS,
  AnalyticsEngineTelemetrySink,
  telemetrySinkFromEnv,
  type AnalyticsEngineDatasetLike,
} from "./analytics-engine-telemetry.ts";

const correlation = actionCorrelation({
  organizationId: "organization:ae" as OrganizationId,
  actionRequestId: "action:ae" as ActionRequestId,
  component: "fga",
  operation: "check",
});

function dataset() {
  const points: Parameters<AnalyticsEngineDatasetLike["writeDataPoint"]>[0][] = [];
  return { points, writeDataPoint: (point: (typeof points)[number]) => points.push(point) };
}

function blob(point: { blobs?: string[] }, name: (typeof ANALYTICS_ENGINE_BLOBS)[number]) {
  return point.blobs?.[ANALYTICS_ENGINE_BLOBS.indexOf(name)];
}

describe("#108 AnalyticsEngineTelemetrySink", () => {
  it("metricをorganization index・metric名・次元・値のdata pointとして書く", () => {
    const target = dataset();
    new AnalyticsEngineTelemetrySink(target).emit(
      metricRecord({
        name: "fga.check_latency_ms",
        value: 42,
        unit: "milliseconds",
        correlation,
        attributes: { errorCode: "fga_timeout", result: "error" },
      }),
    );
    expect(target.points).toHaveLength(1);
    const point = target.points[0]!;
    expect(point.indexes).toEqual(["organization:ae"]);
    expect(point.doubles).toEqual([42]);
    expect(blob(point, "name")).toBe("fga.check_latency_ms");
    expect(blob(point, "component")).toBe("fga");
    expect(blob(point, "operation")).toBe("check");
    expect(blob(point, "errorCode")).toBe("fga_timeout");
    expect(blob(point, "unit")).toBe("milliseconds");
    expect(blob(point, "result")).toBe("error");
    expect(blob(point, "actionRequestId")).toBe("action:ae");
  });

  it("warn / errorのlogは件数として書き、infoのlogは書かない", () => {
    const target = dataset();
    const sink = new AnalyticsEngineTelemetrySink(target);
    sink.emit(safeLogRecord({ level: "info", event: "domain.event", correlation }));
    sink.emit(
      safeLogRecord({
        level: "error",
        event: "workflow.failed",
        correlation,
        attributes: { errorCode: "approval_plan_not_found" },
      }),
    );
    expect(target.points).toHaveLength(1);
    expect(blob(target.points[0]!, "name")).toBe("log.workflow.failed");
    expect(blob(target.points[0]!, "level")).toBe("error");
    expect(target.points[0]!.doubles).toEqual([1]);
  });

  it("sinkの失敗は他のsinkへ波及しない", () => {
    const memory = new MemoryTelemetrySink();
    const errors: unknown[] = [];
    const composite = new CompositeTelemetrySink(
      [
        // bindingの同期例外（JSON.parseで例外を発生させる）
        new AnalyticsEngineTelemetrySink({ writeDataPoint: () => void JSON.parse("{") }),
        memory,
      ],
      (error) => errors.push(error),
    );
    composite.emit(metricRecord({ name: "workflow.retry_total", value: 1, unit: "count" }));
    expect(memory.records).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it("bindingがあればconsoleとAnalytics Engineの両方へ出し、envごとにmemo化する", () => {
    const target = dataset();
    const env = { TELEMETRY_ANALYTICS: target };
    const sink = telemetrySinkFromEnv(env);
    expect(telemetrySinkFromEnv(env)).toBe(sink);
    expect(sink).toBeInstanceOf(CompositeTelemetrySink);
    sink.emit(metricRecord({ name: "outbox.backlog", value: 3, unit: "items" }));
    expect(target.points).toHaveLength(1);
    expect(telemetrySinkFromEnv({})).not.toBeInstanceOf(CompositeTelemetrySink);
  });
});
