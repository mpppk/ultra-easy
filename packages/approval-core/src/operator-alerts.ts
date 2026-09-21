export type OperatorAlertKey =
  | "outbox_backlog"
  | "outbox_failures_increasing"
  | "executor_failures_increasing"
  | "approval_dwell_p95";

export type OperatorAlertStatus = "ok" | "breaching" | "firing";

export type OperatorAlertThresholds = {
  outboxBacklogLimit: number;
  outboxBacklogMinutes: number;
  failureTrendMinutes: number;
  /** nullのときdwellアラートは無効。テナントSLAが文書化されるまでのつなぎ。 */
  dwellP95SlaMs: number | null;
};

export const DEFAULT_OPERATOR_ALERT_THRESHOLDS: OperatorAlertThresholds = {
  outboxBacklogLimit: 100,
  outboxBacklogMinutes: 10,
  failureTrendMinutes: 5,
  dwellP95SlaMs: null,
};

export type OperatorAlertInput = {
  outboxBacklog: number;
  outboxFailedTotal: number;
  executorFailureTotal: number;
  dwellP95Ms: number | null;
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
