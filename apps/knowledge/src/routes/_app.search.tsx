import { createFileRoute } from "@tanstack/react-router";
import { SearchIcon, XCircleIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type * as React from "react";

import { PageBadgePill, TagPill } from "#components/knowledge/badges";
import { AppLink } from "#components/layout/app-link";
import { PageContainer, PageHeader } from "#components/layout/page";
import { CardSkeleton, EmptyState, ErrorState } from "#components/layout/states";
import { Button } from "#components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#components/ui/select";
import { useApiQuery } from "#hooks/use-api-query";
import { apiGet } from "#lib/api-client";
import { relativeTime } from "#lib/format";

import type { SearchView } from "../shared/api.ts";

type SearchParams = { q?: string; space?: string; tag?: string };

export const Route = createFileRoute("/_app/search")({
  validateSearch: (search: Record<string, unknown>): SearchParams => {
    const text = (value: unknown) =>
      typeof value === "string" && value.length > 0 ? value : undefined;
    return { q: text(search.q), space: text(search.space), tag: text(search.tag) };
  },
  component: Search,
});

const ALL = "__all__";

/** Highlights FTS snippet markers (\u0002 / \u0003) without injecting HTML. */
function Snippet({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  text.split("\u0002").forEach((segment, index) => {
    if (index === 0) {
      parts.push(segment);
      return;
    }
    const [matched = "", rest = ""] = segment.split("\u0003");
    parts.push(
      <mark key={index} className="rounded bg-accent px-0.5 text-accent-foreground">
        {matched}
      </mark>,
      rest,
    );
  });
  return <p className="text-sm text-muted-foreground">{parts}</p>;
}

function Search() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [draft, setDraft] = useState(search.q ?? "");
  useEffect(() => setDraft(search.q ?? ""), [search.q]);
  const results = useApiQuery(
    () => apiGet<SearchView>("/api/search", { q: search.q, space: search.space, tag: search.tag }),
    [search.q, search.space, search.tag],
  );
  const update = (next: SearchParams) => void navigate({ search: { ...search, ...next } });
  const filtered = Boolean(search.space || search.tag);

  return (
    <PageContainer>
      <PageHeader
        title="Search"
        description="Search pages across all spaces by title, content, and tags."
      />
      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          update({ q: draft.trim() || undefined });
        }}
        className="flex items-center gap-2 rounded-xl border-2 border-ring bg-card px-4 py-3"
      >
        <SearchIcon className="size-5 text-primary" />
        <input
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Search pages"
          aria-label="Search query"
          maxLength={200}
          className="flex-1 bg-transparent text-lg font-medium outline-none"
        />
        {draft ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              setDraft("");
              update({ q: undefined });
            }}
          >
            <XCircleIcon className="size-5 text-muted-foreground" />
          </button>
        ) : null}
      </form>
      <div className="flex flex-wrap items-center gap-3">
        <Select
          value={search.space ?? ALL}
          onValueChange={(value) => update({ space: value === ALL ? undefined : value })}
        >
          <SelectTrigger className="w-48" aria-label="Filter by space">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Space: All spaces</SelectItem>
            {(results.data?.spaces ?? []).map((space) => (
              <SelectItem key={space.key} value={space.key}>
                Space: {space.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={search.tag ?? ALL}
          onValueChange={(value) => update({ tag: value === ALL ? undefined : value })}
        >
          <SelectTrigger className="w-48" aria-label="Filter by tag">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Tags: All tags</SelectItem>
            {(results.data?.tags ?? []).map((tag) => (
              <SelectItem key={tag} value={tag}>
                Tags: {tag}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {filtered ? (
          <Button variant="ghost" onClick={() => update({ space: undefined, tag: undefined })}>
            Reset filters
          </Button>
        ) : null}
      </div>

      {results.status === "error" ? (
        results.error.code === "validation_error" ? (
          <p role="alert" className="text-sm text-destructive">
            {results.error.title}
          </p>
        ) : (
          <ErrorState compact code={results.error.code} onRetry={results.refetch} />
        )
      ) : !search.q ? (
        <EmptyState
          icon={SearchIcon}
          title="Search your workspace"
          description="Type a keyword to search titles, content and tags you have access to."
        />
      ) : results.status === "loading" ? (
        <div className="flex flex-col gap-3" role="status" aria-label="Searching">
          <CardSkeleton />
          <CardSkeleton />
        </div>
      ) : results.data ? (
        <>
          <p className="text-sm text-muted-foreground">
            {results.data.results.length} {results.data.results.length === 1 ? "result" : "results"}{" "}
            for &quot;
            {results.data.query}&quot;
          </p>
          {results.data.results.length === 0 ? (
            <EmptyState
              icon={SearchIcon}
              title="No results found"
              description="Try different keywords or check your spelling."
              action={
                <Button
                  variant="link"
                  onClick={() => {
                    setDraft("");
                    update({ q: undefined, space: undefined, tag: undefined });
                  }}
                >
                  Clear search
                </Button>
              }
            />
          ) : (
            <ul className="flex flex-col gap-3">
              {results.data.results.map((result) => (
                <li
                  key={result.pageId}
                  className="flex flex-col gap-2 rounded-xl border bg-card p-5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <AppLink
                      href={`/spaces/${result.spaceKey}/pages/${result.pageId}`}
                      className="text-lg font-semibold text-primary hover:underline"
                    >
                      {result.title}
                    </AppLink>
                    <PageBadgePill badge={result.badge} />
                  </div>
                  <Snippet text={result.snippet} />
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>{result.spaceName}</span>
                    {result.tags.map((tag) => (
                      <TagPill key={tag}>{tag}</TagPill>
                    ))}
                    <span>Updated {relativeTime(result.timestamp)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </PageContainer>
  );
}
