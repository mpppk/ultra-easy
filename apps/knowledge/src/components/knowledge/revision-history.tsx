import { ArrowLeftIcon } from "lucide-react";

import { MarkdownView } from "#components/knowledge/markdown-view";
import { Pill, TagPill } from "#components/knowledge/badges";
import { ErrorState, LoadingState } from "#components/layout/states";
import { Button } from "#components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "#components/ui/sheet";
import { useApiQuery } from "#hooks/use-api-query";
import { apiGet, pagePath } from "#lib/api-client";
import { dateTime, SENSITIVITY_LABEL, VISIBILITY_LABEL } from "#lib/format";

import type { RevisionDetailView, RevisionSummaryView } from "../../shared/api.ts";

/** Revision history + read-only revision detail (drawer, not a separate screen). */
export function RevisionHistorySheet({
  spaceKey,
  pageId,
  open,
  revision,
  onOpenChange,
  onSelect,
}: {
  spaceKey: string;
  pageId: string;
  open: boolean;
  revision: number | null;
  onOpenChange: (open: boolean) => void;
  onSelect: (revision: number | null) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        {revision === null ? (
          <HistoryList spaceKey={spaceKey} pageId={pageId} onSelect={onSelect} />
        ) : (
          <RevisionDetail
            spaceKey={spaceKey}
            pageId={pageId}
            number={revision}
            onBack={() => onSelect(null)}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function HistoryList({
  spaceKey,
  pageId,
  onSelect,
}: {
  spaceKey: string;
  pageId: string;
  onSelect: (revision: number) => void;
}) {
  const query = useApiQuery(
    () => apiGet<RevisionSummaryView[]>(`${pagePath(spaceKey, pageId)}/revisions`),
    [spaceKey, pageId],
  );
  return (
    <>
      <SheetHeader>
        <SheetTitle>Revision history</SheetTitle>
        <SheetDescription>
          Immutable revisions and the publications that pinned them.
        </SheetDescription>
      </SheetHeader>
      <div className="px-4 pb-6">
        {query.status === "error" ? (
          <ErrorState compact code={query.error.code} onRetry={query.refetch} />
        ) : !query.data ? (
          <LoadingState rows={2} />
        ) : (
          <ol className="flex flex-col divide-y rounded-lg border">
            {query.data.map((entry) => (
              <li key={entry.number}>
                <button
                  type="button"
                  onClick={() => onSelect(entry.number)}
                  className="flex w-full flex-col gap-1 p-3 text-left hover:bg-muted"
                >
                  <span className="flex items-center gap-2 text-sm font-medium">
                    Revision #{entry.number}
                    {entry.current ? <Pill tone="success">Current published</Pill> : null}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {entry.title} · {entry.createdBy.displayName} · {dateTime(entry.createdAt)}
                  </span>
                  {entry.publications.map((publication) => (
                    <span key={publication.snapshotId} className="text-xs text-muted-foreground">
                      Publication {publication.snapshotId}:{" "}
                      {VISIBILITY_LABEL[publication.visibility]} /{" "}
                      {SENSITIVITY_LABEL[publication.sensitivity]} — {publication.outcome}
                    </span>
                  ))}
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </>
  );
}

function RevisionDetail({
  spaceKey,
  pageId,
  number,
  onBack,
}: {
  spaceKey: string;
  pageId: string;
  number: number;
  onBack: () => void;
}) {
  const query = useApiQuery(
    () => apiGet<RevisionDetailView>(`${pagePath(spaceKey, pageId)}/revisions/${number}`),
    [spaceKey, pageId, number],
  );
  return (
    <>
      <SheetHeader>
        <Button variant="ghost" size="sm" className="w-fit" onClick={onBack}>
          <ArrowLeftIcon /> All revisions
        </Button>
        <SheetTitle>Revision #{number}</SheetTitle>
        <SheetDescription>Read-only immutable content.</SheetDescription>
      </SheetHeader>
      <div className="flex flex-col gap-3 px-4 pb-6">
        {query.status === "error" ? (
          <ErrorState compact code={query.error.code} onRetry={query.refetch} />
        ) : !query.data ? (
          <LoadingState rows={1} />
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              {query.data.createdBy.displayName} · {dateTime(query.data.createdAt)}
            </p>
            <div className="flex flex-wrap gap-1">
              {query.data.tags.map((tag) => (
                <TagPill key={tag}>{tag}</TagPill>
              ))}
            </div>
            <div className="rounded-lg border p-4">
              <MarkdownView markdown={query.data.body} />
            </div>
          </>
        )}
      </div>
    </>
  );
}
