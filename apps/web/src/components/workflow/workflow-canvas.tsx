import "@xyflow/react/dist/style.css";

import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type EdgeChange,
  type NodeProps,
} from "@xyflow/react";
import { useMemo } from "react";

import type { WorkflowGraph, WorkflowNode } from "@app/workflow-core";

import { Badge } from "#components/ui/badge";
import { cn } from "#lib/utils";

import { NODE_TYPE_LABELS, NODE_WIDTH, layoutGraph, nodeSummary } from "./graph-model.ts";

export type NodeOverlay = {
  /** runtimeのNodeRun状態（run view）。 */
  status?: string;
  waitingReason?: string;
  /** Approval Projection（説明用、enforcementではない）。 */
  projection?: { label: string; tone: "required" | "none" | "unknown" };
  /** 実際のchild ActionRequestの承認状態（Materialized Plan由来）。 */
  actualApproval?: string;
  /** nested Composite Action（別Workflow）を呼ぶNode。 */
  composite?: boolean;
};

type NodeData = { node: WorkflowNode; overlay: NodeOverlay | undefined; selected: boolean };

const STATUS_CLASS: Record<string, string> = {
  succeeded: "border-success bg-success/10",
  running: "border-primary bg-primary/10",
  waiting: "border-warning bg-warning/10",
  failed: "border-destructive bg-destructive/10",
  cancelled: "border-muted-foreground bg-muted",
  skipped: "border-dashed opacity-60",
};

function WorkflowNodeView({ data }: NodeProps<Node<NodeData>>) {
  const { node, overlay } = data;
  return (
    <div
      className={cn(
        "rounded-lg border bg-card px-3 py-2 text-card-foreground shadow-sm",
        overlay?.status ? STATUS_CLASS[overlay.status] : undefined,
        data.selected && "ring-[3px] ring-ring/60",
      )}
      style={{ width: NODE_WIDTH }}
      data-testid={`workflow-node-${String(node.id)}`}
    >
      {node.type !== "trigger" ? (
        <Handle type="target" position={Position.Top} className="!bg-muted-foreground" />
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">{node.label ?? String(node.id)}</span>
        <Badge variant="outline" className="shrink-0 text-[10px]">
          {NODE_TYPE_LABELS[node.type]}
        </Badge>
      </div>
      <p className="truncate text-xs text-muted-foreground">{nodeSummary(node) || " "}</p>
      <div className="mt-1 flex flex-wrap gap-1">
        {overlay?.status ? (
          <Badge variant="secondary" className="text-[10px]">
            {overlay.status}
            {overlay.waitingReason ? ` · ${overlay.waitingReason}` : ""}
          </Badge>
        ) : null}
        {overlay?.projection ? (
          <Badge
            variant={overlay.projection.tone === "required" ? "default" : "outline"}
            className={cn("text-[10px]", overlay.projection.tone === "unknown" && "border-dashed")}
            title="Approval Projection（見込み。実際の承認はchild ActionRequestのPlanが決める）"
          >
            {overlay.projection.label}
          </Badge>
        ) : null}
        {overlay?.actualApproval ? (
          <Badge
            variant="default"
            className="text-[10px]"
            title="実際のchild ActionRequestの承認状態"
          >
            {overlay.actualApproval}
          </Badge>
        ) : null}
        {overlay?.composite ? (
          <Badge variant="outline" className="text-[10px]">
            composite
          </Badge>
        ) : null}
      </div>
      {node.type !== "output" ? (
        <Handle type="source" position={Position.Bottom} className="!bg-muted-foreground" />
      ) : null}
    </div>
  );
}

const nodeTypes = { workflow: WorkflowNodeView };

export function WorkflowCanvas({
  graph,
  overlays,
  selectedId,
  onSelect,
  onGraphChange,
  className,
}: {
  graph: WorkflowGraph;
  overlays?: Record<string, NodeOverlay>;
  selectedId?: string | null;
  onSelect?: (nodeId: string | null) => void;
  /** 指定時は編集可能（移動・接続・削除）。 */
  onGraphChange?: (graph: WorkflowGraph) => void;
  className?: string;
}) {
  const editable = onGraphChange !== undefined;
  const { nodes, edges } = useMemo(() => {
    const positioned = layoutGraph(graph);
    return {
      nodes: positioned.map(({ node, x, y }): Node<NodeData> => ({
        id: String(node.id),
        type: "workflow",
        position: { x, y },
        data: {
          node,
          overlay: overlays?.[String(node.id)],
          selected: selectedId === String(node.id),
        },
        draggable: editable,
      })),
      edges: graph.edges.map((edge): Edge => ({
        id: edge.id,
        source: String(edge.source),
        target: String(edge.target),
        ...(edge.branch ? { label: edge.branch } : {}),
        markerEnd: { type: MarkerType.ArrowClosed },
        deletable: editable,
      })),
    };
  }, [graph, overlays, selectedId, editable]);

  function onNodesChange(changes: NodeChange<Node<NodeData>>[]) {
    if (!onGraphChange) return;
    let next = graph;
    for (const change of changes) {
      if (change.type === "position" && change.position) {
        const position = change.position;
        next = {
          ...next,
          nodes: next.nodes.map((node) =>
            String(node.id) === change.id
              ? { ...node, position: { x: position.x, y: position.y } }
              : node,
          ),
        };
      }
      if (change.type === "remove") {
        next = {
          nodes: next.nodes.filter((node) => String(node.id) !== change.id),
          edges: next.edges.filter(
            (edge) => String(edge.source) !== change.id && String(edge.target) !== change.id,
          ),
        };
      }
    }
    if (next !== graph) onGraphChange(next);
  }

  function onEdgesChange(changes: EdgeChange[]) {
    if (!onGraphChange) return;
    const removed = new Set(
      changes.flatMap((change) => (change.type === "remove" ? [change.id] : [])),
    );
    if (removed.size > 0)
      onGraphChange({ ...graph, edges: graph.edges.filter((edge) => !removed.has(edge.id)) });
  }

  function onConnect(connection: Connection) {
    if (!onGraphChange) return;
    const source = graph.nodes.find((node) => String(node.id) === connection.source);
    if (!source) return;
    const ids = new Set(graph.edges.map((edge) => edge.id));
    let index = 1;
    while (ids.has(`e${index}`)) index += 1;
    const used = new Set(
      graph.edges
        .filter((edge) => String(edge.source) === connection.source)
        .map((edge) => edge.branch),
    );
    const branch =
      source.type === "branch"
        ? [
            ...source.cases.map((branchCase) => branchCase.key),
            ...(source.defaultKey ? [source.defaultKey] : []),
          ].find((key) => !used.has(key))
        : undefined;
    onGraphChange({
      ...graph,
      edges: [
        ...graph.edges,
        {
          id: `e${index}`,
          source: connection.source as never,
          target: connection.target as never,
          ...(branch ? { branch } : {}),
        },
      ],
    });
  }

  return (
    <div
      className={cn("h-[520px] w-full overflow-hidden rounded-lg border bg-background", className)}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        nodesConnectable={editable}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={(_, node) => onSelect?.(node.id)}
        onPaneClick={() => onSelect?.(null)}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
