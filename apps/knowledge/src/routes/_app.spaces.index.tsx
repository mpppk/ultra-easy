import { createFileRoute } from "@tanstack/react-router";
import { LayoutGridIcon } from "lucide-react";

import { RolePill, TagPill } from "#components/knowledge/badges";
import { CreateSpaceDialog } from "#components/knowledge/create-dialogs";
import { AppLink } from "#components/layout/app-link";
import { PageContainer, PageHeader } from "#components/layout/page";
import { CardSkeleton, EmptyState, QueryError } from "#components/layout/states";
import { Button } from "#components/ui/button";
import { useApiQuery } from "#hooks/use-api-query";
import { apiGet } from "#lib/api-client";
import { relativeTime } from "#lib/format";

import type { SpacesView } from "../shared/api.ts";

export const Route = createFileRoute("/_app/spaces/")({ component: Spaces });

function Spaces() {
  const spaces = useApiQuery(() => apiGet<SpacesView>("/api/spaces"), []);
  if (spaces.status === "error")
    return <QueryError error={spaces.error} onRetry={spaces.refetch} />;
  const create = spaces.data?.canCreateSpace ? (
    <CreateSpaceDialog trigger={<Button>Create space</Button>} />
  ) : null;
  return (
    <PageContainer>
      <PageHeader
        title="Spaces"
        description="Browse knowledge by team or topic."
        actions={create}
      />
      {!spaces.data ? (
        <div className="grid gap-4 md:grid-cols-2">
          {[0, 1, 2, 3].map((index) => (
            <CardSkeleton key={index} />
          ))}
        </div>
      ) : spaces.data.spaces.length === 0 ? (
        <EmptyState
          icon={LayoutGridIcon}
          title="No spaces yet"
          description="Spaces you are a member of will appear here."
          action={create}
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {spaces.data.spaces.map((space) => (
            <AppLink
              key={space.id}
              href={`/spaces/${space.key}`}
              className="flex flex-col gap-2 rounded-xl border bg-card p-5 transition-colors hover:border-ring"
            >
              <span className="text-2xl font-bold">{space.name}</span>
              <span className="text-xs text-muted-foreground">{space.key}</span>
              {space.description ? <span className="text-sm">{space.description}</span> : null}
              <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <TagPill>
                  {space.publishedPageCount} {space.publishedPageCount === 1 ? "page" : "pages"}
                </TagPill>
                <RolePill role={space.role} />
                {space.lastActivityAt ? (
                  <span>Last activity: {relativeTime(space.lastActivityAt)}</span>
                ) : null}
              </span>
            </AppLink>
          ))}
        </div>
      )}
    </PageContainer>
  );
}
