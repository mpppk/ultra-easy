import {
  CompositeTelemetrySink,
  ConsoleTelemetrySink,
  type TelemetryRecord,
  type TelemetrySink,
} from "@app/approval-core";

/** Workers Analytics Engine datasetのうち、sinkが使う部分（テストで差し替えられる）。 */
export type AnalyticsEngineDatasetLike = {
  writeDataPoint(point: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void;
};

/**
 * Analytics Engineのdata point layout（#108）。SQL APIでは`blob1`...`blob8` / `double1`として
 * 参照する（docs/observability-analytics-engine.md）。順序を変える場合は過去のdata pointと
 * 互換が無くなるため、末尾に追加するだけにする。
 */
export const ANALYTICS_ENGINE_BLOBS = [
  "name",
  "component",
  "operation",
  "errorCode",
  "unit",
  "result",
  "actionRequestId",
  "level",
] as const;

type Blobs = Record<(typeof ANALYTICS_ENGINE_BLOBS)[number], string>;

/**
 * 1つのtelemetry recordを時系列のdata pointへ写像する。metricはそのまま、warn / errorのlogは
 * `log.<event>`の件数（value 1）として書く。infoのlog（domain event等）は件数が多く、
 * SLIはmetricとして別に出ているので書かない。indexはsampling keyとなるorganizationId。
 */
export function analyticsEngineDataPoint(
  record: TelemetryRecord,
): { indexes: string[]; blobs: string[]; doubles: number[] } | null {
  if (record.kind === "log" && record.level === "info") return null;
  const correlation = record.correlation;
  const attributes = record.attributes ?? {};
  const blobs: Blobs = {
    name: record.kind === "metric" ? record.name : `log.${record.event}`,
    component: correlation?.component ?? "",
    operation: correlation?.operation ?? "",
    errorCode: attributes.errorCode ?? "",
    unit: record.kind === "metric" ? record.unit : "count",
    result: attributes.result ?? attributes.status ?? "",
    actionRequestId: correlation?.actionRequestId ? String(correlation.actionRequestId) : "",
    level: record.kind === "log" ? record.level : "",
  };
  return {
    indexes: [correlation ? String(correlation.organizationId) : ""],
    blobs: ANALYTICS_ENGINE_BLOBS.map((key) => blobs[key]),
    doubles: [record.kind === "metric" ? record.value : 1],
  };
}

/** metricと警告以上のlogをWorkers Analytics Engineへ書くsink（#108）。 */
export class AnalyticsEngineTelemetrySink implements TelemetrySink {
  constructor(private readonly dataset: AnalyticsEngineDatasetLike) {}

  emit(record: TelemetryRecord): void {
    const point = analyticsEngineDataPoint(record);
    if (point) this.dataset.writeDataPoint(point);
  }
}

export type TelemetryEnv = {
  /** Workers Analytics Engine dataset binding。未設定ならconsoleだけへ出す。 */
  TELEMETRY_ANALYTICS?: AnalyticsEngineDatasetLike;
};

const sinks = new WeakMap<object, TelemetrySink>();

/**
 * envのbindingから本番のTelemetrySinkを組み立てる（#108）。console（Workers Logs）には常に出し、
 * Analytics Engine bindingがあれば時系列storeにも書く。isolate内ではenvごとに1つを使い回す。
 */
export function telemetrySinkFromEnv(env: TelemetryEnv): TelemetrySink {
  const cached = sinks.get(env);
  if (cached) return cached;
  const console = new ConsoleTelemetrySink();
  const sink = env.TELEMETRY_ANALYTICS
    ? new CompositeTelemetrySink([
        console,
        new AnalyticsEngineTelemetrySink(env.TELEMETRY_ANALYTICS),
      ])
    : console;
  sinks.set(env, sink);
  return sink;
}
