import dagre from "@dagrejs/dagre";

import type { Condition, ValueExpression, ValueTemplate } from "@app/expression-core";
import type {
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNode,
  WorkflowNodeType,
} from "@app/workflow-core";

export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 72;

export const NODE_TYPE_LABELS: Record<WorkflowNodeType, string> = {
  trigger: "Trigger",
  action: "Action",
  branch: "Branch",
  for_each: "ForEach",
  while: "While",
  transform: "Transform",
  program: "Program",
  llm: "LLM",
  join: "Join",
  output: "Output",
};

export const PALETTE: WorkflowNodeType[] = [
  "action",
  "branch",
  "join",
  "for_each",
  "while",
  "transform",
  "program",
  "llm",
  "output",
];

export const field = (path: string): ValueExpression => ({ type: "field", path });
export const literal = (value: unknown): ValueExpression => ({
  type: "literal",
  value: value as never,
});

export const alwaysTrue: Condition = {
  type: "comparison",
  left: literal(1),
  operator: "eq",
  right: literal(1),
};

/** root graphからloop Node ID列を辿ったgraph。 */
export function graphAt(
  definition: WorkflowDefinition,
  path: readonly string[],
): WorkflowGraph | null {
  let graph: WorkflowGraph | null = definition.graph;
  for (const nodeId of path) {
    const node: WorkflowNode | undefined = graph?.nodes.find(
      (candidate) => String(candidate.id) === nodeId,
    );
    graph = node && (node.type === "for_each" || node.type === "while") ? node.body : null;
  }
  return graph;
}

function replaceGraph(
  graph: WorkflowGraph,
  path: readonly string[],
  update: (graph: WorkflowGraph) => WorkflowGraph,
): WorkflowGraph {
  if (path.length === 0) return update(graph);
  const [head, ...rest] = path;
  return {
    ...graph,
    nodes: graph.nodes.map((node) =>
      String(node.id) === head && (node.type === "for_each" || node.type === "while")
        ? { ...node, body: replaceGraph(node.body, rest, update) }
        : node,
    ),
  };
}

/** path上のgraphを不変に更新したdefinitionを返す。 */
export function updateGraphAt(
  definition: WorkflowDefinition,
  path: readonly string[],
  update: (graph: WorkflowGraph) => WorkflowGraph,
): WorkflowDefinition {
  return { ...definition, graph: replaceGraph(definition.graph, path, update) };
}

function allIds(graph: WorkflowGraph): string[] {
  return graph.nodes.flatMap((node) => [
    String(node.id),
    ...(node.type === "for_each" || node.type === "while" ? allIds(node.body) : []),
  ]);
}

export function nextNodeId(definition: WorkflowDefinition, prefix: string): string {
  const ids = new Set(allIds(definition.graph));
  for (let index = 1; ; index += 1) {
    const candidate = `${prefix}${index}`;
    if (!ids.has(candidate)) return candidate;
  }
}

export function nextEdgeId(graph: WorkflowGraph): string {
  const ids = new Set(graph.edges.map((edge) => edge.id));
  for (let index = 1; ; index += 1) {
    const candidate = `e${index}`;
    if (!ids.has(candidate)) return candidate;
  }
}

const emptyObject: ValueTemplate = { type: "object", fields: {} };

/** paletteから追加するNodeの既定値。 */
export function createNode(
  type: WorkflowNodeType,
  id: string,
  position: { x: number; y: number },
): WorkflowNode {
  const base = { id: id as WorkflowNode["id"], position };
  switch (type) {
    case "trigger":
      return { ...base, type };
    case "action":
      return {
        ...base,
        type,
        actionType: "notify.send" as never,
        resource: { type: "workflow_subject", id: literal(`${id}-target`) },
        input: emptyObject,
      };
    case "branch":
      return { ...base, type, cases: [{ key: "yes", when: alwaysTrue }], defaultKey: "no" };
    case "for_each":
      return {
        ...base,
        type,
        collection: field("workflow.input.items"),
        concurrency: 2,
        maxItems: 50,
        body: {
          nodes: [{ id: `${id}_step` as never, type: "transform", output: field("loop.item") }],
          edges: [],
        },
      };
    case "while":
      return {
        ...base,
        type,
        condition: {
          type: "comparison",
          left: field("loop.index"),
          operator: "lt",
          right: literal(3),
        },
        maxIterations: 10,
        body: {
          nodes: [{ id: `${id}_step` as never, type: "transform", output: field("loop.index") }],
          edges: [],
        },
      };
    case "transform":
      return { ...base, type, output: emptyObject };
    case "program":
      return {
        ...base,
        type,
        program: {
          programId: "program:untitled" as never,
          version: 1,
          sourceDigest: "sha256:" as never,
        },
        input: emptyObject,
      };
    case "llm":
      return {
        ...base,
        type,
        model: "@cf/meta/llama-3.1-8b-instruct",
        prompt: literal("要約してください"),
        maxOutputTokens: 256,
        capabilities: {
          llm: {
            models: ["@cf/meta/llama-3.1-8b-instruct"],
            maxCalls: 1,
            maxInputTokens: 2000,
            maxOutputTokens: 256,
            maxCostMicroUsd: 100_000,
          },
        },
      };
    case "join":
      return { ...base, type };
    case "output":
      return { ...base, type, value: emptyObject };
  }
}

export type PositionedNode = { node: WorkflowNode; x: number; y: number };

/** 保存済みpositionが無いNodeをdagreで配置する。 */
export function layoutGraph(graph: WorkflowGraph, force = false): PositionedNode[] {
  const layout = new dagre.graphlib.Graph();
  layout.setGraph({ rankdir: "TB", nodesep: 40, ranksep: 56, marginx: 16, marginy: 16 });
  layout.setDefaultEdgeLabel(() => ({}));
  for (const node of graph.nodes)
    layout.setNode(String(node.id), { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const edge of graph.edges) layout.setEdge(String(edge.source), String(edge.target));
  dagre.layout(layout);
  return graph.nodes.map((node) => {
    if (node.position && !force) return { node, x: node.position.x, y: node.position.y };
    const positioned = layout.node(String(node.id)) as { x: number; y: number } | undefined;
    return {
      node,
      x: (positioned?.x ?? 0) - NODE_WIDTH / 2,
      y: (positioned?.y ?? 0) - NODE_HEIGHT / 2,
    };
  });
}

export function edgeLabel(edge: WorkflowEdge): string | undefined {
  return edge.branch;
}

/** Node / Edgeの表示用summary。 */
export function nodeSummary(node: WorkflowNode): string {
  switch (node.type) {
    case "action":
      return String(node.actionType);
    case "branch":
      return `${node.cases.map((branchCase) => branchCase.key).join(" / ")}${node.defaultKey ? ` / ${node.defaultKey}` : ""}`;
    case "for_each":
      return `${node.collection.type === "field" ? node.collection.path : "literal"} ×${node.concurrency}`;
    case "while":
      return `max ${node.maxIterations}`;
    case "program":
      return `${String(node.program.programId)}@${node.program.version}`;
    case "llm":
      return node.model;
    default:
      return "";
  }
}

export function emptyDefinition(id: string, name: string): WorkflowDefinition {
  return {
    id: id as WorkflowDefinition["id"],
    name,
    inputFields: [],
    graph: {
      nodes: [
        { id: "start" as never, type: "trigger", position: { x: 160, y: 0 } },
        {
          id: "end" as never,
          type: "output",
          value: field("workflow.input"),
          position: { x: 160, y: 200 },
        },
      ],
      edges: [{ id: "e1", source: "start" as never, target: "end" as never }],
    },
  };
}
