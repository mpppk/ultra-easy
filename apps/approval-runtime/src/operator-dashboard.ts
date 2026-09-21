import { Result } from "@praha/byethrow";

import {
  DEFAULT_OPERATOR_ALERT_THRESHOLDS,
  evaluateOperatorAlerts,
  safeLogRecord,
  type ActionRequestId,
  type OperatorAlertThresholds,
  type OrganizationId,
  type PersistedOperatorAlertState,
  type TelemetryComponent,
  type TelemetrySink,
} from "@app/approval-core";
import {
  D1OperatorAlertStateRepository,
  listRecentOrganizations,
  loadOperatorDashboard,
  type D1DatabaseLike,
  type D1OperatorAlertStateRepositoryError,
  type D1OperatorDashboardError,
  type OperatorDashboardSnapshot,
} from "@app/approval-d1";

export type OperatorDashboardView = OperatorDashboardSnapshot & {
  alerts: PersistedOperatorAlertState[];
  thresholds: OperatorAlertThresholds;
};

function positiveNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Deployment-configurableなalert閾値。未設定・不正値はspec baselineへfallbackする。
 * 仕様: docs/observability.md の Minimum alerts。
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

const ALERT_COMPONENT: Record<PersistedOperatorAlertState["key"], TelemetryComponent> = {
  outbox_backlog: "outbox",
  outbox_failures_increasing: "outbox",
  executor_failures_increasing: "executor",
  approval_dwell_p95: "d1",
};

export async function loadOperatorDashboardView(
  db: D1DatabaseLike,
  input: { organizationId: OrganizationId; thresholds: OperatorAlertThresholds },
): Result.ResultAsync<
  OperatorDashboardView,
  D1OperatorDashboardError | D1OperatorAlertStateRepositoryError
> {
  const snapshot = await loadOperatorDashboard(db, { organizationId: input.organizationId });
  if (Result.isFailure(snapshot)) return snapshot;
  const alerts = await new D1OperatorAlertStateRepository(db).loadAll({
    organizationId: input.organizationId,
  });
  if (Result.isFailure(alerts)) return alerts;
  return Result.succeed({
    ...snapshot.value,
    alerts: alerts.value,
    thresholds: input.thresholds,
  });
}

export async function evaluateOrganizationAlerts(input: {
  db: D1DatabaseLike;
  organizationId: OrganizationId;
  thresholds: OperatorAlertThresholds;
  now: string;
  telemetry: TelemetrySink;
}): Result.ResultAsync<
  PersistedOperatorAlertState[],
  D1OperatorDashboardError | D1OperatorAlertStateRepositoryError
> {
  const repository = new D1OperatorAlertStateRepository(input.db);
  const snapshot = await loadOperatorDashboard(input.db, {
    organizationId: input.organizationId,
  });
  if (Result.isFailure(snapshot)) return snapshot;
  const previous = await repository.loadAll({ organizationId: input.organizationId });
  if (Result.isFailure(previous)) return previous;

  const dwellSamples = Object.values(snapshot.value.sli.dwellByStepKey);
  const dwellP95Ms =
    dwellSamples.length === 0 ? null : Math.max(...dwellSamples.map((sample) => sample.p95Ms ?? 0));
  const evaluated = evaluateOperatorAlerts({
    thresholds: input.thresholds,
    previous: previous.value,
    values: {
      outboxBacklog: snapshot.value.outbox.backlog,
      outboxFailedTotal:
        snapshot.value.outbox.failedOutbox + snapshot.value.outbox.failedDeliveries,
      executorFailureTotal: Object.values(snapshot.value.sli.executorFailuresByCode).reduce(
        (total, count) => total + count,
        0,
      ),
      dwellP95Ms,
    },
    now: input.now,
  });

  for (const state of evaluated.states) {
    const saved = await repository.save({ organizationId: input.organizationId, ...state });
    if (Result.isFailure(saved)) return saved;
  }
  for (const transition of evaluated.transitions) {
    const firing = transition.to === "firing";
    input.telemetry.emit(
      safeLogRecord({
        level: firing ? "warn" : "info",
        event: firing ? "alert.firing" : "alert.resolved",
        correlation: {
          organizationId: input.organizationId,
          actionRequestId: "action:operator-alert" as ActionRequestId,
          correlationId: `operator-alert:${String(input.organizationId)}:${transition.key}`,
          component: ALERT_COMPONENT[transition.key],
          operation: "operator.alert",
        },
        attributes: { alertKey: transition.key, status: transition.to },
      }),
    );
  }
  return Result.succeed(evaluated.states);
}

export async function evaluateRecentOrganizationAlerts(input: {
  db: D1DatabaseLike;
  thresholds: OperatorAlertThresholds;
  now: string;
  telemetry: TelemetrySink;
  organizationLimit?: number;
}): Result.ResultAsync<
  { organizationId: OrganizationId; states: PersistedOperatorAlertState[] }[],
  D1OperatorDashboardError | D1OperatorAlertStateRepositoryError
> {
  const organizations = await listRecentOrganizations(input.db, input.organizationLimit ?? 50);
  if (Result.isFailure(organizations)) return organizations;
  const results: { organizationId: OrganizationId; states: PersistedOperatorAlertState[] }[] = [];
  for (const organizationId of organizations.value) {
    const evaluated = await evaluateOrganizationAlerts({
      db: input.db,
      organizationId,
      thresholds: input.thresholds,
      now: input.now,
      telemetry: input.telemetry,
    });
    if (Result.isFailure(evaluated)) return evaluated;
    results.push({ organizationId, states: evaluated.value });
  }
  return Result.succeed(results);
}
