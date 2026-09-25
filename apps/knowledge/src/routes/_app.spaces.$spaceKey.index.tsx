import { createFileRoute } from "@tanstack/react-router";
import { FileTextIcon, PlayIcon, SearchIcon, SettingsIcon } from "lucide-react";
import { useState } from "react";

import { PageBadgePill, RolePill } from "#components/knowledge/badges";
import { CreatePageDialog } from "#components/knowledge/create-dialogs";
import { AppLink, useGo } from "#components/layout/app-link";
import { Breadcrumbs, PageContainer, PageHeader } from "#components/layout/page";
import { EmptyState, LoadingState, QueryError } from "#components/layout/states";
import { Button } from "#components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#components/ui/select";
import { useApiQuery, useMutation } from "#hooks/use-api-query";
import { apiGet, apiSend } from "#lib/api-client";
import { relativeTime } from "#lib/format";

import type { SpaceDetailView } from "../shared/api.ts";

export const Route = createFileRoute("/_app/spaces/$spaceKey/")({
  validateSearch: (search: Record<string, unknown>): { tag?: string } =>
    typeof search.tag === "string" && search.tag ? { tag: search.tag } : {},
  component: SpaceDetail,
});

const ALL = "__all__";

function SpaceDetail() {
  const { spaceKey } = Route.useParams();
  const { tag } = Route.useSearch();
  const navigate = Route.useNavigate();
  const go = useGo();
  const [query, setQuery] = useState("");
  const maintenance = useMutation();
  const detail = useApiQuery(
    () => apiGet<SpaceDetailView>(`/api/spaces/${encodeURIComponent(spaceKey)}`, { tag }),
    [spaceKey, tag],
  );
  if (detail.status === "error")
    return <QueryError error={detail.error} onRetry={detail.refetch} />;
  if (!detail.data) {
    return (
      <PageContainer>
        <LoadingState />
      </PageContainer>
    );
  }
  const { space, pages, tags } = detail.data;
  return (
    <PageContainer>
      <Breadcrumbs items={[{ label: "Spaces", href: "/spaces" }, { label: space.name }]} />
      <PageHeader
        title={space.name}
        badge={<RolePill role={space.role} />}
        description={space.description}
        actions={
          <>
            {detail.data.canRunMaintenance ? (
              <Button
                variant="outline"
                disabled={maintenance.busy}
                onClick={() =>
                  void maintenance
                    .run(() =>
                      apiSend<{ runId: string }>("POST", `/api/spaces/${space.key}/maintenance`),
                    )
                    .then((run) => run && go(`/automation?run=${run.runId}`))
                }
              >
                <PlayIcon /> Run maintenance
              </Button>
            ) : null}
            {detail.data.canAdminister ? (
              <Button variant="outline" asChild>
                <AppLink href={`/spaces/${space.key}/settings`}>
                  <SettingsIcon /> Settings
                </AppLink>
              </Button>
            ) : null}
            {detail.data.canCreatePage ? (
              <CreatePageDialog spaceKey={space.key} trigger={<Button>New page</Button>} />
            ) : null}
          </>
        }
      />
      {maintenance.error ? (
        <p className="text-sm text-destructive">{maintenance.error.title}</p>
      ) : null}
      <form
        role="search"
        className="flex flex-wrap items-center gap-2 rounded-xl border bg-card px-4 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          go(`/search?q=${encodeURIComponent(query)}&space=${encodeURIComponent(space.key)}`);
        }}
      >
        <SearchIcon className="size-4 text-muted-foreground" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={`Search in ${space.name}...`}
          aria-label={`Search in ${space.name}`}
          className="min-w-40 flex-1 bg-transparent text-sm outline-none"
        />
        <Select
          value={tag ?? ALL}
          onValueChange={(value) => void navigate({ search: value === ALL ? {} : { tag: value } })}
        >
          <SelectTrigger size="sm" className="w-40" aria-label="Filter by tag">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All tags</SelectItem>
            {tags.map((entry) => (
              <SelectItem key={entry} value={entry}>
                {entry}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </form>
      {pages.length === 0 ? (
        <EmptyState
          icon={FileTextIcon}
          title={tag ? "No pages with this tag" : "No pages yet"}
          description={
            detail.data.canCreatePage
              ? "Create the first page of this space."
              : "Published pages will appear here."
          }
        />
      ) : (
        <ul className="flex flex-col divide-y rounded-xl border bg-card px-4">
          {pages.map((page) => (
            <li key={page.pageId}>
              <AppLink
                href={`/spaces/${space.key}/pages/${page.pageId}`}
                className="flex items-center justify-between gap-4 py-4 hover:opacity-80"
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-sm font-medium">{page.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {page.tags.length > 0 ? `${page.tags.join(", ")} · ` : ""}
                    {relativeTime(page.updatedAt)}
                  </span>
                  <span className="text-xs text-muted-foreground">by {page.owner.displayName}</span>
                </span>
                <PageBadgePill badge={page.badge} />
              </AppLink>
            </li>
          ))}
        </ul>
      )}
    </PageContainer>
  );
}
