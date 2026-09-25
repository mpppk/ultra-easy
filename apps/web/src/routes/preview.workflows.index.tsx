import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

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
import { studioApi } from "#/components/workflow/studio-api.ts";
import type {
  DefinitionSummary,
  RunSummary,
  StudioCatalog,
} from "#/components/workflow/studio-api.ts";

export const Route = createFileRoute("/preview/workflows/")({
  component: WorkflowStudioHome,
});

function WorkflowStudioHome() {
  const navigate = useNavigate();
  const [definitions, setDefinitions] = useState<DefinitionSummary[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [catalog, setCatalog] = useState<StudioCatalog | null>(null);
  const [newId, setNewId] = useState("wf:employee-onboard");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function reload() {
    setError(null);
    try {
      const [listed, runList, loadedCatalog] = await Promise.all([
        studioApi.definitions(),
        studioApi.runs(),
        studioApi.catalog(),
      ]);
      setDefinitions(listed.definitions);
      setRuns(runList.runs);
      setCatalog(loadedCatalog);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function bootstrap() {
    setBusy(true);
    try {
      await studioApi.bootstrap();
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageContainer>
      <PageHeader
        title="Workflow Studio"
        description="Action Catalog上のActionを組み合わせて業務Workflowを定義し、Composite Actionとしてpublish・実行・監視します（preview）。"
        actions={
          <Button variant="outline" disabled={busy} onClick={bootstrap}>
            preview catalogを初期化
          </Button>
        }
      />
      <PreviewAccessTokenField />
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <PageSection title="Workflow Definitions">
        <div className="flex flex-wrap items-end gap-2">
          <Input
            aria-label="新しいWorkflow ID"
            className="w-64 font-mono"
            value={newId}
            onChange={(event) => setNewId(event.target.value)}
          />
          <Button onClick={() => navigate({ to: "/preview/workflows/$id", params: { id: newId } })}>
            作成 / 開く
          </Button>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>名前</TableHead>
              <TableHead>draft</TableHead>
              <TableHead>published versions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {definitions.map((definition) => (
              <TableRow key={definition.id}>
                <TableCell>
                  <Link
                    to="/preview/workflows/$id"
                    params={{ id: definition.id }}
                    className="font-mono underline"
                  >
                    {definition.id}
                  </Link>
                </TableCell>
                <TableCell>{definition.name}</TableCell>
                <TableCell>{definition.draftRevision ?? "-"}</TableCell>
                <TableCell>
                  {definition.versions.map((version) => `v${version.version}`).join(", ") || "-"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </PageSection>

      <PageSection
        title="Action Catalog"
        description="primitive / composite Actionは同じcatalogから解決されます。"
      >
        <div className="flex flex-wrap gap-2">
          {catalog?.actions.map((action) => (
            <Badge
              key={action.actionType}
              variant={action.kind === "composite" ? "default" : "outline"}
            >
              {action.actionType} · {action.kind}
              {action.workflow?.version
                ? ` (${action.workflow.definitionId}@${action.workflow.version})`
                : ""}
            </Badge>
          ))}
        </div>
      </PageSection>

      <PageSection title="WorkflowRuns">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>run</TableHead>
              <TableHead>workflow</TableHead>
              <TableHead>status</TableHead>
              <TableHead>depth</TableHead>
              <TableHead>parent ActionRequest</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run) => (
              <TableRow key={run.runId}>
                <TableCell>
                  <Link
                    to="/preview/workflow-runs/$runId"
                    params={{ runId: run.runId }}
                    className="font-mono text-xs underline"
                  >
                    {run.runId}
                  </Link>
                </TableCell>
                <TableCell>
                  {run.definitionId}@{run.version}
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{run.status}</Badge>
                </TableCell>
                <TableCell>{run.depth}</TableCell>
                <TableCell className="font-mono text-xs">
                  {run.parentActionRequestId ?? "-"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </PageSection>
    </PageContainer>
  );
}
