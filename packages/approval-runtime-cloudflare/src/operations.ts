import { Result } from "@praha/byethrow";
import { brandLiteral } from "@app/approval-core";

import {
  DEFAULT_OPERATOR_ALERT_THRESHOLDS,
  evaluateOperatorAlerts,
  safeLogRecord,
  systemCorrelation,
  type NotificationSink,
  type OperatorAlertThresholds,
  type OrganizationId,
  type PersistedOperatorAlertState,
  type TelemetryComponent,
  type TelemetrySink,
} from "@app/approval-core";
import {
  D1NotificationOutboxRepository,
  D1OperatorAlertStateRepository,
  listRecentOrganizations,
  loadOperatorDashboard,
  purgeExpiredOperationalData,
  type D1DatabaseLike,
  type D1OperatorAlertStateRepositoryError,
  type D1OperatorDashboardError,
  type OperatorDashboardSnapshot,
} from "@app/approval-d1";

import { emitNotificationSkipped } from "./slack.ts";
import {
  consumeNotificationMessage,
  dispatchNotificationOutbox,
  reconcileDeadLetterNotification,
  type NotificationQueueMessage,
  type NotificationQueueProducer,
} from "./notifications.ts";

// approval-api（staging / production）とapproval-runtime（preview）で共有する運用処理（#105）。
// appsは設定（sink、alert通知、追加のcron task）の注入だけを行い、ロジックを複製しない。

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
export function readOperatorAlertThresholds(env: {
  OPERATOR_ALERT_OUTBOX_BACKLOG?: string;
  OPERATOR_ALERT_OUTBOX_BACKLOG_MINUTES?: string;
  OPERATOR_ALERT_FAILURE_TREND_MINUTES?: string;
  OPERATOR_ALERT_DWELL_P95_SLA_MS?: string;
}): OperatorAlertThresholds {
  const dwellRaw = env.OPERATOR_ALERT_DWELL_P95_SLA_MS;
  const dwellParsed = dwellRaw === undefined ? null : Number(dwellRaw);
  return {
    outboxBacklogLimit: positiveNumber(
      env.OPERATOR_ALERT_OUTBOX_BACKLOG,
      DEFAULT_OPERATOR_ALERT_THRESHOLDS.outboxBacklogLimit,
    ),
    outboxBacklogMinutes: positiveNumber(
      env.OPERATOR_ALERT_OUTBOX_BACKLOG_MINUTES,
      DEFAULT_OPERATOR_ALERT_THRESHOLDS.outboxBacklogMinutes,
    ),
    failureTrendMinutes: positiveNumber(
      env.OPERATOR_ALERT_FAILURE_TREND_MINUTES,
      DEFAULT_OPERATOR_ALERT_THRESHOLDS.failureTrendMinutes,
    ),
    dwellP95SlaMs:
      dwellParsed !== null && Number.isFinite(dwellParsed) && dwellParsed > 0 ? dwellParsed : null,
  };
}

export type OperatorDashboardView = OperatorDashboardSnapshot & {
  alerts: PersistedOperatorAlertState[];
  thresholds: OperatorAlertThresholds;
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
  return Result.succeed({ ...snapshot.value, alerts: alerts.value, thresholds: input.thresholds });
}

const ALERT_COMPONENT: Record<PersistedOperatorAlertState["key"], TelemetryComponent> = {
  outbox_backlog: "outbox",
  outbox_failures_increasing: "outbox",
  executor_failures_increasing: "executor",
  approval_dwell_p95: "d1",
};

export type OperatorAlertTransition = {
  organizationId: OrganizationId;
  key: PersistedOperatorAlertState["key"];
  from: string;
  to: string;
};

export async function evaluateOrganizationAlerts(input: {
  db: D1DatabaseLike;
  organizationId: OrganizationId;
  thresholds: OperatorAlertThresholds;
  now: string;
  telemetry: TelemetrySink;
  /** firing / resolvedへの遷移ごとに呼ぶ（Slack通知等）。 */
  onTransition?: (transition: OperatorAlertTransition) => Promise<void>;
}): Result.ResultAsync<
  PersistedOperatorAlertState[],
  D1OperatorDashboardError | D1OperatorAlertStateRepositoryError
> {
  const repository = new D1OperatorAlertStateRepository(input.db);
  const snapshot = await loadOperatorDashboard(input.db, { organizationId: input.organizationId });
  if (Result.isFailure(snapshot)) return snapshot;
  const previous = await repository.loadAll({ organizationId: input.organizationId });
  if (Result.isFailure(previous)) return previous;

  const dwellSamples = Object.values(snapshot.value.sli.dwellByStepKey);
  const evaluated = evaluateOperatorAlerts({
    thresholds: input.thresholds,
    previous: previous.value,
    values: {
      outboxBacklog: snapshot.value.outbox.backlog,
      outboxFailedTotal:
        snapshot.value.outbox.failedOutbox +
        snapshot.value.outbox.deadOutbox +
        snapshot.value.outbox.failedDeliveries,
      executorFailureTotal: Object.values(snapshot.value.sli.executorFailuresByCode).reduce(
        (total, count) => total + count,
        0,
      ),
      dwellP95Ms:
        dwellSamples.length === 0
          ? null
          : Math.max(...dwellSamples.map((sample) => sample.p95Ms ?? 0)),
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
          actionRequestId: brandLiteral("ActionRequestId", "action:operator-alert"),
          correlationId: `operator-alert:${String(input.organizationId)}:${transition.key}`,
          component: ALERT_COMPONENT[transition.key],
          operation: "operator.alert",
        },
        attributes: { alertKey: transition.key, status: transition.to },
      }),
    );
    await input.onTransition?.({ organizationId: input.organizationId, ...transition });
  }
  return Result.succeed(evaluated.states);
}

/**
 * 直近のorganizationごとにalertを評価する。1 orgの失敗で他のorgの評価を止めず、
 * 失敗したorg数をerrorで返す。
 */
export async function evaluateRecentOrganizationAlerts(input: {
  db: D1DatabaseLike;
  thresholds: OperatorAlertThresholds;
  now: string;
  telemetry: TelemetrySink;
  organizationLimit?: number;
  onTransition?: (transition: OperatorAlertTransition) => Promise<void>;
}): Result.ResultAsync<
  { organizationId: OrganizationId; states: PersistedOperatorAlertState[] }[],
  D1OperatorDashboardError | D1OperatorAlertStateRepositoryError
> {
  const organizations = await listRecentOrganizations(input.db, input.organizationLimit ?? 50);
  if (Result.isFailure(organizations)) return organizations;
  const results: { organizationId: OrganizationId; states: PersistedOperatorAlertState[] }[] = [];
  let firstFailure: D1OperatorDashboardError | D1OperatorAlertStateRepositoryError | undefined;
  for (const organizationId of organizations.value) {
    const evaluated = await evaluateOrganizationAlerts({ ...input, organizationId });
    if (Result.isFailure(evaluated)) {
      firstFailure ??= evaluated.error;
      continue;
    }
    results.push({ organizationId, states: evaluated.value });
  }
  return firstFailure ? Result.fail(firstFailure) : Result.succeed(results);
}

/** cronで実行する独立した処理単位。1つの失敗で後続を止めない。 */
export type ScheduledTask = {
  name: string;
  /** 成功値は処理件数等の要約（ログには出さない）。 */
  run(now: string): Result.ResultAsync<object | number, { code: string }>;
};

export async function runScheduledTasks(input: {
  tasks: readonly ScheduledTask[];
  now: string;
  telemetry: TelemetrySink;
}): Promise<void> {
  const outcomes = await Promise.allSettled(input.tasks.map((task) => task.run(input.now)));
  outcomes.forEach((outcome, index) => {
    const task = input.tasks[index]!;
    const errorCode =
      outcome.status === "rejected"
        ? "scheduled_task_crashed"
        : Result.isFailure(outcome.value)
          ? outcome.value.error.code
          : undefined;
    if (errorCode === undefined) return;
    const correlation = systemCorrelation({ component: "d1", operation: `scheduled.${task.name}` });
    input.telemetry.emit(
      safeLogRecord({
        level: "error",
        event: "scheduled.task_failed",
        correlation,
        attributes: { errorCode },
      }),
    );
  });
}

/** 通知outboxのdispatchとalert評価（両appに共通のcron task）。 */
export function notificationScheduledTasks(input: {
  db: D1DatabaseLike;
  queue: NotificationQueueProducer;
  telemetry: TelemetrySink;
  /** sinkが設定済みなら、未設定時にskipした通知を再送対象へ戻す。 */
  sinkConfigured: boolean;
}): ScheduledTask[] {
  const repository = new D1NotificationOutboxRepository(input.db);
  return [
    {
      name: "dispatch_notification_outbox",
      run: (now) =>
        dispatchNotificationOutbox({
          repository,
          queue: input.queue,
          now,
          telemetry: input.telemetry,
        }),
    },
    ...(input.sinkConfigured
      ? [
          {
            name: "requeue_skipped_notifications",
            run: () => repository.requeueSkipped(),
          },
        ]
      : []),
  ];
}

/** 保持期間を過ぎた運用データの削除（#99）。両appのcronに含める。 */
export function retentionScheduledTask(db: D1DatabaseLike): ScheduledTask {
  return {
    name: "purge_expired_operational_data",
    run: (now) => purgeExpiredOperationalData(db, { now }),
  };
}

export type NotificationQueueBatch = {
  queue: string;
  messages: readonly {
    body: NotificationQueueMessage;
    attempts: number;
    ack(): void;
    retry(options?: { delaySeconds?: number }): void;
  }[];
};

function retryDelaySeconds(attempts: number): number {
  return Math.min(10 * 2 ** Math.max(0, attempts - 1), 600);
}

/**
 * 通知queue（とそのDLQ）のconsumer（#94）。
 * - retriableな失敗だけbackoff付きでretryする。非retriable（correlation不一致、4xx等）は
 *   deliveryをfailedに記録してackし、無駄に再試行してDLQへ送らない。
 * - sinkがskipした配信はskippedとして記録し、`notification.skipped_total`を出す。
 * - DLQのmessageはoutboxをdeadにしてalertの対象にする。
 */
export async function handleNotificationQueueBatch(input: {
  batch: NotificationQueueBatch;
  db: D1DatabaseLike;
  sink: NotificationSink;
  telemetry: TelemetrySink;
  now: () => string;
}): Promise<void> {
  const repository = new D1NotificationOutboxRepository(input.db);
  const deadLetter = input.batch.queue.endsWith("-dlq");
  for (const message of input.batch.messages) {
    if (deadLetter) {
      const reconciled = await reconcileDeadLetterNotification({
        repository,
        message: message.body,
        telemetry: input.telemetry,
      });
      if (Result.isFailure(reconciled) && reconciled.error.retriable) {
        message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      } else {
        message.ack();
      }
      continue;
    }

    const consumed = await consumeNotificationMessage({
      repository,
      sink: input.sink,
      message: message.body,
      now: input.now(),
      telemetry: input.telemetry,
    });
    if (Result.isFailure(consumed)) {
      if (consumed.error.retriable) {
        message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      } else {
        message.ack();
      }
      continue;
    }
    if (consumed.value.skipped > 0) emitNotificationSkipped(input.telemetry, message.body);
    message.ack();
  }
}
