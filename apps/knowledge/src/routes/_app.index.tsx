import { createFileRoute } from "@tanstack/react-router";
import {
  CircleCheckIcon,
  ExternalLinkIcon,
  FileTextIcon,
  PencilLineIcon,
  RotateCwIcon,
} from "lucide-react";

import { Pill, TagPill } from "#components/knowledge/badges";
import { CreatePageDialog } from "#components/knowledge/create-dialogs";
import { EFFECT_ACTION } from "#components/knowledge/publication-panel";
import { AppLink } from "#components/layout/app-link";
import { PageContainer } from "#components/layout/page";
import { CardSkeleton, EmptyState, ErrorState, QueryError } from "#components/layout/states";
import { Button } from "#components/ui/button";
import { Skeleton } from "#components/ui/skeleton";
import { useApiQuery, useMutation } from "#hooks/use-api-query";
import { apiGet, apiSend } from "#lib/api-client";
import { greeting, relativeTime, VISIBILITY_LABEL } from "#lib/format";

import type { AttentionItem, HomeView } from "../shared/api.ts";

export const Route = createFileRoute("/_app/")({ component: Home });

function Home() {
  const home = useApiQuery(() => apiGet<HomeView>("/api/home"), []);
  if (home.status === "error") return <QueryError error={home.error} onRetry={home.refetch} />;
  const data = home.data;
  return (
    <PageContainer>
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">{greeting()}</h1>
        <p className="text-sm text-muted-foreground">
          Here&apos;s what&apos;s happening across your knowledge workspace.
        </p>
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="flex flex-col gap-3" aria-labelledby="recently-published">
          <h2 id="recently-published" className="text-lg font-semibold">
            Recently published
          </h2>
          {!data ? (
            <>
              <CardSkeleton />
              <CardSkeleton />
              <CardSkeleton />
            </>
          ) : data.failedSections.includes("recentlyPublished") ? (
            <ErrorState compact title="Couldn't load recent pages" onRetry={home.refetch} />
          ) : data.recentlyPublished.length === 0 ? (
            <EmptyState
              icon={FileTextIcon}
              title="No published pages yet"
              description="Pages published across your spaces will appear here."
            />
          ) : (
            data.recentlyPublished.map((page) => (
              <AppLink
                key={page.pageId}
                href={`/spaces/${page.spaceKey}/pages/${page.pageId}`}
                className="flex flex-col gap-1.5 rounded-xl border bg-card p-4 transition-colors hover:border-ring"
              >
                <span className="text-lg font-semibold">{page.title}</span>
                <span className="text-xs text-muted-foreground">
                  {page.spaceName} · updated {relativeTime(page.publishedAt)}
                </span>
                <span className="text-xs text-muted-foreground">by {page.owner.displayName}</span>
                <span>
                  <TagPill>{VISIBILITY_LABEL[page.visibility]}</TagPill>
                </span>
              </AppLink>
            ))
          )}
        </section>
        <section className="flex flex-col gap-3" aria-labelledby="needs-attention">
          <h2 id="needs-attention" className="text-lg font-semibold">
            Needs your attention
          </h2>
          {!data ? (
            <>
              <CardSkeleton lines={2} />
              <CardSkeleton lines={4} />
            </>
          ) : data.failedSections.includes("attention") ? (
            <ErrorState compact title="Couldn't load attention items" onRetry={home.refetch} />
          ) : data.attention.length === 0 ? (
            <EmptyState
              icon={CircleCheckIcon}
              title="All clear!"
              description="No pending reviews or actions right now."
            />
          ) : (
            data.attention.map((item, index) => (
              <AttentionCard
                key={`${item.kind}-${item.pageId}-${index}`}
                item={item}
                onChanged={home.refetch}
              />
            ))
          )}
        </section>
      </div>
      <section className="flex flex-col gap-3" aria-labelledby="recently-edited">
        <h2 id="recently-edited" className="text-lg font-semibold">
          Recently edited
        </h2>
        {!data ? (
          <div className="grid gap-3 md:grid-cols-2">
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
          </div>
        ) : data.failedSections.includes("recentlyEdited") ? (
          <ErrorState compact title="Couldn't load recent edits" onRetry={home.refetch} />
        ) : data.recentlyEdited.length === 0 ? (
          <EmptyState
            icon={PencilLineIcon}
            title="No recent edits"
            description="Your recently edited drafts will show up here."
            action={
              data.creatableSpaces.length > 0 ? (
                <CreatePageDialog
                  trigger={<Button>Create page</Button>}
                  spaces={data.creatableSpaces}
                />
              ) : null
            }
          />
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {data.recentlyEdited.map((page) => (
              <AppLink
                key={page.pageId}
                href={`/spaces/${page.spaceKey}/pages/${page.pageId}`}
                className="flex flex-col gap-1.5 rounded-xl border bg-card p-4 transition-colors hover:border-ring"
              >
                <span className="text-lg font-semibold">{page.title}</span>
                <span className="text-xs text-muted-foreground">
                  {page.spaceName} · edited {relativeTime(page.editedAt)}
                </span>
                <span>
                  {page.state === "draft" ? (
                    <Pill>Draft</Pill>
                  ) : (
                    <Pill tone="info">Unpublished changes</Pill>
                  )}
                </span>
              </AppLink>
            ))}
          </div>
        )}
      </section>
    </PageContainer>
  );
}

const KIND: Record<AttentionItem["kind"], { label: string; tone: "warning" | "danger" | "info" }> =
  {
    stale_review: { label: "Review", tone: "warning" },
    update_needed: { label: "Update needed", tone: "warning" },
    publication_conflict: { label: "Conflict", tone: "danger" },
    effect_failed: { label: "Failed", tone: "danger" },
    approval_pending: { label: "Approval pending", tone: "info" },
  };

function AttentionCard({ item, onChanged }: { item: AttentionItem; onChanged: () => void }) {
  const mutation = useMutation();
  const pageHref = `/spaces/${item.spaceKey}/pages/${item.pageId}`;
  return (
    <div className="flex flex-col gap-2 rounded-xl border bg-card p-4">
      <span>
        <Pill tone={KIND[item.kind].tone}>{KIND[item.kind].label}</Pill>
      </span>
      <AppLink
        href={item.kind === "stale_review" ? `/automation?run=${item.runId}` : pageHref}
        className="text-sm font-semibold hover:underline"
      >
        {item.title}
      </AppLink>
      <p className="text-xs text-muted-foreground">{item.detail}</p>
      {item.kind === "effect_failed" ? (
        <div>
          <Button
            size="sm"
            variant="outline"
            disabled={mutation.busy}
            onClick={() =>
              void mutation
                .run(() =>
                  apiSend(
                    "POST",
                    `/api/publications/${item.snapshotId}/effects/${item.effect}/retry`,
                  ),
                )
                .then(onChanged)
            }
          >
            <RotateCwIcon /> {EFFECT_ACTION[item.effect]}
          </Button>
          {mutation.error ? (
            <p className="mt-1 text-xs text-destructive">{mutation.error.title}</p>
          ) : null}
        </div>
      ) : null}
      {item.kind === "approval_pending" ? (
        <div>
          <Button size="sm" variant="outline" asChild>
            <a href={item.approvalUrl}>
              View approval <ExternalLinkIcon />
            </a>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
