import { Link } from "@tanstack/react-router";
import { RefreshCwIcon, SearchIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { PageSection, Toolbar } from "#components/layout/page";
import { EmptyState, ErrorState, LoadingState } from "#components/layout/states";
import { Alert, AlertDescription, AlertTitle } from "#components/ui/alert";
import { Button } from "#components/ui/button";
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
  consoleGet,
  type ConsoleCatalog,
  type Page,
  type RelationshipAuditView,
} from "#lib/console-client";
import { useConsoleQuery } from "#hooks/use-console-query";

import { CopyableId } from "./copyable-id.tsx";
import { AuditPhaseBadge } from "./status-badges.tsx";

const ANY = "__any__";

type AuditFilters = {
  actor: string;
  eventType: string;
  operation: string;
  subject: string;
  relation: string;
  object: string;
  actionRequestId: string;
  mutationKey: string;
  revision: string;
  from: string;
  to: string;
};

const EMPTY: AuditFilters = {
  actor: "",
  eventType: ANY,
  operation: ANY,
  subject: "",
  relation: "",
  object: "",
  actionRequestId: "",
  mutationKey: "",
  revision: "",
  from: "",
  to: "",
};

export function auditQuery(
  filters: AuditFilters,
  cursor?: string,
): Record<string, string | undefined> {
  const value = (raw: string) => (raw.trim() && raw !== ANY ? raw.trim() : undefined);
  return {
    actor: value(filters.actor),
    eventType: value(filters.eventType),
    operation: value(filters.operation),
    subject: value(filters.subject),
    relation: value(filters.relation),
    object: value(filters.object),
    actionRequestId: value(filters.actionRequestId),
    mutationKey: value(filters.mutationKey),
    revision: value(filters.revision),
    from: filters.from ? new Date(filters.from).toISOString() : undefined,
    to: filters.to ? new Date(filters.to).toISOString() : undefined,
    cursor,
    limit: "50",
  };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[10rem_1fr] gap-2 py-1 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

export function AuditDetail({ event }: { event: RelationshipAuditView }) {
  return (
    <dl data-slot="audit-detail" className="divide-y">
      <Field label="Event">
        <AuditPhaseBadge phase={event.phase} />{" "}
        <code className="font-mono text-xs">{event.type}</code>
      </Field>
      <Field label="Meaning">
        {event.phase === "requested"
          ? "The change was requested and durably recorded. This is not proof that FGA changed."
          : event.phase === "confirmed"
            ? "The provider state was observed equal to the desired state (effect confirmed)."
            : event.phase === "indeterminate"
              ? "The provider effect is unknown; reconciliation converges to the latest desired state."
              : event.phase === "superseded"
                ? "A newer revision of the same tuple exists; this mutation was never sent again."
                : event.phase === "failed"
                  ? "The provider rejected the change; it was not applied."
                  : event.phase === "drift_repaired"
                    ? "Reconciliation re-applied the latest desired state after provider drift."
                    : "An apply attempt started."}
      </Field>
      <Field label="Time">{event.occurredAt}</Field>
      <Field label="Actor">
        <CopyableId value={String(event.actor.id)} label="actor" /> ({event.actor.type})
      </Field>
      <Field label="Source ActionRequest">
        <CopyableId value={event.sourceActionRequestId} label="ActionRequest id" />
      </Field>
      <Field label="Correlation ID">
        <CopyableId value={event.sourceActionRequestId} label="correlation id" />
      </Field>
      <Field label="Mutation">
        <CopyableId value={event.mutationKey} label="mutation key" /> · revision {event.revision}
      </Field>
      <Field label="Operation">
        {event.operation} → desired {event.desiredState}
      </Field>
      <Field label="Tuple (logical)">
        <code className="font-mono text-xs">
          {event.subject} {event.relation} {event.object}
        </code>
      </Field>
      <Field label="Provider object">
        <CopyableId value={event.providerObject} label="provider object" />
      </Field>
      <Field label="Model ID">{event.authorizationModelId}</Field>
      <Field label="Error code">{event.errorCode ?? "—"}</Field>
    </dl>
  );
}

export function AuditTable({
  items,
  onSelect,
}: {
  items: RelationshipAuditView[];
  onSelect: (event: RelationshipAuditView) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Time</TableHead>
          <TableHead>Actor</TableHead>
          <TableHead>Event / result</TableHead>
          <TableHead>Operation</TableHead>
          <TableHead>Subject</TableHead>
          <TableHead>Relation</TableHead>
          <TableHead>Object</TableHead>
          <TableHead>Revision</TableHead>
          <TableHead>ActionRequest</TableHead>
          <TableHead>
            <span className="sr-only">Details</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((event) => (
          <TableRow key={event.eventKey} data-phase={event.phase}>
            <TableCell className="text-xs" title={event.occurredAt}>
              {event.occurredAt.slice(0, 19).replace("T", " ")}
            </TableCell>
            <TableCell>
              <code className="font-mono text-xs">{String(event.actor.id)}</code>
            </TableCell>
            <TableCell>
              <AuditPhaseBadge phase={event.phase} />
            </TableCell>
            <TableCell>{event.operation}</TableCell>
            <TableCell>
              <code className="font-mono text-xs">{event.subject}</code>
            </TableCell>
            <TableCell>{event.relation}</TableCell>
            <TableCell>{event.object}</TableCell>
            <TableCell>{event.revision}</TableCell>
            <TableCell>
              <code className="font-mono text-xs">{event.sourceActionRequestId}</code>
            </TableCell>
            <TableCell>
              <Button size="sm" variant="ghost" onClick={() => onSelect(event)}>
                Details
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function AuditPage({ catalog }: { catalog: ConsoleCatalog | undefined }) {
  const [draft, setDraft] = useState<AuditFilters>(EMPTY);
  const [filters, setFilters] = useState<AuditFilters>(EMPTY);
  const [cursors, setCursors] = useState<string[]>([]);
  const [selected, setSelected] = useState<RelationshipAuditView | null>(null);
  const params = useMemo(() => auditQuery(filters, cursors.at(-1)), [filters, cursors]);
  const page = useConsoleQuery(
    () => consoleGet<Page<RelationshipAuditView>>(adminPath("/audit"), params),
    [params],
  );
  const text = (key: keyof AuditFilters, label: string, type = "text") => (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <Input
        type={type}
        value={draft[key]}
        onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
      />
    </label>
  );

  return (
    <PageSection
      title="Authorization audit"
      description="Append-only relationship mutation events for this organization."
    >
      <Alert>
        <AlertTitle>Requested is not confirmed</AlertTitle>
        <AlertDescription>
          “Requested” records the intent before any FGA call. Only “Effect confirmed” means the
          provider state was observed. Indeterminate events are never shown as success.
        </AlertDescription>
      </Alert>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setCursors([]);
          setFilters(draft);
        }}
      >
        <Toolbar>
          {text("actor", "Actor")}
          <label className="flex flex-col gap-1 text-sm">
            Event
            <Select
              value={draft.eventType}
              onValueChange={(eventType) => setDraft({ ...draft, eventType })}
            >
              <SelectTrigger className="w-64" aria-label="Event type filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>any</SelectItem>
                {(catalog?.auditEventTypes ?? []).map((type) => (
                  <SelectItem key={type} value={type}>
                    {type.replace("authorization.relationship_", "")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Operation
            <Select
              value={draft.operation}
              onValueChange={(operation) => setDraft({ ...draft, operation })}
            >
              <SelectTrigger className="w-28" aria-label="Operation filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>any</SelectItem>
                <SelectItem value="write">write</SelectItem>
                <SelectItem value="delete">delete</SelectItem>
              </SelectContent>
            </Select>
          </label>
          {text("subject", "Subject")}
          {text("relation", "Relation")}
          {text("object", "Object (type:id)")}
          {text("actionRequestId", "ActionRequest")}
          {text("mutationKey", "Mutation key")}
          {text("revision", "Revision", "number")}
          {text("from", "From", "datetime-local")}
          {text("to", "To", "datetime-local")}
          <Button type="submit" variant="outline">
            <SearchIcon aria-hidden /> Filter
          </Button>
          <Button type="button" variant="ghost" onClick={() => page.refetch()}>
            <RefreshCwIcon aria-hidden /> Refresh
          </Button>
        </Toolbar>
      </form>
      {page.status === "error" ? (
        <ErrorState title="Could not load the audit log" code={page.error.code} />
      ) : !page.data ? (
        <LoadingState />
      ) : page.data.items.length === 0 ? (
        <EmptyState title="No audit events match" />
      ) : (
        <AuditTable items={page.data.items} onSelect={setSelected} />
      )}
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={cursors.length === 0}
          onClick={() => setCursors(cursors.slice(0, -1))}
        >
          Newer
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!page.data?.nextCursor}
          onClick={() => page.data?.nextCursor && setCursors([...cursors, page.data.nextCursor])}
        >
          Older
        </Button>
      </div>
      <Sheet open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>Audit event</SheetTitle>
            <SheetDescription>
              Append-only record (no Action input, comments or credentials).
            </SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-3 px-4 pb-6">
            {selected ? (
              <>
                <AuditDetail event={selected} />
                <Link
                  to="/admin/authorization/relationships"
                  className="text-sm underline underline-offset-4"
                >
                  Open Relationships (reconciliation view)
                </Link>
              </>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    </PageSection>
  );
}
