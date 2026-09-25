import { Result } from "@praha/byethrow";

import type { D1DatabaseLike, D1PreparedStatementLike } from "./materialized-plan-repository.ts";

/**
 * 運用テーブルの保持期間（#99、docs/data-retention.md）。監査（action_events /
 * force_cancel_audit / authorization_relationship_events）はappend-onlyで削除しない。
 */
export type OperationalRetentionPolicy = {
  /** rate limitの窓が閉じてからの猶予。 */
  rateLimitCounterGraceMs: number;
  /** completedのIdempotency-Key（再生用応答）の保持。 */
  idempotencyKeyMs: number;
  /** lease切れのまま放置されたpending予約の保持。 */
  staleIdempotencyReservationMs: number;
  /** 終端（applied / rejected / failed）したDecision commandの保持。 */
  terminalApprovalCommandMs: number;
  /** dispatched / skippedのoutboxと、sent / skippedのdeliveryの保持。 */
  deliveredNotificationMs: number;
  /** dead / failedのoutboxと、failedのdeliveryの保持（調査用に長め）。 */
  failedNotificationMs: number;
  /** 1回の実行で1テーブルから削除する上限（D1のCPU / query上限を超えない）。 */
  batchSize: number;
};

const DAY = 24 * 60 * 60 * 1000;

export const DEFAULT_OPERATIONAL_RETENTION_POLICY: OperationalRetentionPolicy = {
  rateLimitCounterGraceMs: 60 * 60 * 1000,
  idempotencyKeyMs: 7 * DAY,
  staleIdempotencyReservationMs: DAY,
  terminalApprovalCommandMs: 90 * DAY,
  deliveredNotificationMs: 30 * DAY,
  failedNotificationMs: 90 * DAY,
  batchSize: 1000,
};

export type RetentionPurgeResult = Record<
  | "rateLimitCounters"
  | "idempotencyKeys"
  | "approvalCommands"
  | "notificationDeliveries"
  | "outboxEvents",
  number
>;

export class D1RetentionError extends Error {
  readonly name = "D1RetentionError";
  readonly code = "retention_purge_failed";
  readonly retriable = true;
}

const runStatement = Result.fn({
  try: async (statement: D1PreparedStatementLike) => statement.run(),
  catch: (error): D1RetentionError =>
    new D1RetentionError(error instanceof Error ? error.message : "retention purgeに失敗しました"),
});

function before(now: string, ms: number): string {
  return new Date(Date.parse(now) - ms).toISOString();
}

async function purge(
  statement: D1PreparedStatementLike,
): Result.ResultAsync<number, D1RetentionError> {
  const result = await runStatement(statement);
  if (Result.isFailure(result)) return result;
  if (!result.value.success) {
    return Result.fail(new D1RetentionError(result.value.error ?? "retention purgeに失敗しました"));
  }
  return Result.succeed(result.value.meta?.changes ?? 0);
}

/**
 * 保持期間を過ぎた運用データを削除する（cronから呼ぶ）。各テーブルbatchSize件までのため、
 * 溜まっていた場合は複数回のcronで追いつく。
 */
export async function purgeExpiredOperationalData(
  db: D1DatabaseLike,
  input: { now: string; policy?: Partial<OperationalRetentionPolicy> },
): Result.ResultAsync<RetentionPurgeResult, D1RetentionError> {
  const policy = { ...DEFAULT_OPERATIONAL_RETENTION_POLICY, ...input.policy };
  const limit = policy.batchSize;

  const rateLimitCounters = await purge(
    db
      .prepare(
        `DELETE FROM rate_limit_counters
          WHERE rowid IN (
            SELECT rowid FROM rate_limit_counters WHERE reset_at_ms < ? LIMIT ?
          )`,
      )
      .bind(Date.parse(input.now) - policy.rateLimitCounterGraceMs, limit),
  );
  if (Result.isFailure(rateLimitCounters)) return rateLimitCounters;

  const idempotencyKeys = await purge(
    db
      .prepare(
        `DELETE FROM api_idempotency_keys
          WHERE rowid IN (
            SELECT rowid FROM api_idempotency_keys
             WHERE (status = 'completed' AND updated_at < ?)
                OR (status = 'pending' AND COALESCE(locked_until, updated_at) < ?)
             LIMIT ?
          )`,
      )
      .bind(
        before(input.now, policy.idempotencyKeyMs),
        before(input.now, policy.staleIdempotencyReservationMs),
        limit,
      ),
  );
  if (Result.isFailure(idempotencyKeys)) return idempotencyKeys;

  const approvalCommands = await purge(
    db
      .prepare(
        `DELETE FROM approval_commands
          WHERE rowid IN (
            SELECT rowid FROM approval_commands
             WHERE status IN ('applied', 'rejected', 'failed')
               AND COALESCE(applied_at, created_at) < ?
             LIMIT ?
          )`,
      )
      .bind(before(input.now, policy.terminalApprovalCommandMs), limit),
  );
  if (Result.isFailure(approvalCommands)) return approvalCommands;

  const notificationDeliveries = await purge(
    db
      .prepare(
        `DELETE FROM notification_deliveries
          WHERE rowid IN (
            SELECT rowid FROM notification_deliveries
             WHERE (status IN ('sent', 'skipped') AND updated_at < ?)
                OR (status = 'failed' AND updated_at < ?)
             LIMIT ?
          )`,
      )
      .bind(
        before(input.now, policy.deliveredNotificationMs),
        before(input.now, policy.failedNotificationMs),
        limit,
      ),
  );
  if (Result.isFailure(notificationDeliveries)) return notificationDeliveries;

  const outboxEvents = await purge(
    db
      .prepare(
        `DELETE FROM outbox_events
          WHERE sequence IN (
            SELECT sequence FROM outbox_events
             WHERE (status IN ('dispatched', 'skipped') AND created_at < ?)
                OR (status IN ('dead', 'failed') AND created_at < ?)
             LIMIT ?
          )`,
      )
      .bind(
        before(input.now, policy.deliveredNotificationMs),
        before(input.now, policy.failedNotificationMs),
        limit,
      ),
  );
  if (Result.isFailure(outboxEvents)) return outboxEvents;

  return Result.succeed({
    rateLimitCounters: rateLimitCounters.value,
    idempotencyKeys: idempotencyKeys.value,
    approvalCommands: approvalCommands.value,
    notificationDeliveries: notificationDeliveries.value,
    outboxEvents: outboxEvents.value,
  });
}
