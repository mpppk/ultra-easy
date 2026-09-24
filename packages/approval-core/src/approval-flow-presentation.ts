import type { ApprovalPurpose, FlowConstraints } from "./domain/flow.ts";
import type { PrincipalRef } from "./domain/principal.ts";
import type {
  MaterializedApprovalPlan,
  MaterializedApprovalStep,
  MaterializedFlow,
  PolicyBindingSnapshot,
  ResolvedApproverTarget,
} from "./materialization.ts";

/**
 * Read-only, JSON-serializable, provider-independent projection of a
 * Materialized Approval Plan's flow for display (M9 Explorer simulation).
 *
 * It is a faithful re-shaping of `MaterializedApprovalPlan.flow`: no policy
 * is re-evaluated, no approver candidates are resolved, and no runtime task
 * progress (active step, decisions) is included. Structure, order and
 * completion semantics are preserved exactly.
 */
export type ApprovalTargetPresentation =
  | {
      type: "relation";
      /** Logical (tenant-unscoped) object, e.g. `team:finance`. */
      object: string;
      relation: string;
      sourceKind: "relation" | "principal_relation";
    }
  | { type: "user"; userId: string; sourceKind: "principal" | "user" };

export type CandidateCompletionPresentation =
  | { type: "any"; label: string }
  | { type: "all"; label: string }
  | { type: "quorum"; count: number; label: string };

export type ApprovalStepSourcePresentation = {
  policyBindingId: string;
  policyKey: string;
  policyVersion: number;
  /** Rule that produced this step, when the binding snapshot recorded a match. */
  matchedRuleKey: string | null;
  flowPath: string;
};

export type ApprovalStepPresentation = {
  type: "approval";
  /** Stable position in the flow tree (`root`, `root.0`, `root.1.2`, ...). */
  path: string;
  materializedStepId: string;
  stepKey: string;
  name?: string;
  purpose?: ApprovalPurpose;
  target: ApprovalTargetPresentation;
  resolution: "dynamic" | "snapshot";
  candidateCompletion: CandidateCompletionPresentation;
  selfApproval?: { mode: "allow" | "deny"; subject?: PrincipalRef };
  onUnresolved?: { type: "deny" } | { type: "fallback"; target: ApprovalTargetPresentation };
  expiresAfterSeconds?: number;
  requireCommentOn?: ("approve" | "reject")[];
  source: ApprovalStepSourcePresentation;
};

export type ParallelGroupPresentation = {
  /** Parallel completion strategy. All three are parallel branch groups. */
  type: "all" | "any" | "quorum";
  group: "parallel";
  path: string;
  /** Branches that must complete: all → total, any → 1, quorum → N. */
  required: number;
  total: number;
  /** Human-readable completion condition, e.g. `quorum 2/3`. */
  label: string;
  constraints?: FlowConstraints;
  children: ApprovalFlowPresentationNode[];
};

export type SerialGroupPresentation = {
  type: "serial";
  path: string;
  label: string;
  constraints?: FlowConstraints;
  /** Ordered: each child starts after the previous one completes. */
  children: ApprovalFlowPresentationNode[];
};

export type ApprovalFlowPresentationNode =
  | { type: "none"; path: string; label: string }
  | ApprovalStepPresentation
  | SerialGroupPresentation
  | ParallelGroupPresentation;

export type ApprovalFlowPresentation = {
  requiresApproval: boolean;
  stepCount: number;
  approvalPlanChecksum: string;
  interpreterSemanticsVersion: number;
  root: ApprovalFlowPresentationNode;
};

function presentTarget(target: ResolvedApproverTarget): ApprovalTargetPresentation {
  return target.type === "relation"
    ? {
        type: "relation",
        object: String(target.object),
        relation: String(target.relation),
        sourceKind: target.sourceKind,
      }
    : { type: "user", userId: String(target.userId), sourceKind: target.sourceKind };
}

function presentCandidateCompletion(
  step: MaterializedApprovalStep,
): CandidateCompletionPresentation {
  const completion = step.candidateCompletion ?? "any";
  if (completion === "any") return { type: "any", label: "any candidate" };
  if (completion === "all") return { type: "all", label: "all candidates" };
  return { type: "quorum", count: completion.count, label: `${completion.count} candidates` };
}

function matchedRuleKey(
  snapshots: readonly PolicyBindingSnapshot[],
  bindingId: string,
): string | null {
  const snapshot = snapshots.find((candidate) => String(candidate.bindingId) === bindingId);
  return snapshot?.outcome.type === "matched" ? String(snapshot.outcome.ruleKey) : null;
}

function presentStep(
  step: MaterializedApprovalStep,
  path: string,
  snapshots: readonly PolicyBindingSnapshot[],
): ApprovalStepPresentation {
  return {
    type: "approval",
    path,
    materializedStepId: String(step.materializedStepId),
    stepKey: String(step.stepKey),
    ...(step.name !== undefined ? { name: step.name } : {}),
    ...(step.purpose !== undefined ? { purpose: step.purpose } : {}),
    target: presentTarget(step.target),
    resolution: step.resolution ?? "dynamic",
    candidateCompletion: presentCandidateCompletion(step),
    ...(step.selfApproval ? { selfApproval: step.selfApproval } : {}),
    ...(step.onUnresolved
      ? {
          onUnresolved:
            step.onUnresolved.type === "fallback"
              ? { type: "fallback", target: presentTarget(step.onUnresolved.target) }
              : { type: "deny" },
        }
      : {}),
    ...(step.expiresAfter ? { expiresAfterSeconds: step.expiresAfter.seconds } : {}),
    ...(step.requireCommentOn ? { requireCommentOn: [...step.requireCommentOn] } : {}),
    source: {
      policyBindingId: String(step.source.policyBindingId),
      policyKey: String(step.source.policyKey),
      policyVersion: step.source.policyVersion,
      matchedRuleKey: matchedRuleKey(snapshots, String(step.source.policyBindingId)),
      flowPath: step.source.flowPath,
    },
  };
}

function presentNode(
  flow: MaterializedFlow,
  path: string,
  snapshots: readonly PolicyBindingSnapshot[],
): ApprovalFlowPresentationNode {
  if (flow.type === "none") return { type: "none", path, label: "Approval not required" };
  if (flow.type === "approval") return presentStep(flow, path, snapshots);
  const children = flow.children.map((child, index) =>
    presentNode(child, `${path}.${index}`, snapshots),
  );
  const constraints = flow.constraints ? { constraints: flow.constraints } : {};
  if (flow.type === "serial") {
    return {
      type: "serial",
      path,
      label: `serial (${children.length} in order)`,
      ...constraints,
      children,
    };
  }
  const total = children.length;
  if (flow.strategy === "quorum") {
    return {
      type: "quorum",
      group: "parallel",
      path,
      required: flow.quorum,
      total,
      label: `quorum ${flow.quorum}/${total}`,
      ...constraints,
      children,
    };
  }
  if (flow.strategy === "any") {
    return {
      type: "any",
      group: "parallel",
      path,
      required: 1,
      total,
      label: `any 1/${total}`,
      ...constraints,
      children,
    };
  }
  return {
    type: "all",
    group: "parallel",
    path,
    required: total,
    total,
    label: `all ${total}/${total}`,
    ...constraints,
    children,
  };
}

function countSteps(node: ApprovalFlowPresentationNode): number {
  if (node.type === "none") return 0;
  if (node.type === "approval") return 1;
  return node.children.reduce((total, child) => total + countSteps(child), 0);
}

export function approvalFlowPresentation(plan: MaterializedApprovalPlan): ApprovalFlowPresentation {
  const root = presentNode(plan.flow, "root", plan.policyBindingSnapshots);
  return {
    requiresApproval: plan.flow.type !== "none",
    stepCount: countSteps(root),
    approvalPlanChecksum: String(plan.approvalPlanChecksum),
    interpreterSemanticsVersion: plan.interpreterSemanticsVersion,
    root,
  };
}
