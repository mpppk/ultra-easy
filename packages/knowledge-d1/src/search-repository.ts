import { Result } from "@praha/byethrow";

import type { ReadScope, Sensitivity, Visibility } from "@app/knowledge-core";

import {
  mapResult,
  parseTags,
  Sql,
  tagsText,
  type D1DatabaseLike,
  type KnowledgeStoreError,
} from "./db.ts";

/**
 * Authorization is part of every query (no fetch-then-filter): the caller's
 * ReadScope is bound as parameters, so unauthorized rows never leave D1.
 *
 * Published projection readable by the scope. Expects aliases `p` (pages) and
 * `s` (spaces). Binds: organizationId, memberSpaceIds, principalId, ownerSpaceIds.
 */
const READABLE_PUBLISHED = `s.organization_id = ? AND p.status = 'active'
  AND p.published_revision_id IS NOT NULL AND (
    p.published_visibility = 'organization'
    OR (p.published_visibility = 'space' AND p.space_id IN (SELECT value FROM json_each(?)))
    OR (p.published_visibility = 'private'
        AND (p.owner_id = ? OR p.space_id IN (SELECT value FROM json_each(?)))))`;

function publishedBindings(scope: ReadScope): [string, string, string, string] {
  return [
    scope.organizationId,
    JSON.stringify(scope.memberSpaceIds),
    scope.principalId,
    JSON.stringify(scope.ownerSpaceIds),
  ];
}

/** Authoring projection (drafts). Expects `p` / `s`. Binds: organizationId, authoringSpaceIds. */
const READABLE_AUTHORING = `s.organization_id = ? AND p.status = 'active'
  AND p.space_id IN (SELECT value FROM json_each(?))`;

function authoringBindings(scope: ReadScope): [string, string] {
  return [scope.organizationId, JSON.stringify(scope.authoringSpaceIds)];
}

export type PublishedPageListing = {
  pageId: string;
  spaceId: string;
  spaceKey: string;
  spaceName: string;
  ownerId: string;
  revisionNumber: number;
  title: string;
  body: string;
  tags: string[];
  visibility: Visibility;
  sensitivity: Sensitivity;
  publishedAt: string;
  reviewState: "current" | "update_needed";
};

type PublishedListingRow = {
  page_id: string;
  space_id: string;
  space_key: string;
  space_name: string;
  owner_id: string;
  revision_number: number;
  title: string;
  body: string;
  tags_json: string;
  visibility: Visibility;
  sensitivity: Sensitivity;
  published_at: string;
  review_state: "current" | "update_needed";
};

const PUBLISHED_LISTING_COLUMNS = `p.id AS page_id, p.space_id, s.key AS space_key,
  s.name AS space_name, p.owner_id, r.number AS revision_number, r.title, r.body, r.tags_json,
  p.published_visibility AS visibility, p.published_sensitivity AS sensitivity,
  p.published_at, p.review_state`;

const toPublishedListing = (row: PublishedListingRow): PublishedPageListing => ({
  pageId: row.page_id,
  spaceId: row.space_id,
  spaceKey: row.space_key,
  spaceName: row.space_name,
  ownerId: row.owner_id,
  revisionNumber: Number(row.revision_number),
  title: row.title,
  body: row.body,
  tags: parseTags(row.tags_json),
  visibility: row.visibility,
  sensitivity: row.sensitivity,
  publishedAt: row.published_at,
  reviewState: row.review_state,
});

export type AuthoringPageListing = {
  pageId: string;
  spaceId: string;
  spaceKey: string;
  spaceName: string;
  ownerId: string;
  title: string;
  body: string;
  tags: string[];
  visibility: Visibility;
  sensitivity: Sensitivity;
  updatedAt: string;
  updatedBy: string;
  publishedRevisionId: string | null;
  publishedAt: string | null;
  publishedTitle: string | null;
  publishedBody: string | null;
  publishedTags: string[] | null;
  publishedVisibility: Visibility | null;
  publishedSensitivity: Sensitivity | null;
  reviewState: "current" | "update_needed";
};

type AuthoringListingRow = {
  page_id: string;
  space_id: string;
  space_key: string;
  space_name: string;
  owner_id: string;
  title: string;
  body: string;
  tags_json: string;
  visibility: Visibility;
  sensitivity: Sensitivity;
  updated_at: string;
  updated_by: string;
  published_revision_id: string | null;
  published_at: string | null;
  published_title: string | null;
  published_body: string | null;
  published_tags_json: string | null;
  published_visibility: Visibility | null;
  published_sensitivity: Sensitivity | null;
  review_state: "current" | "update_needed";
};

const AUTHORING_LISTING_COLUMNS = `p.id AS page_id, p.space_id, s.key AS space_key,
  s.name AS space_name, p.owner_id, d.title, d.body, d.tags_json, d.visibility, d.sensitivity,
  d.updated_at, d.updated_by, p.published_revision_id, p.published_at,
  r.title AS published_title, r.body AS published_body, r.tags_json AS published_tags_json,
  p.published_visibility, p.published_sensitivity, p.review_state`;

const toAuthoringListing = (row: AuthoringListingRow): AuthoringPageListing => ({
  pageId: row.page_id,
  spaceId: row.space_id,
  spaceKey: row.space_key,
  spaceName: row.space_name,
  ownerId: row.owner_id,
  title: row.title,
  body: row.body,
  tags: parseTags(row.tags_json),
  visibility: row.visibility,
  sensitivity: row.sensitivity,
  updatedAt: row.updated_at,
  updatedBy: row.updated_by,
  publishedRevisionId: row.published_revision_id,
  publishedAt: row.published_at,
  publishedTitle: row.published_title,
  publishedBody: row.published_body,
  publishedTags: row.published_tags_json === null ? null : parseTags(row.published_tags_json),
  publishedVisibility: row.published_visibility,
  publishedSensitivity: row.published_sensitivity,
  reviewState: row.review_state,
});

export type SearchHit<T> = T & { snippet: string };

/** Snippet highlight markers (control characters; the UI turns them into <mark>). */
export const SNIPPET_OPEN = "\u0002";
export const SNIPPET_CLOSE = "\u0003";

export type SpaceActivity = {
  spaceId: string;
  publishedPageCount: number;
  lastActivityAt: string | null;
};

export type PageLinkListing = { pageId: string; spaceKey: string; title: string };

export class D1SearchRepository {
  private readonly sql: Sql;

  constructor(db: D1DatabaseLike) {
    this.sql = new Sql(db);
  }

  /**
   * Upserts the published index row of a page from its *current* published
   * revision (idempotent: replays converge on the same single row).
   */
  async reindexPublished(
    pageId: string,
  ): Result.ResultAsync<{ indexedRevisionId: string | null }, KnowledgeStoreError> {
    const written = await this.sql.batch([
      this.sql.statement("DELETE FROM published_page_fts WHERE page_id = ?", pageId),
      this.sql.statement(
        `INSERT INTO published_page_fts (page_id, revision_id, title, body, tags)
         SELECT p.id, r.id, r.title, r.body, ${tagsText("r.tags_json")}
         FROM pages p JOIN revisions r ON r.id = p.published_revision_id
         WHERE p.id = ? AND p.status = 'active'`,
        pageId,
      ),
    ]);
    if (Result.isFailure(written)) return written;
    return mapResult(
      this.sql.first<{ revision_id: string }>(
        "SELECT revision_id FROM published_page_fts WHERE page_id = ?",
        pageId,
      ),
      (row) => ({ indexedRevisionId: row?.revision_id ?? null }),
    );
  }

  indexedRevision(pageId: string): Result.ResultAsync<string | null, KnowledgeStoreError> {
    return mapResult(
      this.sql.first<{ revision_id: string }>(
        "SELECT revision_id FROM published_page_fts WHERE page_id = ?",
        pageId,
      ),
      (row) => row?.revision_id ?? null,
    );
  }

  /**
   * Full-text search over the published index. Only rows whose indexed revision
   * is the page's current published revision are returned.
   */
  searchPublished(input: {
    scope: ReadScope;
    match: string;
    spaceId?: string;
    tag?: string;
    limit: number;
  }): Result.ResultAsync<Array<SearchHit<PublishedPageListing>>, KnowledgeStoreError> {
    return mapResult(
      this.sql.all<PublishedListingRow & { snippet: string }>(
        `SELECT ${PUBLISHED_LISTING_COLUMNS},
           snippet(published_page_fts, 3, '${SNIPPET_OPEN}', '${SNIPPET_CLOSE}', '…', 18) AS snippet
         FROM published_page_fts f
         JOIN pages p ON p.id = f.page_id AND p.published_revision_id = f.revision_id
         JOIN revisions r ON r.id = p.published_revision_id
         JOIN spaces s ON s.id = p.space_id
         WHERE published_page_fts MATCH ? AND ${READABLE_PUBLISHED}
           AND (? IS NULL OR p.space_id = ?)
           AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(r.tags_json) WHERE value = ?))
         ORDER BY rank LIMIT ?`,
        input.match,
        ...publishedBindings(input.scope),
        input.spaceId ?? null,
        input.spaceId ?? null,
        input.tag ?? null,
        input.tag ?? null,
        input.limit,
      ),
      (rows) => rows.map((row) => ({ ...toPublishedListing(row), snippet: row.snippet })),
    );
  }

  /** Full-text search over drafts, restricted to spaces whose drafts the caller may read. */
  searchAuthoring(input: {
    scope: ReadScope;
    match: string;
    spaceId?: string;
    tag?: string;
    limit: number;
  }): Result.ResultAsync<Array<SearchHit<AuthoringPageListing>>, KnowledgeStoreError> {
    if (input.scope.authoringSpaceIds.length === 0) return Promise.resolve(Result.succeed([]));
    return mapResult(
      this.sql.all<AuthoringListingRow & { snippet: string }>(
        `SELECT ${AUTHORING_LISTING_COLUMNS},
           snippet(authoring_page_fts, 2, '${SNIPPET_OPEN}', '${SNIPPET_CLOSE}', '…', 18) AS snippet
         FROM authoring_page_fts f
         JOIN pages p ON p.id = f.page_id
         JOIN drafts d ON d.page_id = p.id
         LEFT JOIN revisions r ON r.id = p.published_revision_id
         JOIN spaces s ON s.id = p.space_id
         WHERE authoring_page_fts MATCH ? AND ${READABLE_AUTHORING}
           AND (? IS NULL OR p.space_id = ?)
           AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(d.tags_json) WHERE value = ?))
         ORDER BY rank LIMIT ?`,
        input.match,
        ...authoringBindings(input.scope),
        input.spaceId ?? null,
        input.spaceId ?? null,
        input.tag ?? null,
        input.tag ?? null,
        input.limit,
      ),
      (rows) => rows.map((row) => ({ ...toAuthoringListing(row), snippet: row.snippet })),
    );
  }

  /** Readable published pages, newest publication first (optionally one space / tag). */
  listPublished(input: {
    scope: ReadScope;
    spaceId?: string;
    tag?: string;
    limit: number;
  }): Result.ResultAsync<PublishedPageListing[], KnowledgeStoreError> {
    return mapResult(
      this.sql.all<PublishedListingRow>(
        `SELECT ${PUBLISHED_LISTING_COLUMNS}
         FROM pages p
         JOIN revisions r ON r.id = p.published_revision_id
         JOIN spaces s ON s.id = p.space_id
         WHERE ${READABLE_PUBLISHED}
           AND (? IS NULL OR p.space_id = ?)
           AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(r.tags_json) WHERE value = ?))
         ORDER BY p.published_at DESC LIMIT ?`,
        ...publishedBindings(input.scope),
        input.spaceId ?? null,
        input.spaceId ?? null,
        input.tag ?? null,
        input.tag ?? null,
        input.limit,
      ),
      (rows) => rows.map(toPublishedListing),
    );
  }

  /** Drafts the caller may read, most recently edited first. */
  listAuthoring(input: {
    scope: ReadScope;
    spaceId?: string;
    tag?: string;
    limit: number;
  }): Result.ResultAsync<AuthoringPageListing[], KnowledgeStoreError> {
    if (input.scope.authoringSpaceIds.length === 0) return Promise.resolve(Result.succeed([]));
    return mapResult(
      this.sql.all<AuthoringListingRow>(
        `SELECT ${AUTHORING_LISTING_COLUMNS}
         FROM pages p
         JOIN drafts d ON d.page_id = p.id
         LEFT JOIN revisions r ON r.id = p.published_revision_id
         JOIN spaces s ON s.id = p.space_id
         WHERE ${READABLE_AUTHORING}
           AND (? IS NULL OR p.space_id = ?)
           AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(d.tags_json) WHERE value = ?))
         ORDER BY d.updated_at DESC LIMIT ?`,
        ...authoringBindings(input.scope),
        input.spaceId ?? null,
        input.spaceId ?? null,
        input.tag ?? null,
        input.tag ?? null,
        input.limit,
      ),
      (rows) => rows.map(toAuthoringListing),
    );
  }

  /** Page counts / last activity per space, computed from readable projections only. */
  async spaceActivity(scope: ReadScope): Result.ResultAsync<SpaceActivity[], KnowledgeStoreError> {
    const published = await this.sql.all<{
      space_id: string;
      total: number;
      last_at: string | null;
    }>(
      `SELECT p.space_id, count(*) AS total, max(p.published_at) AS last_at
       FROM pages p JOIN spaces s ON s.id = p.space_id
       WHERE ${READABLE_PUBLISHED}
       GROUP BY p.space_id`,
      ...publishedBindings(scope),
    );
    if (Result.isFailure(published)) return published;
    const authoring =
      scope.authoringSpaceIds.length === 0
        ? Result.succeed<Array<{ space_id: string; last_at: string | null }>>([])
        : await this.sql.all<{ space_id: string; last_at: string | null }>(
            `SELECT p.space_id, max(d.updated_at) AS last_at
             FROM pages p JOIN drafts d ON d.page_id = p.id JOIN spaces s ON s.id = p.space_id
             WHERE ${READABLE_AUTHORING}
             GROUP BY p.space_id`,
            ...authoringBindings(scope),
          );
    if (Result.isFailure(authoring)) return authoring;
    const bySpace = new Map<string, SpaceActivity>();
    for (const row of published.value) {
      bySpace.set(row.space_id, {
        spaceId: row.space_id,
        publishedPageCount: Number(row.total),
        lastActivityAt: row.last_at,
      });
    }
    for (const row of authoring.value) {
      const current = bySpace.get(row.space_id);
      const last = [current?.lastActivityAt ?? null, row.last_at]
        .filter((value): value is string => value !== null)
        .sort()
        .at(-1);
      bySpace.set(row.space_id, {
        spaceId: row.space_id,
        publishedPageCount: current?.publishedPageCount ?? 0,
        lastActivityAt: last ?? null,
      });
    }
    return Result.succeed([...bySpace.values()]);
  }

  /** Readable pages whose *current published* revision links to the page. */
  backlinks(input: {
    scope: ReadScope;
    pageId: string;
    limit: number;
  }): Result.ResultAsync<PageLinkListing[], KnowledgeStoreError> {
    return mapResult(
      this.sql.all<{ page_id: string; space_key: string; title: string }>(
        `SELECT p.id AS page_id, s.key AS space_key, r.title
         FROM page_links l
         JOIN pages p ON p.id = l.source_page_id AND p.published_revision_id = l.source_revision_id
         JOIN revisions r ON r.id = p.published_revision_id
         JOIN spaces s ON s.id = p.space_id
         WHERE l.target_page_id = ? AND ${READABLE_PUBLISHED}
         ORDER BY r.title LIMIT ?`,
        input.pageId,
        ...publishedBindings(input.scope),
        input.limit,
      ),
      (rows) =>
        rows.map((row) => ({ pageId: row.page_id, spaceKey: row.space_key, title: row.title })),
    );
  }

  /** Readable published pages sharing tags with the given ones (most overlap first). */
  related(input: {
    scope: ReadScope;
    pageId: string;
    tags: readonly string[];
    limit: number;
  }): Result.ResultAsync<PageLinkListing[], KnowledgeStoreError> {
    if (input.tags.length === 0) return Promise.resolve(Result.succeed([]));
    return mapResult(
      this.sql.all<{ page_id: string; space_key: string; title: string }>(
        `SELECT p.id AS page_id, s.key AS space_key, r.title, count(*) AS overlap
         FROM pages p
         JOIN revisions r ON r.id = p.published_revision_id
         JOIN spaces s ON s.id = p.space_id
         JOIN json_each(r.tags_json) t
         WHERE p.id != ? AND t.value IN (SELECT value FROM json_each(?)) AND ${READABLE_PUBLISHED}
         GROUP BY p.id ORDER BY overlap DESC, p.published_at DESC LIMIT ?`,
        input.pageId,
        JSON.stringify(input.tags),
        ...publishedBindings(input.scope),
        input.limit,
      ),
      (rows) =>
        rows.map((row) => ({ pageId: row.page_id, spaceKey: row.space_key, title: row.title })),
    );
  }

  /** Tags used by readable content (published, plus drafts where authoring is allowed). */
  async tags(input: {
    scope: ReadScope;
    spaceId?: string;
  }): Result.ResultAsync<string[], KnowledgeStoreError> {
    const published = await this.sql.all<{ value: string }>(
      `SELECT DISTINCT t.value FROM pages p
       JOIN revisions r ON r.id = p.published_revision_id
       JOIN spaces s ON s.id = p.space_id
       JOIN json_each(r.tags_json) t
       WHERE ${READABLE_PUBLISHED} AND (? IS NULL OR p.space_id = ?)`,
      ...publishedBindings(input.scope),
      input.spaceId ?? null,
      input.spaceId ?? null,
    );
    if (Result.isFailure(published)) return published;
    const authoring =
      input.scope.authoringSpaceIds.length === 0
        ? Result.succeed<Array<{ value: string }>>([])
        : await this.sql.all<{ value: string }>(
            `SELECT DISTINCT t.value FROM pages p
             JOIN drafts d ON d.page_id = p.id
             JOIN spaces s ON s.id = p.space_id
             JOIN json_each(d.tags_json) t
             WHERE ${READABLE_AUTHORING} AND (? IS NULL OR p.space_id = ?)`,
            ...authoringBindings(input.scope),
            input.spaceId ?? null,
            input.spaceId ?? null,
          );
    if (Result.isFailure(authoring)) return authoring;
    return Result.succeed(
      [...new Set([...published.value, ...authoring.value].map((row) => row.value))].sort(),
    );
  }
}
