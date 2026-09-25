import { Result } from "@praha/byethrow";

import type { Draft, Page, ReviewState, SaveDraftInput } from "@app/knowledge-core";

import { KnowledgeStoreError, mapResult, Sql, tagsText, type D1DatabaseLike } from "./db.ts";
import { PAGE_COLUMNS, toDraft, toPage, type DraftRow, type PageRow } from "./rows.ts";

const DRAFT_COLUMNS =
  "page_id, title, body, tags_json, visibility, sensitivity, version, updated_by, updated_at";

export type LifecycleTransitionResult =
  | { type: "transitioned"; page: Page }
  | { type: "unchanged"; page: Page };

/** Pages (lifecycle + review state), drafts and watchers. */
export class D1PageRepository {
  private readonly sql: Sql;

  constructor(db: D1DatabaseLike) {
    this.sql = new Sql(db);
  }

  /** Page shell + its first draft, atomically. Drafts are indexed for authoring search. */
  async create(page: Page, draft: Draft): Result.ResultAsync<Page, KnowledgeStoreError> {
    const batch = await this.sql.batch([
      this.sql.statement(
        `INSERT INTO pages (id, space_id, owner_id, status, lifecycle_version, review_state,
           created_at, updated_at) VALUES (?, ?, ?, 'active', ?, 'current', ?, ?)`,
        page.id,
        page.spaceId,
        page.ownerId,
        page.lifecycleVersion,
        page.createdAt,
        page.updatedAt,
      ),
      this.sql.statement(
        `INSERT INTO drafts (${DRAFT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        draft.pageId,
        draft.title,
        draft.body,
        JSON.stringify(draft.tags),
        draft.visibility,
        draft.sensitivity,
        draft.version,
        draft.updatedBy,
        draft.updatedAt,
      ),
      ...this.reindexAuthoringStatements(page.id),
    ]);
    return Result.isFailure(batch) ? batch : Result.succeed(page);
  }

  find(pageId: string): Result.ResultAsync<Page | null, KnowledgeStoreError> {
    return mapResult(
      this.sql.first<PageRow>(`SELECT ${PAGE_COLUMNS} FROM pages p WHERE p.id = ?`, pageId),
      (row) => (row ? toPage(row) : null),
    );
  }

  findDraft(pageId: string): Result.ResultAsync<Draft | null, KnowledgeStoreError> {
    return mapResult(
      this.sql.first<DraftRow>(`SELECT ${DRAFT_COLUMNS} FROM drafts WHERE page_id = ?`, pageId),
      (row) => (row ? toDraft(row) : null),
    );
  }

  /**
   * Saves the draft with optimistic concurrency. Only the Knowledge DB is
   * touched: a draft save never becomes an ActionRequest.
   */
  async saveDraft(input: {
    pageId: string;
    draft: SaveDraftInput;
    principalId: string;
    now: string;
  }): Result.ResultAsync<Draft, KnowledgeStoreError> {
    const { draft } = input;
    const changes = await this.sql.batch([
      this.sql.statement(
        `UPDATE drafts SET title = ?, body = ?, tags_json = ?, visibility = ?, sensitivity = ?,
           version = version + 1, updated_by = ?, updated_at = ?
         WHERE page_id = ? AND version = ?`,
        draft.title,
        draft.body,
        JSON.stringify(draft.tags),
        draft.visibility,
        draft.sensitivity,
        input.principalId,
        input.now,
        input.pageId,
        draft.expectedVersion,
      ),
      this.sql.statement(
        "UPDATE pages SET updated_at = ? WHERE id = ? AND status = 'active'",
        input.now,
        input.pageId,
      ),
      // Rebuilt from the stored draft, so the index matches whichever save won.
      ...this.reindexAuthoringStatements(input.pageId),
    ]);
    if (Result.isFailure(changes)) return changes;
    if (changes.value[0] === 0) {
      return Result.fail(
        new KnowledgeStoreError("draft_conflict", "the draft was changed by someone else"),
      );
    }
    const saved = await this.findDraft(input.pageId);
    if (Result.isFailure(saved)) return saved;
    return saved.value
      ? Result.succeed(saved.value)
      : Result.fail(new KnowledgeStoreError("store_failed", "saved draft disappeared"));
  }

  private reindexAuthoringStatements(pageId: string) {
    return [
      this.sql.statement("DELETE FROM authoring_page_fts WHERE page_id = ?", pageId),
      this.sql.statement(
        `INSERT INTO authoring_page_fts (page_id, title, body, tags)
         SELECT page_id, title, body, ${tagsText("tags_json")} FROM drafts WHERE page_id = ?`,
        pageId,
      ),
    ];
  }

  /** Archive: active -> archived, lifecycle + 1, removed from published search. */
  async archive(
    pageId: string,
    now: string,
  ): Result.ResultAsync<LifecycleTransitionResult | null, KnowledgeStoreError> {
    const changes = await this.sql.batch([
      this.sql.statement(
        `UPDATE pages SET status = 'archived', lifecycle_version = lifecycle_version + 1,
           updated_at = ? WHERE id = ? AND status = 'active'`,
        now,
        pageId,
      ),
      this.sql.statement(
        `DELETE FROM published_page_fts WHERE page_id = ?
           AND (SELECT status FROM pages WHERE id = ?) = 'archived'`,
        pageId,
        pageId,
      ),
    ]);
    if (Result.isFailure(changes)) return changes;
    return this.transitionResult(pageId, changes.value[0] ?? 0);
  }

  /** Restore: archived -> active, lifecycle + 1, published content re-indexed. */
  async restore(
    pageId: string,
    now: string,
  ): Result.ResultAsync<LifecycleTransitionResult | null, KnowledgeStoreError> {
    const changes = await this.sql.batch([
      this.sql.statement(
        `UPDATE pages SET status = 'active', lifecycle_version = lifecycle_version + 1,
           updated_at = ? WHERE id = ? AND status = 'archived'`,
        now,
        pageId,
      ),
      this.sql.statement("DELETE FROM published_page_fts WHERE page_id = ?", pageId),
      this.sql.statement(
        `INSERT INTO published_page_fts (page_id, revision_id, title, body, tags)
         SELECT p.id, r.id, r.title, r.body, ${tagsText("r.tags_json")}
         FROM pages p JOIN revisions r ON r.id = p.published_revision_id
         WHERE p.id = ? AND p.status = 'active'`,
        pageId,
      ),
    ]);
    if (Result.isFailure(changes)) return changes;
    return this.transitionResult(pageId, changes.value[0] ?? 0);
  }

  private async transitionResult(
    pageId: string,
    changes: number,
  ): Result.ResultAsync<LifecycleTransitionResult | null, KnowledgeStoreError> {
    return mapResult(this.find(pageId), (page) =>
      page ? { type: changes > 0 ? "transitioned" : "unchanged", page } : null,
    );
  }

  setReviewState(input: {
    pageId: string;
    state: ReviewState;
    now: string;
  }): Result.ResultAsync<number, KnowledgeStoreError> {
    return this.sql.run(
      `UPDATE pages SET review_state = ?,
         last_reviewed_at = CASE WHEN ? = 'current' THEN ? ELSE last_reviewed_at END,
         updated_at = ? WHERE id = ? AND status = 'active'`,
      input.state,
      input.state,
      input.now,
      input.now,
      input.pageId,
    );
  }

  setWatching(input: {
    pageId: string;
    principalId: string;
    watching: boolean;
    now: string;
  }): Result.ResultAsync<number, KnowledgeStoreError> {
    return input.watching
      ? this.sql.run(
          `INSERT INTO watchers (page_id, principal_id, created_at) VALUES (?, ?, ?)
           ON CONFLICT (page_id, principal_id) DO NOTHING`,
          input.pageId,
          input.principalId,
          input.now,
        )
      : this.sql.run(
          "DELETE FROM watchers WHERE page_id = ? AND principal_id = ?",
          input.pageId,
          input.principalId,
        );
  }

  isWatching(
    pageId: string,
    principalId: string,
  ): Result.ResultAsync<boolean, KnowledgeStoreError> {
    return mapResult(
      this.sql.first<{ found: number }>(
        "SELECT 1 AS found FROM watchers WHERE page_id = ? AND principal_id = ?",
        pageId,
        principalId,
      ),
      (row) => row !== null,
    );
  }

  listWatchers(pageId: string): Result.ResultAsync<string[], KnowledgeStoreError> {
    return mapResult(
      this.sql.all<{ principal_id: string }>(
        "SELECT principal_id FROM watchers WHERE page_id = ? ORDER BY principal_id",
        pageId,
      ),
      (rows) => rows.map((row) => row.principal_id),
    );
  }

  /** Published, active pages whose last publish / review is older than `before`. */
  listStale(input: {
    before: string;
    spaceId?: string;
    limit: number;
  }): Result.ResultAsync<Page[], KnowledgeStoreError> {
    return mapResult(
      this.sql.all<PageRow>(
        `SELECT ${PAGE_COLUMNS} FROM pages p
         WHERE p.status = 'active' AND p.published_revision_id IS NOT NULL
           AND max(p.published_at, coalesce(p.last_reviewed_at, '')) < ?
           AND (? IS NULL OR p.space_id = ?)
         ORDER BY p.published_at LIMIT ?`,
        input.before,
        input.spaceId ?? null,
        input.spaceId ?? null,
        input.limit,
      ),
      (rows) => rows.map(toPage),
    );
  }
}
