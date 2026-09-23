import {
  DEFAULT_OPERATOR_ALERT_THRESHOLDS,
  type OperatorAlertThresholds,
} from "@app/approval-core";

function positiveNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Deployment-configurableなalert閾値。未設定・不正値はspec baselineへfallbackする。
 * 仕様: docs/runbooks/operator-dashboard.md の Overrides (Worker env vars)。
 * staging drillでは `--var OPERATOR_ALERT_OUTBOX_BACKLOG:1` 等で一時的に上書きする。
 */
export function readOperatorAlertThresholds(
  env: Record<string, string | undefined>,
): OperatorAlertThresholds {
  const dwellRaw = env["OPERATOR_ALERT_DWELL_P95_SLA_MS"];
  const dwellParsed = dwellRaw === undefined ? null : Number(dwellRaw);
  return {
    outboxBacklogLimit: positiveNumber(
      env["OPERATOR_ALERT_OUTBOX_BACKLOG"],
      DEFAULT_OPERATOR_ALERT_THRESHOLDS.outboxBacklogLimit,
    ),
    outboxBacklogMinutes: positiveNumber(
      env["OPERATOR_ALERT_OUTBOX_BACKLOG_MINUTES"],
      DEFAULT_OPERATOR_ALERT_THRESHOLDS.outboxBacklogMinutes,
    ),
    failureTrendMinutes: positiveNumber(
      env["OPERATOR_ALERT_FAILURE_TREND_MINUTES"],
      DEFAULT_OPERATOR_ALERT_THRESHOLDS.failureTrendMinutes,
    ),
    dwellP95SlaMs:
      dwellParsed !== null && Number.isFinite(dwellParsed) && dwellParsed > 0 ? dwellParsed : null,
  };
}
