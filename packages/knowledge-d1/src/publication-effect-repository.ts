import { Result } from "@praha/byethrow";

import type {
  PublicationEffect,
  PublicationEffectKind,
  PublicationEffectStatus,
} from "@app/knowledge-core";

import { mapResult, Sql, type D1DatabaseLike, type KnowledgeStoreError } from "./db.ts";
import { toEffect, type EffectRow } from "./rows.ts";

const EFFECT_COLUMNS =
  "publication_snapshot_id, effect, status, attempts, last_error_code, updated_at";

export type NotificationListing = {
  publicationSnapshotId: string;
  pageId: string;
  revisionNumber: number;
  deliveredAt: string;
};

export type StoredToolInvocation = {
  toolName: string;
  argumentsJson: string;
  resultJson: string;
};

/**
 * Post-publish effect ledger, in-app notification deliveries and the MCP
 * downstream dedupe ledger.
 */
export class D1PublicationEffectRepository {
  private readonly sql: Sql;

  constructor(db: D1DatabaseLike) {
    this.sql = new Sql(db);
  }

  list(snapshotId: string): Result.ResultAsync<PublicationEffect[], KnowledgeStoreError> {
    return mapResult(
      this.sql.all<EffectRow>(
        `SELECT ${EFFECT_COLUMNS} FROM publication_effects WHERE publication_snapshot_id = ?
         ORDER BY effect DESC`,
        snapshotId,
      ),
      (rows) => rows.map(toEffect),
    );
  }

  /** Records one attempt of an effect (upsert keyed by snapshot + effect). */
  async record(input: {
    snapshotId: string;
    effect: PublicationEffectKind;
    status: PublicationEffectStatus;
    errorCode: string | null;
    now: string;
  }): Result.ResultAsync<PublicationEffect | null, KnowledgeStoreError> {
    const written = await this.sql.run(
      `INSERT INTO publication_effects (${EFFECT_COLUMNS}) VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT (publication_snapshot_id, effect) DO UPDATE SET
         status = excluded.status, attempts = publication_effects.attempts + 1,
         last_error_code = excluded.last_error_code, updated_at = excluded.updated_at`,
      input.snapshotId,
      input.effect,
      input.status,
      input.errorCode,
      input.now,
    );
    if (Result.isFailure(written)) return written;
    return mapResult(
      this.sql.first<EffectRow>(
        `SELECT ${EFFECT_COLUMNS} FROM publication_effects
         WHERE publication_snapshot_id = ? AND effect = ?`,
        input.snapshotId,
        input.effect,
      ),
      (row) => (row ? toEffect(row) : null),
    );
  }

  /** Failed / unknown effects of the given pages' snapshots (Home attention, Automation). */
  failedForPages(
    pageIds: readonly string[],
  ): Result.ResultAsync<
    Array<PublicationEffect & { pageId: string; revisionNumber: number }>,
    KnowledgeStoreError
  > {
    if (pageIds.length === 0) return Promise.resolve(Result.succeed([]));
    return mapResult(
      this.sql.all<EffectRow & { page_id: string; revision_number: number }>(
        `SELECT e.publication_snapshot_id, e.effect, e.status, e.attempts, e.last_error_code,
           e.updated_at, ps.page_id, ps.revision_number
         FROM publication_effects e
         JOIN publication_snapshots ps ON ps.id = e.publication_snapshot_id
         JOIN pages p ON p.id = ps.page_id AND p.published_snapshot_id = ps.id
         WHERE e.status IN ('failed', 'unknown')
           AND ps.page_id IN (SELECT value FROM json_each(?))
         ORDER BY e.updated_at DESC`,
        JSON.stringify(pageIds),
      ),
      (rows) =>
        rows.map((row) => ({
          ...toEffect(row),
          pageId: row.page_id,
          revisionNumber: Number(row.revision_number),
        })),
    );
  }

  /**
   * Delivers in-app notifications. The (snapshot, watcher) primary key makes
   * replays persistent no-ops. Returns the number of new deliveries.
   */
  async deliverNotifications(input: {
    snapshotId: string;
    pageId: string;
    watcherIds: readonly string[];
    now: string;
  }): Result.ResultAsync<number, KnowledgeStoreError> {
    if (input.watcherIds.length === 0) return Result.succeed(0);
    const written = await this.sql.batch(
      input.watcherIds.map((watcherId) =>
        this.sql.statement(
          `INSERT INTO notification_deliveries (publication_snapshot_id, watcher_id, page_id,
             delivered_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (publication_snapshot_id, watcher_id) DO NOTHING`,
          input.snapshotId,
          watcherId,
          input.pageId,
          input.now,
        ),
      ),
    );
    return mapResult(Promise.resolve(written), (changes) =>
      changes.reduce((total, value) => total + value, 0),
    );
  }

  listNotifications(input: {
    principalId: string;
    limit: number;
  }): Result.ResultAsync<NotificationListing[], KnowledgeStoreError> {
    return mapResult(
      this.sql.all<{
        publication_snapshot_id: string;
        page_id: string;
        revision_number: number;
        delivered_at: string;
      }>(
        `SELECT n.publication_snapshot_id, n.page_id, ps.revision_number, n.delivered_at
         FROM notification_deliveries n
         JOIN publication_snapshots ps ON ps.id = n.publication_snapshot_id
         WHERE n.watcher_id = ? ORDER BY n.delivered_at DESC LIMIT ?`,
        input.principalId,
        input.limit,
      ),
      (rows) =>
        rows.map((row) => ({
          publicationSnapshotId: row.publication_snapshot_id,
          pageId: row.page_id,
          revisionNumber: Number(row.revision_number),
          deliveredAt: row.delivered_at,
        })),
    );
  }

  findInvocation(
    idempotencyKey: string,
  ): Result.ResultAsync<StoredToolInvocation | null, KnowledgeStoreError> {
    return mapResult(
      this.sql.first<{ tool_name: string; arguments_json: string; result_json: string }>(
        `SELECT tool_name, arguments_json, result_json FROM tool_invocations
         WHERE idempotency_key = ?`,
        idempotencyKey,
      ),
      (row) =>
        row
          ? {
              toolName: row.tool_name,
              argumentsJson: row.arguments_json,
              resultJson: row.result_json,
            }
          : null,
    );
  }

  recordInvocation(input: {
    idempotencyKey: string;
    toolName: string;
    argumentsJson: string;
    resultJson: string;
    now: string;
  }): Result.ResultAsync<number, KnowledgeStoreError> {
    return this.sql.run(
      `INSERT INTO tool_invocations (idempotency_key, tool_name, arguments_json, result_json,
         created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      input.idempotencyKey,
      input.toolName,
      input.argumentsJson,
      input.resultJson,
      input.now,
    );
  }

  demoSetting(key: string): Result.ResultAsync<string | null, KnowledgeStoreError> {
    return mapResult(
      this.sql.first<{ value: string }>("SELECT value FROM demo_settings WHERE key = ?", key),
      (row) => row?.value ?? null,
    );
  }

  setDemoSetting(key: string, value: string): Result.ResultAsync<number, KnowledgeStoreError> {
    return this.sql.run(
      `INSERT INTO demo_settings (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }
}
