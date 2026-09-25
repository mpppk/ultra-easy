import { createFileRoute } from "@tanstack/react-router";
import {
  CheckIcon,
  CircleDashedIcon,
  CircleIcon,
  ExternalLinkIcon,
  PlayIcon,
  RotateCwIcon,
  WorkflowIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";
import type * as React from "react";

import { Pill, statusTone } from "#components/knowledge/badges";
import { EFFECT_ACTION } from "#components/knowledge/publication-panel";
import { AppLink } from "#components/layout/app-link";
import { PageContainer, PageHeader } from "#components/layout/page";
import { CardSkeleton, EmptyState, ErrorState, QueryError } from "#components/layout/states";
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
import { dateTime, relativeTime, SENSITIVITY_LABEL, VISIBILITY_LABEL } from "#lib/format";
import { cn } from "#lib/utils";

import type {
  AutomationCategory,
  AutomationDetailView,
  AutomationView,
  StepStatus,
} from "../shared/api.ts";

type Params = { tab?: AutomationCategory; run?: string };

const TABS: Array<{ key: AutomationCategory; label: string }> = [
  { key: "running", label: "Running" },
  { key: "waiting", label: "Waiting" },
  { key: "needs_attention", label: "Needs attention" },
  { key: "completed", label: "Completed" },
];

export const Route = createFileRoute("/_app/automation")({
  validateSearch: (search: Record<string, unknown>): Params => ({
    ...(TABS.some((tab) => tab.key === search.tab)
      ? { tab: search.tab as AutomationCategory }
      : {}),
    ...(typeof search.run === "string" && search.run ? { run: search.run } : {}),
  }),
  component: Automation,
});

function Automation() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const list = useApiQuery(() => apiGet<AutomationView>("/api/automation"), []);
  const items = list.data?.items ?? [];
  const selected = items.find((item) => item.runId === search.run);
  const tab: AutomationCategory =
    search.tab ??
    selected?.category ??
    (items.some((item) => item.category === "needs_attention") ? "needs_attention" : "running");
  const visible = items.filter((item) => item.category === tab);
  const [maintenanceSpace, setMaintenanceSpace] = useState<string>("");
  const maintenance = useMutation();

  if (list.status === "error") return <QueryError error={list.error} onRetry={list.refetch} />;
  const spaces = list.data?.spaces ?? [];
  const chosenSpace = maintenanceSpace || spaces[0]?.key || "";

  return (
    <PageContainer className="max-w-7xl">
      <PageHeader
        title="Automation"
        description="Knowledge lifecycle workflows: publication, post-publish effects and maintenance."
        actions={
          spaces.length > 0 ? (
            <div className="flex items-center gap-2">
              <Select value={chosenSpace} onValueChange={setMaintenanceSpace}>
                <SelectTrigger className="w-44" aria-label="Space to maintain">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {spaces.map((space) => (
                    <SelectItem key={space.key} value={space.key}>
                      {space.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                disabled={maintenance.busy || !chosenSpace}
                onClick={() =>
                  void maintenance
                    .run(() =>
                      apiSend<{ runId: string }>("POST", `/api/spaces/${chosenSpace}/maintenance`),
                    )
                    .then((run) => {
                      list.refetch();
                      if (run) void navigate({ search: { run: run.runId } });
                    })
                }
              >
                <PlayIcon /> Run maintenance
              </Button>
            </div>
          ) : null
        }
      />
      {maintenance.error ? (
        <p className="text-sm text-destructive">{maintenance.error.title}</p>
      ) : null}
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Automation status">
        {TABS.map((entry) => {
          const count = items.filter((item) => item.category === entry.key).length;
          const active = entry.key === tab;
          return (
            <button
              key={entry.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => void navigate({ search: { tab: entry.key } })}
              className={cn(
                "rounded-full border px-4 py-2 text-sm font-medium",
                active
                  ? "border-primary bg-primary text-primary-foreground"
                  : "bg-card hover:bg-muted",
              )}
            >
              {entry.label}
              {count > 0 && (entry.key === "needs_attention" || active) ? ` · ${count}` : ""}
            </button>
          );
        })}
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <section className="flex flex-col gap-3" aria-labelledby="automation-items">
          <div className="flex items-end justify-between">
            <h2 id="automation-items" className="text-lg font-semibold">
              Automation items
            </h2>
            <span className="text-xs text-muted-foreground">{visible.length} items</span>
          </div>
          {!list.data ? (
            <>
              <CardSkeleton lines={1} />
              <CardSkeleton lines={1} />
            </>
          ) : visible.length === 0 ? (
            <EmptyState
              icon={WorkflowIcon}
              title="Nothing here"
              description="No automation items in this state."
            />
          ) : (
            visible.map((item) => (
              <button
                key={item.runId}
                type="button"
                onClick={() => void navigate({ search: { tab, run: item.runId } })}
                className={cn(
                  "flex items-center justify-between gap-3 rounded-xl border bg-card p-4 text-left transition-colors hover:border-ring",
                  item.runId === search.run && "border-primary ring-1 ring-primary",
                )}
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-sm font-medium">{item.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {item.space.name} · {item.category === "completed" ? "Completed" : "Started"}{" "}
                    {relativeTime(item.category === "completed" ? item.updatedAt : item.startedAt)}
                  </span>
                </span>
                <Pill tone={statusTone(item.status)}>{item.statusLabel}</Pill>
              </button>
            ))
          )}
        </section>
        {search.run ? (
          <RunDetail key={search.run} runId={search.run} onChanged={list.refetch} />
        ) : (
          <div className="hidden rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground lg:block">
            Select an item to see its timeline.
          </div>
        )}
      </div>
    </PageContainer>
  );
}

const STEP_ICON: Record<StepStatus, React.ReactNode> = {
  done: <CheckIcon className="size-4 text-success" />,
  running: <CircleDashedIcon className="size-4 animate-spin text-info" />,
  waiting: <CircleIcon className="size-4 text-warning" />,
  pending: <CircleIcon className="size-4 text-muted-foreground/40" />,
  failed: <XIcon className="size-4 text-destructive" />,
  conflict: <XIcon className="size-4 text-destructive" />,
  skipped: <CircleIcon className="size-4 text-muted-foreground/40" />,
  cancelled: <XIcon className="size-4 text-muted-foreground" />,
};

const DECISIONS: Array<{ value: string; label: string }> = [
  { value: "still_valid", label: "Still valid" },
  { value: "update_needed", label: "Needs update" },
  { value: "archive_candidate", label: "Archive candidate" },
];

function RunDetail({ runId, onChanged }: { runId: string; onChanged: () => void }) {
  const detail = useApiQuery(
    () => apiGet<AutomationDetailView>(`/api/automation/${encodeURIComponent(runId)}`),
    [runId],
  );
  const mutation = useMutation();
  const act = (action: () => Promise<unknown>) =>
    void mutation.run(action).then(() => {
      detail.refetch();
      onChanged();
    });
  if (detail.status === "error") {
    return detail.error.status === 404 ? (
      <ErrorState
        compact
        title="Not found or forbidden"
        description="This automation item is not available to you."
      />
    ) : (
      <ErrorState compact code={detail.error.code} onRetry={detail.refetch} />
    );
  }
  if (!detail.data) return <CardSkeleton lines={6} />;
  const run = detail.data;
  const pendingApproval = run.approvals.find((approval) => approval.status === "pending");
  const pageHref = run.page ? `/spaces/${run.space.key}/pages/${run.page.id}` : null;
  return (
    <section
      aria-label="Automation detail"
      className="flex flex-col gap-5 rounded-xl border bg-card p-5"
    >
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">{run.label}</h2>
          <p className="text-xs text-muted-foreground">
            {run.space.name} · Started {relativeTime(run.startedAt)}
          </p>
        </div>
        <Pill tone={statusTone(run.status)}>{run.statusLabel}</Pill>
      </header>

      <div className="flex flex-col gap-2">
        <h3 className="font-semibold">Step timeline</h3>
        <ol className="flex flex-col gap-2">
          {run.steps.map((step) => (
            <li key={step.key} className="flex items-start gap-2 text-sm">
              <span className="mt-0.5">{STEP_ICON[step.status]}</span>
              <span className="flex flex-col">
                <span
                  className={cn(
                    step.status === "waiting" && "text-warning",
                    step.status === "failed" && "text-destructive",
                  )}
                >
                  {step.label}
                </span>
                {step.detail ? (
                  <span className="text-xs text-muted-foreground">{step.detail}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      </div>

      {pendingApproval ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-warning/10 p-3 text-sm">
          <span>Waiting for approval in ultra-easy ({pendingApproval.actionType}).</span>
          <Button size="sm" asChild>
            <a href={pendingApproval.url}>
              View approval <ExternalLinkIcon />
            </a>
          </Button>
        </div>
      ) : null}

      {run.humanInputs.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="font-semibold">Owner review</h3>
          {run.humanInputs.map((input) => (
            <div key={input.key} className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
              <AppLink
                href={`/spaces/${input.spaceKey}/pages/${input.pageId}`}
                className="font-medium hover:underline"
              >
                {input.title}
              </AppLink>
              <p>{input.prompt}</p>
              <p className="text-xs text-muted-foreground">
                Suggestion (LLM, not a decision): {input.analysis}
              </p>
              {input.status === "answered" ? (
                <p className="text-xs">
                  Answered:{" "}
                  <strong>
                    {DECISIONS.find((entry) => entry.value === input.answer)?.label ?? input.answer}
                  </strong>
                </p>
              ) : input.canRespond ? (
                <div className="flex flex-wrap gap-2">
                  {DECISIONS.map((decision) => (
                    <Button
                      key={decision.value}
                      size="sm"
                      variant="outline"
                      disabled={mutation.busy}
                      onClick={() =>
                        act(() =>
                          apiSend("POST", `/api/automation/${run.runId}/inputs/${input.key}`, {
                            answer: decision.value,
                          }),
                        )
                      }
                    >
                      {decision.label}
                    </Button>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Waiting for {input.assignee.displayName}.
                </p>
              )}
            </div>
          ))}
        </div>
      ) : null}

      {run.failure ? (
        <div className="rounded-lg bg-destructive/10 p-3 text-sm" role="alert">
          <p className="font-semibold text-destructive">Failure</p>
          <p className="text-destructive">{run.failure.message}</p>
          <p className="text-xs text-muted-foreground">code: {run.failure.code}</p>
        </div>
      ) : null}
      {mutation.error ? <p className="text-xs text-destructive">{mutation.error.title}</p> : null}
      {run.retryableEffects.length > 0 || pageHref ? (
        <div className="flex flex-wrap gap-2">
          {run.publication
            ? run.retryableEffects.map((effect) => (
                <Button
                  key={effect}
                  size="sm"
                  variant="outline"
                  disabled={mutation.busy}
                  onClick={() =>
                    act(() =>
                      apiSend(
                        "POST",
                        `/api/publications/${run.publication?.snapshotId}/effects/${effect}/retry`,
                      ),
                    )
                  }
                >
                  <RotateCwIcon /> {EFFECT_ACTION[effect]}
                </Button>
              ))
            : null}
          {pageHref ? (
            <Button size="sm" variant="outline" asChild>
              <AppLink href={pageHref}>Open page</AppLink>
            </Button>
          ) : null}
        </div>
      ) : null}

      {run.page || run.publication ? (
        <div className="flex flex-col gap-2">
          <h3 className="font-semibold">Related</h3>
          {run.page && pageHref ? (
            <AppLink href={pageHref} className="rounded-lg border p-3 text-sm hover:border-ring">
              <span className="block font-medium">Page link</span>
              <span className="text-muted-foreground">
                {run.space.name} / {run.page.title}
              </span>
            </AppLink>
          ) : null}
          {run.publication ? (
            <div className="rounded-lg border p-3 text-sm">
              <p className="font-medium">Publication Snapshot</p>
              <p className="text-muted-foreground">
                Revision #{run.publication.revisionNumber} · {run.publication.createdBy.displayName}{" "}
                · {relativeTime(run.publication.createdAt)}
              </p>
              <p className="text-muted-foreground">
                Visible to: {VISIBILITY_LABEL[run.publication.visibility]} ·{" "}
                {SENSITIVITY_LABEL[run.publication.sensitivity]}
              </p>
              <p className="font-mono text-xs text-muted-foreground">
                {run.publication.snapshotId}
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      <details className="text-sm">
        <summary className="cursor-pointer font-semibold">Audit trail</summary>
        <p className="mt-1 text-xs text-muted-foreground">
          WorkflowRun <span className="font-mono">{run.runId}</span> · ActionRequest{" "}
          <span className="font-mono">{run.actionRequestId}</span>
        </p>
        <ol className="mt-2 flex flex-col gap-1">
          {run.audit.map((event, index) => (
            <li key={index} className="text-xs">
              <span className="text-muted-foreground">{dateTime(event.at)}</span> ·{" "}
              <strong>{event.type}</strong> ·{" "}
              <span className="font-mono">{event.actionRequestId}</span> · {event.detail}
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}
