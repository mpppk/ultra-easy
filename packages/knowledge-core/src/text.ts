import { Result } from "@praha/byethrow";

/** Page paths inside Markdown links: `/spaces/<key>/pages/<pageId>`. */
const PAGE_LINK =
  /\]\(\s*(?:https?:\/\/[^/\s)]+)?\/spaces\/[a-z][a-z0-9-]*\/pages\/([a-z0-9_]{3,40})/g;

/** Page IDs a Markdown body links to (deduplicated, in order of appearance). */
export function extractPageLinks(markdown: string): string[] {
  return [...new Set([...markdown.matchAll(PAGE_LINK)].map((match) => match[1] ?? ""))].filter(
    (id) => id.length > 0,
  );
}

export class SearchQueryError extends Error {
  constructor(
    readonly code: "empty_query" | "query_too_long",
    message: string,
  ) {
    super(message);
    this.name = "SearchQueryError";
  }
}

const MAX_TERMS = 8;

/**
 * Turns free text into a safe FTS5 MATCH expression: every term is quoted
 * (FTS operators in user input have no effect) and prefix-matched.
 */
export function ftsMatchExpression(query: string): Result.Result<string, SearchQueryError> {
  const terms = query
    .split(/[\s"]+/u)
    .map((term) => term.replace(/[^\p{L}\p{N}_-]/gu, ""))
    .filter((term) => term.length > 0);
  if (terms.length === 0) {
    return Result.fail(new SearchQueryError("empty_query", "Enter a search term"));
  }
  if (terms.length > MAX_TERMS) {
    return Result.fail(
      new SearchQueryError("query_too_long", `Use at most ${MAX_TERMS} search terms`),
    );
  }
  return Result.succeed(terms.map((term) => `"${term}"*`).join(" "));
}

/** Plain-text excerpt of Markdown (for cards when no FTS snippet exists). */
export function markdownExcerpt(markdown: string, maxLength = 180): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_`>|~-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}

export function wordCount(markdown: string): number {
  return markdown.split(/\s+/u).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

const ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

/** Random, URL-safe identifier (`<prefix>_<12 chars>`). */
export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let id = "";
  for (const byte of bytes) id += ID_ALPHABET[byte % ID_ALPHABET.length];
  return `${prefix}_${id}`;
}

export const STALE_AFTER_DAYS = 90;

/** Published pages not reviewed / republished within the window are stale. */
export function isStale(
  page: { status: string; publishedAt: string | null; lastReviewedAt: string | null },
  now: Date,
  staleAfterDays = STALE_AFTER_DAYS,
): boolean {
  if (page.status !== "active" || page.publishedAt === null) return false;
  const reference = Math.max(
    Date.parse(page.publishedAt),
    page.lastReviewedAt ? Date.parse(page.lastReviewedAt) : 0,
  );
  return now.getTime() - reference > staleAfterDays * 24 * 60 * 60 * 1000;
}
