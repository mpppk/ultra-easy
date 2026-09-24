import { PlusIcon, RefreshCwIcon, SearchIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";

import type { ManagedRelationshipCatalog } from "@app/approval-core";

import { PageSection, Toolbar } from "#components/layout/page";
import { EmptyState, ErrorState, LoadingState } from "#components/layout/states";
import { Alert, AlertDescription, AlertTitle } from "#components/ui/alert";
import { Button } from "#components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#components/ui/dialog";
import { Input } from "#components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "#components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#components/ui/table";
import {
  adminPath,
  ConsoleApiError,
  consoleGet,
  consolePost,
  type ActionRequestView,
  type ConsoleCatalog,
  type Page,
  type RelationshipDetail,
  type RelationshipView,
} from "#lib/console-client";
import { useConsoleQuery } from "#hooks/use-console-query";

import { useConsoleSession } from "./console-session.tsx";
import { CopyableId } from "./copyable-id.tsx";
import { ActionRequestStatusBadge, SyncStatusBadge } from "./status-badges.tsx";

const ANY = "__any__";

/**
 * Catalog entries the console may offer for mutation. `authorization_admin`
 * is never offered (bootstrap-only); the server rejects it regardless.
 */
export function mutableCatalogEntries(catalog: ManagedRelationshipCatalog) {
  return catalog.filter((entry) => entry.objectType !== "authorization_admin");
}

export type RelationshipDraft = {
  operation: "write" | "delete";
  catalogKey: string;
  userId: string;
  objectId: string;
};

/** The exact governed ActionRequest (1 ActionRequest = 1 tuple mutation). */
export function relationshipActionRequest(draft: RelationshipDraft) {
  const [objectType, relation] = draft.catalogKey.split("#");
  return {
    action: {
      type: "authorization.relationship.update",
      resource: { type: "authorization_admin", id: "root" },
      input: {
        operation: draft.operation,
        tuple: {
          user: draft.userId.trim(),
          relation: relation ?? "",
          object: `${objectType ?? ""}:${draft.objectId.trim()}`,
        },
      },
    },
  };
}

type RelationshipOutput = {
  relationship?: {
    status?: string;
    effectConfirmed?: boolean;
    revision?: number;
    mutationKey?: string;
  };
};

/** Explains a submitted change without implying "changed" before confirmation. */
export function submissionSummary(view: ActionRequestView): {
  requestStatus: string;
  syncStatus: string | null;
  message: string;
} {
  const output = (view.result?.output ?? null) as RelationshipOutput | null;
  const syncStatus = output?.relationship?.status ?? null;
  if (view.status === "pending_approval") {
    return {
      requestStatus: view.status,
      syncStatus,
      message: "Waiting for approval. The relationship has not been changed.",
    };
  }
  if (view.status !== "executed") {
    return {
      requestStatus: view.status,
      syncStatus,
      message: `Not applied (${view.result?.code ?? view.status}).`,
    };
  }
  if (syncStatus === "confirmed") {
    return {
      requestStatus: view.status,
      syncStatus,
      message: "Effect confirmed in FGA (observed).",
    };
  }
  if (syncStatus === "superseded") {
    return {
      requestStatus: view.status,
      syncStatus,
      message: "Superseded: a newer change to this relationship took precedence.",
    };
  }
  return {
    requestStatus: view.status,
    syncStatus,
    message:
      "Intent recorded but the FGA effect is not confirmed yet. Reconciliation will converge to the latest desired state.",
  };
}

function MutationDialog({
  open,
  onOpenChange,
  catalog,
  initial,
  onSubmitted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  catalog: ManagedRelationshipCatalog;
  initial: RelationshipDraft;
  onSubmitted: () => void;
}) {
  const entries = mutableCatalogEntries(catalog);
  const [draft, setDraft] = useState(initial);
  const [submitted, setSubmitted] = useState<ActionRequestView>();
  const [error, setError] = useState<ConsoleApiError>();
  const [busy, setBusy] = useState(false);
  const request = relationshipActionRequest(draft);
  const destructive = draft.operation === "delete";
  const locked = initial.userId !== "" && initial.objectId !== "";

  async function submit() {
    setBusy(true);
    setError(undefined);
    try {
      const view = await consolePost<ActionRequestView>("/api/action-requests", request, {
        "idempotency-key": crypto.randomUUID(),
      });
      setSubmitted(view);
      onSubmitted();
    } catch (caught) {
      setError(
        caught instanceof ConsoleApiError
          ? caught
          : new ConsoleApiError(0, "network_error", String(caught)),
      );
    } finally {
      setBusy(false);
    }
  }

  async function refreshStatus() {
    if (!submitted) return;
    setBusy(true);
    try {
      setSubmitted(
        await consoleGet<ActionRequestView>(
          `/api/action-requests/${encodeURIComponent(submitted.id)}`,
        ),
      );
      onSubmitted();
    } catch (caught) {
      if (caught instanceof ConsoleApiError) setError(caught);
    } finally {
      setBusy(false);
    }
  }

  const summary = submitted ? submissionSummary(submitted) : null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{destructive ? "Delete relationship" : "Add relationship"}</DialogTitle>
          <DialogDescription>
            Creates an <code>authorization.relationship.update</code> ActionRequest. It goes through
            authorization, approval policy and re-authorization; FGA is never written directly.
          </DialogDescription>
        </DialogHeader>
        {!submitted ? (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm">
              Relationship (Managed Relationship Catalog)
              <Select
                value={draft.catalogKey}
                disabled={locked}
                onValueChange={(catalogKey) => setDraft({ ...draft, catalogKey })}
              >
                <SelectTrigger aria-label="Relationship type">
                  <SelectValue placeholder="Select object type # relation" />
                </SelectTrigger>
                <SelectContent>
                  {entries.map((entry) => (
                    <SelectItem
                      key={`${entry.objectType}#${entry.relation}`}
                      value={`${entry.objectType}#${entry.relation}`}
                    >
                      {entry.objectType}#{entry.relation} — {entry.description}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Subject (stable user ID, not email)
              <Input
                placeholder="user:auth0|…"
                value={draft.userId}
                disabled={locked}
                onChange={(event) => setDraft({ ...draft, userId: event.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Object ID (logical, without organization)
              <Input
                placeholder="T-123"
                value={draft.objectId}
                disabled={locked}
                onChange={(event) => setDraft({ ...draft, objectId: event.target.value })}
              />
            </label>
            <details className="text-sm" open>
              <summary className="cursor-pointer text-muted-foreground">
                ActionRequest preview (1 request = 1 tuple mutation)
              </summary>
              <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted p-2 text-xs">
                {JSON.stringify(request, null, 2)}
              </pre>
            </details>
            {destructive ? (
              <Alert variant="destructive">
                <AlertTitle>This removes access once applied</AlertTitle>
                <AlertDescription>
                  Confirm the subject and object. The change is audited and may need approval.
                </AlertDescription>
              </Alert>
            ) : null}
            {error ? <ErrorState title="Submission rejected" code={error.code} /> : null}
          </div>
        ) : (
          <div data-slot="submission-result" className="flex flex-col gap-2 text-sm">
            <p className="flex flex-wrap items-center gap-2">
              ActionRequest <CopyableId value={submitted.id} label="ActionRequest id" />
            </p>
            <p className="flex flex-wrap items-center gap-2">
              Request: <ActionRequestStatusBadge status={summary?.requestStatus ?? ""} />
              Relationship:{" "}
              {summary?.syncStatus ? (
                <SyncStatusBadge status={summary.syncStatus} />
              ) : (
                <span className="text-muted-foreground">not changed</span>
              )}
            </p>
            <p>{summary?.message}</p>
            {error ? <ErrorState title="Status refresh failed" code={error.code} /> : null}
          </div>
        )}
        <DialogFooter>
          {!submitted ? (
            <Button
              variant={destructive ? "destructive" : "default"}
              disabled={busy || !draft.catalogKey || !draft.userId.trim() || !draft.objectId.trim()}
              onClick={() => void submit()}
            >
              {destructive ? <Trash2Icon aria-hidden /> : <PlusIcon aria-hidden />}
              {destructive ? "Submit delete request" : "Submit add request"}
            </Button>
          ) : (
            <Button variant="outline" disabled={busy} onClick={() => void refreshStatus()}>
              <RefreshCwIcon aria-hidden /> Refresh status
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RelationshipDetailSheet({
  tupleKey,
  onClose,
}: {
  tupleKey: string | null;
  onClose: () => void;
}) {
  const [observe, setObserve] = useState(false);
  const detail = useConsoleQuery(
    tupleKey
      ? () =>
          consoleGet<RelationshipDetail>(
            adminPath(`/relationships/${encodeURIComponent(tupleKey)}`),
            observe ? { observe: "true" } : undefined,
          )
      : null,
    [tupleKey, observe],
  );
  return (
    <Sheet
      open={tupleKey !== null}
      onOpenChange={(open) => {
        if (!open) {
          setObserve(false);
          onClose();
        }
      }}
    >
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>Relationship</SheetTitle>
          <SheetDescription>
            Desired state, mutation journal and provider inspection.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-3 px-4 pb-6 text-sm">
          {detail.status === "error" ? (
            <ErrorState title="Could not load relationship" code={detail.error.code} />
          ) : !detail.data ? (
            <LoadingState />
          ) : (
            <>
              <p>
                <code className="font-mono">
                  {detail.data.relationship.subject} {detail.data.relationship.relation}{" "}
                  {detail.data.relationship.object}
                </code>
              </p>
              <p className="flex items-center gap-2">
                Desired <strong>{detail.data.relationship.desiredState}</strong> (rev{" "}
                {detail.data.relationship.revision}) ·{" "}
                <SyncStatusBadge status={detail.data.relationship.syncStatus} />
              </p>
              <details>
                <summary className="cursor-pointer text-muted-foreground">
                  Provider refs (details)
                </summary>
                <p>
                  logical:{" "}
                  <CopyableId value={detail.data.relationship.object} label="logical object" />
                </p>
                <p>
                  provider:{" "}
                  <CopyableId
                    value={detail.data.relationship.providerObject}
                    label="provider object"
                  />
                </p>
                <p>
                  tuple key:{" "}
                  <CopyableId value={detail.data.relationship.tupleKey} label="tuple key" />
                </p>
              </details>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => setObserve(true)}>
                  <SearchIcon aria-hidden /> Inspect FGA state
                </Button>
                {detail.data.provider ? (
                  detail.data.provider.error ? (
                    <span className="text-destructive">
                      provider error <code>{detail.data.provider.error}</code>
                    </span>
                  ) : (
                    <span>
                      FGA observed: <strong>{detail.data.provider.observedState}</strong>
                    </span>
                  )
                ) : null}
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Rev</TableHead>
                    <TableHead>Operation</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>ActionRequest</TableHead>
                    <TableHead>Error</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.data.mutations.map((mutation) => (
                    <TableRow key={mutation.mutationKey}>
                      <TableCell>{mutation.revision}</TableCell>
                      <TableCell>{mutation.operation}</TableCell>
                      <TableCell>
                        <SyncStatusBadge status={mutation.status} />
                      </TableCell>
                      <TableCell>
                        <CopyableId value={mutation.actionRequestId} label="ActionRequest id" />
                      </TableCell>
                      <TableCell>{mutation.lastErrorCode ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

type Filters = { subject: string; relation: string; object: string; syncStatus: string };

export function RelationshipsTable({
  items,
  canEdit,
  onInspect,
  onDelete,
}: {
  items: RelationshipView[];
  canEdit: boolean;
  onInspect: (tupleKey: string) => void;
  onDelete: (item: RelationshipView) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Subject</TableHead>
          <TableHead>Relation</TableHead>
          <TableHead>Object</TableHead>
          <TableHead>Desired</TableHead>
          <TableHead title="desired revision / confirmed revision">Rev / confirmed</TableHead>
          <TableHead>Sync</TableHead>
          <TableHead>Last changed</TableHead>
          <TableHead>Source ActionRequest</TableHead>
          <TableHead>
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => (
          <TableRow key={item.tupleKey}>
            <TableCell>
              <CopyableId value={item.subject} label="subject" />
            </TableCell>
            <TableCell>{item.relation}</TableCell>
            <TableCell>{item.object}</TableCell>
            <TableCell>{item.desiredState}</TableCell>
            <TableCell>
              {item.revision} / {item.confirmedRevision ?? "—"}
            </TableCell>
            <TableCell>
              <SyncStatusBadge status={item.syncStatus} />
            </TableCell>
            <TableCell className="text-xs" title={item.updatedAt}>
              {item.updatedAt.slice(0, 16).replace("T", " ")}
            </TableCell>
            <TableCell>
              <CopyableId value={item.sourceActionRequestId} label="source ActionRequest" />
            </TableCell>
            <TableCell className="flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => onInspect(item.tupleKey)}>
                Inspect
              </Button>
              {canEdit && item.managed && item.desiredState === "present" ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  aria-label={`Delete ${item.subject} ${item.relation} ${item.object}`}
                  onClick={() => onDelete(item)}
                >
                  <Trash2Icon aria-hidden />
                </Button>
              ) : null}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function RelationshipsPage({ catalog }: { catalog: ConsoleCatalog | undefined }) {
  const session = useConsoleSession();
  const [draftFilters, setDraftFilters] = useState<Filters>({
    subject: "",
    relation: ANY,
    object: "",
    syncStatus: ANY,
  });
  const [filters, setFilters] = useState(draftFilters);
  const [cursors, setCursors] = useState<string[]>([]);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ key: number; initial: RelationshipDraft } | null>(null);
  const cursor = cursors.at(-1);
  const params = useMemo(
    () => ({
      subject: filters.subject || undefined,
      relation: filters.relation === ANY ? undefined : filters.relation,
      object: filters.object || undefined,
      syncStatus: filters.syncStatus === ANY ? undefined : filters.syncStatus,
      cursor,
      limit: "25",
    }),
    [filters, cursor],
  );
  const page = useConsoleQuery(
    () => consoleGet<Page<RelationshipView>>(adminPath("/relationships"), params),
    [params],
  );
  const relations = [
    ...new Set((catalog?.managedRelationships ?? []).map((entry) => entry.relation)),
  ];

  return (
    <PageSection
      title="Relationships"
      description="Console-managed relationships from the tenant's desired-state journal (never a shared FGA store scan)."
      actions={
        session.permissions.editor && catalog ? (
          <Button
            onClick={() =>
              setDialog({
                key: Date.now(),
                initial: { operation: "write", catalogKey: "", userId: "", objectId: "" },
              })
            }
          >
            <PlusIcon aria-hidden /> Add relationship
          </Button>
        ) : null
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setCursors([]);
          setFilters(draftFilters);
        }}
      >
        <Toolbar>
          <label className="flex flex-col gap-1 text-sm">
            Subject
            <Input
              value={draftFilters.subject}
              onChange={(event) =>
                setDraftFilters({ ...draftFilters, subject: event.target.value })
              }
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Relation
            <Select
              value={draftFilters.relation}
              onValueChange={(relation) => setDraftFilters({ ...draftFilters, relation })}
            >
              <SelectTrigger className="w-40" aria-label="Relation filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>any</SelectItem>
                {relations.map((relation) => (
                  <SelectItem key={relation} value={relation}>
                    {relation}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Object (type:id)
            <Input
              value={draftFilters.object}
              onChange={(event) => setDraftFilters({ ...draftFilters, object: event.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Sync status
            <Select
              value={draftFilters.syncStatus}
              onValueChange={(syncStatus) => setDraftFilters({ ...draftFilters, syncStatus })}
            >
              <SelectTrigger className="w-40" aria-label="Sync status filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>any</SelectItem>
                {(catalog?.syncStatuses ?? []).map((status) => (
                  <SelectItem key={status} value={status}>
                    {status}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <Button type="submit" variant="outline">
            <SearchIcon aria-hidden /> Filter
          </Button>
          <Button type="button" variant="ghost" onClick={() => page.refetch()}>
            <RefreshCwIcon aria-hidden /> Refresh
          </Button>
        </Toolbar>
      </form>
      {page.status === "error" ? (
        <ErrorState title="Could not load relationships" code={page.error.code} />
      ) : !page.data ? (
        <LoadingState />
      ) : page.data.items.length === 0 ? (
        <EmptyState
          title="No console-managed relationships"
          description="Relationships appear here after a governed change is requested."
        />
      ) : (
        <RelationshipsTable
          items={page.data.items}
          canEdit={session.permissions.editor}
          onInspect={setInspecting}
          onDelete={(item) =>
            setDialog({
              key: Date.now(),
              initial: {
                operation: "delete",
                catalogKey: `${item.objectType}#${item.relation}`,
                userId: item.subject,
                objectId: item.object.slice(item.object.indexOf(":") + 1),
              },
            })
          }
        />
      )}
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={cursors.length === 0}
          onClick={() => setCursors(cursors.slice(0, -1))}
        >
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!page.data?.nextCursor}
          onClick={() => page.data?.nextCursor && setCursors([...cursors, page.data.nextCursor])}
        >
          Next
        </Button>
      </div>
      {dialog && catalog ? (
        <MutationDialog
          key={dialog.key}
          open
          onOpenChange={(open) => !open && setDialog(null)}
          catalog={catalog.managedRelationships}
          initial={dialog.initial}
          onSubmitted={() => page.refetch()}
        />
      ) : null}
      <RelationshipDetailSheet tupleKey={inspecting} onClose={() => setInspecting(null)} />
    </PageSection>
  );
}
