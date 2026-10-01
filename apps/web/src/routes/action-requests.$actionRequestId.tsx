import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import type { ActionRequestView, ApprovalTaskPage } from "@app/approval-application";

import { PageContainer, PageHeader } from "#components/layout/page";
import { Button } from "#components/ui/button";
import { Card, CardContent } from "#components/ui/card";
import { ConsoleApiError, consoleGet } from "#lib/console-client";

export const Route = createFileRoute("/action-requests/$actionRequestId")({
  component: ActionRequestPage,
});

function ActionRequestPage() {
  const { actionRequestId } = Route.useParams();
  const [action, setAction] = useState<ActionRequestView | null>(null);
  const [tasks, setTasks] = useState<ApprovalTaskPage["items"]>([]);
  const [error, setError] = useState<ConsoleApiError | null>(null);

  async function refresh() {
    try {
      const [loaded, page] = await Promise.all([
        consoleGet<ActionRequestView>(
          `/api/action-requests/${encodeURIComponent(actionRequestId)}`,
        ),
        consoleGet<ApprovalTaskPage>(
          `/api/action-requests/${encodeURIComponent(actionRequestId)}/tasks`,
        ),
      ]);
      setAction(loaded);
      setTasks(page.items);
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
  }, [actionRequestId]);

  return (
    <PageContainer className="max-w-2xl">
      <PageHeader title="ActionRequest" description={actionRequestId} />
      {error ? (
        <Card>
          <CardContent className="space-y-3">
            <p role="alert" className="text-destructive">
              {error.code}
            </p>
            {error.status === 401 ? (
              <a
                href={`/login?redirect=${encodeURIComponent(`/action-requests/${actionRequestId}`)}`}
              >
                Sign in
              </a>
            ) : (
              <Button variant="outline" onClick={() => void refresh()}>
                Retry
              </Button>
            )}
          </CardContent>
        </Card>
      ) : !action ? (
        <p className="text-muted-foreground">Loading ActionRequest…</p>
      ) : (
        <Card>
          <CardContent className="space-y-4">
            <h1 className="text-lg font-semibold">{String(action.action.type)}</h1>
            <p className="text-sm">Status: {action.status}</p>
            <p className="break-all text-sm text-muted-foreground">
              {String(action.action.resource.type)} · {String(action.action.resource.id)}
            </p>
            <div className="space-y-2">
              <h2 className="font-medium">Approval tasks</h2>
              {tasks.length === 0 ? (
                <p className="text-sm text-muted-foreground">No approval tasks yet.</p>
              ) : (
                <ul className="space-y-2">
                  {tasks.map((task) => (
                    <li key={String(task.id)}>
                      <a
                        className="text-primary underline"
                        href={`/approval-tasks/${encodeURIComponent(String(task.id))}`}
                      >
                        {task.name ?? task.stepKey} · {task.status}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <Button variant="outline" onClick={() => void refresh()}>
              Refresh
            </Button>
          </CardContent>
        </Card>
      )}
    </PageContainer>
  );
}
