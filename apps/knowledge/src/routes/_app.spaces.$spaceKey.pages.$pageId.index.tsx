import { createFileRoute } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArrowRightIcon,
  EyeIcon,
  EyeOffIcon,
  ExternalLinkIcon,
  PencilIcon,
} from "lucide-react";
import { useState } from "react";
import type * as React from "react";

import { Pill, TagPill } from "#components/knowledge/badges";
import { MarkdownView } from "#components/knowledge/markdown-view";
import { PublicationPanel } from "#components/knowledge/publication-panel";
import { PublishDialog } from "#components/knowledge/publish-dialog";
import { RevisionHistorySheet } from "#components/knowledge/revision-history";
import { AppLink } from "#components/layout/app-link";
import { Breadcrumbs, PageContainer } from "#components/layout/page";
import { LoadingState, QueryError } from "#components/layout/states";
import { Button } from "#components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#components/ui/dialog";
import { useApiQuery, useMutation } from "#hooks/use-api-query";
import { apiGet, apiSend, pagePath } from "#lib/api-client";
import { relativeTime, SENSITIVITY_LABEL, VISIBILITY_LABEL } from "#lib/format";

import type { PageLinkView, PageView } from "../shared/api.ts";

export const Route = createFileRoute("/_app/spaces/$spaceKey/pages/$pageId/")({
  validateSearch: (search: Record<string, unknown>): { revision?: number } => {
    const revision = Number(search.revision);
    return Number.isSafeInteger(revision) && revision > 0 ? { revision } : {};
  },
  component: PageViewScreen,
});

function PageViewScreen() {
  const { spaceKey, pageId } = Route.useParams();
  const { revision } = Route.useSearch();
  const navigate = Route.useNavigate();
  const path = pagePath(spaceKey, pageId);
  const view = useApiQuery(() => apiGet<PageView>(path), [path]);
  const mutation = useMutation();
  const [publishOpen, setPublishOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(revision !== undefined);

  if (view.status === "error") return <QueryError error={view.error} onRetry={view.refetch} />;
  if (!view.data) {
    return (
      <PageContainer>
        <LoadingState rows={2} />
      </PageContainer>
    );
  }
  const data = view.data;
  const archived = data.page.status === "archived";
  const title = data.published?.title ?? data.draft?.title ?? "Untitled page";
  const waitingApproval = data.publication?.state === "waiting_approval";
  const act = (action: () => Promise<unknown>) => void mutation.run(action).then(view.refetch);
  const selectRevision = (number: number | null) =>
    void navigate({ search: number === null ? {} : { revision: number }, replace: true });

  return (
    <PageContainer>
      <Breadcrumbs
        items={[{ label: data.space.name, href: `/spaces/${data.space.key}` }, { label: title }]}
      />
      {archived ? (
        <Banner tone="neutral">
          <span>This page has been archived.</span>
          {data.access.restore ? (
            <Button
              size="sm"
              variant="outline"
              disabled={mutation.busy}
              onClick={() => act(() => apiSend("POST", `${path}/restore`))}
            >
              Restore
            </Button>
          ) : null}
        </Banner>
      ) : null}
      {waitingApproval && data.publication?.approvalUrl ? (
        <Banner tone="warning">
          <span>This page is awaiting approval before publishing.</span>
          <Button size="sm" variant="outline" asChild>
            <a href={data.publication.approvalUrl}>
              View in Approval <ExternalLinkIcon />
            </a>
          </Button>
        </Banner>
      ) : null}
      {data.pendingArchive ? (
        <Banner tone="warning">
          <span>Archiving this page is waiting for the page owner&apos;s approval.</span>
          <Button size="sm" variant="outline" asChild>
            <a href={data.pendingArchive.approvalUrl}>
              View approval <ExternalLinkIcon />
            </a>
          </Button>
        </Banner>
      ) : null}
      {data.page.reviewState === "update_needed" && !archived ? (
        <Banner tone="warning">
          <span>The owner marked this page as needing an update during a freshness review.</span>
        </Banner>
      ) : null}

      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1.5">
          <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
          <div className="flex flex-wrap items-center gap-2">
            {archived ? (
              <Pill>Archived</Pill>
            ) : data.published ? (
              <Pill tone="success">Published</Pill>
            ) : (
              <Pill>Draft</Pill>
            )}
            {data.published ? (
              <TagPill>{SENSITIVITY_LABEL[data.published.sensitivity]}</TagPill>
            ) : null}
            {waitingApproval ? <Pill tone="warning">Pending approval</Pill> : null}
            {data.draft?.hasUnpublishedChanges && data.published ? (
              <Pill tone="info">Unpublished changes</Pill>
            ) : null}
          </div>
          {data.published ? (
            <p className="text-xs text-muted-foreground">
              {archived ? "Last published as revision" : "Revision"} #
              {data.published.revisionNumber} · {data.published.publishedBy.displayName} ·{" "}
              {relativeTime(data.published.publishedAt)}
              <br />
              Visible to: {VISIBILITY_LABEL[data.published.visibility]} · Owner:{" "}
              {data.page.owner.displayName}
            </p>
          ) : data.draft ? (
            <p className="text-xs text-muted-foreground">
              Draft · Last saved {relativeTime(data.draft.updatedAt)} by{" "}
              {data.draft.updatedBy.displayName}
              <br />
              Not yet published
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {data.access.watch ? (
            <Button
              variant="outline"
              disabled={mutation.busy}
              onClick={() =>
                act(() => apiSend("PUT", `${path}/watch`, { watching: !data.watching }))
              }
            >
              {data.watching ? <EyeOffIcon /> : <EyeIcon />}
              {data.watching ? "Unwatch" : "Watch"}
            </Button>
          ) : null}
          {data.access.archive ? (
            <Button variant="outline" onClick={() => setArchiveOpen(true)}>
              <ArchiveIcon /> Archive
            </Button>
          ) : null}
          {data.access.restore ? (
            <Button
              variant="outline"
              disabled={mutation.busy}
              onClick={() => act(() => apiSend("POST", `${path}/restore`))}
            >
              Restore
            </Button>
          ) : null}
          {data.access.edit ? (
            <Button variant="outline" asChild>
              <AppLink href={`/spaces/${data.space.key}/pages/${data.page.id}/edit`}>
                <PencilIcon /> Edit
              </AppLink>
            </Button>
          ) : archived && data.draft ? (
            <Button variant="outline" disabled>
              Edit
            </Button>
          ) : null}
          {data.access.publish && data.nextPublication ? (
            <Button
              variant={data.draft?.hasUnpublishedChanges ? "default" : "outline"}
              disabled={waitingApproval}
              onClick={() => setPublishOpen(true)}
            >
              {data.draft?.hasUnpublishedChanges ? (
                <span className="size-1.5 rounded-full bg-primary-foreground" aria-hidden />
              ) : null}
              Publish
            </Button>
          ) : archived && data.draft ? (
            <Button variant="outline" disabled>
              Publish
            </Button>
          ) : null}
        </div>
      </header>
      {mutation.error ? <p className="text-sm text-destructive">{mutation.error.title}</p> : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <article className="min-h-80 rounded-xl border bg-card p-6">
          {data.published ? (
            <MarkdownView markdown={data.published.body} />
          ) : data.draft ? (
            <>
              <p className="mb-4 text-xs text-muted-foreground">
                Draft preview — not visible to viewers until published.
              </p>
              <MarkdownView markdown={data.draft.body} />
            </>
          ) : null}
          {data.published && data.published.tags.length > 0 ? (
            <div className="mt-6 flex flex-wrap gap-1">
              {data.published.tags.map((tag) => (
                <TagPill key={tag}>{tag}</TagPill>
              ))}
            </div>
          ) : null}
        </article>
        <aside className="flex flex-col gap-5">
          {data.draft ? (
            <SideSection title={archived ? "Publication history" : "Publication"}>
              {data.publication ? (
                <PublicationPanel publication={data.publication} onChanged={view.refetch} />
              ) : (
                <div className="rounded-xl border bg-card p-4">
                  <p className="font-semibold">No publication history</p>
                  <p className="text-sm text-muted-foreground">
                    Save your draft and publish when ready.
                  </p>
                </div>
              )}
            </SideSection>
          ) : null}
          {data.historyCount !== null ? (
            <SideSection title="History">
              {data.historyCount === 0 ? (
                <p className="text-sm text-muted-foreground">No revisions yet</p>
              ) : (
                <button
                  type="button"
                  className="flex w-fit items-center gap-1 text-sm text-primary hover:underline"
                  onClick={() => setHistoryOpen(true)}
                >
                  View {data.historyCount} {data.historyCount === 1 ? "revision" : "revisions"}{" "}
                  <ArrowRightIcon className="size-3.5" />
                </button>
              )}
            </SideSection>
          ) : null}
          <LinkList title="Related pages" links={data.related} empty="No related pages" />
          <LinkList title="Backlinks" links={data.backlinks} empty="No pages link here" />
        </aside>
      </div>

      {data.nextPublication ? (
        <PublishDialog
          open={publishOpen}
          onOpenChange={setPublishOpen}
          next={data.nextPublication}
          busy={mutation.busy}
          error={mutation.error?.title ?? null}
          onConfirm={() => {
            const next = data.nextPublication;
            if (!next) return;
            void mutation
              .run(() =>
                apiSend("POST", `${path}/publish`, { expectedDraftVersion: next.draftVersion }),
              )
              .then((result) => {
                if (result) setPublishOpen(false);
                view.refetch();
              });
          }}
        />
      ) : null}
      <Dialog open={archiveOpen} onOpenChange={setArchiveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive this page?</DialogTitle>
            <DialogDescription>
              Archived pages disappear from search and lists. ultra-easy may ask the page owner to
              approve.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setArchiveOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={mutation.busy}
              onClick={() => {
                setArchiveOpen(false);
                act(() => apiSend("POST", `${path}/archive`));
              }}
            >
              Archive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {data.access.readHistory ? (
        <RevisionHistorySheet
          spaceKey={spaceKey}
          pageId={pageId}
          open={historyOpen}
          revision={revision ?? null}
          onOpenChange={(open) => {
            setHistoryOpen(open);
            if (!open) selectRevision(null);
          }}
          onSelect={selectRevision}
        />
      ) : null}
    </PageContainer>
  );
}

function Banner({ tone, children }: { tone: "neutral" | "warning"; children: React.ReactNode }) {
  return (
    <div
      role="status"
      className={
        tone === "warning"
          ? "flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning"
          : "flex flex-wrap items-center gap-3 rounded-xl border bg-muted px-4 py-3 text-sm"
      }
    >
      {children}
    </div>
  );
}

function SideSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function LinkList({
  title,
  links,
  empty,
}: {
  title: string;
  links: PageLinkView[];
  empty: string;
}) {
  return (
    <SideSection title={title}>
      {links.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-2 rounded-xl border bg-card p-4">
          {links.map((link) => (
            <li key={link.pageId}>
              <AppLink
                href={`/spaces/${link.spaceKey}/pages/${link.pageId}`}
                className="text-sm hover:underline"
              >
                {link.title}
              </AppLink>
            </li>
          ))}
        </ul>
      )}
    </SideSection>
  );
}
