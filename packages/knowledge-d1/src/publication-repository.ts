import { Result } from "@praha/byethrow";

import {
  decidePublishCommit,
  extractPageLinks,
  type PublicationOutcome,
  type PublicationSnapshot,
} from "@app/knowledge-core";

import { KnowledgeStoreError, Sql, type D1DatabaseLike } from "./db.ts";
import { D1PageRepository } from "./page-repository.ts";
import { D1RevisionRepository } from "./revision-repository.ts";

/**
 * Downstream mutation of `knowledge.revision.publish`: a durable
 * compare-and-swap on the page lifecycle version.
 */
export class D1PublicationRepository {
  private readonly sql: Sql;
  private readonly pages: D1PageRepository;
  private readonly revisions: D1RevisionRepository;

  constructor(db: D1DatabaseLike) {
    this.sql = new Sql(db);
    this.pages = new D1PageRepository(db);
    this.revisions = new D1RevisionRepository(db);
  }

  async commitPublish(input: {
    snapshotId: string;
    now: string;
  }): Result.ResultAsync<
    { snapshot: PublicationSnapshot; outcome: PublicationOutcome } | null,
    KnowledgeStoreError
  > {
    const snapshot = await this.revisions.findSnapshot(input.snapshotId);
    if (Result.isFailure(snapshot)) return snapshot;
    if (!snapshot.value) return Result.succeed(null);
    const existing = await this.revisions.findOutcome(snapshot.value.id);
    if (Result.isFailure(existing)) return existing;
    if (existing.value)
      return Result.succeed({ snapshot: snapshot.value, outcome: existing.value });

    const page = await this.pages.find(snapshot.value.pageId);
    if (Result.isFailure(page)) return page;
    if (!page.value) {
      return Result.fail(new KnowledgeStoreError("store_failed", "snapshot page is missing"));
    }
    const decision = decidePublishCommit(page.value, snapshot.value);
    if (decision.type === "conflict") {
      return this.recordConflict(snapshot.value, decision, input.now);
    }
    if (decision.type === "commit") {
      const revision = await this.revisions.find(snapshot.value.revisionId);
      if (Result.isFailure(revision)) return revision;
      const pageId = snapshot.value.pageId;
      const links = extractPageLinks(revision.value?.body ?? "").filter(
        (target) => target !== pageId,
      );
      const committed = await this.sql.batch(
        this.commitStatements(snapshot.value, links, input.now),
      );
      if (Result.isFailure(committed)) return committed;
    }

    // Re-read: the CAS UPDATE may have lost a race after decidePublishCommit.
    const after = await this.pages.find(snapshot.value.pageId);
    if (Result.isFailure(after)) return after;
    if (after.value?.publishedSnapshotId !== snapshot.value.id) {
      const retry = after.value ? decidePublishCommit(after.value, snapshot.value) : null;
      return this.recordConflict(
        snapshot.value,
        retry?.type === "conflict"
          ? retry
          : {
              reason: "lifecycle_mismatch",
              expectedLifecycleVersion: snapshot.value.expectedLifecycleVersion,
              actualLifecycleVersion: after.value?.lifecycleVersion ?? -1,
            },
        input.now,
      );
    }
    const outcome = await this.revisions.findOutcome(snapshot.value.id);
    if (Result.isFailure(outcome)) return outcome;
    return Result.succeed({
      snapshot: snapshot.value,
      outcome: outcome.value ?? {
        snapshotId: snapshot.value.id,
        status: "published",
        recordedAt: input.now,
      },
    });
  }

  private commitStatements(snapshot: PublicationSnapshot, links: string[], now: string) {
    // Every follow-up statement only applies when the CAS above really moved
    // the page to this snapshot (same transaction).
    const committed = "(SELECT published_snapshot_id FROM pages WHERE id = ?) = ?";
    return [
      this.sql.statement(
        `UPDATE pages SET published_revision_id = ?, published_snapshot_id = ?,
           published_visibility = ?, published_sensitivity = ?, published_at = ?, published_by = ?,
           lifecycle_version = lifecycle_version + 1, review_state = 'current',
           last_reviewed_at = ?, updated_at = ?
         WHERE id = ? AND lifecycle_version = ? AND status = 'active'`,
        snapshot.revisionId,
        snapshot.id,
        snapshot.visibility,
        snapshot.sensitivity,
        now,
        snapshot.createdBy,
        now,
        now,
        snapshot.pageId,
        snapshot.expectedLifecycleVersion,
      ),
      this.sql.statement(
        `INSERT INTO publication_outcomes (publication_snapshot_id, status, reason,
           expected_lifecycle_version, actual_lifecycle_version, recorded_at)
         SELECT ?, 'published', NULL, ?, ?, ? WHERE ${committed}
         ON CONFLICT (publication_snapshot_id) DO NOTHING`,
        snapshot.id,
        snapshot.expectedLifecycleVersion,
        snapshot.expectedLifecycleVersion + 1,
        now,
        snapshot.pageId,
        snapshot.id,
      ),
      ...links.map((target) =>
        this.sql.statement(
          `INSERT INTO page_links (source_revision_id, source_page_id, target_page_id)
           SELECT ?, ?, ? WHERE ${committed}
           ON CONFLICT (source_revision_id, target_page_id) DO NOTHING`,
          snapshot.revisionId,
          snapshot.pageId,
          target,
          snapshot.pageId,
          snapshot.id,
        ),
      ),
      ...(["search_reindex", "watcher_notification"] as const).map((effect) =>
        this.sql.statement(
          `INSERT INTO publication_effects (publication_snapshot_id, effect, status, attempts,
             last_error_code, updated_at)
           SELECT ?, ?, 'pending', 0, NULL, ? WHERE ${committed}
           ON CONFLICT (publication_snapshot_id, effect) DO NOTHING`,
          snapshot.id,
          effect,
          now,
          snapshot.pageId,
          snapshot.id,
        ),
      ),
    ];
  }

  private async recordConflict(
    snapshot: PublicationSnapshot,
    conflict: {
      reason: "lifecycle_mismatch" | "archived";
      expectedLifecycleVersion: number;
      actualLifecycleVersion: number;
    },
    now: string,
  ): Result.ResultAsync<
    { snapshot: PublicationSnapshot; outcome: PublicationOutcome },
    KnowledgeStoreError
  > {
    const written = await this.sql.run(
      `INSERT INTO publication_outcomes (publication_snapshot_id, status, reason,
         expected_lifecycle_version, actual_lifecycle_version, recorded_at)
       VALUES (?, 'conflict', ?, ?, ?, ?)
       ON CONFLICT (publication_snapshot_id) DO NOTHING`,
      snapshot.id,
      conflict.reason,
      conflict.expectedLifecycleVersion,
      conflict.actualLifecycleVersion,
      now,
    );
    if (Result.isFailure(written)) return written;
    const stored = await this.revisions.findOutcome(snapshot.id);
    if (Result.isFailure(stored)) return stored;
    return Result.succeed({
      snapshot,
      outcome: stored.value ?? {
        snapshotId: snapshot.id,
        status: "conflict",
        ...conflict,
        recordedAt: now,
      },
    });
  }
}
