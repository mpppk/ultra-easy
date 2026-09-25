import { Link, createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import type { WorkflowGraph } from "@app/workflow-core";

import { PageContainer, PageHeader, PageSection } from "#components/layout/page";
import { PreviewAccessTokenField } from "#components/preview/access-token-field";
import { Badge } from "#components/ui/badge";
import { Button } from "#components/ui/button";
import { Input } from "#components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#components/ui/table";
import { graphAt } from "#/components/workflow/graph-model.ts";
import { studioApi } from "#/components/workflow/studio-api.ts";
import type { ActionView, RunView } from "#/components/workflow/studio-api.ts";
import { WorkflowCanvas, type NodeOverlay } from "#components/workflow/workflow-canvas";

export const Route = createFileRoute("/preview/workflow-runs/$runId")({
  component: WorkflowRunPage,
});

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

function WorkflowRunPage() {
  const { runId } = Route.useParams();
  const [view, setView] = useState<RunView | null>(null);
  const [parent, setParent] = useState<ActionView | null>(null);
  const [scope, setScope] = useState("root");
  const [inputValue, setInputValue] = useState('"approved"');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const loaded = await studioApi.run(runId);
      setView(loaded);
      const parentId = loaded.run.invocation.parentAction?.actionRequestId;
      if (parentId) setParent(await studioApi.action(parentId));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [runId]);

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  const state = view?.run.state;
  const scopeState = state?.scopes[scope];
  const graph: WorkflowGraph | null =
    view?.definition && scopeState ? graphAt(view.definition, scopeState.path.map(String)) : null;
  const overlays = useMemo(() => {
    const result: Record<string, NodeOverlay> = {};
    if (!state || !graph) return result;
    for (const node of graph.nodes) {
      const nodeRun = state.nodeRuns[`${scope}:${String(node.id)}`];
      const child = view?.children.find(
        (candidate) => candidate.nodeRunId === `${scope}:${String(node.id)}`,
      );
      result[String(node.id)] = {
        ...(nodeRun ? { status: nodeRun.status } : {}),
        ...(nodeRun?.waitingReason ? { waitingReason: nodeRun.waitingReason } : {}),
        ...(child?.approvalRequired
          ? { actualApproval: `承認必要（実際）: ${child.status ?? "-"}` }
          : {}),
        ...(child?.childRunId ? { composite: true } : {}),
      };
    }
    return result;
  }, [state, graph, scope, view]);

  const waitingInputs = state
    ? Object.values(state.effects).filter(
        (effect) => effect.request.kind === "human_input" && effect.status === "in_flight",
      )
    : [];

  return (
    <PageContainer className="max-w-7xl">
      <PageHeader
        title={<span className="font-mono text-lg">{runId}</span>}
        description={
          state
            ? `${String(state.definitionId)}@${state.version} · depth ${view?.run.depth ?? 0} · checksum ${String(state.checksum).slice(0, 18)}…`
            : undefined
        }
        actions={
          <>
            <Link to="/preview/workflows" className="text-sm underline">
              Studio
            </Link>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => act(() => studioApi.advance(runId))}
            >
              advance
            </Button>
            <Button
              variant="outline"
              disabled={busy || (state ? TERMINAL.has(state.status) : true)}
              onClick={() => act(() => studioApi.cancel(runId))}
            >
              cancel
            </Button>
          </>
        }
      />
      <PreviewAccessTokenField />
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {state ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge data-testid="run-status">{state.status}</Badge>
          {state.error ? <Badge variant="destructive">{state.error.code}</Badge> : null}
          {view?.run.invocation.parentRunId ? (
            <Link
              to="/preview/workflow-runs/$runId"
              params={{ runId: view.run.invocation.parentRunId }}
              className="underline"
            >
              親run
            </Link>
          ) : null}
          {parent ? (
            <span>
              親Composite ActionRequest{" "}
              <span className="font-mono text-xs">{parent.actionRequestId}</span>:{" "}
              <Badge variant="outline">{parent.status?.status ?? "-"}</Badge>
              {parent.approval && parent.approval.status === "pending" ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-2"
                  disabled={busy}
                  onClick={() => act(() => studioApi.decide(parent.actionRequestId, "approve"))}
                >
                  workflow-level承認（{parent.approval.tasks[0]?.candidateUserIds.join(", ")}）
                </Button>
              ) : null}
            </span>
          ) : null}
        </div>
      ) : null}

      {state ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>scope:</span>
          {Object.keys(state.scopes).map((scopeId) => (
            <Button
              key={scopeId}
              size="sm"
              variant={scopeId === scope ? "default" : "outline"}
              onClick={() => setScope(scopeId)}
            >
              {scopeId} · {state.scopes[scopeId]?.status}
            </Button>
          ))}
        </div>
      ) : null}
      {graph ? <WorkflowCanvas graph={graph} overlays={overlays} /> : null}

      {waitingInputs.length > 0 ? (
        <PageSection title="入力待ち（human input）">
          {waitingInputs.map((effect) => (
            <div key={String(effect.id)} className="flex flex-wrap items-center gap-2">
              <span className="text-sm">
                {effect.request.kind === "human_input" ? effect.request.prompt : ""}
              </span>
              <Input
                aria-label="入力値(JSON)"
                className="h-8 w-64 font-mono text-xs"
                value={inputValue}
                onChange={(event) => setInputValue(event.target.value)}
              />
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  act(() =>
                    studioApi.provideInput(
                      runId,
                      String(effect.id),
                      JSON.parse(inputValue) as unknown,
                    ),
                  )
                }
              >
                送信
              </Button>
            </div>
          ))}
        </PageSection>
      ) : null}

      <PageSection
        title="child ActionRequests（実際の承認はここ）"
        description="各childは通常のActionRequestとしてAuthorization / Approval / Re-Authorizationを通ります。"
      >
        <Table data-testid="child-actions">
          <TableHeader>
            <TableRow>
              <TableHead>Node</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>status</TableHead>
              <TableHead>承認（Plan）</TableHead>
              <TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view?.children.map((child) => (
              <TableRow key={child.actionRequestId}>
                <TableCell className="font-mono text-xs">{child.nodeRunId}</TableCell>
                <TableCell>
                  {child.actionType}
                  <p className="font-mono text-[10px] text-muted-foreground">
                    {child.actionRequestId}
                  </p>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{child.status ?? "-"}</Badge>
                  {child.code ? (
                    <span className="ml-1 text-xs text-destructive">{child.code}</span>
                  ) : null}
                </TableCell>
                <TableCell>
                  {child.approvalRequired === null ? "-" : child.approvalRequired ? "必要" : "不要"}
                </TableCell>
                <TableCell className="flex flex-wrap gap-1">
                  {child.status === "pending_approval" ? (
                    <>
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          act(() => studioApi.decide(child.actionRequestId, "approve"))
                        }
                      >
                        承認
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => act(() => studioApi.decide(child.actionRequestId, "reject"))}
                      >
                        却下
                      </Button>
                    </>
                  ) : null}
                  {child.childRunId ? (
                    <Link
                      to="/preview/workflow-runs/$runId"
                      params={{ runId: child.childRunId }}
                      className="text-sm underline"
                    >
                      nested run
                    </Link>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </PageSection>

      {state?.output !== undefined ? (
        <PageSection title="Output">
          <pre
            className="overflow-auto rounded bg-muted p-2 font-mono text-xs"
            data-testid="run-output"
          >
            {JSON.stringify(state.output, null, 2)}
          </pre>
        </PageSection>
      ) : null}

      <PageSection title="監査イベント（workflow_events）">
        <ul className="max-h-72 overflow-auto font-mono text-xs">
          {view?.events.map((event) => (
            <li key={event.eventKey}>
              {event.occurredAt} {event.type} {event.nodeRunId ?? ""} {event.effectId ?? ""}{" "}
              {JSON.stringify(event.data)}
            </li>
          ))}
        </ul>
      </PageSection>
    </PageContainer>
  );
}
