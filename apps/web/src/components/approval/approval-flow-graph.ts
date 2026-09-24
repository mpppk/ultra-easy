import type {
  ApprovalFlowPresentation,
  ApprovalFlowPresentationNode,
  ApprovalStepPresentation,
  ParallelGroupPresentation,
} from "@app/approval-core";

/**
 * Compiles an ApprovalFlowPresentation (#117) into a flat, layout-agnostic
 * graph. Semantics are never re-derived: every node/edge maps 1:1 to the
 * Materialized Plan structure.
 *
 * - `approval`          → step node
 * - `all | any | quorum`→ split + join gateway nodes labelled with the
 *                          completion condition (e.g. `quorum 2/3`)
 * - `serial`            → ordered edges between children
 * - `none`              → one explicit "Approval not required" node
 */
export type FlowGraphNode =
  | { id: string; kind: "start"; label: string }
  | { id: string; kind: "end"; label: string }
  | { id: string; kind: "none"; label: string }
  | { id: string; kind: "step"; label: string; step: ApprovalStepPresentation }
  | {
      id: string;
      kind: "split" | "join";
      label: string;
      group: Pick<ParallelGroupPresentation, "type" | "required" | "total" | "label" | "path">;
    };

export type FlowGraphEdge = {
  id: string;
  source: string;
  target: string;
  label?: string;
};

export type FlowGraph = { nodes: FlowGraphNode[]; edges: FlowGraphEdge[] };

type Fragment = { entry: string; exit: string };

const COMPLETION_TEXT: Record<
  ParallelGroupPresentation["type"],
  (group: ParallelGroupPresentation) => string
> = {
  all: (group) => `all ${group.total} branches must complete`,
  any: (group) => `any 1 of ${group.total} branches completes`,
  quorum: (group) => `${group.required} of ${group.total} branches complete`,
};

export function completionText(group: ParallelGroupPresentation): string {
  return COMPLETION_TEXT[group.type](group);
}

export function stepTitle(step: ApprovalStepPresentation): string {
  return step.name ? `${step.name} (${step.stepKey})` : step.stepKey;
}

export function buildApprovalFlowGraph(flow: ApprovalFlowPresentation): FlowGraph {
  const nodes: FlowGraphNode[] = [];
  const edges: FlowGraphEdge[] = [];
  const edge = (source: string, target: string, label?: string) =>
    edges.push({ id: `${source}->${target}`, source, target, ...(label ? { label } : {}) });

  function compile(node: ApprovalFlowPresentationNode): Fragment {
    if (node.type === "none") {
      nodes.push({ id: node.path, kind: "none", label: node.label });
      return { entry: node.path, exit: node.path };
    }
    if (node.type === "approval") {
      nodes.push({ id: node.path, kind: "step", label: stepTitle(node), step: node });
      return { entry: node.path, exit: node.path };
    }
    if (node.type === "serial") {
      const fragments = node.children.map(compile);
      fragments.slice(1).forEach((fragment, index) => {
        const previous = fragments[index];
        if (previous)
          edge(previous.exit, fragment.entry, `then (${index + 2}/${fragments.length})`);
      });
      const first = fragments[0];
      const last = fragments.at(-1);
      return first && last
        ? { entry: first.entry, exit: last.exit }
        : { entry: node.path, exit: node.path };
    }
    const group = {
      type: node.type,
      required: node.required,
      total: node.total,
      label: node.label,
      path: node.path,
    };
    const split = `${node.path}:split`;
    const join = `${node.path}:join`;
    nodes.push({ id: split, kind: "split", label: `${node.label} · parallel`, group });
    for (const child of node.children) {
      const fragment = compile(child);
      edge(split, fragment.entry);
      edge(fragment.exit, join);
    }
    nodes.push({ id: join, kind: "join", label: completionText(node), group });
    return { entry: split, exit: join };
  }

  nodes.push({ id: "start", kind: "start", label: "ActionRequest submitted" });
  const root = compile(flow.root);
  nodes.push({ id: "end", kind: "end", label: "Re-authorize & execute" });
  edge("start", root.entry);
  edge(root.exit, "end");
  return { nodes, edges };
}
