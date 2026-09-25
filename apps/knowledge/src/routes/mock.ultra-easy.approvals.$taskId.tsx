import { createFileRoute } from "@tanstack/react-router";
import { ShieldCheckIcon } from "lucide-react";

import { Pill, statusTone } from "#components/knowledge/badges";
import { ErrorState } from "#components/layout/states";
import { Button } from "#components/ui/button";
import { useApiQuery, useMutation } from "#hooks/use-api-query";
import { apiGet, apiSend } from "#lib/api-client";
import { dateTime } from "#lib/format";

import type { ApprovalTaskPageView } from "../shared/api.ts";

export const Route = createFileRoute("/mock/ultra-easy/approvals/$taskId")({
  component: MockApproval,
});

/**
 * Stand-in for the ultra-easy Approval UI (the target of Knowledge's
 * "View approval" deep links) until the real one is reachable from this app.
 * Deliberately outside the Knowledge shell: Knowledge itself never approves.
 */
function MockApproval() {
  const { taskId } = Route.useParams();
  const task = useApiQuery(
    () =>
      apiGet<ApprovalTaskPageView>(`/api/mock-ultra-easy/approvals/${encodeURIComponent(taskId)}`),
    [taskId],
  );
  const mutation = useMutation();
  const decide = (decision: "approve" | "reject") =>
    void mutation
      .run(() =>
        apiSend("POST", `/api/mock-ultra-easy/approvals/${encodeURIComponent(taskId)}/decision`, {
          decision,
        }),
      )
      .then(task.refetch);
  return (
    <main className="min-h-dvh bg-muted px-4 py-10">
      <div className="mx-auto flex max-w-2xl flex-col gap-5">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <ShieldCheckIcon className="size-5 text-primary" /> ultra-easy Approval
          <Pill tone="warning">mock</Pill>
        </div>
        {task.status === "error" ? (
          <ErrorState
            title={
              task.error.status === 404
                ? "Approval task not found"
                : "Couldn't load the approval task"
            }
            code={task.error.code}
            onRetry={
              task.error.status === 401
                ? () =>
                    window.location.assign(`/login?redirect=/mock/ultra-easy/approvals/${taskId}`)
                : task.refetch
            }
          />
        ) : !task.data ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="flex flex-col gap-4 rounded-xl border bg-card p-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h1 className="text-xl font-bold">{task.data.actionType}</h1>
                <p className="text-xs text-muted-foreground">
                  Requested by {task.data.requestedBy.displayName} · {dateTime(task.data.createdAt)}
                </p>
              </div>
              <Pill
                tone={statusTone(
                  task.data.status === "pending"
                    ? "waiting"
                    : task.data.status === "approved"
                      ? "succeeded"
                      : "failed",
                )}
              >
                {task.data.status}
              </Pill>
            </div>
            <dl className="grid grid-cols-[10rem_1fr] gap-y-2 text-sm">
              {task.data.context.map((entry) => (
                <div key={entry.label} className="contents">
                  <dt className="text-muted-foreground">{entry.label}</dt>
                  <dd className="font-mono text-xs">{entry.value}</dd>
                </div>
              ))}
              <dt className="text-muted-foreground">Approvers</dt>
              <dd>{task.data.candidates.map((candidate) => candidate.displayName).join(", ")}</dd>
              {task.data.decidedBy ? (
                <>
                  <dt className="text-muted-foreground">Decided by</dt>
                  <dd>
                    {task.data.decidedBy.displayName} ·{" "}
                    {task.data.decidedAt ? dateTime(task.data.decidedAt) : ""}
                  </dd>
                </>
              ) : null}
            </dl>
            {task.data.subjectLink ? (
              <a href={task.data.subjectLink} className="text-sm text-primary hover:underline">
                Review the immutable revision (read-only)
              </a>
            ) : null}
            {mutation.error ? (
              <p className="text-sm text-destructive">{mutation.error.title}</p>
            ) : null}
            {task.data.status === "pending" ? (
              task.data.canDecide ? (
                <div className="flex gap-2">
                  <Button disabled={mutation.busy} onClick={() => decide("approve")}>
                    Approve
                  </Button>
                  <Button
                    variant="outline"
                    disabled={mutation.busy}
                    onClick={() => decide("reject")}
                  >
                    Reject
                  </Button>
                </div>
              ) : (
                <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">
                  Signed in as {task.data.viewer.displayName}, who is not an approver of this task.
                  Switch the demo principal to one of:{" "}
                  {task.data.candidates.map((candidate) => candidate.displayName).join(", ")}
                </p>
              )
            ) : null}
            {task.data.returnLink ? (
              <a
                href={task.data.returnLink}
                className="text-sm text-muted-foreground hover:underline"
              >
                ← Back to Knowledge
              </a>
            ) : null}
          </div>
        )}
      </div>
    </main>
  );
}
