import { Result } from "@praha/byethrow";

import {
  actionCorrelation,
  safeLogRecord,
  type ActionRequestId,
  type OrganizationId,
  type TelemetrySink,
} from "@app/approval-core";
import {
  listStuckActionRequestCandidates,
  type D1DatabaseLike,
  type D1OperatorSignalError,
} from "@app/approval-d1";

import type { WorkflowBindingControl, WorkflowInstanceStatus } from "./workflow-cancellation.ts";
import { actionWorkflowInstanceId } from "./workflow.ts";

// #109: D1だけでは判定できないalert signal（Workflow instanceの状態、Analytics Engineのmetric）。

/** Workflowがもう進めない状態。projectionが非終端のままなら滞留している。 */
const FINISHED_WORKFLOW_STATUSES: ReadonlySet<WorkflowInstanceStatus> = new Set([
  "complete",
  "errored",
  "terminated",
]);

export type StuckActionRequest = {
  actionRequestId: ActionRequestId;
  projectionStatus: "pending" | "approved";
  /** Workflow instanceの状態。取得できなければ`unavailable`（instanceが無い等）。 */
  workflowStatus: WorkflowInstanceStatus | "unavailable";
  updatedAt: string;
};

const workflowStatus = Result.fn({
  try: async (workflow: WorkflowBindingControl, instanceId: string) =>
    (await (await workflow.get(instanceId)).status()).status,
  catch: (error): Error => (error instanceof Error ? error : new Error(String(error))),
});

/**
 * 滞留したActionRequestを検出する（#109）。projectionがpending / approvedのまま
 * `stuckAfterMinutes`以上更新が無く結果も無いものを候補とし、Workflow instanceが
 * 終わっている（complete / errored / terminated）か存在しないものを滞留と判定する。
 * 承認待ちでWorkflowがwaitingのものは正常なので含めない。
 */
export async function detectStuckActionRequests(input: {
  db: D1DatabaseLike;
  workflow: WorkflowBindingControl;
  organizationId: OrganizationId;
  now: string;
  stuckAfterMinutes: number;
  telemetry: TelemetrySink;
  limit?: number;
}): Result.ResultAsync<StuckActionRequest[], D1OperatorSignalError> {
  const updatedBefore = new Date(
    Date.parse(input.now) - input.stuckAfterMinutes * 60_000,
  ).toISOString();
  const candidates = await listStuckActionRequestCandidates(input.db, {
    organizationId: input.organizationId,
    updatedBefore,
    limit: input.limit ?? 20,
  });
  if (Result.isFailure(candidates)) return candidates;

  const stuck: StuckActionRequest[] = [];
  for (const candidate of candidates.value) {
    const instanceId = await actionWorkflowInstanceId({
      organizationId: input.organizationId,
      actionRequestId: candidate.actionRequestId,
    });
    const status = await workflowStatus(input.workflow, instanceId);
    const resolved = Result.isSuccess(status) ? status.value : "unavailable";
    if (resolved !== "unavailable" && !FINISHED_WORKFLOW_STATUSES.has(resolved)) continue;
    stuck.push({ ...candidate, workflowStatus: resolved });
    input.telemetry.emit(
      safeLogRecord({
        level: "warn",
        event: "action.stuck",
        correlation: actionCorrelation({
          organizationId: input.organizationId,
          actionRequestId: candidate.actionRequestId,
          component: "workflow",
          operation: "operator.stuck_detection",
        }),
        attributes: {
          status: candidate.projectionStatus,
          errorCode: `workflow_${resolved}`,
        },
      }),
    );
  }
  return Result.succeed(stuck);
}

export type FgaAlertMetrics = { errorRate: number | null; checkP95Ms: number | null };

/** 組織ごとのFGA metric（cron 1回につき1回だけ読む）。 */
export type FgaAlertMetricsSource = {
  load(): Result.ResultAsync<Map<string, FgaAlertMetrics>, { code: string; message: string }>;
};

/** FGA metricを集計するwindow（分）。alertの継続時間とは別。 */
export const FGA_METRIC_WINDOW_MINUTES = 5;

const FGA_CALL_METRICS = [
  "fga.check_latency_ms",
  "fga.list_users_latency_ms",
  "fga.read_latency_ms",
  "fga.write_latency_ms",
];

type SqlRows = { data?: Record<string, unknown>[] };

const postSql = Result.fn({
  try: async (input: {
    fetch: typeof globalThis.fetch;
    accountId: string;
    apiToken: string;
    query: string;
  }): Promise<SqlRows> => {
    const response = await input.fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(input.accountId)}/analytics_engine/sql`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${input.apiToken}` },
        body: input.query,
      },
    );
    if (!response.ok) {
      return Promise.reject(new Error(`Analytics Engine SQL API: HTTP ${response.status}`));
    }
    return (await response.json()) as SqlRows;
  },
  catch: (error) => ({
    code: "fga_metrics_unavailable",
    message: error instanceof Error ? error.message : String(error),
  }),
});

function numberOf(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

/**
 * Workers Analytics Engine（#108のTELEMETRY_ANALYTICS dataset）をSQL APIで読み、組織ごとの
 * FGA error率とCheck p95を返す（#109）。API tokenには`Account Analytics: Read`だけを付ける。
 */
export function analyticsEngineFgaMetrics(input: {
  accountId: string;
  apiToken: string;
  dataset: string;
  fetch?: typeof globalThis.fetch;
}): FgaAlertMetricsSource | null {
  // datasetはSQLへ埋め込むため識別子だけを許す。
  if (!/^[A-Za-z0-9_]+$/.test(input.dataset)) return null;
  const fetchImplementation = input.fetch ?? globalThis.fetch.bind(globalThis);
  const window = `timestamp > NOW() - INTERVAL '${FGA_METRIC_WINDOW_MINUTES}' MINUTE`;
  const callList = FGA_CALL_METRICS.map((name) => `'${name}'`).join(", ");
  return {
    async load() {
      const rates = await postSql({
        fetch: fetchImplementation,
        accountId: input.accountId,
        apiToken: input.apiToken,
        query: `SELECT index1 AS organizationId,
                  sumIf(_sample_interval * double1, blob1 = 'fga.error_total') AS errors,
                  sumIf(_sample_interval, blob1 IN (${callList})) AS calls
                FROM ${input.dataset}
                WHERE ${window} AND blob1 IN ('fga.error_total', ${callList})
                GROUP BY organizationId
                FORMAT JSON`,
      });
      if (Result.isFailure(rates)) return rates;
      const latency = await postSql({
        fetch: fetchImplementation,
        accountId: input.accountId,
        apiToken: input.apiToken,
        query: `SELECT index1 AS organizationId,
                  quantileExactWeighted(0.95)(double1, _sample_interval) AS p95
                FROM ${input.dataset}
                WHERE ${window} AND blob1 = 'fga.check_latency_ms'
                GROUP BY organizationId
                FORMAT JSON`,
      });
      if (Result.isFailure(latency)) return latency;

      const metrics = new Map<string, FgaAlertMetrics>();
      for (const row of rates.value.data ?? []) {
        const errors = numberOf(row.errors) ?? 0;
        const calls = numberOf(row.calls) ?? 0;
        const denominator = Math.max(calls, errors);
        metrics.set(String(row.organizationId), {
          errorRate: denominator > 0 ? errors / denominator : null,
          checkP95Ms: null,
        });
      }
      for (const row of latency.value.data ?? []) {
        const organizationId = String(row.organizationId);
        metrics.set(organizationId, {
          errorRate: metrics.get(organizationId)?.errorRate ?? null,
          checkP95Ms: numberOf(row.p95),
        });
      }
      return Result.succeed(metrics);
    },
  };
}

export type FgaMetricsEnv = {
  /** Cloudflare account ID（非secret）。 */
  ANALYTICS_ENGINE_ACCOUNT_ID?: string;
  /** `Account Analytics: Read`だけを持つAPI token（secret）。 */
  ANALYTICS_ENGINE_API_TOKEN?: string;
  /** TELEMETRY_ANALYTICS bindingのdataset名。 */
  TELEMETRY_DATASET?: string;
};

/** envからFGA metric sourceを作る。どれかが未設定ならnull（FGA alertは評価しない）。 */
export function fgaAlertMetricsFromEnv(env: FgaMetricsEnv): FgaAlertMetricsSource | null {
  const accountId = env.ANALYTICS_ENGINE_ACCOUNT_ID?.trim();
  const apiToken = env.ANALYTICS_ENGINE_API_TOKEN?.trim();
  const dataset = env.TELEMETRY_DATASET?.trim();
  if (!accountId || !apiToken || !dataset) return null;
  return analyticsEngineFgaMetrics({ accountId, apiToken, dataset });
}
