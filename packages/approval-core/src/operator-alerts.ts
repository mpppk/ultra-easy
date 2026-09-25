export type OperatorAlertKey =
  | "outbox_backlog"
  | "outbox_failures_increasing"
  | "executor_failures_increasing"
  | "approval_dwell_p95"
  /** #109: Workflowの異常終了（workflow.failed event）が直近windowにある。 */
  | "workflow_failures"
  /** #109: OpenFGAのerror率（Analytics Engine metric）。 */
  | "fga_error_rate"
  /** #109: OpenFGA Checkのp95 latency（Analytics Engine metric）。 */
  | "fga_latency_p95"
  /** #109: projectionが非終端なのにWorkflowが終わっている等、進まないActionRequest。 */
  | "stuck_action_requests";

export const OPERATOR_ALERT_KEYS: readonly OperatorAlertKey[] = [
  "outbox_backlog",
  "outbox_failures_increasing",
  "executor_failures_increasing",
  "approval_dwell_p95",
  "workflow_failures",
  "fga_error_rate",
  "fga_latency_p95",
  "stuck_action_requests",
];

/** alertから誘導するrunbook（Slack通知・dashboardに出す）。 */
export const OPERATOR_ALERT_RUNBOOKS: Record<OperatorAlertKey, string> = {
  outbox_backlog: "docs/runbooks/dependency-outage.md",
  outbox_failures_increasing: "docs/runbooks/dependency-outage.md",
  executor_failures_increasing: "docs/runbooks/dependency-outage.md",
  approval_dwell_p95: "docs/runbooks/operator-dashboard.md",
  workflow_failures: "docs/runbooks/stuck-action-request.md",
  fga_error_rate: "docs/runbooks/dependency-outage.md",
  fga_latency_p95: "docs/runbooks/dependency-outage.md",
  stuck_action_requests: "docs/runbooks/stuck-action-request.md",
};

export type OperatorAlertStatus = "ok" | "breaching" | "firing";

export type OperatorAlertThresholds = {
  outboxBacklogLimit: number;
  outboxBacklogMinutes: number;
  failureTrendMinutes: number;
  /** nullのときdwellアラートは無効。テナントSLAが文書化されるまでのつなぎ。 */
  dwellP95SlaMs: number | null;
  /** workflow.failedを数える直近window（分）。1件でもあれば即firing。 */
  workflowFailureWindowMinutes: number;
  /** FGA error率の上限（0.01 = 1%）と、継続時間（分）。 */
  fgaErrorRateLimit: number;
  fgaErrorMinutes: number;
  /** FGA Check p95の上限（ms）と、継続時間（分）。 */
  fgaLatencyP95Ms: number;
  fgaLatencyMinutes: number;
  /** この時間（分）以上更新の無い非終端ActionRequestを滞留候補として照合する。 */
  stuckAfterMinutes: number;
};

export const DEFAULT_OPERATOR_ALERT_THRESHOLDS: OperatorAlertThresholds = {
  outboxBacklogLimit: 100,
  outboxBacklogMinutes: 10,
  failureTrendMinutes: 5,
  dwellP95SlaMs: null,
  workflowFailureWindowMinutes: 5,
  fgaErrorRateLimit: 0.01,
  fgaErrorMinutes: 5,
  fgaLatencyP95Ms: 1_000,
  fgaLatencyMinutes: 10,
  stuckAfterMinutes: 15,
};

export type OperatorAlertInput = {
  outboxBacklog: number;
  outboxFailedTotal: number;
  executorFailureTotal: number;
  dwellP95Ms: number | null;
  /** 直近windowのworkflow.failed件数。undefinedは未評価（ok扱い）。 */
  workflowFailuresInWindow?: number;
  /** Analytics Engine由来。null / undefinedはmetric sourceが未設定・取得不可（ok扱い）。 */
  fgaErrorRate?: number | null;
  fgaCheckP95Ms?: number | null;
  /** 滞留と判定したActionRequest数。 */
  stuckActionRequests?: number;
};

export type PersistedOperatorAlertState = {
  key: OperatorAlertKey;
  status: OperatorAlertStatus;
  breachedSince: string | null;
  lastOutboxFailedTotal: number | null;
  lastExecutorFailureTotal: number | null;
  updatedAt: string;
};

export type OperatorAlertTransition = {
  key: OperatorAlertKey;
  from: OperatorAlertStatus;
  to: OperatorAlertStatus;
};

function minutesBetween(from: string, to: string): number | null {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return (end - start) / 60_000;
}

function nextStatus(input: {
  breached: boolean;
  previous: PersistedOperatorAlertState;
  requiredMinutes: number;
  now: string;
}): { status: OperatorAlertStatus; breachedSince: string | null } {
  const { breached, previous, requiredMinutes, now } = input;
  if (!breached) return { status: "ok", breachedSince: null };
  const breachedSince = previous.breachedSince ?? now;
  if (previous.status === "firing") return { status: "firing", breachedSince };
  const elapsed = minutesBetween(breachedSince, now);
  if (elapsed !== null && elapsed >= requiredMinutes) {
    return { status: "firing", breachedSince };
  }
  return { status: "breaching", breachedSince };
}

/**
 * アラート閾値評価のpure関数。cron評価とdashboard表示で同じ判定を使う。
 * 増加系は前回観測値との比較でsustained increaseを判定する。
 */
export function evaluateOperatorAlerts(input: {
  thresholds: OperatorAlertThresholds;
  previous: readonly PersistedOperatorAlertState[];
  values: OperatorAlertInput;
  now: string;
}): { states: PersistedOperatorAlertState[]; transitions: OperatorAlertTransition[] } {
  const previousByKey = new Map<OperatorAlertKey, PersistedOperatorAlertState>();
  for (const state of input.previous) previousByKey.set(state.key, state);
  const fallback = (key: OperatorAlertKey): PersistedOperatorAlertState => ({
    key,
    status: "ok",
    breachedSince: null,
    lastOutboxFailedTotal: null,
    lastExecutorFailureTotal: null,
    updatedAt: input.now,
  });
  const lastOutboxFailed = previousByKey.get("outbox_failures_increasing")?.lastOutboxFailedTotal;
  const lastExecutorFailed = previousByKey.get(
    "executor_failures_increasing",
  )?.lastExecutorFailureTotal;

  const specs: Array<{
    key: OperatorAlertKey;
    breached: boolean;
    requiredMinutes: number;
    lastOutboxFailedTotal?: number;
    lastExecutorFailureTotal?: number;
  }> = [
    {
      key: "outbox_backlog",
      breached: input.values.outboxBacklog > input.thresholds.outboxBacklogLimit,
      requiredMinutes: input.thresholds.outboxBacklogMinutes,
    },
    {
      key: "outbox_failures_increasing",
      breached:
        lastOutboxFailed !== null &&
        lastOutboxFailed !== undefined &&
        input.values.outboxFailedTotal > lastOutboxFailed,
      requiredMinutes: input.thresholds.failureTrendMinutes,
      lastOutboxFailedTotal: input.values.outboxFailedTotal,
    },
    {
      key: "executor_failures_increasing",
      breached:
        lastExecutorFailed !== null &&
        lastExecutorFailed !== undefined &&
        input.values.executorFailureTotal > lastExecutorFailed,
      requiredMinutes: input.thresholds.failureTrendMinutes,
      lastExecutorFailureTotal: input.values.executorFailureTotal,
    },
    {
      key: "approval_dwell_p95",
      breached:
        input.thresholds.dwellP95SlaMs !== null &&
        input.values.dwellP95Ms !== null &&
        input.values.dwellP95Ms > input.thresholds.dwellP95SlaMs,
      requiredMinutes: input.thresholds.failureTrendMinutes,
    },
    {
      key: "workflow_failures",
      breached: (input.values.workflowFailuresInWindow ?? 0) > 0,
      requiredMinutes: 0,
    },
    {
      key: "fga_error_rate",
      breached:
        input.values.fgaErrorRate !== undefined &&
        input.values.fgaErrorRate !== null &&
        input.values.fgaErrorRate > input.thresholds.fgaErrorRateLimit,
      requiredMinutes: input.thresholds.fgaErrorMinutes,
    },
    {
      key: "fga_latency_p95",
      breached:
        input.values.fgaCheckP95Ms !== undefined &&
        input.values.fgaCheckP95Ms !== null &&
        input.values.fgaCheckP95Ms > input.thresholds.fgaLatencyP95Ms,
      requiredMinutes: input.thresholds.fgaLatencyMinutes,
    },
    {
      key: "stuck_action_requests",
      breached: (input.values.stuckActionRequests ?? 0) > 0,
      requiredMinutes: 0,
    },
  ];

  const states: PersistedOperatorAlertState[] = [];
  const transitions: OperatorAlertTransition[] = [];
  for (const spec of specs) {
    const previous = previousByKey.get(spec.key) ?? fallback(spec.key);
    const next = nextStatus({
      breached: spec.breached,
      previous,
      requiredMinutes: spec.requiredMinutes,
      now: input.now,
    });
    const state: PersistedOperatorAlertState = {
      key: spec.key,
      status: next.status,
      breachedSince: next.breachedSince,
      lastOutboxFailedTotal: spec.lastOutboxFailedTotal ?? previous.lastOutboxFailedTotal,
      lastExecutorFailureTotal: spec.lastExecutorFailureTotal ?? previous.lastExecutorFailureTotal,
      updatedAt: input.now,
    };
    states.push(state);
    if (state.status !== previous.status) {
      transitions.push({ key: spec.key, from: previous.status, to: state.status });
    }
  }
  return { states, transitions };
}
