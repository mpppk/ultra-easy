import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import type { ActionRequestView, ApprovalTaskView } from "@app/approval-application";

import { PageContainer, PageHeader } from "#components/layout/page";
import { Button } from "#components/ui/button";
import { Card, CardContent } from "#components/ui/card";
import { Input } from "#components/ui/input";
import { ConsoleApiError, consoleGet, consolePost } from "#lib/console-client";

export const Route = createFileRoute("/approval-tasks/$taskId")({
  component: ApprovalTaskPage,
});

function ApprovalTaskPage() {
  const { taskId } = Route.useParams();
  const [task, setTask] = useState<ApprovalTaskView | null>(null);
  const [action, setAction] = useState<ActionRequestView | null>(null);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<ConsoleApiError | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const loaded = await consoleGet<ApprovalTaskView>(
        `/api/approval-tasks/${encodeURIComponent(taskId)}`,
      );
      const parent = await consoleGet<ActionRequestView>(
        `/api/action-requests/${encodeURIComponent(String(loaded.actionRequestId))}`,
      );
      setTask(loaded);
      setAction(parent);
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof ConsoleApiError
          ? caught
          : new ConsoleApiError(503, "unavailable", "Unavailable"),
      );
    }
  }

  useEffect(() => {
    void refresh();
  }, [taskId]);

  async function decide(decision: "approve" | "reject") {
    setBusy(true);
    setError(null);
    try {
      await consolePost(
        `/api/approval-tasks/${encodeURIComponent(taskId)}/decisions`,
        { decision, ...(comment.trim() ? { comment: comment.trim() } : {}) },
        { "idempotency-key": crypto.randomUUID() },
      );
      setSubmitted(true);
      await refresh();
    } catch (caught) {
      setError(
        caught instanceof ConsoleApiError
          ? caught
          : new ConsoleApiError(503, "unavailable", "Unavailable"),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageContainer className="max-w-2xl">
      <PageHeader title="Approval task" description={taskId} />
      {error ? (
        <Card>
          <CardContent className="space-y-3">
            <p role="alert" className="text-destructive">
              {error.code}
            </p>
            {error.status === 401 ? (
              <a href={`/login?redirect=${encodeURIComponent(`/approval-tasks/${taskId}`)}`}>
                Sign in
              </a>
            ) : (
              <Button variant="outline" onClick={() => void refresh()}>
                Retry
              </Button>
            )}
          </CardContent>
        </Card>
      ) : !task || !action ? (
        <p className="text-muted-foreground">Loading approval…</p>
      ) : (
        <Card>
          <CardContent className="space-y-4">
            <div className="space-y-1">
              <h1 className="text-lg font-semibold">{task.name ?? task.stepKey}</h1>
              <p className="text-sm text-muted-foreground">Status: {task.status}</p>
              <p className="text-sm">{String(action.action.type)}</p>
              <p className="break-all text-sm text-muted-foreground">
                {String(action.action.resource.type)} · {String(action.action.resource.id)}
              </p>
              <a
                className="text-sm text-primary underline"
                href={`/action-requests/${encodeURIComponent(String(task.actionRequestId))}`}
              >
                View ActionRequest
              </a>
            </div>
            {submitted ? (
              <p role="status">Decision submitted. Refresh to see the final state.</p>
            ) : null}
            {task.status === "pending" && task.canApprove ? (
              <div className="space-y-3">
                <label className="block text-sm">
                  Comment
                  <Input
                    value={comment}
                    maxLength={10_000}
                    onChange={(event) => setComment(event.target.value)}
                  />
                </label>
                <div className="flex gap-2">
                  <Button disabled={busy} onClick={() => void decide("approve")}>
                    Approve
                  </Button>
                  <Button variant="outline" disabled={busy} onClick={() => void decide("reject")}>
                    Reject
                  </Button>
                </div>
              </div>
            ) : task.status === "pending" ? (
              <p className="text-sm text-muted-foreground">You cannot decide this task.</p>
            ) : null}
            <Button variant="outline" onClick={() => void refresh()}>
              Refresh
            </Button>
          </CardContent>
        </Card>
      )}
    </PageContainer>
  );
}
