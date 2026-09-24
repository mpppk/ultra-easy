import type { ApprovalFlowPresentationNode, ApprovalStepPresentation } from "@app/approval-core";

import { cn } from "#lib/utils";

import { completionText, stepTitle } from "./approval-flow-graph.ts";
import { targetText } from "./approval-step-detail.tsx";

/**
 * Keyboard-accessible tree with the same information as the graph. Serial
 * groups are ordered lists (order = execution order); parallel groups state
 * their completion condition in text, not only via layout or color.
 */
export function ApprovalFlowTree({
  root,
  selectedPath,
  onSelect,
}: {
  root: ApprovalFlowPresentationNode;
  selectedPath?: string;
  onSelect: (step: ApprovalStepPresentation) => void;
}) {
  return (
    <div data-slot="approval-flow-tree" aria-label="Approval flow (tree)">
      <TreeNode node={root} selectedPath={selectedPath} onSelect={onSelect} />
    </div>
  );
}

function TreeNode({
  node,
  selectedPath,
  onSelect,
}: {
  node: ApprovalFlowPresentationNode;
  selectedPath?: string;
  onSelect: (step: ApprovalStepPresentation) => void;
}) {
  if (node.type === "none") {
    return (
      <p data-node-type="none" className="rounded-md border border-dashed px-3 py-2 text-sm">
        {node.label}
      </p>
    );
  }
  if (node.type === "approval") {
    const selected = node.path === selectedPath;
    return (
      <button
        type="button"
        data-node-type="approval"
        aria-pressed={selected}
        onClick={() => onSelect(node)}
        className={cn(
          "w-full rounded-md border px-3 py-2 text-left text-sm hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
          selected && "border-ring bg-accent",
        )}
      >
        <span className="font-medium">{stepTitle(node)}</span>
        <span className="block text-muted-foreground">
          {targetText(node.target)} · {node.resolution} · {node.candidateCompletion.label}
        </span>
      </button>
    );
  }
  const children = node.children.map((child) => (
    <li key={child.path} className="pl-1">
      <TreeNode node={child} selectedPath={selectedPath} onSelect={onSelect} />
    </li>
  ));
  if (node.type === "serial") {
    return (
      <div data-node-type="serial" className="flex flex-col gap-1">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {`Serial — in order (${node.children.length})`}
        </p>
        <ol className="flex list-decimal flex-col gap-2 pl-6">{children}</ol>
      </div>
    );
  }
  return (
    <div data-node-type={node.type} className="flex flex-col gap-1 rounded-md border-l-4 pl-3">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {`Parallel · ${node.label} — ${completionText(node)}`}
      </p>
      <ul className="flex list-disc flex-col gap-2 pl-6">{children}</ul>
    </div>
  );
}
