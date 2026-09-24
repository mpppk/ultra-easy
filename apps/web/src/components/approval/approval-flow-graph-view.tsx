import "@xyflow/react/dist/style.css";

import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { useMemo } from "react";

import type { ApprovalFlowPresentation, ApprovalStepPresentation } from "@app/approval-core";

import { cn } from "#lib/utils";

import { buildApprovalFlowGraph, type FlowGraphNode } from "./approval-flow-graph.ts";
import { layoutApprovalFlowGraph } from "./approval-flow-layout.ts";
import { targetText } from "./approval-step-detail.tsx";

type NodeData = { graph: FlowGraphNode; selected: boolean };

function StepNode({ data }: NodeProps<Node<NodeData>>) {
  const graph = data.graph;
  if (graph.kind !== "step") return null;
  return (
    <div
      className={cn(
        "w-[240px] rounded-lg border bg-card px-3 py-2 text-card-foreground shadow-sm",
        data.selected && "ring-[3px] ring-ring/60",
      )}
    >
      <Handle type="target" position={Position.Top} className="!bg-muted-foreground" />
      <p className="truncate text-sm font-medium">{graph.label}</p>
      <p className="truncate text-xs text-muted-foreground">{targetText(graph.step.target)}</p>
      <p className="text-xs text-muted-foreground">
        {graph.step.resolution} · {graph.step.candidateCompletion.label}
      </p>
      <Handle type="source" position={Position.Bottom} className="!bg-muted-foreground" />
    </div>
  );
}

function GatewayNode({ data }: NodeProps<Node<NodeData>>) {
  const graph = data.graph;
  return (
    <div className="w-[220px] rounded-md border-2 border-dashed bg-muted px-2 py-1.5 text-center text-xs font-medium">
      <Handle type="target" position={Position.Top} className="!bg-muted-foreground" />
      {graph.kind === "split" ? "⑂ " : "⑃ "}
      {graph.label}
      <Handle type="source" position={Position.Bottom} className="!bg-muted-foreground" />
    </div>
  );
}

function TerminalNode({ data }: NodeProps<Node<NodeData>>) {
  const graph = data.graph;
  return (
    <div
      className={cn(
        "w-[200px] rounded-full border bg-background px-3 py-2 text-center text-xs",
        graph.kind === "none" && "border-dashed font-medium",
      )}
    >
      {graph.kind !== "start" ? <Handle type="target" position={Position.Top} /> : null}
      {graph.label}
      {graph.kind !== "end" ? <Handle type="source" position={Position.Bottom} /> : null}
    </div>
  );
}

const nodeTypes = { step: StepNode, gateway: GatewayNode, terminal: TerminalNode };

/**
 * Read-only React Flow rendering of the Materialized Approval Plan (an
 * inspector, not an editor): nodes cannot be dragged or connected; selecting a
 * step opens its metadata.
 */
export function ApprovalFlowGraphView({
  flow,
  selectedPath,
  onSelect,
}: {
  flow: ApprovalFlowPresentation;
  selectedPath?: string;
  onSelect: (step: ApprovalStepPresentation) => void;
}) {
  const { nodes, edges } = useMemo(() => {
    const layout = layoutApprovalFlowGraph(buildApprovalFlowGraph(flow));
    return {
      nodes: layout.nodes.map((node): Node<NodeData> => ({
        id: node.id,
        type:
          node.kind === "step"
            ? "step"
            : node.kind === "split" || node.kind === "join"
              ? "gateway"
              : "terminal",
        position: { x: node.x, y: node.y },
        data: { graph: node, selected: node.id === selectedPath },
        draggable: false,
        connectable: false,
        selectable: node.kind === "step",
        ariaLabel: node.label,
      })),
      edges: layout.edges.map((edge): Edge => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        ...(edge.label ? { label: edge.label } : {}),
        markerEnd: { type: MarkerType.ArrowClosed },
      })),
    };
  }, [flow, selectedPath]);

  return (
    <div data-slot="approval-flow-graph" className="h-[480px] w-full rounded-lg border">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        fitView
        colorMode="system"
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, node) => {
          const graph = (node.data as NodeData).graph;
          if (graph.kind === "step") onSelect(graph.step);
        }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
