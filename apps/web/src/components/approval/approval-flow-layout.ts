import dagre from "@dagrejs/dagre";

import type { FlowGraph, FlowGraphNode } from "./approval-flow-graph.ts";

/**
 * Dagre-specific auto layout, kept behind this helper so the renderer can
 * switch engines (e.g. ELK) without touching graph compilation.
 */
export type PositionedNode = FlowGraphNode & {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function nodeSize(node: FlowGraphNode): { width: number; height: number } {
  if (node.kind === "step") return { width: 240, height: 88 };
  if (node.kind === "split" || node.kind === "join") return { width: 220, height: 44 };
  return { width: 200, height: 40 };
}

export function layoutApprovalFlowGraph(
  graph: FlowGraph,
  direction: "TB" | "LR" = "TB",
): { nodes: PositionedNode[]; edges: FlowGraph["edges"] } {
  const layout = new dagre.graphlib.Graph();
  layout.setGraph({ rankdir: direction, nodesep: 32, ranksep: 48, marginx: 16, marginy: 16 });
  layout.setDefaultEdgeLabel(() => ({}));
  for (const node of graph.nodes) layout.setNode(node.id, nodeSize(node));
  for (const edge of graph.edges) layout.setEdge(edge.source, edge.target);
  dagre.layout(layout);
  return {
    nodes: graph.nodes.map((node) => {
      const { width, height } = nodeSize(node);
      const positioned = layout.node(node.id) as { x: number; y: number } | undefined;
      // dagre positions are node centers; React Flow expects the top-left corner.
      return {
        ...node,
        width,
        height,
        x: (positioned?.x ?? 0) - width / 2,
        y: (positioned?.y ?? 0) - height / 2,
      };
    }),
    edges: graph.edges,
  };
}
