import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import type { ApprovalProjection, CapabilityReview } from "@app/workflow-application";
import { allNodes, validateWorkflowDefinition } from "@app/workflow-core";
import type {
  ProgramNodeVersion,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowNodeType,
  WorkflowValidationIssue,
} from "@app/workflow-core";

import { PageContainer, PageHeader, PageSection } from "#components/layout/page";
import { PreviewAccessTokenField } from "#components/preview/access-token-field";
import { Badge } from "#components/ui/badge";
import { Button } from "#components/ui/button";
import { Input } from "#components/ui/input";
import { Textarea } from "#components/ui/textarea";
import {
  NODE_TYPE_LABELS,
  PALETTE,
  createNode,
  emptyDefinition,
  graphAt,
  nextNodeId,
  updateGraphAt,
} from "#/components/workflow/graph-model.ts";
import { NodeInspector } from "#components/workflow/node-inspector";
import {
  CapabilityReviewPanel,
  ProgramAuthoringPanel,
  ProjectionPanel,
  projectionLabel,
} from "#components/workflow/studio-panels";
import { studioApi } from "#/components/workflow/studio-api.ts";
import type { StudioCatalog } from "#/components/workflow/studio-api.ts";
import { WorkflowCanvas, type NodeOverlay } from "#components/workflow/workflow-canvas";

export const Route = createFileRoute("/preview/workflows/$id")({
  component: WorkflowEditor,
});

function fieldSuggestions(definition: WorkflowDefinition, catalog: StudioCatalog | null): string[] {
  const inputs = (definition.inputFields ?? []).map((item) => item.path);
  const nodes = allNodes(definition.graph).map(({ node }) => `nodes.${String(node.id)}.output`);
  const variables = Object.keys(definition.variables ?? {}).map((name) => `variables.${name}`);
  const namespaces = (catalog?.fields.workflow?.namespaces ?? [])
    .map((namespace) => namespace.pattern)
    .filter((pattern) => !pattern.includes("*"));
  return [...new Set([...inputs, ...nodes, ...variables, ...namespaces])];
}

function WorkflowEditor() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const [definition, setDefinition] = useState<WorkflowDefinition>(() => emptyDefinition(id, id));
  const [revision, setRevision] = useState<number | null>(null);
  const [versions, setVersions] = useState<number[]>([]);
  const [catalog, setCatalog] = useState<StudioCatalog | null>(null);
  const [programs, setPrograms] = useState<ProgramNodeVersion[]>([]);
  const [path, setPath] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<WorkflowValidationIssue[]>([]);
  const [capabilities, setCapabilities] = useState<CapabilityReview[]>([]);
  const [projection, setProjection] = useState<ApprovalProjection | null>(null);
  const [actionType, setActionType] = useState("employee.onboard");
  const [runInput, setRunInput] = useState(
    '{ "employeeId": "EMP-1", "email": "bob@example.com", "amount": 50000 }',
  );
  const [inputFieldsText, setInputFieldsText] = useState("[]");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const [detail, loadedCatalog, loadedPrograms] = await Promise.all([
        studioApi.definition(id),
        studioApi.catalog(),
        studioApi.programs(),
      ]);
      setCatalog(loadedCatalog);
      setPrograms(loadedPrograms.programs);
      setVersions(detail.versions.map((version) => version.version));
      const latest = detail.versions.at(-1);
      const loaded = detail.draft?.definition ?? latest?.definition;
      if (loaded) {
        setDefinition(loaded);
        setInputFieldsText(JSON.stringify(loaded.inputFields ?? [], null, 2));
      }
      setRevision(detail.draft?.revision ?? null);
      const binding = detail.bindings.at(-1);
      if (binding) setActionType(binding.actionType);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  useEffect(() => {
    void load();
  }, [id]);

  const graph = graphAt(definition, path) ?? definition.graph;
  const selectedNode = graph.nodes.find((node) => String(node.id) === selected) ?? null;
  const localIssues = useMemo(() => {
    const result = validateWorkflowDefinition(definition);
    return result.valid ? [] : result.issues;
  }, [definition]);
  const fields = fieldSuggestions(definition, catalog);
  const delegationFields = [
    "action.input.amount",
    "action.input",
    "action.type",
    "action.resource.id",
    "actor.id",
    "origin.type",
    "now",
  ];
  const compositeTypes = new Set(
    catalog?.actions
      .filter((action) => action.kind === "composite")
      .map((action) => action.actionType),
  );
  const overlays = useMemo(() => {
    const result: Record<string, NodeOverlay> = {};
    for (const node of graph.nodes) {
      const item = projection?.items.find((candidate) => candidate.nodeId === String(node.id));
      result[String(node.id)] = {
        ...(item ? { projection: projectionLabel(item) } : {}),
        ...(node.type === "action" && compositeTypes.has(String(node.actionType))
          ? { composite: true }
          : {}),
      };
    }
    return result;
  }, [graph, projection, catalog]);

  async function run(label: string, action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await action();
      setMessage(label);
    } catch (caught) {
      const details = (caught as { details?: { issues?: WorkflowValidationIssue[] } }).details;
      if (details?.issues) setServerIssues(details.issues);
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  function withInputFields(): WorkflowDefinition {
    try {
      return {
        ...definition,
        inputFields: JSON.parse(inputFieldsText) as WorkflowDefinition["inputFields"],
      };
    } catch {
      return definition;
    }
  }

  function addNode(type: WorkflowNodeType) {
    const nodeId = nextNodeId(definition, type === "for_each" ? "each" : type);
    const node = createNode(type, nodeId, {
      x: 40 + graph.nodes.length * 24,
      y: 60 + graph.nodes.length * 24,
    });
    setDefinition(
      updateGraphAt(definition, path, (current) => ({
        ...current,
        nodes: [...current.nodes, node],
      })),
    );
    setSelected(nodeId);
  }

  function updateNode(next: WorkflowNode) {
    setDefinition(
      updateGraphAt(definition, path, (current) => ({
        ...current,
        nodes: current.nodes.map((node) => (String(node.id) === String(next.id) ? next : node)),
      })),
    );
  }

  function deleteNode(nodeId: string) {
    setDefinition(
      updateGraphAt(definition, path, (current) => ({
        nodes: current.nodes.filter((node) => String(node.id) !== nodeId),
        edges: current.edges.filter(
          (edge) => String(edge.source) !== nodeId && String(edge.target) !== nodeId,
        ),
      })),
    );
    setSelected(null);
  }

  const issues = [...localIssues, ...serverIssues];

  return (
    <PageContainer className="max-w-7xl">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Input
              aria-label="Workflow名"
              className="h-9 w-72"
              value={definition.name}
              onChange={(event) => setDefinition({ ...definition, name: event.target.value })}
            />
            <span className="font-mono text-sm text-muted-foreground">{id}</span>
          </span>
        }
        description={`draft revision ${revision ?? "-"} · published ${versions.map((version) => `v${version}`).join(", ") || "-"}`}
        actions={
          <>
            <Link to="/preview/workflows" className="text-sm underline">
              一覧へ
            </Link>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                run("draftを保存しました", async () => {
                  const saved = await studioApi.saveDraft(id, withInputFields(), revision);
                  setRevision(saved.revision);
                  setServerIssues(saved.issues);
                  setCapabilities(saved.capabilities);
                })
              }
            >
              draft保存
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                run("検証しました", async () => {
                  const validated = await studioApi.validate(id, withInputFields());
                  setServerIssues(validated.issues);
                  setCapabilities(validated.capabilities);
                })
              }
            >
              検証
            </Button>
          </>
        }
      />
      <PreviewAccessTokenField />
      {message ? <p className="text-sm text-success">{message}</p> : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <button
              type="button"
              className="underline"
              onClick={() => {
                setPath([]);
                setSelected(null);
              }}
            >
              root
            </button>
            {path.map((segment, index) => (
              <span key={segment} className="flex items-center gap-2">
                ›
                <button
                  type="button"
                  className="font-mono underline"
                  onClick={() => setPath(path.slice(0, index + 1))}
                >
                  {segment} body
                </button>
              </span>
            ))}
          </div>
          <div className="flex flex-wrap gap-1" role="toolbar" aria-label="Node palette">
            {PALETTE.map((type) => (
              <Button key={type} size="sm" variant="outline" onClick={() => addNode(type)}>
                + {NODE_TYPE_LABELS[type]}
              </Button>
            ))}
          </div>
          <WorkflowCanvas
            graph={graph}
            overlays={overlays}
            selectedId={selected}
            onSelect={setSelected}
            onGraphChange={(next) => setDefinition(updateGraphAt(definition, path, () => next))}
          />
          <p className="text-xs text-muted-foreground">
            Nodeの下端から別Nodeの上端へドラッグで接続（Branchからは未使用のcase
            keyが割り当てられます）。選択してDelete / Backspaceで削除。
          </p>
          <PageSection title={`検証（${issues.length}件）`}>
            {issues.length === 0 ? (
              <Badge variant="secondary" className="w-fit">
                valid
              </Badge>
            ) : (
              <ul className="text-xs text-destructive" data-testid="validation-issues">
                {issues.map((issue, index) => (
                  <li key={index}>
                    {issue.code} @ {issue.location}: {issue.message}
                  </li>
                ))}
              </ul>
            )}
          </PageSection>
          <PageSection title="workflow input fields（Composite Actionのinput schema）">
            <Textarea
              className="min-h-24 font-mono text-xs"
              value={inputFieldsText}
              onChange={(event) => setInputFieldsText(event.target.value)}
            />
          </PageSection>
        </div>

        <div className="flex flex-col gap-4">
          <div className="rounded-lg border p-3">
            {selectedNode ? (
              <NodeInspector
                key={String(selectedNode.id)}
                node={selectedNode}
                onChange={updateNode}
                onDelete={() => deleteNode(String(selectedNode.id))}
                onOpenBody={() => {
                  setPath([...path, String(selectedNode.id)]);
                  setSelected(null);
                }}
                fields={fields}
                delegationFields={delegationFields}
                actions={catalog?.actions ?? []}
                programs={programs}
                llmModel={catalog?.llmModel ?? "@cf/qwen/qwen2.5-coder-32b-instruct"}
              />
            ) : (
              <p className="text-sm text-muted-foreground">Nodeを選択すると編集できます。</p>
            )}
          </div>

          <PageSection title="Publish">
            <Input
              aria-label="Composite Action type"
              className="h-8 font-mono text-xs"
              value={actionType}
              onChange={(event) => setActionType(event.target.value)}
            />
            <Button
              disabled={busy}
              onClick={() =>
                run("publishしました", async () => {
                  const published = await studioApi.publish(id, withInputFields(), actionType);
                  setVersions((current) => [...current, published.version.version]);
                  setServerIssues([]);
                  setProjection(await studioApi.projection(id, JSON.parse(runInput) as unknown));
                })
              }
            >
              versionをpublish（Composite Action）
            </Button>
          </PageSection>

          <PageSection title="Approval Projection">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || versions.length === 0}
              onClick={() =>
                run("見込みを計算しました", async () =>
                  setProjection(await studioApi.projection(id, JSON.parse(runInput) as unknown)),
                )
              }
            >
              見込みを計算
            </Button>
            <ProjectionPanel projection={projection} />
          </PageSection>

          <PageSection title="実行">
            <Textarea
              aria-label="run input"
              className="min-h-16 font-mono text-xs"
              value={runInput}
              onChange={(event) => setRunInput(event.target.value)}
            />
            <Button
              disabled={busy || versions.length === 0}
              onClick={() =>
                run("開始しました", async () => {
                  const started = await studioApi.startRun(
                    actionType,
                    JSON.parse(runInput) as unknown,
                  );
                  const view = await studioApi.action(started.actionRequestId);
                  if (view.runId)
                    await navigate({
                      to: "/preview/workflow-runs/$runId",
                      params: { runId: view.runId },
                    });
                  else setMessage(`ActionRequest ${started.actionRequestId}: ${started.status}`);
                })
              }
            >
              Composite Actionとして実行
            </Button>
          </PageSection>

          <PageSection title="Capability review">
            <CapabilityReviewPanel reviews={capabilities} />
          </PageSection>

          <PageSection title="Program Node authoring">
            <ProgramAuthoringPanel
              onPublished={() =>
                void studioApi.programs().then((loaded) => setPrograms(loaded.programs))
              }
            />
          </PageSection>
        </div>
      </div>
    </PageContainer>
  );
}
