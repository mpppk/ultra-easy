import { Result } from "@praha/byethrow";

import type {
  PublicationOutcome,
  PublicationRequest,
  PublicationSnapshot,
  Revision,
} from "@app/knowledge-core";

import { mapResult, Sql, type D1DatabaseLike, type KnowledgeStoreError } from "./db.ts";
import {
  toOutcome,
  toRevision,
  toSnapshot,
  type OutcomeRow,
  type RevisionRow,
  type SnapshotRow,
} from "./rows.ts";

const REVISION_COLUMNS = "id, page_id, number, title, body, tags_json, created_by, created_at";
const SNAPSHOT_COLUMNS = `id, page_id, revision_id, revision_number, space_id, visibility,
  sensitivity, expected_lifecycle_version, created_by, created_at`;

export type RevisionSummary = Omit<Revision, "body">;

/** Immutable Revisions + PublicationSnapshots and their correlation / outcome rows. */
export class D1RevisionRepository {
  private readonly sql: Sql;

  constructor(db: D1DatabaseLike) {
    this.sql = new Sql(db);
  }

  find(revisionId: string): Result.ResultAsync<Revision | null, KnowledgeStoreError> {
    return mapResult(
      this.sql.first<RevisionRow>(
        `SELECT ${REVISION_COLUMNS} FROM revisions WHERE id = ?`,
        revisionId,
      ),
      (row) => (row ? toRevision(row) : null),
    );
  }

  findByNumber(
    pageId: string,
    number: number,
  ): Result.ResultAsync<Revision | null, KnowledgeStoreError> {
    return mapResult(
      this.sql.first<RevisionRow>(
        `SELECT ${REVISION_COLUMNS} FROM revisions WHERE page_id = ? AND number = ?`,
        pageId,
        number,
      ),
      (row) => (row ? toRevision(row) : null),
    );
  }

  latest(pageId: string): Result.ResultAsync<Revision | null, KnowledgeStoreError> {
    return mapResult(
      this.sql.first<RevisionRow>(
        `SELECT ${REVISION_COLUMNS} FROM revisions WHERE page_id = ? ORDER BY number DESC LIMIT 1`,
        pageId,
      ),
      (row) => (row ? toRevision(row) : null),
    );
  }

  list(pageId: string): Result.ResultAsync<RevisionSummary[], KnowledgeStoreError> {
    return mapResult(
      this.sql.all<Omit<RevisionRow, "body">>(
        `SELECT id, page_id, number, title, tags_json, created_by, created_at
         FROM revisions WHERE page_id = ? ORDER BY number DESC`,
        pageId,
      ),
      (rows) =>
        rows.map((row) => {
          const { body: _body, ...summary } = toRevision({ ...row, body: "" });
          return summary;
        }),
    );
  }

  count(pageId: string): Result.ResultAsync<number, KnowledgeStoreError> {
    return mapResult(
      this.sql.first<{ total: number }>(
        "SELECT count(*) AS total FROM revisions WHERE page_id = ?",
        pageId,
      ),
      (row) => Number(row?.total ?? 0),
    );
  }

  /**
   * Writes the (optional new) revision and the snapshot in one batch. Both are
   * INSERT-only; triggers reject later UPDATE / DELETE.
   */
  async insertPublication(input: {
    revision: Revision | null;
    snapshot: PublicationSnapshot;
  }): Result.ResultAsync<PublicationSnapshot, KnowledgeStoreError> {
    const { revision, snapshot } = input;
    const statements = revision
      ? [
          this.sql.statement(
            `INSERT INTO revisions (${REVISION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            revision.id,
            revision.pageId,
            revision.number,
            revision.title,
            revision.body,
            JSON.stringify(revision.tags),
            revision.createdBy,
            revision.createdAt,
          ),
        ]
      : [];
    statements.push(
      this.sql.statement(
        `INSERT INTO publication_snapshots (${SNAPSHOT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        snapshot.id,
        snapshot.pageId,
        snapshot.revisionId,
        snapshot.revisionNumber,
        snapshot.spaceId,
        snapshot.visibility,
        snapshot.sensitivity,
        snapshot.expectedLifecycleVersion,
        snapshot.createdBy,
        snapshot.createdAt,
      ),
    );
    const written = await this.sql.batch(statements);
    return Result.isFailure(written) ? written : Result.succeed(snapshot);
  }

  findSnapshot(
    snapshotId: string,
  ): Result.ResultAsync<PublicationSnapshot | null, KnowledgeStoreError> {
    return mapResult(
      this.sql.first<SnapshotRow>(
        `SELECT ${SNAPSHOT_COLUMNS} FROM publication_snapshots WHERE id = ?`,
        snapshotId,
      ),
      (row) => (row ? toSnapshot(row) : null),
    );
  }

  latestSnapshot(
    pageId: string,
  ): Result.ResultAsync<PublicationSnapshot | null, KnowledgeStoreError> {
    return mapResult(
      this.sql.first<SnapshotRow>(
        `SELECT ${SNAPSHOT_COLUMNS} FROM publication_snapshots WHERE page_id = ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        pageId,
      ),
      (row) => (row ? toSnapshot(row) : null),
    );
  }

  /** Snapshots of a revision (to mark which publication a revision belongs to). */
  snapshotsForPage(pageId: string): Result.ResultAsync<PublicationSnapshot[], KnowledgeStoreError> {
    return mapResult(
      this.sql.all<SnapshotRow>(
        `SELECT ${SNAPSHOT_COLUMNS} FROM publication_snapshots WHERE page_id = ?
         ORDER BY created_at DESC, rowid DESC`,
        pageId,
      ),
      (rows) => rows.map(toSnapshot),
    );
  }

  attachRequest(request: PublicationRequest): Result.ResultAsync<number, KnowledgeStoreError> {
    return this.sql.run(
      `INSERT INTO publication_requests (publication_snapshot_id, action_request_id,
         workflow_run_id, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (publication_snapshot_id) DO NOTHING`,
      request.publicationSnapshotId,
      request.actionRequestId,
      request.workflowRunId,
      request.createdAt,
    );
  }

  findRequest(
    snapshotId: string,
  ): Result.ResultAsync<PublicationRequest | null, KnowledgeStoreError> {
    return mapResult(
      this.sql.first<{
        publication_snapshot_id: string;
        action_request_id: string;
        workflow_run_id: string | null;
        created_at: string;
      }>(
        `SELECT publication_snapshot_id, action_request_id, workflow_run_id, created_at
         FROM publication_requests WHERE publication_snapshot_id = ?`,
        snapshotId,
      ),
      (row) =>
        row
          ? {
              publicationSnapshotId: row.publication_snapshot_id,
              actionRequestId: row.action_request_id,
              workflowRunId: row.workflow_run_id,
              createdAt: row.created_at,
            }
          : null,
    );
  }

  findOutcome(
    snapshotId: string,
  ): Result.ResultAsync<PublicationOutcome | null, KnowledgeStoreError> {
    return mapResult(
      this.sql.first<OutcomeRow>(
        `SELECT publication_snapshot_id, status, reason, expected_lifecycle_version,
           actual_lifecycle_version, recorded_at
         FROM publication_outcomes WHERE publication_snapshot_id = ?`,
        snapshotId,
      ),
      (row) => (row ? toOutcome(row) : null),
    );
  }

  outcomesForPage(pageId: string): Result.ResultAsync<PublicationOutcome[], KnowledgeStoreError> {
    return mapResult(
      this.sql.all<OutcomeRow>(
        `SELECT o.publication_snapshot_id, o.status, o.reason, o.expected_lifecycle_version,
           o.actual_lifecycle_version, o.recorded_at
         FROM publication_outcomes o
         JOIN publication_snapshots ps ON ps.id = o.publication_snapshot_id
         WHERE ps.page_id = ?`,
        pageId,
      ),
      (rows) => rows.map(toOutcome),
    );
  }

  /**
   * Conflicted publications of an author with no later publication attempt by
   * the same author on the same page after the conflict was recorded.
   */
  unresolvedConflictsBy(
    principalId: string,
    limit: number,
  ): Result.ResultAsync<
    Array<{ snapshot: PublicationSnapshot; outcome: PublicationOutcome }>,
    KnowledgeStoreError
  > {
    return mapResult(
      this.sql.all<SnapshotRow & OutcomeRow>(
        `SELECT ps.id, ps.page_id, ps.revision_id, ps.revision_number, ps.space_id, ps.visibility,
           ps.sensitivity, ps.expected_lifecycle_version, ps.created_by, ps.created_at,
           o.publication_snapshot_id, o.status, o.reason, o.actual_lifecycle_version, o.recorded_at
         FROM publication_snapshots ps
         JOIN publication_outcomes o ON o.publication_snapshot_id = ps.id
         WHERE ps.created_by = ? AND o.status = 'conflict'
           AND NOT EXISTS (
             SELECT 1 FROM publication_snapshots newer
             WHERE newer.page_id = ps.page_id AND newer.created_by = ps.created_by
               AND newer.created_at > o.recorded_at)
         ORDER BY o.recorded_at DESC LIMIT ?`,
        principalId,
        limit,
      ),
      (rows) => rows.map((row) => ({ snapshot: toSnapshot(row), outcome: toOutcome(row) })),
    );
  }
}
