import type { WorkflowGraph } from "./definition.ts";
import { findNode, incomingEdges, topologicalOrder, visitGraphs } from "./graph.ts";

export type NodeReachability = {
  /** 必ず実行されるか（Branch非選択やloop 0回で実行されないことがあるならconditional）。 */
  reachability: "always" | "conditional";
  /** loop bodyの中にあり、複数回実行されうる。 */
  repeated: boolean;
  /** 所属するloop Node ID列（rootは空）。 */
  loopPath: string[];
};

const MAX_BRANCH_ASSIGNMENTS = 512;

/** 保守的な判定: 全入力edgeがBranch edgeか、skipされうるNodeから出ているならskipされうる。 */
function conservativeSkippable(graph: WorkflowGraph, order: readonly string[]): Set<string> {
  const canSkip = new Set<string>();
  for (const nodeId of order) {
    const incoming = incomingEdges(graph, nodeId);
    const skippable =
      incoming.length > 0 &&
      incoming.every((edge) => {
        const source = findNode(graph, edge.source);
        return (
          (source?.type === "branch" && edge.branch !== undefined) ||
          canSkip.has(String(edge.source))
        );
      });
    if (skippable) canSkip.add(nodeId);
  }
  return canSkip;
}

/**
 * Branchの選択（case / default）の全組み合わせでactivationを伝播し、どれか1つでも
 * 実行されない組み合わせがあるNodeをskipされうるとする（Joinは1本でもactiveなら実行される）。
 */
function exactSkippable(graph: WorkflowGraph, order: readonly string[]): Set<string> | null {
  const branches = graph.nodes.filter((node) => node.type === "branch");
  const choices = branches.map((node) =>
    node.type === "branch"
      ? [
          ...node.cases.map((branchCase) => branchCase.key),
          ...(node.defaultKey !== undefined ? [node.defaultKey] : []),
        ]
      : [],
  );
  const total = choices.reduce((product, options) => product * Math.max(1, options.length), 1);
  if (total > MAX_BRANCH_ASSIGNMENTS) return null;
  const canSkip = new Set<string>();
  for (let index = 0; index < total; index += 1) {
    const selected = new Map<string, string | undefined>();
    let remainder = index;
    branches.forEach((branch, position) => {
      const options = choices[position] ?? [];
      const width = Math.max(1, options.length);
      selected.set(String(branch.id), options[remainder % width]);
      remainder = Math.floor(remainder / width);
    });
    const active = new Set<string>();
    for (const nodeId of order) {
      const incoming = incomingEdges(graph, nodeId);
      const isActive =
        incoming.length === 0 ||
        incoming.some((edge) => {
          if (!active.has(String(edge.source))) return false;
          const source = findNode(graph, edge.source);
          return source?.type !== "branch" || edge.branch === selected.get(String(edge.source));
        });
      if (isActive) active.add(nodeId);
      else canSkip.add(nodeId);
    }
  }
  return canSkip;
}

/**
 * Nodeが実行されるかどうかを静的に分類する（Approval Projection用, #159）。
 *
 * `not_taken`はBranchの非選択edgeからだけ生まれ、全入力edgeが`not_taken`のNodeだけがskipされる
 * （kernelと同じ意味論）。Branch選択の全組み合わせで実行されるNodeを`always`とする
 * （組み合わせが多すぎる場合は保守的に判定する）。loop bodyのNodeは0回 / 複数回実行されうる。
 */
export function analyzeNodeReachability(root: WorkflowGraph): Map<string, NodeReachability> {
  const result = new Map<string, NodeReachability>();
  for (const { graph, path } of visitGraphs(root)) {
    const order = (topologicalOrder(graph) ?? graph.nodes.map((node) => node.id)).map(String);
    const canSkip = exactSkippable(graph, order) ?? conservativeSkippable(graph, order);
    const insideLoop = path.length > 0;
    for (const nodeId of order) {
      result.set(nodeId, {
        reachability: canSkip.has(nodeId) || insideLoop ? "conditional" : "always",
        repeated: insideLoop,
        loopPath: path.map(String),
      });
    }
  }
  return result;
}
