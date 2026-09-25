import type { WorkflowEdge, WorkflowGraph, WorkflowNode } from "./definition.ts";
import type { NodeId } from "./ids.ts";

export function incomingEdges(graph: WorkflowGraph, nodeId: NodeId | string): WorkflowEdge[] {
  return graph.edges.filter((edge) => String(edge.target) === String(nodeId));
}

export function outgoingEdges(graph: WorkflowGraph, nodeId: NodeId | string): WorkflowEdge[] {
  return graph.edges.filter((edge) => String(edge.source) === String(nodeId));
}

export function findNode(graph: WorkflowGraph, nodeId: NodeId | string): WorkflowNode | undefined {
  return graph.nodes.find((node) => String(node.id) === String(nodeId));
}

export function loopBody(node: WorkflowNode): WorkflowGraph | undefined {
  return node.type === "for_each" || node.type === "while" ? node.body : undefined;
}

/** root graphからloop Node IDの列を辿ってbody graphを得る。 */
export function graphAtPath(
  root: WorkflowGraph,
  path: readonly (NodeId | string)[],
): WorkflowGraph | undefined {
  let current: WorkflowGraph | undefined = root;
  for (const nodeId of path) {
    if (!current) return undefined;
    const node = findNode(current, nodeId);
    current = node ? loopBody(node) : undefined;
  }
  return current;
}

/**
 * Kahnのアルゴリズムによる決定的なtopological order（同順位はgraph上の宣言順）。
 * cycleがあればnull。
 */
export function topologicalOrder(graph: WorkflowGraph): NodeId[] | null {
  const ids = graph.nodes.map((node) => String(node.id));
  const known = new Set(ids);
  const indegree = new Map(ids.map((id) => [id, 0]));
  for (const edge of graph.edges) {
    if (!known.has(String(edge.source)) || !known.has(String(edge.target))) continue;
    indegree.set(String(edge.target), (indegree.get(String(edge.target)) ?? 0) + 1);
  }
  const order: NodeId[] = [];
  const queue = graph.nodes.filter((node) => indegree.get(String(node.id)) === 0);
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node) break;
    order.push(node.id);
    for (const edge of outgoingEdges(graph, node.id)) {
      const target = String(edge.target);
      if (!known.has(target)) continue;
      const remaining = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, remaining);
      if (remaining === 0) {
        const next = findNode(graph, target);
        if (next) queue.push(next);
      }
    }
  }
  return order.length === graph.nodes.length ? order : null;
}

/** 同じgraph内でnodeIdへ到達できるNode（祖先）の集合。 */
export function ancestorsOf(graph: WorkflowGraph, nodeId: NodeId | string): Set<string> {
  const ancestors = new Set<string>();
  const stack = [String(nodeId)];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    for (const edge of incomingEdges(graph, current)) {
      const source = String(edge.source);
      if (ancestors.has(source)) continue;
      ancestors.add(source);
      stack.push(source);
    }
  }
  return ancestors;
}

export type GraphVisit = {
  graph: WorkflowGraph;
  /** root graphからのloop Node ID列（rootは空）。 */
  path: NodeId[];
};

/** root graphと全loop bodyを深さ優先で列挙する。 */
export function visitGraphs(root: WorkflowGraph): GraphVisit[] {
  const visits: GraphVisit[] = [];
  const walk = (graph: WorkflowGraph, path: NodeId[]) => {
    visits.push({ graph, path });
    for (const node of graph.nodes) {
      const body = loopBody(node);
      if (body) walk(body, [...path, node.id]);
    }
  };
  walk(root, []);
  return visits;
}

/** 全graphのNodeを列挙する。 */
export function allNodes(root: WorkflowGraph): { node: WorkflowNode; path: NodeId[] }[] {
  return visitGraphs(root).flatMap(({ graph, path }) =>
    graph.nodes.map((node) => ({ node, path })),
  );
}
